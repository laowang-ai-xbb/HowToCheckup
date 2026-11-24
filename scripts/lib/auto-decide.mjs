/**
 * 自动运营决策层（纯函数，不联网、不写文件）
 *
 * 老板 2026-11-24 的方向：巡检结论不是"待办清单"，是程序动作。
 * 这里把 reports/updates.json 的六种结论翻译成动作，但**只产出计划，不动手**。
 * 真正写文件、跑测试、回滚在 scripts/auto-apply.mjs。拆两层的理由：
 *   · 决策对不对能离线单测（错了会静默降级/静默漏报，光靠线上看不出来）；
 *   · 写文件那层不掺判断，出错只可能是 IO 或测试门禁，容易定位。
 *
 * 安全铁律（写死在这里，改之前先想清楚）：
 *   1. 只降不升：verified → stale，绝不 stale → verified。机器判断错了也只会"少推荐"，
 *      不会"多推荐一个做了可能有害的项目"。
 *   2. 不碰判定：verdict / when / frequency / quotes / catalogIds 一个字都不改。
 *      数字变化（45→50 岁）机器看不出"哪个对"，只把依据标旧，交回指南原文核对。
 *   3. 幂等：同一份报告跑十遍，结果和跑一遍一样。
 *   4. 保守默认：拿不准的（没有匹配规则、字段不全）一律 no-op，不猜。
 */

/** 允许机器自动改的字段白名单 —— 执行层只认这些，多一个都不写 */
export const WRITABLE = Object.freeze({
  evidence: ['status', 'reviewNote', 'checkedAt'],
});

const AUTO_NOTE = '自动巡检降级：依据原文发生变化或暂时抓不到，机器先把它降到"待核实"，不自动改结论数字。原始报告见 reports/updates.json。';

/** 合规的日期戳：报告的 checkedAt 取日期部分；取不到就不动 checkedAt（不写假日期） */
const stampOf = (report) => {
  const s = report?.checkedAt;
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
};

/** 从报告里收集所有"需要降级的 evidence"：(ruleId, url) 去重 */
const collectDowngrades = (report) => {
  const out = new Map(); // key = `${ruleId}\u0000${url}`
  const add = (ruleId, url, reason) => {
    if (!ruleId || !url) return;
    const k = `${ruleId}\u0000${url}`;
    if (!out.has(k)) out.set(k, { ruleId, url, reasons: [] });
    out.get(k).reasons.push(reason);
  };
  // 引用失效：我们引的那句在新版原文里找不到了 —— 最要紧，优先降级
  for (const x of report?.quoteBroken || []) {
    add(x.ruleId, x.url, '引用失效（原句在新版原文里找不到）');
  }
  // 关键数字变化：结论可能要跟着改，机器不猜，先降级
  for (const x of report?.changed || []) {
    for (const id of x.usedBy || []) add(id, x.url, '关键数字变化（需核对年龄/间隔）');
  }
  return [...out.values()];
};

/**
 * 主决策：report → { actions, summary }
 * actions 是纯数据，执行层照单执行，不做任何判断。
 */
export const decide = (report) => {
  const actions = [];
  if (!report || typeof report !== 'object') {
    return { actions, summary: { skipped: true, reason: '没有报告' } };
  }
  const stamp = stampOf(report);

  // 1) 依据降级（引用失效 / 数字变化）—— 只降不升
  for (const d of collectDowngrades(report)) {
    actions.push({
      type: 'DOWNGRADE_EVIDENCE',
      ruleId: d.ruleId,
      url: d.url,
      fields: {
        status: 'stale',
        reviewNote: `${AUTO_NOTE}${d.reasons.join('；')}。`,
        ...(stamp ? { checkedAt: stamp } : {}),
      },
      reason: d.reasons.join('；'),
    });
  }

  // 2) 抓取失败：记进 broken-sources.json，不删依据、不改规则。
  //    删依据会让清单凭空短一截 —— 那是比"依据暂时抓不到"更糟的错误。
  const broken = [...(report.broken || []), ...(report.catalogWatch?.broken || [])];
  for (const b of broken) {
    if (!b.url) continue;
    actions.push({
      type: 'MARK_BROKEN',
      url: b.url,
      source: b.source || '',
      usedBy: b.usedBy || [],
      error: b.error || '',
      checkedAt: stamp,
    });
  }

  // 3) 目录页发现新标题：记进线索队列，不自动收进规则。
  //    "标题里有'指南'两个字"不等于"这是能逐字引用的权威依据"，机器不替人做这个判断。
  for (const g of report.catalogWatch?.newGuidelines || []) {
    actions.push({
      type: 'RADAR',
      source: g.source || '',
      id: g.id || '',
      title: g.title || '',
      url: g.url || '',
      checkedAt: stamp,
    });
  }

  const summary = {
    downgrade: actions.filter((a) => a.type === 'DOWNGRADE_EVIDENCE').length,
    broken: actions.filter((a) => a.type === 'MARK_BROKEN').length,
    radar: actions.filter((a) => a.type === 'RADAR').length,
    noop: !(report.quoteBroken || []).length && !(report.changed || []).length
      && !broken.length && !(report.catalogWatch?.newGuidelines || []).length,
  };
  return { actions, summary };
};

/** 决策层自检用的常量导出，便于单测断言"机器绝不升级" */
export const SAFE_STATUS = Object.freeze(['stale', 'pending']);
