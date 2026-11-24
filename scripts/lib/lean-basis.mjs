/**
 * 偏向（lean）的"依据指纹"。
 *
 * 为什么需要这个文件：
 *   老板问过两次「新指南出来了，偏向会不会自动改」。诚实答案是：B 档的偏向不是
 *   指南里的一句话，是我们在指南原文之间做的一次判断（同一份原文，可以被读成
 *   "偏向做"也可以被读成"偏向不做"，取决于中国人的发病基线、代价、可及性）。
 *   所以**不能让机器直接改这个值** —— 我拿词表试过，21 条 B 档里有 11 条会被改错
 *   （"未推荐一般风险人群筛查"里同时有"推荐"和"不推荐"，词表分不清主谓）。
 *
 *   能做、也真该做的是另一半：**机器负责发现"该重看了"，人只负责写那一句判断**。
 *   做法是给每条带偏向的规则存一枚指纹 —— 它当时依据的那几段原文 + 当时写的偏向。
 *   指纹一变，检查就红，逼着人回来重读原文、重写 leanNote，再显式登记一次。
 *
 *   这就是"自动"的边界：自动发现、自动拦下、自动留痕；自动改值那一半，
 *   一旦做错就是把一个"临床判断"交给字符串匹配，我不做。
 */

import { createHash } from 'node:crypto';

/** 参与指纹的字段：证据原文 + 机构 + 年份。
 *  故意不含 status / checkedAt / url —— 那些是"我们核过没有"，不是"原文说了什么"，
 *  重新核一遍不该触发偏向复核（否则每跑一次巡检就红一次，很快就没人看了）。 */
const evText = (e) => [e.org, e.year, e.point, ...(e.quotes || [])].join('\u0001');

export const basisOf = (rule) => createHash('sha1')
  .update((rule.evidence || []).map(evText).join('\u0002'))
  .digest('hex')
  .slice(0, 16);

/** 只有带 lean 的规则才需要账：没有偏向的规则，证据变了由 check-updates 那一层管。 */
export const leanRules = (rules) => rules.filter((r) => r.lean);

/**
 * 纯函数比对，三件事分开报 —— 合成一句"偏向要复核"没有用，人得知道是哪一种：
 *   missing   账上没有这条（新加的规则，或者上一条被删了又加回来）
 *   stale     原文变了 → 偏向的依据可能已经失效
 *   drifted   偏向值本身被改过，但没有登记（谁改的、为什么改，得留一句）
 */
export const compare = (rules, basis) => {
  const out = [];
  for (const r of leanRules(rules)) {
    const rec = basis.rules?.[r.id];
    const hash = basisOf(r);
    if (!rec) { out.push({ id: r.id, kind: 'missing', hash, lean: r.lean }); continue; }
    if (rec.hash !== hash) out.push({ id: r.id, kind: 'stale', hash, was: rec.hash, lean: r.lean });
    if (rec.lean !== r.lean) out.push({ id: r.id, kind: 'drifted', hash, was: rec.lean, lean: r.lean });
  }
  const live = new Set(leanRules(rules).map((r) => r.id));
  for (const id of Object.keys(basis.rules || {})) {
    if (!live.has(id)) out.push({ id, kind: 'gone' });
  }
  return out;
};

/** 重新登记：把当前原文指纹与当前偏向一起写进账。只该在"人真的读过原文"之后跑。 */
export const rebase = (rules) => {
  const next = {};
  for (const r of leanRules(rules)) next[r.id] = { hash: basisOf(r), lean: r.lean };
  return next;
};
