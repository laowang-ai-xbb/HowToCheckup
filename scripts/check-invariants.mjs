#!/usr/bin/env node
/**
 * 跑不变量清单。任何一条不通过，退出码非零。
 *
 * 用法：npm run check:invariants
 * 它和 validate.mjs 的分工：
 *   validate  查"数据对不对"（规则、证据、字段可达性）
 *   invariants 查"我们踩过的坑有没有被重新踩回去"（跨文件的约束）
 */
import { loadSources, runInvariants, INVARIANTS } from './lib/invariants.mjs';

const files = loadSources('.');
const results = runInvariants(files);

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  if (r.ok) console.log(`ok   ${r.id}`);
  else {
    console.log(`FAIL ${r.id}`);
    console.log(`     为什么重要：${r.why}`);
    console.log(`     问题：${r.msg}`);
  }
}

console.log(`\n${results.length - failed.length}/${results.length} 条不变量成立（共 ${INVARIANTS.length} 条）`);
if (failed.length) process.exit(1);
