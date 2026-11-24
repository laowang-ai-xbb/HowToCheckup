// SPDX-License-Identifier: MIT
// Copyright (c) 2026 老王AI瞎bb
// See LICENSE at the repository root.

/**
 * 依据的排版口径（结果页折叠表 + 依据页卡片共用）。
 *
 * 为什么单独一个文件：同一份 `evidence[]` 要在三个地方出现 ——
 *   ① 结果页每张卡底部的「依据 N 条」折叠表（谁 / 文件 / 强度 / 原文）；
 *   ② 依据页的长卡片（机构 + 文件名 + 一句结论 + 原文摘录 + 链接）；
 *   ③ 依据分类标准的说明（标签词表）。
 * 三处的"谁"和"文件"必须切得一模一样，否则同一份依据在两页上写法不同，读者会以为不是一份。
 */

/** 出处字符串里带书名号的，把它拆成「机构 + 文件」两半 */
export const isDocTitle = (x) => /指南|共识|清单|方案|目录|标准|规范/.test(x);

/**
 * splitOrg：把 evidence.org 拆成 { who, doc }。
 *
 * 数据里有三种写法，都得认：
 *   ① 带书名号：`中华医学会消化病学分会《中国结直肠癌筛查指南》`
 *   ② 文件名直接写在 org 里、没有书名号：`SNMMI（…）Choosing Wisely 清单第 1 条`
 *   ③ 只有机构名：`USPSTF`
 * 第三种不能替它编一个文件名 —— 依据页上有原文链接，让他自己点。
 */
export const splitOrg = (org) => {
  const t = String(org || '').trim();
  if (!t) return { who: '—', doc: '' };
  const m = t.match(/^(.*?)《(.+?)》\s*$/);
  if (m) return { who: m[1].replace(/[，,、\s]+$/, '') || m[1], doc: `《${m[2]}》` };
  if (isDocTitle(t)) {
    const head = t.split(/[（(]/)[0].trim();
    return { who: head !== t && !isDocTitle(head) ? head : '—', doc: t };
  }
  return { who: t, doc: '' };
};

/** 证据强度 → 人话标签 + 药丸配色。没有 strength 但有 status=pending 的，标成待核实 */
export const ST = {
  strong: ['强推荐', 'st-strong'],
  conditional: ['个体化决定', 'st-cond'],
  against: ['不推荐', 'st-against'],
  insufficient: ['证据不足', 'st-ins'],
  /* 疫苗、老年综合评估这类出处没有 GRADE 评级，强度列写的是"文件性质"。
   * 这两个词不是我们打的分，页尾的分级标准里写清了区别。 */
  guide: ['官方指南', 'st-guide'],
  consensus: ['专家共识', 'st-guide'],
  /* 依据页「去哪一栏是怎么定的」用到的两种文件：它们都不是筛查证据，
   * 而是"机构该怎么建、流程该怎么走"的规范。标签写文件性质，不写推荐强弱，
   * 页尾的分级标准里各有一句说明 —— 不这样标，读者会把它当成"这项该做"。 */
  standard: ['团体标准', 'st-guide'],
  norm: ['工作规范', 'st-guide'],
};

export const stOf = (e) => {
  if (ST[e.strength]) return ST[e.strength];
  if (e.status === 'pending') return ['待核实', 'st-ins'];
  return ['见原文', 'st-ins'];
};

/** 只算能给人看的依据；待核实的先不摆出来（它还没核过） */
export const liveEv = (rule) => (rule && rule.evidence ? rule.evidence : []).filter((e) => e.status !== 'pending');
export const evCount = (rule) => liveEv(rule).length;

/** 折叠表的一行 */
export const evRows = (rule, href) => liveEv(rule).map((e) => {
  const { who, doc } = splitOrg(e.org);
  const [label, cls] = stOf(e);
  return { who, doc, year: e.year || '', label, cls, href: href || e.url || '', ext: !!e.url && !href };
});
