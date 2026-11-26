#!/usr/bin/env node
/**
 * 依据页正文「可追溯」校验：reason 里出现的每个数字，都必须能在自己的证据里找到出处。
 *
 * 为什么要有这个（老板 2026-11-25 定的规矩）：
 *   依据页的正文（reason，界面上叫「这条检查是怎么回事」）是给人读的白话，
 *   此前是纯手写、没有任何机器校验——写错一个年龄、年限、百分比，系统不知道，
 *   直到用户发现才暴露。健康产品里这等于拿信任赌运气。
 *
 *   证据的原文摘录（quotes）已经有 validate.mjs 逐字对快照；但 reason 是"翻译+归纳"，
 *   不可能整段逐字命中。折中的硬约束是：**数字不许凭空来**。
 *   reason 里每一个数字（年龄、年数、发病率、百分比、年份），都必须能在
 *    ① 本规则 evidence 的 point / quotes / year / org / doc，或
 *    ② 这些 evidence 对应的原文快照全文
 *   里找到。找不到就报错——要么数字写错了，要么该补一条出处。
 *
 * 为什么语料要含快照全文：很多数字（如发病率 20/10 万、乙醇 50g/天）写在原文正文里，
 * 但没被摘进 quotes。只比 quotes 会误伤一堆正确的数字。快照全文才是真正的"出处"。
 *
 * 归一化与 validate.mjs 的 squash 同思路（删空白、全角折半、去千分位逗号），
 * 这里自带一份轻量实现，避免和 validate 的执行顺序耦合。
 *
 * 用法：node scripts/check-reason-source.mjs
 * 退出码：0 = 每个数字都有出处；1 = 有数字无处可查（必须修）
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

const rules = load('data/rules.json').rules;
let snapIndex = {};
try { snapIndex = load('data/snapshots/_index.json'); } catch { /* 没有快照索引时只用元数据，仍会显式报错 */ }

/** 全角数字/标点折半，删所有空白和常见千分位，保证"20/10 万"和"20/10万"能对上。 */
const norm = (s) => String(s ?? '')
  .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/[，,]/g, '')
  .replace(/\s+/g, '');

const snapCache = new Map();
const snapText = (url) => {
  if (snapCache.has(url)) return snapCache.get(url);
  const rec = snapIndex[url];
  let t = '';
  if (rec && rec.file) {
    const p = join(root, rec.file);
    if (existsSync(p)) {
      try { t = norm(readFileSync(p, 'utf8')); } catch { t = ''; }
    }
  }
  snapCache.set(url, t);
  return t;
};

let bad = 0;
let checked = 0;
let rulesWithNumber = 0;
const missing = [];

for (const rule of rules) {
  const reason = rule.reason || '';
  // 匹配整数与小数。年份（2025）、年龄（45）、年限（5）、百分比（60）、发病率（20/10万里的 20）都覆盖。
  const nums = [...new Set(reason.match(/\d+(?:\.\d+)?/g) || [])];
  if (!nums.length) continue;
  rulesWithNumber++;

  // 语料 = 证据元数据 + 每条证据的原文快照全文
  let corpus = '';
  for (const e of rule.evidence || []) {
    corpus += norm([e.point, e.year, e.org, e.doc, (e.quotes || (e.quote ? [e.quote] : [])).join('')].join(' '));
    corpus += snapText(e.url);
  }
  if (!corpus) {
    // 没有可用语料，reason 又写了数字 → 无法核验，按错误处理
    for (const n of nums) { checked++; missing.push(`${rule.id}：数字 ${n} 无证据语料可核验`); }
    bad += nums.length;
    continue;
  }

  for (const n of nums) {
    checked++;
    if (!corpus.includes(n)) missing.push(`${rule.id}：数字 ${n} 在证据里找不到 →「${reason.slice(0, 46)}…」`);
  }
}

for (const m of missing) console.log(`FAIL ${m}`);
const ok = checked - missing.length;
console.log(`\n依据页正文可追溯：${ok}/${checked} 个数字在证据/原文里可查（覆盖 ${rulesWithNumber}/${rules.length} 条正文）`);
console.log(missing.length
  ? `${missing.length} 个数字无处可查——数字写错，或需要补一条带出处的证据。`
  : '正文里的每个数字都有出处。');
process.exit(bad || missing.length ? 1 : 0);
