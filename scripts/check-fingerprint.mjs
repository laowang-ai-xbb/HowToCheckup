#!/usr/bin/env node
/**
 * 指纹校验：确认构建标识真的进了产物。
 *
 * 为什么需要这一条：指纹只有「被编进 dist」才有用。一旦有人重构 main.js 时
 * 顺手删掉那一行，产物里就没有标识了 —— 页面照常工作，测试全绿，
 * 等到真要证明"这份代码是我写的"那天才发现没留下来。
 *
 * 用法：node scripts/check-fingerprint.mjs（dist 不存在时只校验源码，不报错）
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const out = [];
const ok = (n, x = '') => out.push(`ok   ${n}${x ? ' — ' + x : ''}`);
const bad = (n, x = '') => out.push(`FAIL ${n}${x ? ' — ' + x : ''}`);

const fp = JSON.parse(readFileSync('data/fingerprint.json', 'utf8'));
const main = readFileSync('src/main.js', 'utf8');

if (!/^tjzn-\d{4}-\d{2}-\d{2}-[0-9a-f]{6}$/.test(fp.id || '')) bad('fingerprint.json 的 id 格式', fp.id);
else ok('fingerprint.json 的 id 格式', fp.id);

if (!/import fp from '\.\.\/data\/fingerprint\.json'/.test(main)) bad('main.js 没有引入 fingerprint.json');
else ok('main.js 引入了 fingerprint.json');

if (!/dataset\.v = fp\.id/.test(main)) bad('main.js 没有把 id 写进 html[data-v]');
else ok('main.js 把 id 写进 html[data-v]');

const canaries = fp.canaries || [];
if (canaries.length < 3) bad('埋点少于 3 处', String(canaries.length));
else ok('埋点登记齐全', `${canaries.length} 处`);

/* dist 不存在（还没构建）就跳过产物校验 —— 这不是失败，是"还没到那一步" */
const dir = 'dist/assets';
if (!existsSync(dir)) {
  ok('产物校验', 'dist 还没构建，跳过');
} else {
  const js = readdirSync(dir).filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  if (!js.includes(fp.id)) bad('构建产物里找不到构建标识', fp.id);
  else ok('构建产物里能找到构建标识', fp.id);
}

console.log(out.join('\n'));
const failed = out.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${out.length - failed}/${out.length} 通过`);
if (failed) process.exit(1);
