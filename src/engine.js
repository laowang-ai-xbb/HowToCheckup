// SPDX-License-Identifier: MIT
// Copyright (c) 2026 老王AI瞎bb
// See LICENSE at the repository root.

/**
 * 判定引擎（页面侧）
 *
 * 判定逻辑不在这里实现，直接从 scripts/lib/match.mjs 引入 —— 与校验器、
 * 统计脚本共用同一份代码。两份实现一旦漂移，就会出现"校验通过但线上判错"。
 */
import rulesJson from '../data/rules.json' with { type: 'json' };
import catalogJson from '../data/catalog.json' with { type: 'json' };
import vaccinesJson from '../data/vaccines.json' with { type: 'json' };
import { match } from '../scripts/lib/match.mjs';

export const rules = rulesJson.rules;
export const catalogById = new Map(catalogJson.items.map((i) => [i.id, i]));

/* 别名归一：FIT ≡ 便潜血这类"同一项两个名字"统一成一个 id。
 * evaluate（当前清单去重）和 upcoming（只报新面孔）都要用它，
 * 必须放模块层 —— 藏在 evaluate 里的话 upcoming 一引用就 ReferenceError，
 * 结果页整个渲染不出来（2026-11-24 修 Bug B 时踩过）。 */
const canon = (id) => catalogById.get(id)?.sameAs || id;
export const vaccineMeta = vaccinesJson;

/**
 * 按年龄性别筛出该考虑的疫苗。
 *
 * 刻意不按"风险因素"再筛：疫苗的适应证本来就是"到年龄就打"，
 * 加一堆条件只会让老人看不懂自己到底该不该打。
 * 真正需要个体化的是免疫状态（能不能用减毒活疫苗），那条交给接种门诊判断。
 */
export const vaccinesFor = (profile) => {
  const age = Number(profile.age) || 0;
  return vaccinesJson.vaccines.filter((v) => {
    if (age < v.ageMin || age > v.ageMax) return false;
    if (v.gender && v.gender !== profile.gender) return false;
    return true;
  });
};

/** 空画像：所有字段都有合法默认值，避免 undefined 参与比较。
 *
 * **默认值绝对不许等于任何一个选项的取值** —— 这是一条硬规矩，不是洁癖。
 * 单选题的"选中"是拿 `state.profile[key] === 选项值` 直接比的（src/main.js），
 * 所以默认值一旦撞上某个选项，那一屏一进来就有一个选项是青色的，看着像
 * "你已经答过了"。2026-11-23 老板就抓到了这个：「幽门螺杆菌查过吗」默认选中
 * 「没查过，或不记得」—— 而"没答"和"记不清"是两件事：前者该提示他补答，
 * 后者是他自己说的，不能替他认。
 *
 * 所以"未答"统一用空串（数值用 null），'unknown' 只保留一个意思：
 * 用户自己点了「不确定 / 记不清 / 没查过」。
 * scripts/lib/invariants.mjs 的 empty-profile-not-an-answer 会拦着不让它再撞上。
 */
export const emptyProfile = () => ({
  age: null,
  gender: null,
  pregnant: '',
  smoking: '',
  packYears: null,
  secondhand: '',
  alcohol: '',
  cookingOilFume: '',
  /* 体型（J10 方案 2）：
   *   bodyMode   bmi（填了身高体重）/ shape（选了「不方便说」→ 降级到方案 1）
   *              / unknown（选了「不确定」，结果页留回补入口）/ declined（连降级也不想选）
   * 这几个字段都**不参与 A/B/C 判定**，只影响结果页那句体型提示。
   * 判定细节全在 src/body.js，别在这里再写一份界值。 */
  bodyMode: 'bmi',
  bodyHeight: 0,
  bodyWeight: 0,
  bodyWaist: 0,
  bodyShape: '',
  weightLoss: '',
  occupationDust: '',
  occupationTypes: [],
  province: '',
  familyHistory: [],
  pastHistory: [],
  hpStatus: '',
  recentChecks: [],
  // 60 岁以上才问，只用于出「转诊卡」，不参与 A/B/C 判定
  fallHistory: '',
  gaitDifficulty: '',
  memoryConcern: '',
});

/**
 * 既往检查史 → 规则：哪条规则命中了"你最近做过这项"。
 *
 * 为什么按规则 id 精确列、不按 skipIfDoneWithin 的窗口数字反推：
 *   同样写 5 年，肠镜是 5 年一次、胃镜也是 5 年一次，但低剂量 CT 是 1 年、
 *   肝癌是半年 —— 用数字反推会把"半年内做过肝脏检查"误当成"1 年内做过 CT"。
 *   一行一条，读起来也一眼能对。
 *
 * 这里只**打标记**，不改 A/B/C 分档：填了"做过"不等于"以后不用管"，
 * 是否真的跳过由医生判断。产品负责提醒，不负责下结论。
 */
export const RECENT_CHECK_FIELDS = ['recentChecks'];
const RULE_TO_CHECK = {
  'colorectal-screening': 'colonoscopy',
  'lung-ldct-high-risk': 'ldct',
  'stomach-gastroscopy-high-risk': 'gastroscopy',
  'stomach-gastroscopy-average-risk': 'gastroscopy',
  'breast-cancer-screening': 'breast',
  'breast-cancer-screening-high-risk': 'breast',
  'cervical-cancer-screening': 'cervical',
  'liver-cancer-screening': 'liver',
};

/** 这条规则对应的检查，用户填了"最近做过"吗？ */
export const recentlyDone = (rule, profile) => {
  const key = RULE_TO_CHECK[rule.id];
  if (!key) return false;
  return Array.isArray(profile.recentChecks) && profile.recentChecks.includes(key);
};

/** 跑一遍规则，返回分好档、排好序的结果 */
export const evaluate = (profile) => {
  const buckets = { A: [], B: [], C: [] };
  for (const rule of rules) {
    if (!match(rule.when, profile)) continue;
    rule.recentlyDone = recentlyDone(rule, profile);
    buckets[rule.category].push(rule);
  }
  const sortRule = (a, b) => (a.priority ?? 999) - (b.priority ?? 999);
  buckets.A.sort(sortRule);
  buckets.B.sort(sortRule);
  buckets.C.sort(sortRule);

  /* ---- 同一个检查项只出现一次 ----
   * 老板 2026-11-21 的话：「还有没有其他检查项会出现类似的问题，全面排查并解决。」
   *
   * 根因不在规则，在"规则 → 项目"是一对多：基础套餐里有便潜血和腹部超声，
   * 结直肠筛查和肝癌筛查里也有同一个 id。规则本身都成立，但渲染是"按规则出卡"，
   * 于是同一项在不同卡里各说一遍，用户以为要做两次。
   *
   * 所以判定归判定（规则各自命中，不动），**展示归一**在这里：
   *   · sameAs：别名（FIT ≡ 便潜血）→ 归到同一个 id 上；
   *   · 按 A → B → C 顺序认领，priority 小的先占（推荐做的先占，避免同项既"该做"又"不必做"）；
   *   · rule.shownIds = 这条规则实际要展示的项目；空了的整张卡不渲染。
   * 别把这项合并写进规则里 —— 规则一改，理由和依据就跟着乱。
   */
  const claimed = new Map(); // 规范 id → 认领它的规则 id
  for (const key of ['A', 'B', 'C']) {
    for (const rule of buckets[key]) {
      const shown = [];
      const merged = [];
      const local = new Set();   // 同一条规则里也可能自己撞（结肠镜规则同时列了 fit 和 stool-ob）
      for (const id of rule.catalogIds || []) {
        const c = canon(id);
        if (local.has(c)) { merged.push(c); continue; }
        if (claimed.has(c) && claimed.get(c) !== rule.id) { merged.push(c); continue; }
        local.add(c);
        claimed.set(c, rule.id);
        shown.push(id);
      }
      rule.shownIds = shown;
      rule.mergedInto = merged;
      // 一条规则的项目全被上游认领完了 → 这张卡没有新信息，不渲染（但规则本身仍算命中）
      rule.hidden = (rule.catalogIds || []).length > 0 && shown.length === 0;
    }
  }
  return buckets;
};

/** 规则对应的项目名（一条规则可能覆盖多个项目）
 *  只用 shownIds：被合并掉的项目不在这里重复出现。 */
export const itemNames = (rule) =>
  (rule.shownIds ?? rule.catalogIds ?? []).map((id) => catalogById.get(id)?.name).filter(Boolean);

/**
 * 一条规则对外展示的统一短名。
 *
 * 为什么放在数据层而不是各个页面里各写一次替换：
 *   同一条规则会被结果页卡片、复制文字、分享图、打印稿四处用到。
 *   以前"基础体检项目（每年一次的基础套餐）""肿瘤标志物套餐（体检常规组合）"
 *   在复制文字和图片里冒出来，就是因为各处的兜底逻辑不一样 —— 一处认 rule.name，
 *   一处认 catalog.name，改了一个漏三个。现在短名写在规则上，所有出口只认这一个函数。
 *
 * 没有 displayName 的规则保持原逻辑，不为这两条改全局数据。
 */
export const ruleLabel = (rule) => {
  if (!rule) return '';
  if (rule.displayName) return rule.displayName;
  const names = itemNames(rule);
  const joined = names.join('、');
  return names.length > 3 || joined.length > 30 ? (rule.name || '') : (joined || rule.name || '');
};

/**
 * 「二选一」提示（不改判定，不隐藏）。
 *
 * 便潜血/FIT 和肠镜查的是同一件事，四五十岁的人不该两个都做。
 * 但我**没有**把其中一条藏掉：藏掉便潜血会让基础套餐少一项；藏掉肠镜更糟 ——
 * 那是灵敏度和获益都更高的一条，藏它等于把人往差的那条路上推。
 * 所以做法是两条都留着，各带一句"和另一个二选一"。
 */
export const mutexNotes = (buckets) => {
  const present = [];
  for (const key of ['A', 'B', 'C']) {
    for (const rule of buckets[key]) {
      if (rule.hidden) continue;
      for (const id of rule.shownIds || []) {
        const it = catalogById.get(id);
        if (it?.exclusiveGroup) present.push({ id, name: it.name, group: it.exclusiveGroup, rule });
      }
    }
  }
  const out = new Map();
  for (const x of present) {
    const others = present.filter((y) => y.group === x.group && y.id !== x.id && y.rule.id !== x.rule.id);
    if (!others.length) continue;
    out.set(x.rule.id, `和「${others.map((o) => o.name).join('」「')}」二选一，不用都做`);
  }
  return out;
};

/**
 * "再过 N 年该加什么"。
 *
 * 不能用 rule.when.ageMin 直接算：很多规则的年龄写在嵌套条件里
 * （肠镜是 any[all[ageMin 45], all[家族史 + ageMin 40]]，PSA 同理），
 * 顶层没有 ageMin，直接读会让最重要的几条预告永远消失。
 *
 * 正解是"把年龄推到 N 年后重新判一次"，命中即说明到那年真的会加。
 * 这既不需要解析嵌套，也不会把"45 岁起且幽门螺杆菌阳性"预告给一个阴性的 44 岁用户。
 */
export const upcoming = (profile, buckets) => {
  if (!profile.age) return [];
  const already = new Set(buckets.A.map((r) => r.id).concat(buckets.B.map((r) => r.id)));
  /* 「再过几年」只报新面孔。
   * 2026-11-24 老板走查：44 岁的预告里出现「便潜血」，可它就在今年的基础套餐里——
   * 同一项既在"今年要做"又在"过两年要加"，用户会以为自己漏了什么。
   * 所以把当前清单里真实在展示的项目（规范化后）收进来，预告规则先滤掉这些老面孔，
   * 只剩新项目的才预告；一张卡里也只说新加的那几项（肠镜后面不再挂着便潜血）。
   * 只认 A/B（真正在让人做的事），不算 C——「不必做」卡里的项目不该挡住将来的推荐。 */
  const presentIds = new Set();
  for (const key of ['A', 'B']) {
    for (const r of buckets[key]) {
      if (r.hidden) continue;
      for (const id of r.shownIds || []) presentIds.add(canon(id));
    }
  }
  const out = [];
  for (const rule of rules) {
    if (rule.category !== 'A' || already.has(rule.id)) continue;
    for (let gap = 1; gap <= 5; gap++) {
      const age = profile.age + gap;
      if (age > 100) break;
      if (match(rule.when, { ...profile, age })) {
        const fresh = (rule.catalogIds || []).filter((id) => !presentIds.has(canon(id)));
        if ((rule.catalogIds || []).length > 0 && fresh.length === 0) break;
        rule.shownIds = fresh;
        out.push({ rule, gap });
        break;
      }
    }
  }
  return out.sort((a, b) => a.gap - b.gap);
};
