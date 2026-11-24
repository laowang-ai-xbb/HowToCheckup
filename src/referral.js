// SPDX-License-Identifier: MIT
// Copyright (c) 2026 老王AI瞎bb
// See LICENSE at the repository root.

/**
 * 转诊卡：老年综合评估里，产品真正该负责的那一段。
 *
 * 为什么不做量表：
 *   TUGT（计时起立行走）要秒表、一把固定高度的椅子、3 米直线；Mini-Cog 要当面念三个词、
 *   画钟。用户在手机上自测出来的数字不可信，而我们又拿它去出建议 —— 等于用假数据做真决策。
 *   所以这里只做两件事：把「功能下降」问出来，把「该去哪」说清楚。评分交回给医生。
 *
 * 为什么不做成「检查项目」：
 *   CGA 不是一组检查，是一套由医护执行的流程，产出是干预计划。体检中心只会给你一张化验单。
 *   承认这条边界，比假装能做更值钱 —— 市面上很多「老年套餐」正是靠模糊这条边界卖钱的。
 *
 * 文案规矩：一句话说事。用户是 60 岁以上的人，卡片超过四行就不看了。
 */

const CARDS = [
  {
    id: 'fall',
    when: (p) => p.fallHistory === 'yes',
    title: '摔过一跤，值得去看看',
    why: '常是腿劲、平衡或用药出了问题。',
    dept: '老年科 · 骨质疏松门诊',
    bring: '带上骨密度报告和正在吃的药',
  },
  {
    id: 'gait',
    when: (p) => p.gaitDifficulty === 'yes',
    title: '起身要扶，不全是年纪的事',
    why: '多半是腿劲下降，能练回来。',
    dept: '老年科 · 康复科',
    bring: '',
  },
  {
    id: 'memory',
    when: (p) => p.memoryConcern === 'yes',
    title: '记性的事，别自己判断',
    why: '早查能分清是老化还是病。',
    dept: '记忆门诊 · 神经内科',
    bring: '让家里人一起去，自己最说不准',
  },
];

/**
 * 这三个字段不进 A/B/C 档判定，只决定「转诊卡」出不出。
 * 在这里显式登记，是为了让 validate.mjs 能区分
 * 「字段白填（真 bug）」和「字段由转诊卡消费（正常）」。
 */
export const REFERRAL_FIELDS = ['fallHistory', 'gaitDifficulty', 'memoryConcern'];

/** 只有 60 岁以上才可能出卡 —— 链接可以被手改，年龄门槛在这里再守一道 */
export const referrals = (profile) => {
  if (Number(profile.age) < 60) return [];
  return CARDS.filter((c) => c.when(profile)).map(({ when, ...rest }) => rest);
};

/** 三条的统一说明，只出现一次，不重复贴在每张卡上 */
export const REFERRAL_NOTE =
  '这三件事体检中心做不了：老年综合评估要医生当面做、要看你的用药和家里环境。别买「老年套餐」。';

/**
 * 老年综合评估的依据（依据页与卡片底部共用）。
 * 出处已核：中华医学会老年医学分会《老年综合评估技术应用中国专家共识》，
 * 中华老年医学杂志 2017;36(5):471-477，DOI 10.3760/cma.j.issn.0254-9026.2017.05.001。
 * 摘录是原文里的原句，逐字未改 —— 依据页的"逐字可核"靠的就是这一点。
 */
export const CGA_EVIDENCE = {
  org: '中华医学会老年医学分会《老年综合评估技术应用中国专家共识》',
  year: '2017',
  strength: 'consensus',
  point: '老年综合评估（CGA）是用多学科方法评估老年人的躯体情况、功能状态、心理健康和社会环境状况，并据此制订治疗计划；共识把它定位为"现代老年医学的核心技术之一""筛查老年综合征的有效手段"。',
  quotes: ['老年综合评估是现代老年医学的核心技术之一,是筛查老年综合征的有效手段。'],
  cite: '中华老年医学杂志, 2017, 36(5): 471-477',
  url: 'https://rs.yiigle.com/cmaid/992204',
};
