#!/usr/bin/env node
/**
 * 「同一个检查项不许在一份清单里出现两次」——他亲自抓过的那个 bug 的守卫。
 *
 * 老板 2026-11-21 的备注：「还有没有其他检查项会出现类似的问题，全面排查并解决。」
 * 排查结论：52 个检查项里，14 个被多条规则引用，但其中 12 个靠年龄带／风险分层天然互斥；
 * 真正会同时命中的只有 2 处（便潜血：基础套餐 × 结直肠；腹部超声：基础套餐 × 肝癌）。
 *
 * 这个脚本不复述结论，而是**直接跑真引擎**：随机造画像 → 看这份清单里到底有没有重复项。
 * 抽样是固定种子的，所以今天绿、明天也绿；要是谁改了规则把重复带回来，这一跑就红。
 *
 * 另外钉一条反向的：合并不能把东西弄丢 ——
 * 凡是被某条规则声明、又确实命中的项目，必须出现在某条可见规则的 shownIds 里。
 *
 * 用法：node scripts/check-dupes.mjs [样本数]
 */
import { readFileSync } from 'node:fs';
import { evaluate } from '../src/engine.js';

const N = Number(process.argv[2]) || 8000;

/** 固定种子随机（mulberry32）：同样的输入永远给同样的样本 */
const rnd = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const R = rnd(20261121);
const pick = (a) => a[Math.floor(R() * a.length)];
const chance = (p) => R() < p;

const AGES = [18, 25, 30, 35, 39, 40, 44, 45, 49, 50, 54, 55, 59, 60, 64, 65, 69, 70, 74, 75, 76, 79, 80, 85];
const FAM = ['colorectal', 'stomach', 'lung', 'liver', 'breast', 'ovarian', 'prostate', 'thyroid'];
const PAST = ['hbv', 'cirrhosis', 'chronicGastric', 'chronicLung', 'diabetes', 'hypertension', 'cvd', 'dementia', 'cancer'];

const gen = () => {
  const smoking = pick(['never', 'former', 'current', 'unknown']);
  const p = {
    age: pick(AGES),
    gender: chance() ? 'male' : 'female',
    pregnant: 'no',
    smoking,
    packYears: (smoking === 'former' || smoking === 'current') ? pick([0, 5, 10, 19, 20, 29, 30, 40]) : 0,
    secondhand: pick(['yes', 'no', 'unknown']),
    alcohol: pick(['none', 'light', 'moderate', 'heavy', 'unknown']),
    cookingOilFume: pick(['yes', 'no', 'unknown']),
    bmiLevel: pick(['under', 'normal', 'over', 'obese', 'unknown']),
    occupationDust: pick(['yes', 'no', 'unknown']),
    occupationTypes: [],
    province: '',
    familyHistory: FAM.filter(() => chance(0.16)),
    pastHistory: PAST.filter(() => chance(0.18)),
    hpStatus: pick(['positive', 'negative', 'unknown']),
    fallHistory: pick(['yes', 'no', 'unknown']),
    gaitDifficulty: pick(['yes', 'no', 'unknown']),
    memoryConcern: pick(['yes', 'no', 'unknown']),
  };
  if (p.age < 60) { p.fallHistory = 'unknown'; p.gaitDifficulty = 'unknown'; }
  return p;
};

const catalog = JSON.parse(readFileSync('data/catalog.json', 'utf8')).items;
const byId = new Map(catalog.map((i) => [i.id, i]));
const canon = (id) => byId.get(id)?.sameAs || id;
const nameOf = (id) => byId.get(id)?.name || id;

const dupCases = [];
const lostCases = [];
for (let n = 0; n < N; n++) {
  const p = gen();
  const b = evaluate(p);
  const seen = new Map();   // canon id → [ruleId...]
  const shownByAny = new Set();
  let declared = 0;

  for (const key of ['A', 'B', 'C']) {
    for (const rule of b[key]) {
      if (rule.hidden) continue;
      for (const id of rule.shownIds || []) {
        const c = canon(id);
        shownByAny.add(c);
        if (!seen.has(c)) seen.set(c, []);
        seen.get(c).push(rule.id);
      }
    }
  }
  // 命中过的规则声明了什么，就该在某处出现（除非被同名别名或上游认领——那也算出现过）
  for (const key of ['A', 'B', 'C']) {
    for (const rule of b[key]) {
      /* 2026-11-24：临床安全层会出于明确理由隐藏整张卡（LDCT 不够高危、
       * 症状/衰弱闸、C 档抑制）。这是有意不展示，不是"合并把项目弄丢了"。
       * 只有没有 suppressedBy 的 hidden（老链路的上游认领）才继续查有没有去处。 */
      if (rule.hidden && rule.suppressedBy) continue;
      for (const id of rule.catalogIds || []) {
        declared++;
        if (!shownByAny.has(canon(id))) lostCases.push({ p, rule: rule.id, id });
      }
    }
  }
  const dups = [...seen.entries()].filter(([, v]) => v.length > 1);
  if (dups.length) dupCases.push({ p, dups: dups.map(([id, v]) => `${nameOf(id)} ← ${v.join(' + ')}`) });
}

const out = [];
const ok = (m, x = '') => out.push(`ok   ${m}${x ? ' — ' + x : ''}`);
const bad = (m, x = '') => out.push(`FAIL ${m}${x ? ' — ' + x : ''}`);

dupsCheck: {
  if (dupCases.length) {
    bad(`同一项在一份清单里只出现一次`, `${dupCases.length}/${N} 份画像有重复，例：${dupCases[0].dups.join('；')}`);
    console.log(JSON.stringify(dupCases[0].p));
  } else {
    ok('同一项在一份清单里只出现一次', `${N} 份随机画像，0 份重复`);
  }
}
if (lostCases.length) {
  const c = lostCases[0];
  bad('合并没有把项目弄丢（声明过又命中的，必须有地方展示）', `${lostCases.length} 处，例：${c.rule} 的 ${nameOf(c.id)}`);
} else {
  ok('合并没有把项目弄丢');
}

console.log(out.join('\n'));
const failed = out.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${out.length - failed}/${out.length} 通过`);
process.exit(failed ? 1 : 0);
