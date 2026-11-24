#!/usr/bin/env node
/**
 * 偏向的"依据指纹"巡检。
 *
 * 用法：
 *   npm run check:lean           只看，不改。有差异就退出码 1。
 *   npm run accept:lean          人读过原文、改完 lean/leanNote 之后，重新登记指纹。
 *
 * 它回答的是老板问的那句「有新指南出来了，偏向会自动改吗」：
 *   不会自动改值（B 档的偏向是判断，不是原文里的一句话，交给字符串匹配会改错 ——
 *   src/lib/lean-basis.mjs 开头写了为什么，21 条里 11 条会被改错）。
 *   但会自动发现：原文一变、或偏向被悄悄改过没留痕，这里立刻红。
 *
 * 为什么单独一个脚本、不进 check-invariants：不变量是纯函数（只看代码文本），
 * 这一条要拿账本对数据，还要能写文件。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { compare, rebase, leanRules } from './lib/lean-basis.mjs';

const ROOT = join(import.meta.dirname, '..');
const RULES = join(ROOT, 'data', 'rules.json');
const BASIS = join(ROOT, 'data', 'lean-basis.json');
const accept = process.argv.includes('--accept');

const rules = JSON.parse(readFileSync(RULES, 'utf8')).rules;
const basis = existsSync(BASIS)
  ? JSON.parse(readFileSync(BASIS, 'utf8'))
  : { version: 1, updatedAt: '', why: '', rules: {} };

if (accept) {
  const next = rebase(rules);
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(BASIS, JSON.stringify({
    version: 1,
    updatedAt: today,
    why: '偏向的账：每条带 lean 的规则，在它当次被复核时依据的证据原文指纹 + 当时的偏向。'
      + '指纹对不上 = 原文变了或偏向被改过，必须回去重读（npm run check:lean）。'
      + '重新登记只能是人真读过原文之后跑 npm run accept:lean，别在 CI 里跑。',
    rules: next,
  }, null, 2) + '\n', 'utf8');
  console.log(`已重新登记 ${Object.keys(next).length} 条偏向的依据指纹（${today}）`);
  process.exit(0);
}

const diffs = compare(rules, basis);
const WORD = {
  missing: '账上没有这条（新规则 / 或被删后又加回来）',
  stale: '依据原文变了 —— 偏向可能已经失效',
  drifted: '偏向值被改过，但没有登记复核',
  gone: '账上有、规则里没了',
};

if (!diffs.length) {
  console.log(`ok    ${leanRules(rules).length} 条偏向的依据都没变`);
  process.exit(0);
}

for (const d of diffs) {
  console.log(`FAIL ${d.id}：${WORD[d.kind] || d.kind}`);
  if (d.kind === 'stale') console.log(`     原指纹 ${d.was} → 现指纹 ${d.hash}`);
  if (d.kind === 'drifted') console.log(`     账上 ${d.was} → 现在 ${d.lean}`);
}

console.log(`
这 ${diffs.length} 条要人回来读一遍原文，不是可以点一下"忽略"的东西：
  1. 去 data/rules.json 找到这条规则，重读 evidence 里的原文摘录；
  2. 判断偏向还成不成立，不成立就改 lean / leanNote（为什么改，写进 leanNote）；
  3. 跑 npm run accept:lean 登记，这一步等于签字。
`);
process.exit(1);
