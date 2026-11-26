#!/usr/bin/env node
/**
 * 老年人那三题的守卫。
 *
 * 为什么单独测：
 *   这三题是唯一"按年龄动态出现"的题目，而且是唯一不进 A/B/C 判定的输入。
 *   出错的两种方式都很安静：该出现时没出现（老人拿不到转诊卡）、
 *   不该出现时出现了（59 岁的人被问"最近摔过吗"，莫名其妙）。
 *   两种都不会报错，只会让人困惑 —— 所以用断言钉住。
 */
import { activeQuestions, questions } from '../src/questions.js';
import { referrals } from '../src/referral.js';
import { emptyProfile, redFlagHits } from '../src/engine.js';
import { readFileSync } from 'node:fs';

const SENSORY = ['fallHistory', 'gaitDifficulty', 'memoryConcern'];
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name} — ${detail}`); }
};

const keysAt = (age) => new Set(activeQuestions({ ...emptyProfile(), age, gender: 'male' }).map((q) => q.key));
const femaleKeysAt = (age) => new Set(activeQuestions({ ...emptyProfile(), age, gender: 'female' }).map((q) => q.key));

/* 备孕题的年龄边界：WHO 育龄妇女 15–49；50+ 不再常规问，
 * 但结果页另有孕产兜底，不等于生理上绝对不可能。 */
check('49 岁女性仍问备孕题', femaleKeysAt(49).has('pregnant'));
check('50 岁女性不再问备孕题', !femaleKeysAt(50).has('pregnant'));
check('78 岁女性不再问备孕题', !femaleKeysAt(78).has('pregnant'));
check('男性任何年龄都不问备孕题', !keysAt(40).has('pregnant') && !keysAt(78).has('pregnant'));

check('59 岁不问这三题', SENSORY.every((k) => !keysAt(59).has(k)), [...keysAt(59)].join(','));
check('60 岁开始问这三题', SENSORY.every((k) => keysAt(60).has(k)), [...keysAt(60)].join(','));
check('80 岁仍然问', SENSORY.every((k) => keysAt(80).has(k)));

// 题量基准：首页不再显示「还剩 N 题」（老板第 10 条要求隐藏），但题量本身仍是设计基准，
// 60 岁以上多出的三题会直接影响答题时长，所以这两条留着守住。
/* 合并后题量（2026-11-26）：分叉点 10 题 + 症状闸 +1 + 红旗题 +1 + 既往检查史 +1 = 13 题（59 岁，不含年龄）。
 * 60 岁起再加感官三题，差值 +3 不变。 */
check('59 岁不含年龄共 13 题', keysAt(59).size - 1 === 13, String(keysAt(59).size - 1));
check('60 岁起多 3 题', keysAt(60).size - keysAt(59).size === 3, String(keysAt(60).size - keysAt(59).size));

/* 筛查前提与暴露年限：只在真正需要时展开，避免一上来多一堆题 */
check('49 岁不问症状闸', !keysAt(49).has('symptomFlags'));
check('50 岁问症状闸', keysAt(50).has('symptomFlags'));
check('红旗症状所有年龄都问', keysAt(30).has('redFlags') && keysAt(70).has('redFlags'));
check('69 岁不问衰弱闸', !keysAt(69).has('frailty') && !keysAt(69).has('recentHospital'));
check('70 岁问衰弱闸', keysAt(70).has('frailty') && keysAt(70).has('recentHospital'));
const withQuit = new Set(activeQuestions({ ...emptyProfile(), age: 55, gender: 'male', smoking: 'quit' }).map((q) => q.key));
check('只有戒烟者才问戒烟年限', withQuit.has('smokingQuitYears') && !keysAt(55).has('smokingQuitYears'));
const withSH = new Set(activeQuestions({ ...emptyProfile(), age: 55, gender: 'male', secondhand: 'yes' }).map((q) => q.key));
check('只有二手烟"是"才问年限', withSH.has('secondhandYears') && !keysAt(55).has('secondhandYears'));
const withOcc = new Set(activeQuestions({ ...emptyProfile(), age: 55, gender: 'male', occupationDust: 'yes' }).map((q) => q.key));
check('只有职业暴露"是"才问种类与年限', withOcc.has('occupationAgents') && withOcc.has('occupationYears'));

/* 既往检查史（P0-2/P1-10）：和幽门螺杆菌那题一起构成"以前查过什么"。
 * 它不参与 A/B/C 判定，只在卡片上提示"最近做过"，所以这里守三件事：
 *   题目存在、可选可跳过、值都是 schema 登记过的。 */
check('有既往检查史这道题', keysAt(59).has('recentChecks'));
const rcQ = questions.find((q) => q.key === 'recentChecks');
check('既往检查史是可选的多选题', !!rcQ && rcQ.kind === 'multi' && rcQ.optional === true);
check('既往检查史给了「都没做过」和「记不清」两个出口',
  !!rcQ && /都没做过/.test(rcQ.noneLabel || '') && /记不清/.test(rcQ.unknownLabel || ''));
const rcSchema = JSON.parse(readFileSync('data/inputs.schema.json', 'utf8')).fields.recentChecks;
check('既往检查史的每个选项都在 schema 里登记',
  !!rcSchema && rcQ.options.every((o) => rcSchema.items.includes(o.v)),
  rcQ ? rcQ.options.map((o) => o.v).join(',') : 'no question');
check('既往检查史明确不改档位（informationalOnly）', rcSchema?.informationalOnly === true);

const pk = new Set(questions.map((q) => q.key));
check('三题都在 questions 里', SENSORY.every((k) => pk.has(k)));

/* 家族史里的痴呆项：3B 风险提示的触发入口。
 * 忘了放进选项，结果页代码写得再对也永远不会出现，所以单独钉住。 */
const famQ = questions.find((q) => q.key === 'familyHistory');
check('家族史能选阿尔茨海默病 / 其他痴呆', !!famQ && famQ.options.some((o) => o.v === 'dementia'));

// 转诊卡：只有 60 岁以上、且答"有"才出
const card = (p) => referrals({ ...emptyProfile(), age: 68, gender: 'female', ...p });
check('60 岁以下一律不出卡', referrals({ ...emptyProfile(), age: 59, gender: 'male', fallHistory: 'yes' }).length === 0);
check('三个都答"有"出三张卡', card({ fallHistory: 'yes', gaitDifficulty: 'yes', memoryConcern: 'yes' }).length === 3);
check('都答"没有"不出卡', card({ fallHistory: 'no', gaitDifficulty: 'no', memoryConcern: 'no' }).length === 0);
check('答"记不清"不出卡（不确定不等于有）', card({ fallHistory: 'unknown' }).length === 0);
check('每张卡都有科室', card({ fallHistory: 'yes', gaitDifficulty: 'yes', memoryConcern: 'yes' }).every((c) => c.dept && c.dept.length > 3));

// 文案长度：卡片超过四行，60 岁以上的人就不看了
const long = card({ fallHistory: 'yes', gaitDifficulty: 'yes', memoryConcern: 'yes' }).filter((c) => c.why.length > 22);
check('卡片说明都控制在 22 字内', long.length === 0, long.map((c) => c.why).join(' / '));

// 疫苗数据：不能出现价格和品牌
const vac = JSON.parse(readFileSync(new URL('../data/vaccines.json', import.meta.url), 'utf8'));const vacText = JSON.stringify(vac.vaccines);
check('疫苗数据里不写价格', !/¥|元\/剂|价格|售价/.test(vacText));
check('每支疫苗都有依据链接', vac.vaccines.every((v) => /^https?:\/\//.test(v.source?.url || '')));
check('每支疫苗都有剂量说明', vac.vaccines.every((v) => v.dose && v.dose.length > 2));

/* ---- 分享链接的往返：能选出来的，必须能带出去 ----
 * 白名单原来手抄在 share.js 里，已经漂移过两次（家族史的糖尿病 / 早发心梗、
 * 既往史的阿尔茨海默病）。症状是"能填、能看到结果、发给家人就没了"，
 * 页面上一点错都不报。彩蛋那条最狠：它只认阿尔茨海默病，被洗掉之后，
 * 别人发来的链接永远触发不了彩蛋。所以这里逐题、逐选项跑一遍往返。 */
const { sanitizeProfile } = await import('../src/share.js');
const roundTripBad = [];
for (const q of questions) {
  if (q.kind === 'body' || q.kind === 'age') continue;   // 数值题在 body-unit 里单独测
  for (const o of q.options || []) {
    const raw = { age: 40, gender: 'male', [q.key]: q.kind === 'multi' ? [o.v] : o.v };
    const got = sanitizeProfile(raw)?.[q.key];
    const ok = q.kind === 'multi'
      ? Array.isArray(got) && got.includes(o.v)
      : got === o.v;
    if (!ok) roundTripBad.push(`${q.key}=${o.v}`);
  }
}
check('每个选项都能过一遍分享链接（白名单不许漏项）', roundTripBad.length === 0, roundTripBad.join(' / '));

/* encode 侧守护（2026-11-25 根因修复）：cookingOilFume 曾被 KEEP 手工白名单漏掉，
 * 结果页油烟提醒"有时出现有时消失"。decode 侧由 questions 自动生成没有这个问题，
 * 所以 round-trip 测试抓不到 —— 只有核对"编码白名单"才能堵住。
 * 语义已翻转：默认全带，剔除必须登记进 EXCLUDE_FROM_LINK 并写理由。 */
{
  const { LINK_KEEP, LINK_EXCLUDE } = await import('../src/share.js');
  const keep = new Set(LINK_KEEP);
  const excl = new Set(Object.keys(LINK_EXCLUDE || {}));
  const missing = questions
    .filter((q) => q.kind !== 'body' && q.kind !== 'age')
    .filter((q) => !keep.has(q.key) && !excl.has(q.key))
    .map((q) => q.key);
  check('问卷每个字段都被链接白名单覆盖（KEEP ∪ EXCLUDE，不许漏）', missing.length === 0, missing.join(','));
  const unregistered = Object.keys(LINK_EXCLUDE || {}).filter((k) => !questions.some((q) => q.key === k));
  check('EXCLUDE 登记的字段必须真实存在于问卷（防手滑删题后留下幽灵登记）', unregistered.length === 0, unregistered.join(','));
}

/* 红旗症状（P0-1）：安全分流，不改 A/B/C。钉住四条边界，防误改：
 *   ① 题目在、是可选多选、8 项、有"都没有/说不清"两个出口；
 *   ② 急诊三项、门诊五项分组正确；
 *   ③ "说不清"不触发任何警告（不知道不等于没有）；
 *   ④ 65+ 老 weightLoss 题答 ge5 → 门诊体重条命中，且不重复。 */
const rfQ2 = questions.find((q) => q.key === 'redFlags');
check('红旗是可选多选、8 个症状', !!rfQ2 && rfQ2.kind === 'multi' && rfQ2.optional === true && rfQ2.options.length === 8);
check('红旗有「这些都没有」和「说不清」两个出口',
  !!rfQ2 && rfQ2.noneLabel === '这些都没有' && rfQ2.unknownLabel === '说不清');
check('红旗 3 急诊 + 5 门诊',
  rfQ2 && rfQ2.options.filter((o) => o.tone === 'emergency').length === 3
  && rfQ2.options.filter((o) => o.tone === 'clinic').length === 5);
const p1 = { ...emptyProfile(), redFlags: ['stroke', 'bloodInStool'] };
const h1 = redFlagHits(p1);
check('急诊+门诊分别命中', h1.emergency.length === 1 && h1.clinic.length === 1);
check('「说不清」不触发任何警告',
  redFlagHits({ ...emptyProfile(), redFlags: 'unknown' }).emergency.length === 0
  && redFlagHits({ ...emptyProfile(), redFlags: 'unknown' }).clinic.length === 0);
const hLink = redFlagHits({ ...emptyProfile(), age: 70, weightLoss: 'ge5', redFlags: ['weightLoss'] });
check('掉体重联动只出一条，不重复', hLink.clinic.filter((x) => x.v === 'weightLoss').length === 1);
// 症状属隐私，绝不进分享链接白名单——直接看链接里编码了哪些字段。
const { encodeProfile } = await import('../src/share.js');
const rawCode = encodeProfile(p1);
const rawJson = JSON.parse(Buffer.from(rawCode.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
check('症状不进分享链接（隐私）', !('redFlags' in rawJson), Object.keys(rawJson).join(','));

console.log(`\n${pass}/${pass + fail} 通过`);
if (fail) process.exit(1);
