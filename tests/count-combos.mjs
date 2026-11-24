#!/usr/bin/env node
/**
 * 组合规模实测：到底有多少种互不相同的体检结论清单。
 *
 * 为什么需要它：讨论"要不要给某个组合单独做个页面"时，必须知道组合数是几百还是几十万。
 * 空口说数字不可验证。
 *
 * 两个口径，分开报，不混着说：
 *   1) 理论输入组合 = 所有选项全排列（只作量级参照，绝大多数组合结论相同）
 *   2) 结论种类 = 在大规模抽样上实测去重得到的"下界"；配合年龄分局的精确证明
 *
 * 用法：node tests/count-combos.mjs [--samples 3000000]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { match } from '../scripts/lib/match.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const rules = load('data/rules.json').rules;
const inputs = load('data/inputs.schema.json');
const AGE_MIN = inputs.fields.age?.min ?? 18;
const AGE_MAX = inputs.fields.age?.max ?? 100;
const argN = Number(process.argv[process.argv.indexOf('--samples') + 1]) || 1_000_000;

// ---------- 理论输入规模 ----------
let theoretical = AGE_MAX - AGE_MIN + 1;
for (const [name, def] of Object.entries(inputs.fields)) {
  if (name === 'age') continue;
  if (def.type === 'enum') theoretical *= def.values.length;
  else if (def.type === 'array') theoretical *= 2 ** (def.items?.length ?? 0);
}

// ---------- 1. 年龄分局：精确 ----------
const collectAge = (w, out = []) => {
  for (const [k, v] of Object.entries(w || {})) {
    if (k === 'ageMin') out.push(v);
    else if (k === 'ageMax') out.push(v + 1);
    else if (['any', 'all', 'none'].includes(k)) v.forEach((c) => collectAge(c, out));
  }
  return out;
};
const cutSet = new Set([AGE_MIN]);
for (const r of rules) for (const t of collectAge(r.when)) if (t > AGE_MIN && t <= AGE_MAX) cutSet.add(t);
const cuts = [...cutSet].sort((a, b) => a - b);

const zeroRisk = (age) => ({
  age, gender: 'male', smoking: 'no', packYears: 0, secondhand: 'no', alcohol: 'none',
  occupationDust: 'no', hpStatus: 'negative', familyHistory: [], pastHistory: [], pregnant: 'no',
});
const sigOf = (p) => {
  const A = [], B = [], C = [];
  for (const r of rules) if (match(r.when, p)) (r.category === 'A' ? A : r.category === 'B' ? B : C).push(r.id);
  return `A:${A.sort().join(',')}|B:${B.sort().join(',')}|C:${C.sort().join(',')}`;
};

let regimeBreaking = 0;
for (let i = 0; i < cuts.length; i++) {
  const to = i + 1 < cuts.length ? cuts[i + 1] - 1 : AGE_MAX;
  const ref = sigOf(zeroRisk(cuts[i]));
  for (let a = cuts[i] + 1; a <= to; a++) if (sigOf(zeroRisk(a)) !== ref) { regimeBreaking++; break; }
}

// ---------- 2. 全维度随机抽样（下界） ----------
const opt = (def, rnd) => def.values[Math.floor(rnd() * def.values.length)];
const subset = (items, rnd) => items.filter(() => rnd() < 0.5);
const famItems = inputs.fields.familyHistory.items;
const pastItems = inputs.fields.pastHistory.items;

let seed = 20261118;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

const signatures = new Set();
const hitCount = new Map(rules.map((r) => [r.id, 0]));
for (let i = 0; i < argN; i++) {
  const age = AGE_MIN + Math.floor(rnd() * (AGE_MAX - AGE_MIN + 1));
  const p = {
    age,
    gender: rnd() < 0.5 ? 'male' : 'female',
    pregnant: rnd() < 0.1 ? 'yes' : 'no',
    smoking: opt(inputs.fields.smoking, rnd),
    packYears: rnd() < 0.25 ? 25 : 0,
    secondhand: opt(inputs.fields.secondhand, rnd),
    alcohol: opt(inputs.fields.alcohol, rnd),
    occupationDust: opt(inputs.fields.occupationDust, rnd),
    hpStatus: opt(inputs.fields.hpStatus, rnd),
    familyHistory: subset(famItems, rnd),
    pastHistory: subset(pastItems, rnd),
  };
  const A = [], B = [], C = [];
  for (const r of rules) {
    if (!match(r.when, p)) continue;
    hitCount.set(r.id, hitCount.get(r.id) + 1);
    (r.category === 'A' ? A : r.category === 'B' ? B : C).push(r.id);
  }
  signatures.add(`A:${A.sort().join(',')}|B:${B.sort().join(',')}|C:${C.sort().join(',')}`);
}

console.log('==== 组合规模实测 ====');
console.log(`理论输入组合（所有选项全排列，仅作量级参照）：${theoretical.toExponential(2)}`);
console.log(`年龄结论分局（规则阈值自动推出）：${cuts.length} 个，切点 ${cuts.join(', ')}`);
console.log(`分局内逐岁一致性：${regimeBreaking === 0 ? '通过（每局内所有年龄结论完全相同）' : `失败（${regimeBreaking} 处）`}`);
console.log(`随机抽样：${argN.toLocaleString('en-US')} 个画像`);
console.log(`去重后的"结论清单"种类：${signatures.size.toLocaleString('en-US')} 种（下界）`);
console.log(`→ 数量级：约 ${Math.round(signatures.size / 500) * 500} 种，远小于理论组合`);

console.log(`\n规则活性（被触发的抽样占比）：`);
const never = [];
for (const r of rules) {
  const pct = (hitCount.get(r.id) / argN) * 100;
  if (pct === 0) never.push(r.id);
  if (pct < 0.2) console.log(`  ${pct === 0 ? '死规则' : '极少 '} ${r.id.padEnd(38)} ${pct.toFixed(3)}%`);
}
if (!never.length) console.log('  （死规则 0 条）');
