#!/usr/bin/env node
/**
 * 自动运营执行层：把巡检报告的结论变成程序动作（不需要人点确认）
 *
 * 干什么：
 *   1. 读 reports/updates.json；
 *   2. 交给 scripts/lib/auto-decide.mjs 出动作计划（纯函数，只降不升）；
 *   3. 按白名单改 rules.json / 线索队列；
 *   4. 跑 test:logic（除真浏览器外的全量门禁）；全绿才保留，失败自动回滚到改动前；
 *      —— 浏览器验收（check:ui）要另有 4173 preview 服务，由 workflow 单独一步跑；
 *         自动降级只改 evidence.status / reviewNote，不碰任何渲染代码，逻辑门禁足够兜底。
 *   5. 可选 --commit：测试通过后在 CI 里提交（本地默认不提交，方便先看 diff）。
 *
 * 安全边界（_ROOT CAUSE，不是打补丁）：
 *   - 机器只做"保守降级"：把 verified 降到 stale、把坏源记进队列。
 *     绝不升级、绝不改判定数字、绝不删依据 —— 判断错了方向也是安全的（少推荐，不多推）。
 *   - 白名单字段：执行层只写 auto-decide 声明的字段，其它一律不碰。
 *   - 幂等：重复跑不重复改；同一条降级已经 stale 且理由相同就跳过。
 *   - 门禁：npm test 不过就整份回滚，绝不留一个红的仓库在 main 上。
 *
 * 用法：
 *   node scripts/auto-apply.mjs                        # 本地演练：改文件+跑测试，不提交
 *   node scripts/auto-apply.mjs --report=x.json        # 指定报告
 *   node scripts/auto-apply.mjs --commit               # CI 用：全绿后提交
 *   node scripts/auto-apply.mjs --dry-run              # 只打印计划，不写任何文件
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { decide } from './lib/auto-decide.mjs';

const argv = process.argv.slice(2);
const reportPath = (argv.find((a) => a.startsWith('--report=')) || '').split('=')[1] || 'reports/updates.json';
const dryRun = argv.includes('--dry-run');
const doCommit = argv.includes('--commit');

const RULES = 'data/rules.json';
const BROKEN = 'data/broken-sources.json';
const RADAR = 'data/radar-queue.json';

if (!existsSync(reportPath)) {
  console.error(`没有报告 ${reportPath} —— 先跑 npm run check:updates -- --json=${reportPath}`);
  process.exit(1);
}
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const { actions, summary } = decide(report);

console.log(`自动运营：降级 ${summary.downgrade} / 坏源 ${summary.broken} / 新线索 ${summary.radar}`);
if (summary.noop) { console.log('没有需要处理的结论，收工（不产生空改动）。'); process.exit(0); }
if (dryRun) {
  console.log(JSON.stringify(actions, null, 2));
  process.exit(0);
}

/* ---------- 备份：任何改动前先留住原文件，失败整份回滚 ---------- */
const backups = new Map();
const backup = (path) => {
  if (backups.has(path)) return;
  backups.set(path, existsSync(path) ? readFileSync(path, 'utf8') : null);
};
const rollback = () => {
  for (const [path, orig] of backups) {
    if (orig === null) { try { rmSync(path); } catch { /* ignore */ } }
    else writeFileSync(path, orig, 'utf8');
  }
};

/* ---------- 1) 应用降级到 rules.json（严格白名单） ---------- */
backup(RULES);
const doc = JSON.parse(readFileSync(RULES, 'utf8'));
const rules = doc.rules || doc;
let changed = 0;
for (const a of actions.filter((x) => x.type === 'DOWNGRADE_EVIDENCE')) {
  const rule = rules.find((r) => r.id === a.ruleId);
  if (!rule) continue;
  const evs = (rule.evidence || []).filter((e) => e.url === a.url);
  for (const ev of evs) {
    // 铁律：只降不升。已经不是 verified 的（含 stale/pending）不重复写。
    if (ev.status !== 'verified') continue;
    for (const [k, v] of Object.entries(a.fields)) {
      // 白名单兜底：decide 万一多给了字段，这里也只认这三个
      if (k === 'status' || k === 'reviewNote' || k === 'checkedAt') ev[k] = v;
    }
    changed++;
  }
}
if (changed) writeFileSync(RULES, JSON.stringify(doc, null, 2) + '\n', 'utf8');

/* ---------- 2) 坏源 / 新线索：追加到 JSON 队列，幂等去重 ---------- */
const appendQueue = (path, keyFn, items) => {
  if (!items.length) return 0;
  backup(path);
  let arr = [];
  try { arr = JSON.parse(readFileSync(path, 'utf8')).items || []; } catch { /* 首次 */ }
  const seen = new Set(arr.map(keyFn));
  let added = 0;
  for (const it of items) {
    const k = keyFn(it);
    if (seen.has(k)) continue;
    seen.add(k); arr.push(it); added++;
  }
  if (added) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ note: '巡检自动生成的线索队列（机器只记录，不直接改规则）。', items: arr }, null, 2) + '\n', 'utf8');
  }
  return added;
};
const brokenAdded = appendQueue(BROKEN, (x) => x.url, actions.filter((a) => a.type === 'MARK_BROKEN')
  .map(({ type, ...x }) => x));
const radarAdded = appendQueue(RADAR, (x) => `${x.source}|${x.title}`, actions.filter((a) => a.type === 'RADAR')
  .map(({ type, ...x }) => x));

console.log(`实际写入：降级 ${changed} 条依据 / 坏源 ${brokenAdded} 条 / 新线索 ${radarAdded} 条`);
if (!changed && !brokenAdded && !radarAdded) {
  console.log('全部已是最新（幂等），不跑测试、不提交。');
  process.exit(0);
}

/* ---------- 3) 门禁：全量测试，绿了才留下，红了整份回滚 ---------- */
let testOk = true;
try {
  execFileSync('npm', ['run', 'test:logic'], { stdio: 'inherit', env: process.env });
} catch {
  testOk = false;
}
if (!testOk) {
  rollback();
  console.error('全量测试未通过 —— 已自动回滚全部改动，仓库保持原样。');
  process.exit(1);
}
console.log('全量测试通过，改动保留。');

/* ---------- 4) 可选提交（CI 用） ---------- */
if (doCommit) {
  const files = [...backups.keys()];
  try {
    execFileSync('git', ['add', ...files], { stdio: 'inherit' });
    const msg = `chore(auto): 巡检自动降级 ${changed} 条依据，记录坏源 ${brokenAdded} / 线索 ${radarAdded}`;
    execFileSync('git', ['commit', '-m', msg], { stdio: 'inherit' });
    console.log('已提交。');
  } catch (e) {
    console.error('提交失败（测试已通过，改动仍在工作区）：', e.message);
    process.exit(1);
  }
}
