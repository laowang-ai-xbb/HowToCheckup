/* 巡检源健康度（2026-11-25 老板批准的"官方源优先"三级分级方案的机器层）：
 *   A 级官方直连（每周抓原文/落地页）；
 *   B 级官方有 WAF —— 官方地位不变，连续失败 ≥3 周才在周报标"长期抓不到"，
 *       同时用 mirrorUrl（C 级转载雷达）确认"这家真的还在更新"；
 *   截断检测：新正文比基线短一半以上 → 疑似被 WAF 打断/改版，不是"指南改了"。
 * 纯函数、无 IO：check-updates.mjs 负责读写，node 单测直接考这里。 */

export const FAIL_THRESHOLD = 3;

/** 一次性更新全部源的连续失败计数：成功的清零，失败的 +1 */
export const nextFailures = (failures = {}, okIds, totalSources) => {
  const out = { ...failures };
  for (const id of okIds) delete out[id];
  for (const id of Object.keys(out)) {
    if (!totalSources.includes(id)) delete out[id]; // 源被删了，计数也删
  }
  return out;
};

export const bumpFailure = (failures = {}, id) => ({ ...failures, [id]: (failures[id] || 0) + 1 });

/** 连续失败达到阈值的源（B 级"长期抓不到"名单） */
export const longUnreachable = (failures = {}, threshold = FAIL_THRESHOLD) =>
  Object.entries(failures)
    .filter(([, n]) => n >= threshold)
    .map(([id, n]) => ({ id, consecutiveFailures: n }));

/**
 * 截断检测：本次正文比基线短一半以上、且基线本身够长（>500 字符）时，
 * 判定"疑似页面被截断/改版"，不是"指南正文改了" —— 防止把抓坏了当成引文失效误报。
 */
export const isTruncated = (newLen, baseLen) =>
  Number.isFinite(baseLen) && baseLen > 500 && Number.isFinite(newLen) && newLen > 0 && newLen < baseLen * 0.5;
