// SPDX-License-Identifier: MIT
// Copyright (c) 2026 老王AI瞎bb
// See LICENSE at the repository root.

/**
 * 病友彩蛋（EGG）。
 *
 * 老板 2026-11-21 定：方案 3「进来那一瞬」——刚进结果页给一次整屏，点一下立刻进，
 * 之后收成顶部一条窄带，想看再点。并且明说两次：「这是句祝福，不是医嘱」那行小字
 * **一个字不留**。所以这个文件、模板、样式里都不许再出现那类免责小字。
 *
 * 两条入口，祝福分人称（老板 2026-11-23 第 2 条）：
 *   ① 他自己勾了癌症 / 阿尔茨海默病 / 心梗脑卒中  → 「祝你早日康复」
 *   ② 家族史里有癌症 / 阿尔茨海默病 / 心脏病       → 「祝你家人早日康复」
 * ② 是新加的：病长在家人身上，跟他说「祝你早日康复」是句错话，
 * 但"十年内这些病会成为过去"这句安慰对他同样成立 —— 所以彩蛋照给，只换人称。
 *
 * 三种命中（老板 2026-11-25 第 2 条）：既往症和家族史**都**勾了病的，
 * 祝福改成「祝你和你的家人身体健康」—— 病人和家属都是他牵挂的人，只祝一边都是错话。
 *
 * 两边同时命中时的处理见下面「三种命中」—— 2026-11-25 起改为独立的 wishBoth 文案。
 * 没病的人两边都不给 —— 没病的人看到「祝你早日康复」会觉得被冒犯，
 * 也会显得产品在乱猜。
 */
import egg from '../data/egg.json' with { type: 'json' };

export const eggData = egg;

export const eggFor = (profile) => {
  const self = Array.isArray(profile?.pastHistory) ? profile.pastHistory : [];
  const family = Array.isArray(profile?.familyHistory) ? profile.familyHistory : [];

  const selfHit = egg.trigger.some((k) => self.includes(k));
  const familyHit = (egg.familyTrigger || []).some((k) => family.includes(k));

  // 两边都命中 → 病人和家属都是他牵挂的人，只祝一边都是错话（老板 2026-11-25 第 2 条）
  if (selfHit && familyHit) {
    return { ...egg, wish: egg.wishBoth, sign: egg.signBoth, forBoth: true };
  }
  if (selfHit) {
    return { ...egg, wish: egg.wish, forFamily: false };
  }
  if (familyHit) {
    return { ...egg, wish: egg.wishFamily, forFamily: true };
  }
  return null;
};
