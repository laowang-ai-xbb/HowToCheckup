#!/usr/bin/env node
/**
 * 偏向账本的单测（不联网、不写盘）。
 *
 * 为什么值得单测：这套东西的价值全在"原文一改就红"。它坏掉的方式很安静 ——
 * 指纹算法把 org/year 也算进去，哪天我把 evText 的字段改掉，账本还是能对上，
 * 只是从此对"原文变了"不再敏感：一条永远通过的巡检比没有巡检更糟。
 * 所以这里直接造四种情况，要求 compare 各自报对。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { basisOf, compare, rebase, leanRules } from '../scripts/lib/lean-basis.mjs';

const rules = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'data', 'rules.json'), 'utf8')).rules;
const clone = (x) => JSON.parse(JSON.stringify(x));

let pass = 0;
const fails = [];
const ok = (m) => { pass++; console.log('ok   ' + m); };
const bad = (m) => { fails.push(m); console.log('FAIL ' + m); };

/* ---- 1. 干净账本：全对上 ---- */
const basis = { rules: rebase(rules) };
compare(rules, basis).length === 0
  ? ok(`刚登记的账本零差异（${leanRules(rules).length} 条偏向）`)
  : bad(`刚登记的账本就有差异：${JSON.stringify(compare(rules, basis)).slice(0, 120)}`);

/* ---- 2. 原文改一个字 → stale（这是这套东西存在的唯一理由） ---- */
{
  const r = clone(rules);
  const t = leanRules(r).find((x) => (x.evidence?.[0]?.quotes || []).length);
  t.evidence[0].quotes[0] += '。';
  const d = compare(r, basis);
  d.length === 1 && d[0].id === t.id && d[0].kind === 'stale'
    ? ok('把一条原文摘录改一个字 → 报 stale（依据变了，偏向要复核）')
    : bad(`改原文应该只报一条 stale，实际：${JSON.stringify(d).slice(0, 160)}`);
}

/* ---- 3. 只改偏向值 → drifted（不是 stale：原文没变，是人改了嘴） ---- */
{
  const r = clone(rules);
  const t = leanRules(r)[0];
  t.lean = t.lean === 'for' ? 'against' : 'for';
  const d = compare(r, basis);
  d.length === 1 && d[0].kind === 'drifted'
    ? ok('偷偷改偏向值 → 报 drifted（改了没留痕）')
    : bad(`改偏向应该只报一条 drifted，实际：${JSON.stringify(d).slice(0, 160)}`);
}

/* ---- 4. 新加一条带偏向的规则 → missing；删掉一条 → gone ---- */
{
  const r = clone(rules);
  const t = leanRules(r)[0];
  const copy = { ...clone(t), id: 'unit-test-new-rule' };
  r.push(copy);
  const d1 = compare(r, basis);
  d1.length === 1 && d1[0].kind === 'missing'
    ? ok('新增带偏向的规则 → 报 missing（必须先登记）')
    : bad(`新增规则应该报 missing，实际：${JSON.stringify(d1).slice(0, 160)}`);

  const r2 = rules.filter((x) => x.id !== leanRules(rules)[0].id);
  const d2 = compare(r2, basis);
  d2.length === 1 && d2[0].kind === 'gone'
    ? ok('删掉一条带偏向的规则 → 报 gone（账上不许留孤儿）')
    : bad(`删规则应该报 gone，实际：${JSON.stringify(d2).slice(0, 160)}`);
}

/* ---- 5. 指纹只认原文：核过一遍（改 status / checkedAt）不该触发复核 ---- */
{
  const r = clone(rules);
  const t = leanRules(r).find((x) => x.evidence?.[0]);
  t.evidence[0].status = 'verified';
  t.evidence[0].checkedAt = '2099-01-01';
  basisOf(t) === basisOf(leanRules(rules).find((x) => x.id === t.id))
    ? ok('重新核一遍（status / checkedAt 变）不触发偏向复核')
    : bad('status / checkedAt 被算进了指纹 —— 每跑一次巡检都会红，很快就没人看了');
}

console.log(`\n${pass}/${pass + fails.length} 通过`);
if (fails.length) process.exit(1);
