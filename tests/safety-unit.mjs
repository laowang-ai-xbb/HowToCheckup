#!/usr/bin/env node
/**
 * 金标准画像门禁（P0/P1）
 *
 * 每条都来自一次真实复现的错误：
 *   戒烟 30 年还被判 LDCT 高危、二手烟"是"无年限就高危、家族史但本人不吸烟也高危、
 *   120 岁还在出癌症筛查和疫苗、unknown 被当成"没有"。
 *
 * 这些用例只问"输出变了没有"，不碰规则内部实现 —— 下一次有人把 C 档改回 A→B→C
 * 认领，或者把 unknown 兜底成阴性，这里必须红。
 */
import { emptyProfile, evaluate, evaluateDetailed } from '../src/engine.js';
import { vaccinesDeferred, gateMessage, applySafety, SAFETY_VERSION } from '../scripts/lib/safety.mjs';
import { toFacts, lungLDCT2025 } from '../scripts/lib/facts.mjs';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name} — ${detail}`); }
};

const P = (over = {}) => ({ ...emptyProfile(), gender: 'male', age: 55, ...over });
const has = (b, cat, id) => (b[cat] || []).some((r) => r.id === id && !r.hidden);
const ids = (b, cat) => b[cat].filter((r) => !r.hidden).map((r) => r.id);

// ---- 1. 肺癌 LDCT：2025 版严格口径 ----
{
  const b = evaluate(P({ smoking: 'quit', packYears: 20, smokingQuitYears: 'ge5' }));
  check('戒烟 30 年不再判 LDCT 高危', !has(b, 'A', 'lung-ldct-high-risk') && has(b, 'C', 'lung-ldct-not-high-risk'), ids(b, 'A').join(','));
  check('戒烟超过 5 年给出分歧提示', evaluateDetailed(P({ smoking: 'quit', packYears: 20, smokingQuitYears: 'ge5' }))[1].disputes.length === 1);
}
{
  const b = evaluate(P({ smoking: 'quit', packYears: 20, smokingQuitYears: 'lt5' }));
  check('戒烟 5 年以内仍判 LDCT 高危', has(b, 'A', 'lung-ldct-high-risk') && !has(b, 'C', 'lung-ldct-not-high-risk'));
}
{
  const b = evaluate(P({ smoking: 'yes', packYears: 20 }));
  check('现在吸烟 20 包年判 LDCT 高危', has(b, 'A', 'lung-ldct-high-risk'));
}
{
  const p = P({ secondhand: 'yes', secondhandYears: 'ge20' });
  const b = evaluate(p);
  check('被动吸烟≥20 年判 LDCT 高危', has(b, 'A', 'lung-ldct-high-risk'));
  check('被动吸烟≥20 年不会被 C 档挡掉', !has(b, 'C', 'lung-ldct-not-high-risk'));
}
{
  const [b, meta] = evaluateDetailed(P({ secondhand: 'yes' }));
  check('二手烟只有"是"没有年限 → 算不出来', !has(b, 'A', 'lung-ldct-high-risk') && !has(b, 'C', 'lung-ldct-not-high-risk') && meta.indeterminate.length === 1);
}
{
  const b = evaluate(P({ occupationDust: 'yes', occupationYears: 'ge5', occupationAgents: ['construction'] }));
  check('普通建筑粉尘不算明确职业致癌物', !has(b, 'A', 'lung-ldct-high-risk') && has(b, 'C', 'lung-ldct-not-high-risk'));
}
{
  const b = evaluate(P({ occupationDust: 'yes', occupationYears: 'ge5', occupationAgents: ['asbestos'] }));
  check('石棉暴露≥5 年判 LDCT 高危', has(b, 'A', 'lung-ldct-high-risk'));
}
{
  const b = evaluate(P({ gender: 'female', familyHistory: ['lung'], packYears: 0 }));
  check('家族史但本人不吸烟不判 LDCT 高危', !has(b, 'A', 'lung-ldct-high-risk'));
  check('家族史本身进"有分歧、去问医生"', evaluateDetailed(P({ gender: 'female', familyHistory: ['lung'], packYears: 0 }))[1].disputes.length === 1);
}
{
  const b = evaluate(P({ gender: 'female', familyHistory: ['lung'], packYears: 20 }));
  check('家族史合并本人≥15 包年判 LDCT 高危', has(b, 'A', 'lung-ldct-high-risk'));
}

// ---- 2. 老链接兼容：没答过 ≠ 说没有 ----
{
  const p = P({ smoking: 'quit', packYears: 20 }); // 老链接没有 smokingQuitYears
  const [b, meta] = evaluateDetailed(p);
  check('老链接缺戒烟年限 → 算不出来，不冒充"不用做"',
    !has(b, 'A', 'lung-ldct-high-risk') && !has(b, 'C', 'lung-ldct-not-high-risk')
    && meta.indeterminate.some((x) => x.fields.includes('戒烟年限')));
  const facts = toFacts(p);
  check('戒烟状态保留为 quit', facts.exposures[0].status === 'quit');
}

// ---- 3. 筛查前提三闸 ----
{
  const p = P({ age: 120, gender: 'female' });
  const [b, meta] = evaluateDetailed(p);
  check('120 岁不再输出癌症筛查 A/B 与疫苗', b.A.every((r) => r.hidden) && b.B.every((r) => r.hidden) && vaccinesDeferred(meta));
  check('120 岁给的是"先找医生"说明', /超出范围/.test(gateMessage(meta)));
}
{
  const [b, meta] = evaluateDetailed(P({ symptomFlags: ['cough2w'] }));
  check('有症状 → 不走无症状筛查清单', b.A.every((r) => r.hidden) && b.B.every((r) => r.hidden));
  check('有症状 → 明确提示去门诊', /门诊看病/.test(gateMessage(meta)));
}
{
  const [b, meta] = evaluateDetailed(P({ age: 78, frailty: 'yes' }));
  check('衰弱 → 筛查降级并说明原因', b.A.every((r) => r.hidden) && /耐受/.test(gateMessage(meta)));
}

// ---- 4. 抑制优先：C 档先算，A/B 里同一项目必须撤掉 ----
{
  // 合成一组冲突：A 说做 PET-CT、C 说不做。老链路 A→B→C 会把 C 藏掉。
  const a = { id: 'synthetic-a', category: 'A', catalogIds: ['pet-ct'], shownIds: ['pet-ct'] };
  const c = { id: 'pet-ct-screening', category: 'C', catalogIds: ['pet-ct'], shownIds: ['pet-ct'] };
  const [b, meta] = applySafety(P(), { A: [a], B: [], C: [c] });
  check('C 档"不推荐"优先，A 档同项目被撤下', b.A[0].hidden === true && has(b, 'C', 'pet-ct-screening'));
  check('抑制动作留痕', meta.suppressed.some((s) => s.id === 'synthetic-a' && /不推荐/.test(s.reason)));
}
{
  const b = evaluate(P({ gender: 'male', familyHistory: ['ovarian'] }));
  check('卵巢家族史不再给男性出建议', !has(b, 'B', 'ovarian-family-history'));
  const f = evaluate(P({ gender: 'female', age: 40, familyHistory: ['ovarian'] }));
  check('女性仍然出卵巢家族史建议', has(f, 'B', 'ovarian-family-history'));
}

// ---- 5. 三态与幂等 ----
{
  const p = P({ smoking: 'yes', packYears: 20 });
  const b1 = evaluate(p);
  const b2 = evaluate(p);
  check('同一画像连算两次结果一致（规则对象不串味）',
    JSON.stringify(ids(b1, 'A')) === JSON.stringify(ids(b2, 'A'))
    && JSON.stringify(ids(b1, 'C')) === JSON.stringify(ids(b2, 'C')));
  check('A/B 标 confirmed、C 标 baseline',
    b1.A.filter((r) => !r.hidden).every((r) => r.clinicalStatus === 'confirmed')
    && b1.C.filter((r) => !r.hidden).every((r) => r.clinicalStatus === 'baseline'));
  check('安全层有版本号，方便线上对照', typeof SAFETY_VERSION === 'string' && SAFETY_VERSION.length > 5);
}
{
  const facts = toFacts(P({ secondhand: 'yes', secondhandYears: 'ge20', smoking: 'no' }));
  const ld = lungLDCT2025(facts);
  check('被动吸烟≥20 年即使在事实层也成立', ld.eligible === true);
}

console.log(`\n${pass}/${pass + fail} 通过`);
if (fail) process.exit(1);
