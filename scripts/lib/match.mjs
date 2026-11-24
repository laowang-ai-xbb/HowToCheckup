/**
 * 规则匹配器（唯一实现）
 *
 * 为什么单独抽出来：判定逻辑原本在 validate.mjs、count-combos.mjs 里各写一份，
 * 两份实现一旦漂移，就会出现"校验通过但线上判错"的隐性故障。
 * 判定规则只允许有一份代码。
 */

/** 单条件判定 */
export const matchLeaf = (field, cond, profile) => {
  const v = profile[field];
  if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
    if ('gte' in cond) return Number(v) >= cond.gte;
    if ('gt' in cond) return Number(v) > cond.gt;
    if ('lte' in cond) return Number(v) <= cond.lte;
    if ('lt' in cond) return Number(v) < cond.lt;
    if ('eq' in cond) return v === cond.eq;
    if ('in' in cond) return cond.in.includes(v);
    return false;
  }
  if (Array.isArray(v)) return v.includes(cond);
  return v === cond;
};

/** 整条 when 判定 */
export const match = (when, profile) => {
  for (const [k, v] of Object.entries(when || {})) {
    if (k === 'ageMin') { if (Number(profile.age) < v) return false; continue; }
    if (k === 'ageMax') { if (Number(profile.age) > v) return false; continue; }
    if (k === 'any') { if (!v.some((c) => match(c, profile))) return false; continue; }
    if (k === 'all') { if (!v.every((c) => match(c, profile))) return false; continue; }
    if (k === 'none') { if (v.some((c) => match(c, profile))) return false; continue; }
    if (!matchLeaf(k, v, profile)) return false;
  }
  return true;
};

/** 按 A/B/C 分组输出 */
export const evaluate = (rules, profile) => {
  const out = { A: [], B: [], C: [] };
  for (const r of rules) if (match(r.when, profile)) out[r.category].push(r.id);
  return out;
};
