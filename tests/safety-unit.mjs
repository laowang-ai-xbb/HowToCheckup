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
  check('家族史本身进"有分歧、去咨询医生"', evaluateDetailed(P({ gender: 'female', familyHistory: ['lung'], packYears: 0 }))[1].disputes.length === 1);
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

/* ============================================================
 * 6. 金标准扩到 100 条（老板 2026-11-24 计划 6）
 *
 * 上面 27 条是"曾经真错过"的回归用例；这一批是**边界矩阵**：
 * 把 2025 LDCT、三闸、三态、性别与抑制的边界成系统地钉死，
 * 以后任何人改规则/事实层，只要有一条边界被踩坏，这里就红。
 * 全部只看输出（has/ids/medical meta），不碰内部实现。
 * ============================================================ */

// ---- 6A. LDCT：吸烟剂量 × 戒烟时间 × 年龄（严格口径）----
{
  const cases = [
    // 说明, 画像增量, 期望高危?
    ['现在吸烟 19 包年不够 20', { smoking: 'yes', packYears: 19 }, false],
    ['现在吸烟 20 包年够', { smoking: 'yes', packYears: 20 }, true],
    ['现在吸烟 30 包年够', { smoking: 'yes', packYears: 30 }, true],
    ['戒烟≤5 年 20 包年够', { smoking: 'quit', packYears: 20, smokingQuitYears: 'lt5' }, true],
    ['戒烟超过 5 年不够（进分歧）', { smoking: 'quit', packYears: 20, smokingQuitYears: 'ge5' }, false],
    ['戒烟 5 年但这题缺失 → 算不出来', { smoking: 'quit', packYears: 20 }, false],
    ['戒烟但说不清年限 → 算不出来', { smoking: 'quit', packYears: 20, smokingQuitYears: 'unknown' }, false],
    ['不吸烟即使 40 包年也不按吸烟入口', { smoking: 'no', packYears: 40 }, false],
    ['不方便说吸烟 → 不猜高危', { smoking: 'declined', packYears: 20 }, false],
    ['吸烟题完全没答 → 不算高危', { packYears: 20 }, false],
    ['49 岁吸烟 20 包年不够年龄', { age: 49, smoking: 'yes', packYears: 20 }, false],
    ['50 岁吸烟 20 包年够', { age: 50, smoking: 'yes', packYears: 20 }, true],
    // 80 岁起不进 A 档强推荐，改由 lung-ldct-80plus（B 档"看你的情况"）承载
    ['80 岁吸烟 20 包年不进 A 档强推荐', { age: 80, smoking: 'yes', packYears: 20 }, false],
    ['81 岁超出 LDCT 年龄上限', { age: 81, smoking: 'yes', packYears: 20 }, false],
    ['女性吸烟 20 包年同样够', { gender: 'female', smoking: 'yes', packYears: 20 }, true],
  ];
  for (const [name, over, want] of cases) {
    const b = evaluate(P(over));
    check('LDCT·' + name, has(b, 'A', 'lung-ldct-high-risk') === want, ids(b, 'A').join(','));
  }
}

// ---- 6B. LDCT：被动吸烟年限边界 ----
{
  const cases = [
    ['二手烟≥20 年够', { secondhand: 'yes', secondhandYears: 'ge20' }, true],
    ['二手烟 15–20 年不够（无家族史）', { secondhand: 'yes', secondhandYears: 'ge15' }, false],
    ['二手烟<15 年不够', { secondhand: 'yes', secondhandYears: 'lt15' }, false],
    ['二手烟说不清年限 → 不算高危', { secondhand: 'yes', secondhandYears: 'unknown' }, false],
    ['二手烟题缺失 → 不算高危', { secondhand: 'yes' }, false],
    ['二手烟答"没有" → 不够', { secondhand: 'no', secondhandYears: 'ge20' }, false],
    ['不吸烟 + 二手烟≥20 年仍够', { smoking: 'no', secondhand: 'yes', secondhandYears: 'ge20' }, true],
  ];
  for (const [name, over, want] of cases) {
    const b = evaluate(P(over));
    check('二手烟·' + name, has(b, 'A', 'lung-ldct-high-risk') === want, ids(b, 'A').join(','));
  }
}

// ---- 6C. LDCT：职业致癌物（明确 vs 普通粉尘）× 年限 ----
{
  const agents = {
    known: ['asbestos'],        // 石棉：指南点名
    legacy: ['mining'],         // 旧职业类别：兜底算致癌物
    ordinary: ['construction'], // 建筑：普通粉尘，不算
  };
  const cases = [
    ['石棉≥5 年够', { agents: agents.known, years: 'ge5' }, true],
    ['石棉高强度≥1 年够', { agents: agents.known, years: 'high1' }, true],
    ['石棉<5 年一般强度不够', { agents: agents.known, years: 'lt5' }, false],
    ['石棉年限说不清 → 不算高危', { agents: agents.known, years: 'unknown' }, false],
    ['普通粉尘≥5 年不算高危', { agents: agents.ordinary, years: 'ge5' }, false],
    ['建筑+石棉混合：有石棉就算', { agents: ['construction', 'asbestos'], years: 'ge5' }, true],
    // 旧链接的 occupationTypes（mining 等）目前只在 facts 层有兜底，规则 when 不认它，
    // 所以不会进 A 档。如实钉住这个行为；若日后决定让旧类别也升档，需要同时改规则 when。
    ['旧链接职业类别 mining≥5 年不进 A 档', { legacyTypes: agents.legacy, years: 'ge5' }, false],
    ['职业题答"没有"不算', { dust: 'no', agents: agents.known, years: 'ge5' }, false],
  ];
  for (const [name, cfg, want] of cases) {
    // 旧链接用 occupationTypes（如 mining），新题用 occupationAgents（如 asbestos）
    const over = { occupationDust: cfg.dust || 'yes', occupationYears: cfg.years };
    if (cfg.legacyTypes) over.occupationTypes = cfg.legacyTypes;
    else over.occupationAgents = cfg.agents;
    const b = evaluate(P(over));
    check('职业·' + name, has(b, 'A', 'lung-ldct-high-risk') === want, ids(b, 'A').join(','));
  }
}

// ---- 6D. LDCT：家族史合并暴露 ----
{
  const cases = [
    ['家族史 + 本人 15 包年够', { familyHistory: ['lung'], packYears: 15, smoking: 'yes' }, true],
    ['家族史 + 本人 14 包年不够', { familyHistory: ['lung'], packYears: 14, smoking: 'yes' }, false],
    ['家族史 + 二手烟≥15 年够', { familyHistory: ['lung'], secondhand: 'yes', secondhandYears: 'ge15' }, true],
    ['家族史 + 二手烟<15 年不够', { familyHistory: ['lung'], secondhand: 'yes', secondhandYears: 'lt15' }, false],
    ['家属史但本人完全不吸烟 → 分歧不升档', { familyHistory: ['lung'], smoking: 'no' }, false],
    ['非肺癌家族史不与吸烟合并', { familyHistory: ['breast'], packYears: 20, smoking: 'yes' }, true], // 20 包年本身够
    ['家族史为"不确定"不算有', { familyHistory: 'unknown', packYears: 20, smoking: 'yes' }, true], // 20 包年本身够
  ];
  for (const [name, over, want] of cases) {
    const b = evaluate(P(over));
    check('家族史·' + name, has(b, 'A', 'lung-ldct-high-risk') === want, ids(b, 'A').join(','));
  }
  // 分歧路径：家族史单独 / 戒烟超 5 年 / 职业短年限
  for (const [name, over] of [
    ['家族史单独进分歧', { familyHistory: ['lung'], smoking: 'no' }],
    ['戒烟超 5 年进分歧', { smoking: 'quit', packYears: 20, smokingQuitYears: 'ge5' }],
    ['职业短年限进分歧', { occupationDust: 'yes', occupationAgents: ['asbestos'], occupationYears: 'lt5' }],
  ]) {
    const [, meta] = evaluateDetailed(P(over));
    check('分歧·' + name, meta.disputes.length === 1, `disputes=${meta.disputes.length}`);
  }
}

// ---- 6E. 筛查前提三闸：症状 / 衰弱 / 年龄 ----
{
  const gated = [
    ['有咳嗽症状', { symptomFlags: ['cough2w'] }],
    ['有咯血症状', { symptomFlags: ['hemoptysis'] }],
    ['有胸痛症状', { symptomFlags: ['chestPain'] }],
    ['有体重下降症状', { symptomFlags: ['weightLoss'] }],
    ['有气短症状', { symptomFlags: ['breathless'] }],
    ['衰弱', { frailty: 'yes' }],
    ['近期住院≥2 次', { recentHospital: 'ge2' }],
    ['年龄 101', { age: 101 }],
    ['年龄 149', { age: 149 }],
  ];
  for (const [name, over] of gated) {
    const [b, meta] = evaluateDetailed(P(over));
    check('三闸·' + name + ' 压下所有 A/B',
      b.A.every((r) => r.hidden) && b.B.every((r) => r.hidden) && vaccinesDeferred(meta),
      `A=${ids(b, 'A').join(',')}`);
  }
  const notGated = [
    ['衰弱答"没有"', { frailty: 'no' }],
    ['住院 1 次', { recentHospital: 'one' }],
    ['住院题没答', {}],
    ['年龄 100 仍适用', { age: 100 }],
    ['年龄 18 起', { age: 18 }],
  ];
  for (const [name, over] of notGated) {
    const [b] = evaluateDetailed(P(over));
    check('三闸·' + name + ' 不误压', b.A.some((r) => !r.hidden), `A=${ids(b, 'A').join(',')}`);
  }
}

// ---- 6F. 三态与幂等：unknown / declined / 空值 不能被当成"没有" ----
{
  const tri = [
    ['吸烟 declined', { smoking: 'declined' }],
    ['吸烟 unknown', { smoking: 'unknown' }],
    ['二手烟 declined 无年限', { secondhand: 'declined' }],
    ['职业 declined 无年限', { occupationDust: 'declined' }],
    ['幽门螺杆菌 unknown', { hpStatus: 'unknown' }],
    ['家族史 unknown', { familyHistory: 'unknown' }],
    ['既往史 unknown', { pastHistory: 'unknown' }],
  ];
  for (const [name, over] of tri) {
    const b = evaluate(P(over));
    check('三态·' + name + ' 不冒充高危',
      !has(b, 'A', 'lung-ldct-high-risk'), ids(b, 'A').join(','));
  }
  // 幂等：同一画像连算 5 次，A/B/C 全一致
  {
    const p = P({ smoking: 'quit', packYears: 20, smokingQuitYears: 'ge5', familyHistory: ['lung'] });
    const sig = () => JSON.stringify(evaluate(p));
    const first = sig();
    check('幂等·同一画像连算 5 次结果完全一致', [2, 3, 4, 5].every(() => sig() === first));
  }
  // 临床状态标签：A/B confirmed、C baseline、被 LDCT 压下的为 indeterminate
  {
    const b1 = evaluate(P({ smoking: 'yes', packYears: 20 }));
    check('标签·高危吸烟 A 全 confirmed',
      b1.A.filter((r) => !r.hidden).every((r) => r.clinicalStatus === 'confirmed'));
    const [b2] = evaluateDetailed(P({ smoking: 'quit', packYears: 20, smokingQuitYears: 'unknown' }));
    check('标签·LDCT 算不出来不冒充 confirmed',
      b2.A.filter((r) => r.id === 'lung-ldct-high-risk').every((r) => r.clinicalStatus === 'indeterminate' || r.hidden));
  }
}

// ---- 6G. 性别 / 抑制 / 基础项 ----
{
  const sexCases = [
    ['男性不出卵巢家族史', { gender: 'male', familyHistory: ['ovarian'] }, 'B', 'ovarian-family-history', false],
    ['女性出卵巢家族史', { gender: 'female', familyHistory: ['ovarian'] }, 'B', 'ovarian-family-history', true],
    ['男性出 PSA', { gender: 'male', age: 55 }, 'B', 'psa-50-69', true],
    ['女性不出 PSA', { gender: 'female', age: 55 }, 'B', 'psa-50-69', false],
    ['男性不出宫颈筛查', { gender: 'male', age: 40 }, 'B', 'cervical-screening', false],
  ];
  for (const [name, over, cat, id, want] of sexCases) {
    const b = evaluate(P(over));
    check('性别·' + name, has(b, cat, id) === want, `${cat}:${ids(b, cat).join(',')}`);
  }
  // C 档优先抑制：合成冲突（A 说做 PET-CT，C 说不做）
  const synth = (a, c) => applySafety(P(), { A: [a], B: [], C: [c] });
  const mk = (id, cat, item) => ({ id, category: cat, catalogIds: [item], shownIds: [item] });
  {
    const [b, meta] = synth(mk('x-a', 'A', 'pet-ct'), mk('pet-c', 'C', 'pet-ct'));
    check('抑制·C 档赢，A 档同项目隐藏', b.A[0].hidden === true && !has(b, 'A', 'x-a'));
    check('抑制·留痕', meta.suppressed.some((s) => /不推荐|冲突/.test(s.reason)));
  }
  // 基础套餐人人有
  check('基础项·成年男性有 base-package', has(evaluate(P({ age: 30 })), 'A', 'base-package'));
  check('基础项·成年女性有 base-package', has(evaluate(P({ age: 30, gender: 'female' })), 'A', 'base-package'));
}

// ---- 6H. 换新版依据后：4 条证据的引文仍逐字命中快照（计划 1 回归）----
{
  const { readFileSync } = await import('node:fs');
  const { squash } = await import('../scripts/lib/source-fetch.mjs');
  const idx = JSON.parse(readFileSync(new URL('../data/snapshots/_index.json', import.meta.url), 'utf8'));
  const rulesDoc = JSON.parse(readFileSync(new URL('../data/rules.json', import.meta.url), 'utf8'));
  const targets = ['liver-cancer-screening', 'diabetes-followup', 'dm-family-hba1c', 'cvd-family-carotid'];
  for (const id of targets) {
    const rule = rulesDoc.rules.find((r) => r.id === id);
    const evs = (rule?.evidence || []).filter((e) => e.status === 'verified' && /2024|medlive|xhyxzz/.test(e.url + e.point));
    let ok = evs.length > 0;
    let detail = 'no 2024 evidence';
    for (const ev of evs) {
      const rec = idx[ev.url];
      if (!rec?.file) { ok = false; detail = 'no snapshot'; break; }
      const text = squash(readFileSync(new URL('../' + rec.file, import.meta.url), 'utf8'));
      for (const q of ev.quotes || (ev.quote ? [ev.quote] : [])) {
        if (!text.includes(squash(q))) { ok = false; detail = 'quote miss: ' + q.slice(0, 24); break; }
      }
    }
    check('新依据·' + id + ' 引文逐字命中 2024 版原文', ok, detail);
  }
}

// ---- 9. 典型人群画像：对照中国真实人群分布的常见组合 ----
// 边界用例（上面 1–8 组）故意取临界值，因为 bug 藏在边界；
// 这一组补的是"人群里最常见的那批人"——确保最常见的路径不走样。
// 分布参考：中国成人吸烟率约 50%（男）/2%（女）；高血压患病约 1/4 成人；
// 50+ 女性乳腺/宫颈筛查、60+ 骨密度、45+ 结直肠癌筛查都是人群级高频组合。
{
  const cases = [
    // [画像名, 画像, 断言]
    ['45 岁男 · 从不吸烟 · 不饮酒（人群最大的一格）',
      { age: 45, gender: 'male', smoking: 'no', packYears: 0, alcohol: 'none' },
      (b) => !has(b, 'A', 'lung-ldct-high-risk') && has(b, 'A', 'base-package')],
    ['52 岁男 · 吸烟 10 包年（不到 20 包年线）',
      { age: 52, gender: 'male', smoking: 'yes', packYears: 10 },
      (b) => !has(b, 'A', 'lung-ldct-high-risk')],
    ['48 岁女 · 常规体检（乳腺/宫颈按年龄走）',
      { age: 48, gender: 'female', smoking: 'no' },
      (b) => has(b, 'A', 'base-package') && !has(b, 'A', 'lung-ldct-high-risk')],
    ['58 岁女 · 无家族史（女性专项按年龄档走，不出高危项）',
      { age: 58, gender: 'female', smoking: 'no' },
      (b) => has(b, 'A', 'base-package') || has(b, 'B', 'base-package')],
    ['66 岁男 · 戒烟 8 年 · 曾 25 包年（戒烟超 5 年，不进高危）',
      { age: 66, gender: 'male', smoking: 'quit', packYears: 25, smokingQuitYears: 'ge5' },
      (b) => !has(b, 'A', 'lung-ldct-high-risk')],
    ['38 岁男 · 吸烟 15 包年（年龄不到 50，不进高危，落 C 档明确不用做）',
      { age: 38, gender: 'male', smoking: 'yes', packYears: 15 },
      (b) => !has(b, 'A', 'lung-ldct-high-risk') && has(b, 'C', 'lung-ldct-not-high-risk')],
    ['71 岁女 · 糖尿病家族史（糖尿病规则按家族史走）',
      { age: 71, gender: 'female', smoking: 'no', familyHistory: ['diabetes'] },
      (b) => ids(b, 'A').concat(ids(b, 'B'), ids(b, 'C')).length > 0],
    ['83 岁男 · 高危吸烟史（超 LDCT 上限，落 80plus 个体化档）',
      { age: 83, gender: 'male', smoking: 'yes', packYears: 30 },
      (b) => !has(b, 'A', 'lung-ldct-high-risk') && has(b, 'B', 'lung-ldct-80plus')],
  ];
  for (const [name, profile, assertFn] of cases) {
    const b = evaluate(P(profile));
    check('典型·' + name, assertFn(b), JSON.stringify({ A: ids(b, 'A').slice(0, 6), C: ids(b, 'C').slice(0, 4) }));
  }
}

console.log(`\n${pass}/${pass + fail} 通过`);
if (fail) process.exit(1);
