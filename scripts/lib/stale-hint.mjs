/* 依据时效提示（计划 5 的"过期降级"展示层，2026-11-25 老板定稿口径）：
 *   - 48 个月（4 年）未复核、且该规则只有 1 条依据支撑 → 卡内提示"依据较旧"；
 *   - 多条依据互相印证时单条旧不提示（不拿它打扰用户）；
 *   - 只提示，不改变判定 —— 降级动作由巡检执行器按白名单做，展示层只负责说清楚。
 * 纯函数、无依赖：views13 在浏览器里用它渲染卡内提示，node 单测直接考它。 */
export const STALE_MONTHS = 48;

export const monthsBetween = (iso, now = new Date()) => {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const then = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(then.getTime())) return null;
  // 不取整：比较时要用精确值（调用方自行决定怎么展示）
  return (now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
};

/** 返回卡内提示文案；不需要提示时返回 '' */
export const staleHint = (rule, now = new Date()) => {
  const evs = (rule && rule.evidence) || [];
  if (evs.length !== 1) return '';
  const e = evs[0];
  if (e.status && e.status !== 'verified') return '';
  // 用精确天数比较，不能先取整 —— floor 会把 48.9 个月砍成 48，把过期漏掉
  const months = monthsBetween(e.checkedAt, now);
  if (months === null || months <= STALE_MONTHS) return '';
  const years = Math.round(months / 12);
  return `这条依据较旧（约 ${years} 年前核实，超过 ${STALE_MONTHS / 12} 年复核周期），且只有这一份文件支持 —— 结论仍按指南原文给出，但请以医生意见为准。`;
};
