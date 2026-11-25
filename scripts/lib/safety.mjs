/**
 * 临床安全后处理层（P0 止血 + P1 三态）
 *
 * 为什么是"后处理"而不是重写老引擎：
 *   老引擎的规则表/校验器/不变量有几十处守卫，整体重写风险太高。
 *   这里在"规则命中"之后加一道统一的临床闸门：抑制优先、三态、筛查前提。
 *   任何时刻把 engine.js 里这一行去掉，就能回退到老链路。
 *
 * 铁律：
 *   1. C 档先算。先拿到"不推荐"的黑名单，再从 A/B 候选里移除。
 *      老链路按 A→B→C 认领，会把"不建议做"藏起来 —— 这是最危险的一种静默错误。
 *   2. unknown ≠ no。算不出来就明确说算不出来，绝不降级成"不用做"。
 *   3. 不改画像、不改规则源数据；只在本次输出的副本上打标记。
 */
import { toFacts, gates, lungLDCT2025, UNKNOWN } from './facts.mjs';

export const SAFETY_VERSION = 'p0p1-2026-11-25.1';

const clone = (r) => ({ ...r, shownIds: r.shownIds ? [...r.shownIds] : undefined });

const sameItem = (a, b, canon) => canon(a) === canon(b);

/** 输出一段给用户看的闸门说明；没有触发就返回 '' */
export const gateMessage = (meta) => {
  if (!meta || !meta.gate) return '';
  const g = meta.gate;
  if (g.ageOutOfScope) {
    return '这份清单按 18–100 岁成年人设计。你填的年龄超出范围，常规筛查建议不再适用，请先找医生按你的实际情况评估。';
  }
  if (g.frailDowngrade) {
    return '筛查的获益要几年后才显现。你目前的身体状况（近期住院 / 需要搀扶 / 高龄）可能耐受不了后续检查与治疗，常规筛查清单先不给你下结论，请让医生当面评估。';
  }
  if (g.symptomStop) {
    return '你已经勾了不舒服的症状。这时候要做的是门诊看病、明确诊断，不是按"无症状筛查"清单体检。下面这份清单仅供和医生讨论时参考。';
  }
  return '';
};

/** 老分享链接/新画像都走这里；疫苗要不要出也由同一道闸决定 */
export const vaccinesDeferred = (meta) => {
  const g = meta?.gate;
  return !!(g && (g.ageOutOfScope || g.frailDowngrade || g.symptomStop));
};

/**
 * 主入口：P0/P1 安全后处理
 * @param {object} profile 用户画像
 * @param {{A:Array,B:Array,C:Array}} raw 老引擎 evaluateRaw 的输出
 * @param {{canon?:Function}} opts canon：项目别名归一（FIT ≡ 便潜血）
 * @returns {{A:Array,B:Array,C:Array}} 同形状对象，规则对象上挂 clinicalStatus / hidden
 *         同时把诊断信息放进第二个返回值 meta
 */
export const applySafety = (profile, raw, opts = {}) => {
  const canon = opts.canon || ((x) => x);
  const buckets = {
    A: (raw?.A || []).map(clone),
    B: (raw?.B || []).map(clone),
    C: (raw?.C || []).map(clone),
  };
  const facts = toFacts(profile);
  const gate = gates(facts);
  const meta = {
    version: SAFETY_VERSION,
    gate,
    indeterminate: [],
    disputes: [],
    suppressed: [],
    facts,
  };

  const find = (id) => ['A', 'B', 'C']
    .flatMap((k) => buckets[k].map((r) => ({ k, r })))
    .find((x) => x.r.id === id);

  // ---- 闸一：筛查前提（症状 / 衰弱 / 年龄范围）----
  // 把 A/B 全数压下；C 档"不推荐"保留，让页面还能回答"哪些不用做"。
  if (gate.ageOutOfScope || gate.frailDowngrade || gate.symptomStop) {
    for (const k of ['A', 'B']) {
      for (const r of buckets[k]) {
        r.hidden = true;
        r.suppressedBy = 'screen-gate';
        meta.suppressed.push({ id: r.id, reason: '筛查前提不满足' });
      }
    }
  }

  // ---- 闸二：C 档优先抑制 ----
  // 先收齐"明确不做"的项目，再从 A/B 里撤掉。注意这里按规则声明的 catalogIds 算，
  // 不用 shownIds —— shownIds 是归一之后剩下的，拿它算会漏（老链路踩过这个坑）。
  const blocked = new Set();
  for (const r of buckets.C) for (const id of r.catalogIds || []) blocked.add(canon(id));
  for (const k of ['A', 'B']) {
    for (const r of buckets[k]) {
      if (r.hidden) continue;
      const shown = (r.shownIds ?? r.catalogIds ?? []).filter((id) => !blocked.has(canon(id)));
      const removed = (r.shownIds ?? r.catalogIds ?? []).filter((id) => blocked.has(canon(id)));
      if (removed.length) {
        meta.suppressed.push({ id: r.id, reason: '与 C 档「不用做/不推荐」冲突', items: removed });
      }
      r.shownIds = shown;
      r.mergedInto = [...(r.mergedInto || []), ...removed];
      if ((r.catalogIds || []).length && !shown.length) r.hidden = true;
    }
  }

  // ---- 闸三：肺癌 LDCT 按 2025 版严格口径重判 ----
  const lung = lungLDCT2025(facts);
  const aLDCT = find('lung-ldct-high-risk');
  const bLDCT = find('lung-ldct-80plus');
  const cLDCT = find('lung-ldct-not-high-risk');
  const gateOn = gate.ageOutOfScope || gate.frailDowngrade || gate.symptomStop;

  if (!gateOn && (lung.indeterminate || !lung.eligible)) {
    // 只压 A 档高危和 C 档"不是高危"。80plus 这条 B 档不能压：
    // 它的 when 本身就要求 ageMin 80 + 某条高危条件成立，能匹配上说明条件确凿，
    // 此时 lung.eligible=false 纯粹是因为年龄超出 50–80 区间 —— 这正是它存在的意义
    // （80 岁以上按预期寿命个体化判断）。压掉它，80+ 高危人群连一张 LDCT 卡都没有
    // （2026-11-25 典型人群画像测试抓出来的回归）。
    if (aLDCT) {
      aLDCT.r.hidden = true;
      aLDCT.r.suppressedBy = lung.indeterminate ? 'ldct-unknown' : 'ldct-ineligible';
      meta.suppressed.push({ id: aLDCT.r.id, reason: lung.indeterminate ? '肺癌筛查条件算不出来' : '不符合 2025 版高危条件' });
    }
    if (cLDCT) {
      // 信息不足时不能说"不属于高危、不用做"——那等于替用户认了不知道的事
      cLDCT.r.hidden = lung.indeterminate;
      cLDCT.r.suppressedBy = lung.indeterminate ? 'ldct-unknown' : undefined;
    }
  } else if (!gateOn && lung.eligible && cLDCT) {
    cLDCT.r.hidden = true;
    cLDCT.r.suppressedBy = 'ldct-eligible';
  }

  if (lung.indeterminate) {
    meta.indeterminate.push({
      key: 'lung-ldct',
      q: '肺癌筛查条件还差几项',
      fields: lung.fields,
      effect: '年限不清楚时，既不能说"该做"也不能说"不用做"；补上后再算',
    });
  }
  if (lung.legacyDispute && !lung.eligible && !lung.indeterminate) {
    // 2-B 分歧通用化（2026-11-25）：文案来自条款卡 clause.dispute（数据），不再硬编码 ——
    // 以后新增分歧只改 rules.json，机制不动。找不到数据时用兜底文案，行为不劣化。
    const withDispute = ['A', 'B', 'C']
      .flatMap((k) => buckets[k])
      .find((r) => r.id.startsWith('lung-ldct') && r.clause?.dispute);
    meta.disputes.push({
      key: withDispute?.clause?.dispute?.key || 'lung-ldct',
      text: withDispute?.clause?.dispute?.text
        || '你的情况按 2025 版中国 LDCT 指南不够高危条件，但按 USPSTF/ACS 等较宽松口径可能需要筛查。两版结论不一致，请带上吸烟和暴露年限去咨询医生。',
    });
  }

  // ---- 三态标签：confirmed / indeterminate / baseline ----
  for (const k of ['A', 'B']) {
    for (const r of buckets[k]) {
      r.clinicalStatus = r.hidden ? 'indeterminate' : 'confirmed';
      if (r.suppressedBy === 'ldct-unknown') r.clinicalStatus = 'indeterminate';
    }
  }
  for (const r of buckets.C) r.clinicalStatus = 'baseline';

  return [buckets, meta];
};

export { UNKNOWN };
