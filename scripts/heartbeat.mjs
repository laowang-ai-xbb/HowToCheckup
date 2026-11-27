#!/usr/bin/env node
/**
 * 巡检心跳（2026-11-27 任务2 第一步）
 *
 * 防什么：整套巡检静默死亡——Actions 配额用尽、依赖装不上、schedule 被关。
 * 那时 workflow 根本不会跑，没有任何报错，页面看起来一切正常。
 * 心跳 = 巡检每次成功跑完写时间戳；下一次运行时回头看上一次的时间戳，
 * 超过 14 天没成功记录就开 issue 报警。"没人盯"不许变成"没人知道坏了"。
 *
 * 流程（workflow 每次运行最后一步调用）：
 *   1. 读 reports/heartbeat-last.json（上次成功的时间戳，随仓库提交）；
 *   2. 过期 → 开/追加 issue「巡检心跳警报」；
 *   3. 把本次运行写下的 reports/heartbeat.json 存为新的 last，提交回仓库。
 *
 * 用法：node scripts/heartbeat.mjs            # CI 里用
 *       node scripts/heartbeat.mjs --check    # 本地只检查不提交
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { heartbeatStale } from './lib/year-sentinel.mjs';

const checkOnly = process.argv.includes('--check');
const LAST = 'reports/heartbeat-last.json';
const FRESH = 'reports/heartbeat.json';

const lastOkAt = existsSync(LAST)
  ? (() => { try { return JSON.parse(readFileSync(LAST, 'utf8')).lastOkAt || ''; } catch { return ''; } })()
  : '';

const verdict = heartbeatStale(lastOkAt);

if (verdict.stale) {
  const reason = verdict.reason || '心跳缺失';
  console.log(`::warning::心跳过期：${reason}`);
  if (!checkOnly) {
    const body = [
      '巡检心跳过期，整套自动巡检可能已静默死亡（Actions 配额、依赖失效、schedule 被关都会这样——不报错，只是不再运行）。',
      '',
      `- 上次成功：${lastOkAt || '（无记录）'}`,
      `- 判定：${reason}`,
      `- 本次检查时间：${new Date().toISOString()}`,
      '',
      '请到 Actions 页看「指南更新巡检」workflow：最近一次运行是什么时候、失败原因是什么。',
      '心跳恢复后本 issue 可关闭。这个报警每过 14 天没有成功运行就会再响一次。',
    ].join('\n');
    const existing = execFileSync('gh', ['issue', 'list', '--state', 'open', '--search',
      '巡检心跳警报 in:title', '--json', 'number', '--jq', '.[0].number'], { encoding: 'utf8' }).trim();
    if (existing) {
      execFileSync('gh', ['issue', 'comment', existing, '--body', body], { encoding: 'utf8' });
      console.log(`已在 issue #${existing} 追加心跳警报。`);
    } else {
      const url = execFileSync('gh', ['issue', 'create', '--title',
        '巡检心跳警报：自动化可能已静默死亡', '--body', body], { encoding: 'utf8' }).trim();
      console.log(`已开心跳警报 issue：${url}`);
    }
  }
} else {
  console.log(`心跳正常：${verdict.days} 天前有成功记录。`);
}

// 无论是否过期，本次能跑到这里 = workflow 活着，把新的心跳存档提交回去。
// heartbeat.json 由 check-updates.mjs 在巡检主体跑完后写入；万一没有（上游步骤失败），
// 就把本次时间写进去——workflow 能执行到这一步本身就是"活着"的证据。
let fresh = { lastOkAt: new Date().toISOString(), sources: null, drift: null, broken: null };
try { fresh = JSON.parse(readFileSync(FRESH, 'utf8')); } catch { /* 上游没写，用兜底 */ }
if (checkOnly) {
  console.log(`（--check 只看不动；下次心跳应为 ${JSON.stringify(fresh.lastOkAt || '')}）`);
} else {
  writeFileSync(LAST, JSON.stringify(fresh, null, 2) + '\n', 'utf8');
  console.log('心跳存档已更新 reports/heartbeat-last.json，待 workflow 提交回仓库。');
}
