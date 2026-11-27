// SPDX-License-Identifier: MIT
// Copyright (c) 2026 老王AI瞎bb
// See LICENSE at the repository root.

/**
 * 结果页（结论卡）与依据页的排版件。
 *
 * 老板 2026-11-22 定稿：「结果页用现在最新改完的结论卡」—— 也就是 demo/v13-a。
 * 所以这里的每个零件都对着 demo 那一版写，产品与 demo 长得一样；
 * 差别只在数据来源（产品用引擎实时算，demo 用固定画像）。
 *
 * 一条规矩：正文只回答"我今年该做什么"。为什么、能查出什么、原文怎么写的，
 * 都收进每张卡底部的「依据 N 条」，或者去依据页那一页看 —— 正文里不铺开。
 */
import { catalogById, itemNames, ruleLabel } from './engine.js';
import { evCount, evRows, splitOrg, stOf, liveEv } from './evfmt.js';
import { staleHint } from '../scripts/lib/stale-hint.mjs';

const esc = (s = '') => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* ---------------- 长页面下滑引导（老板 2026-11-28）----------------
 * 结果页/依据页在手机上是三四屏长文，老年用户可能不知道往下滑。
 * 视觉完全复用问卷页的 .peek 零件（渐隐遮罩 + 青色跳动箭头 + 同款字号），
 * 保证"问卷里见过一次，结果页再见到就认识"。
 *
 * 触发闸门（三条都满足才出现，缺一不弹）：
 *   ① 手机视口（<600px，与 CSS 的 display:none 阈值一致）
 *   ② 页面确实长：可滚动高度超过 2 屏 —— 短页面没有"忘了往下"这回事
 *   ③ 本会话这一页还没弹过：sessionStorage 记账，刷了不重弹
 *      （骚扰一次就够；老年用户被反复闪反而慌）
 * 消失：滚动超过 140px（证明他会往下翻）或触底。
 * 减速动效：箭头不跳（CSS media query 管），文字保留。 */
export const mountScrollHint = (pageKey, text = '往下滑 · 下面还有内容') => {
  const KEY = `scrollhint-${pageKey}`;
  try {
    if (sessionStorage.getItem(KEY)) return;
  } catch { /* 隐私模式拿不到 sessionStorage 就当没弹过，宁可多弹一次别静默失效 */ }
  if (window.innerWidth >= 600) return;
  // 等首屏渲染稳定再量：太早量 scrollHeight 会拿渲染前的值
  requestAnimationFrame(() => setTimeout(() => {
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    if (scrollable < window.innerHeight * 1.5) return; // 不足两屏半，没有引导的必要
    const el = document.createElement('div');
    el.className = 'scrollhint';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `<div class="peek-in"><div class="peek-chev">↓</div><div class="peek-t">${esc(text)}</div></div>`;
    document.body.appendChild(el);
    try { sessionStorage.setItem(KEY, '1'); } catch { /* 同上 */ }
    const off = () => {
      el.classList.add('off');
      setTimeout(() => el.remove(), 500);
      window.removeEventListener('scroll', off);
    };
    window.addEventListener('scroll', () => {
      const nearBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 80;
      if (window.scrollY > 140 || nearBottom) off();
    }, { passive: true });
  }, 600));
};


/** 卡片的标题：统一走引擎里的规则短名。
 *  以前这里自己算一遍，分享文字又算一遍，两处兜底不一样就漏出了括号里的解释。 */
export const titleOf = ruleLabel;

/* 偏向只在依据页讲：结果页回答"我该做什么"，不摆天平；
   依据页回答"为什么这么判"，才把两方利弊的倾向摊开。 */
export const leanOf = (rule) =>
  rule.lean === 'for' ? '偏向做'
    : rule.lean === 'against' ? '偏向不做'
      : rule.lean === 'either' ? '两边差不多' : '';

const X_LINK = ' target="_blank" rel="noopener noreferrer"';

/* ---------------- 依据：折叠成四列表 ----------------
 * 不展开时只占一行；展开回答"谁说的 / 哪份文件 / 证据强度 / 去哪看原文"。
 * 原文摘录不放在这里 —— 那是依据页的活。
 */
const evTable = (rows) => `
  <div class="evtw"><table class="evt">
    <thead><tr><th>谁</th><th>文件</th><th>证据强度</th><th>原文</th></tr></thead>
    <tbody>${rows.map((x) => `<tr>
      <td>${esc(x.who)}</td>
      <td>${x.href ? `<a href="${esc(x.href)}"${x.ext ? X_LINK : ''}>${esc(x.doc || '见原文')}</a>` : esc(x.doc || '见原文')}${x.year ? `<span class="evy">${esc(x.year)}</span>` : ''}</td>
      <td><span class="st ${x.cls}">${esc(x.label)}</span></td>
      <td>${x.ext ? `<a href="${esc(x.href)}"${X_LINK}>原文 ↗</a>` : `<a href="${esc(x.href)}">依据页 ›</a>`}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;

export const evBoxHTML = (rows, opt = {}) => !rows || !rows.length ? '' : `
  <details class="evbox">
    <summary><span class="evcnt">依据 ${rows.length} 条</span><span class="evx">${esc(opt.hint || '谁说的 · 哪份文件 · 证据强度')}</span></summary>
    ${evTable(rows)}
    ${opt.note ? `<p class="evnote2">${esc(opt.note)}</p>` : ''}
    ${opt.href ? `<a class="evall" href="${esc(opt.href)}">${esc(opt.allText || '在依据页看原文与逐字摘录 ›')}</a>` : ''}
  </details>`;

/** 一条规则的依据框：表格指到依据页对应锚点。
 * 触发原因只给 B 档（老板 2026-11-28）：A 档"必做"不需要解释为什么是你——
 * 它对所有人都成立；C 档"不用做"的解释在 foldHTML 的板块层面。
 * B 档"看你的情况"才是"你的信息改变了清单"的地方，点名触发原因最有价值。 */
export const ruleEvBox = (rule, ctx) => {
  const n = evCount(rule);
  if (!n) return '';
  const isB = rule.category === 'B';
  return evBoxHTML(evRows(rule, ctx.href(rule.id)), {
    href: ctx.href(rule.id),
    /* 老板 2026-11-28：B 档卡的依据折叠里要点名触发原因——
     * "因为你勾了糖尿病家族史、你 35 岁以上"，让用户看到问卷没白填。
     * 文案由 triggerReason 生成，只在 B 档且有 profile 时出。 */
    note: isB && ctx.triggerReason ? ctx.triggerReason(rule) : '',
  });
};

/* ---------------- B 档触发原因 ----------------
 * 为什么放依据折叠里（老板定的）：卡片正文已经够满了，触发原因属于
 * "为什么列给你"的解释层，和"谁说的"放一起最自然。样式走 .evnote2，
 * 与折叠表里其他说明文字同字号同色，不另起炉灶。
 *
 * 文案规则：只说"已用上的信息"（你勾了什么/你的年龄性别），
 * 不说"取决于"——那句话现在已经写进副标题了，两处都说会显得没说完。 */
const FH_LABEL = {
  colorectal: '结直肠癌家族史',
  stomach: '胃癌或食管癌家族史',
  lung: '肺癌家族史',
  liver: '肝癌家族史',
  breast: '乳腺癌家族史',
  ovarian: '卵巢癌家族史',
  prostate: '前列腺癌家族史',
  thyroid: '甲状腺癌家族史',
  diabetes: '糖尿病家族史',
  prematureCvd: '早发心血管病家族史',
  dementia: '痴呆家族史',
};
const PH_LABEL = {
  diabetes: '确诊过糖尿病',
  hypertension: '确诊过高血压',
  cvd: '确诊过心脑血管病',
  cancer: '有癌症病史',
  thyroid: '确诊过甲状腺疾病',
  ckd: '确诊过慢性肾病',
  intestinalMetaplasia: '有肠化生',
  birads: '乳腺 BI-RADS 分级异常',
  lungNodule: '查出过肺结节',
};

/** 从规则 when + 用户 profile 生成"为什么在你这"的一句话；生成不了就返回空串 */
export const triggerReason = (rule, profile) => {
  if (!rule || !profile) return '';
  const w = rule.when || {};
  const parts = [];

  // 家族史/既往史：when 引用的值用户真的勾了才提（否则这条根本不会命中，也不该提）
  if (w.familyHistory) {
    const picked = Array.isArray(profile.familyHistory) ? profile.familyHistory : [];
    const v = typeof w.familyHistory === 'string' ? w.familyHistory : null;
    if (v && picked.includes(v) && FH_LABEL[v]) parts.push(`你填了${FH_LABEL[v]}`);
  }
  if (w.pastHistory) {
    const picked = Array.isArray(profile.pastHistory) ? profile.pastHistory : [];
    const v = typeof w.pastHistory === 'string' ? w.pastHistory : null;
    if (v && picked.includes(v) && PH_LABEL[v]) parts.push(`你填了「${PH_LABEL[v]}」`);
  }
  if (w.pregnant === 'yes' && profile.pregnant === 'yes') parts.push('你填了「怀孕中」');

  const age = Number(profile.age);
  const ageIn = age > 0
    && (w.ageMin == null || age >= w.ageMin)
    && (w.ageMax == null || age <= w.ageMax);

  // when 里有家族史/既往史要求但用户没勾对应项时，这条规则不会命中、本函数不会被调；
  // 但防将来 when 结构变化（如家族史改成数组语义）导致"纯年龄文案"误述触发原因，
  // 这里加一道保险：when 引用了个人史字段但没凑出触发点，就宁可不解释。
  const referencesPersonalHistory = w.familyHistory != null || w.pastHistory != null || w.pregnant != null;

  // 年龄区间的人话：只有下限→"35 岁以上"；只有上限→"74 岁及以下"；双限→"50–69 岁"
  const ageText = (w.ageMin != null || w.ageMax != null) && ageIn
    ? w.ageMin != null && w.ageMax != null
      ? `${w.ageMin}–${w.ageMax} 岁`
      : w.ageMin != null ? `${w.ageMin} 岁以上` : `${w.ageMax} 岁及以下`
    : '';

  // 有个人史触发条件时，年龄只是辅助条件，放句尾；没有时年龄就是主因
  if (parts.length) {
    if (ageText) parts.push(`你 ${ageText}`);
    return `出现在这里，因为${parts.join('，')}。`;
  }
  if (referencesPersonalHistory) return ''; // 见上：个人史条件没凑出触发点，宁可不解释
  // 纯年龄/性别触发：点明"你已经告诉过我们"这件事
  if (ageText) {
    const g = w.gender === 'male' && profile.gender === 'male' ? '、男性' : w.gender === 'female' && profile.gender === 'female' ? '、女性' : '';
    return `出现在这里，因为你 ${ageText}${g}。`;
  }
  return '';
};

/* ---------------- 清单里的一行 ---------------- */
const FREQ_BASIS = {
  practice: '这个间隔是体检行业的通行做法，不是哪份指南的条文',
  doctor: '这个间隔由医生按你的情况定，指南没有给统一数字',
};

export const atomHTML = (rule, idx, key, ctx) => {
  const names = itemNames(rule);
  const many = names.length > 3 || names.join('、').length > 30;
  const title = titleOf(rule);
  const mutex = ctx.mutex && ctx.mutex.get(rule.id)
    ? `<span class="apick">${esc(ctx.mutex.get(rule.id))}</span>` : '';
  const soft = rule.frequency.basis && rule.frequency.basis !== 'guideline';
  return `
  <article class="atom${key ? ' key' : ''}">
    <div class="an">${key ? `<span class="kn">${idx}</span>` : ''}${esc(title)}</div>
    ${many ? `<p class="ids">${names.map(esc).join('、')}</p>` : ''}
    <p class="aw">${esc(rule.verdict)}</p>
    <div class="am">
      <span class="af">${esc(rule.frequency.text)}</span>
      ${mutex}
    </div>
    ${/* 分歧说明写在这条项目卡内（老板定的口径），不放顶部模块。
          样式沿用 .tip 的字号与颜色，只加一道细左边线做安静的视觉标记。 */ ''}
    ${ctx.disputeFor && ctx.disputeFor(rule.id) ? `<p class="tip atom-dispute"><b>指南结论有分歧：</b>${esc(ctx.disputeFor(rule.id))}</p>` : ''}
    ${/* 依据较旧提示（计划 5）：48 个月+仅单条依据才出现，同款 .tip 形态、琥珀色左线。 */ ''}
    ${staleHint(rule) ? `<p class="tip atom-stale"><b>这条依据可能旧了：</b>${esc(staleHint(rule))}</p>` : ''}
    ${soft ? `<p class="tip">${FREQ_BASIS[rule.frequency.basis] || ''}${rule.frequency.basisNote ? '：' + esc(rule.frequency.basisNote) : ''}</p>` : ''}
    ${(rule.redFlags || []).length ? `<p class="tip"><b>出现这些情况要去看医生：</b>${rule.redFlags.map(esc).join('、')}</p>` : ''}
    ${tellDoctorHTML(rule)}
    ${ruleEvBox(rule, ctx)}
  </article>`;
};

/* 「做之前先跟医生说」—— 跟 redFlags 是两件事，所以不能共用一句话：
 *   redFlags  是他已经有不舒服了，"出现这些情况要去看医生"；
 *   tellDoctor 是他已经知道自己有某种情况，"做之前先说一声，让医生判断能不能做"。
 * 洁牙这条就用后者：产品没有资格替他判"你不能洗牙"，只有资格提醒他开口。
 *
 * 默认折起来（老板 2026-11-22 要求）：这五行摊开会让一张卡片变成一屏，
 * 而它只在"我正好符合其中一条"时才有用。summary 的字号/颜色/右侧指示器
 * 全部照「依据 N 条」那行写 —— 一页里两种折叠件长得不一样才是问题。
 */
export const tellDoctorHTML = (rule) => {
  const list = rule?.tellDoctor || [];
  if (!list.length) return '';
  return `
    <details class="tell">
      <summary><span class="tc">这几类人做之前先跟医生说</span><span class="tn">${list.length} 类</span></summary>
      <ul>${list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    </details>`;
};

/* ---------------- 「去哪做」 ----------------
 * 依据页每一节顶上那一行：挂哪个科。
 *
 * 老板 2026-11-22 定稿：这一行只留「去哪做：科室」，别的一个字都不要 ——
 * 不标"原文点名／科室惯例"，不写"要单独预约"这类说明。理由是这个页面已经够长了，
 * 而这一行是他十次有八次真正要找的东西：越短越找得到。
 * 那些说明并没有丢：`data/where.json` 里每条都还留着 basis 和 note（校验器在管），
 * 只是不上页面 —— 想恢复，改这里一处就够。
 *
 * 排版上什么都不加：字号、行距、颜色、加粗全部照 .evr（「它为什么在你清单里」
 * 「能查出什么」）。三个模块长得一模一样，读者才不用分辨"哪行是什么"。
 * 唯一留的钩子是 class="ewv"，给浏览器测试认这一行用。
 */
export const whereHTML = (w) => (w && w.dept ? `<p class="ewv"><b>去哪做：</b>${esc(w.dept)}</p>` : '');

/* 标准项目那一节：20 项挤在一行「去哪」里会变成一堵字墙，
 * 所以按"在体检中心的哪个位置"分组列出来 —— 每行就是【科室 → 项目】，
 * 没有一个字的解释。分组口径和结果页那六个格子一致，
 * 只是把"抽血查的 / 机器照的"换成"检验科 / 心电图室·超声室"。 */
export const whereBaseHTML = (base, ids) => {
  if (!base || !ids.length) return '';
  const rows = (base.groups || [])
    .map((g) => ({ ...g, ids: (g.ids || []).filter((id) => ids.includes(id)) }))
    .filter((g) => g.ids.length);
  if (!rows.length) return '';
  const name = (id) => (catalogById.get(id)?.name || id).replace(/（.*?）/g, '');
  return `
    <div class="ewb">
      <ul class="ewbg">${rows.map((g) => `<li>
        <span class="ewbd">${esc(g.dept)}</span>
        <span class="ewbi">${g.ids.map(name).map(esc).join('、')}</span>
      </li>`).join('')}</ul>
    </div>`;
};

/* ---------------- 目录 ---------------- */
export const tocHTML = (secs) => !secs.length ? '' : `
  <nav class="toc" aria-label="本页目录" style="--tcols:${secs.length <= 4 ? 2 : 3}">
    ${secs.map((s) => `<a href="#${s.id}">${esc(s.label)} <i>${s.n}</i></a>`).join('')}
  </nav>`;

export const sectionHTML = (id, title, sub, inner, extraCls = '') => !inner ? '' : `
  <section class="${extraCls}" id="${id}">
    <h2 class="sh">${esc(title)}${sub ? ` <span>${esc(sub)}</span>` : ''}</h2>
    ${inner}
  </section>`;

/* ---------------- 缺口回补（页首抽屉，不离开结果页） ----------------
 * 老板 2026-11-24 选 B：点「去补这一题」就在这一块下面展开题卡，答一题收一题。
 * 上一版跳回问卷页，老人补第二题时要重新找入口；现在清单一直在原地，上下文不丢。
 * 两种拒答都留入口：「不确定」和「不方便说」在标签上分开写（记不清 / 不愿说），
 * 但回补这条路是同一条 —— 上一版只判了 unknown，选「不方便说」的人静默少了几项。
 */
export const gapsTopHTML = (gaps, { open = false, editor = '' } = {}) => !gaps || !gaps.length ? '' : `
  <details class="gaps gaptop" ${open ? 'open' : ''}>
    <summary>
      <span class="gbdot"></span>
      <span><b>${gaps.length} 题没答</b>：${gaps.map((g) => esc(g.q)).join('、')} —— 会影响结论</span>
      <span class="gbgo"></span>
    </summary>
    <div class="gapbody">
      <ul>${gaps.map((g) => `<li>
        <span class="gq">${esc(g.q)}</span>
        <span class="gtag">${g.blank ? '没答' : (g.unsure ? '记不清' : '不愿说')}</span>
        <span class="geff">${esc(g.effect)}</span>
        <button class="gbtn" type="button" data-act="goto" data-key="${esc(g.key)}">去补这一题 ›</button>
      </li>`).join('')}</ul>
      ${editor}
    </div>
  </details>`;

/* ---------------- 年龄到了，这些检查会变 ----------------
 * 老板 2026-11-26 定的口径：卡内的"界线提示"不再散在各张卡里，统一收进这个模块。
 * 两类变化都放这儿：① 到年龄会"加上"的新项目（原 upcoming）；② 到年龄要"重定"的
 * 界线（如 75 岁后肠癌查不查没有统一结论）。模块名从"再过几年要加上"改掉，因为
 * 第二类是"要重新决定"不是"加上"，旧名字会骗人。
 * 依据仍取各自规则自己的证据 —— 预告不是拍脑袋推的年龄线。 */
export const soonHTML = (soon, ctx = null, boundaries = []) => {
  // 同一件事不写两遍：boundary 标了 mergesRule 时，它的文案降为那一条「加上」的副说明
  const merged = new Map();
  for (const b of boundaries || []) if (b.mergesRule) merged.set(b.mergesRule, b.text);
  const rows = [
    ...(soon || []).map(({ rule, gap }) => ({
      gap, kind: '加上', rule, text: titleOf(rule), note: merged.get(rule.id) || '',
    })),
    ...(boundaries || []).filter((b) => !b.mergesRule || !(soon || []).some((s) => s.rule.id === b.mergesRule))
      .map((b) => ({ gap: b.gap, kind: '重定', rule: b.rule, text: b.text, note: '' })),
  ].sort((a, b) => a.gap - b.gap);
  if (!rows.length) return '';
  const evRules = [...new Map(rows.map((r) => [r.rule?.id, r.rule]).filter(([id]) => id)).values()];
  return `
  <section class="soon" id="soon">
    <h2 class="sh">年龄到了，这些检查会变 <span>到年龄才加，到年龄要重定</span></h2>
    <ul>${rows.map(({ gap, kind, text, note }) => `<li>
      <b class="syear">${gap} 年后</b><b class="skind ${kind === '重定' ? 'kind-recheck' : ''}">${kind}</b>
      <span class="sbody"><span>${esc(text)}</span>${note ? `<small class="snote">${esc(note)}</small>` : ''}</span>
    </li>`).join('')}</ul>
    ${ctx && evRules.length ? evBoxHTML(
    evRules.flatMap((rule) => evRows(rule, ctx.href('soon-' + rule.id))),
    { href: ctx.href('soon-all'), hint: '到年龄才变，依据哪份指南', allText: '在依据页看这些项目的原文 ›' },
  ) : ''}
  </section>`;
};

/* ---------------- 每年都做的标准项 ---------------- */
const BASE_GROUPS = [
  { t: '抽血查的', ids: ['cbc', 'liver', 'renal', 'glucose', 'lipids', 'uric'] },
  { t: '留尿、留便查的', ids: ['urine', 'stool-routine', 'stool-ob'] },
  { t: '医生动手查的', ids: ['general', 'internal', 'surgery', 'eye', 'ent', 'dental'] },
  { t: '机器照的', ids: ['ecg', 'abd-us'] },
  { t: '按性别加的', ids: ['gyn-exam', 'pelvic-us', 'urinary-us'] },
  { t: '要你自己填的', ids: ['questionnaire'] },
];

/* 「标准项目」这一区原本只有一网格 chip，chip 上塞不下一句话。
 * 洁牙是个例外：它是每年一次、人人该做，但**体检套餐里通常没有**，得单独约。
 * 所以不塞进 chip（塞进去用户会以为到院就能洗），而是这一区末尾单独一条。
 *
 * 形态照抄 .atom 卡片（老板 2026-11-22：要和整页和谐统一）：
 * 标题 .an / 结论 .aw / 频次 .am>.af / 说明 .tip / 依据框。不放自造的 17px 大标题，
 * 也不放橙色提示块 —— 一页里只有这一项有自己的一套字号和底色，本身就是不和谐。
 */
const scalingHTML = (rule, ctx) => {
  if (!rule) return '';
  const rows = evRows(rule, ctx.href(rule.id));
  return `
  <div class="scaling" id="scaling">
    <p class="sc-kick">另外还有一项，通常要单独约</p>
    <article class="atom">
      <div class="an">${esc(rule.name)}</div>
      <p class="aw">${esc(rule.verdict)}</p>
      <div class="am"><span class="af">${esc(rule.frequency?.text || '')}</span></div>
      <p class="tip">${esc(rule.reason)}</p>
      ${tellDoctorHTML(rule)}
      ${evBoxHTML(rows, { href: ctx.href(rule.id), hint: '为什么每年洗一次' })}
    </article>
  </div>`;
};

export const baseHTML = ({ ids, baseRule, claimed, scaling }, ctx) => {
  if (!ids.length) return '';
  const used = new Set(BASE_GROUPS.flatMap((g) => g.ids));
  const other = ids.filter((id) => !used.has(id));
  /* 别名归一：FIT 和便潜血是同一项（catalog.json 的 sameAs）。
   * 上面专项里写的是「粪便免疫化学检测」，这里写的是「便潜血」——
   * 不归一的话，两者对不上，虚线永远不会出现（2026-11-23 修的就是这个）。 */
  const canon = (id) => catalogById.get(id)?.sameAs || id;
  const claimedKeys = new Set([...(claimed || [])].map(canon));
  const gs = BASE_GROUPS
    .map((g) => ({ ...g, ids: g.ids.filter((id) => ids.includes(id)) }))
    .filter((g) => g.ids.length);
  const chip = (id) => {
    const nm = (catalogById.get(id)?.name || id).replace(/（.*?）/g, '');
    return `<span class="chip${claimedKeys.has(canon(id)) ? ' dup' : ''}">${esc(nm)}</span>`;
  };
  const rows = baseRule ? evRows(baseRule, ctx.href('base-all')) : [];
  /* 虚线是"这一项上面已经说过"的记号。没有一项被打虚线时，那句解释就是无的放矢 ——
     老板走查时看到的正是这种空提示：文案在，虚线不在。 */
  const dup = ids.filter((id) => claimedKeys.has(canon(id))).length;
  return `
  <section id="yearly">
    <h2 class="sh">每年都做的标准 ${ids.length} 项 <span>这是每个人每年最基础的检查项目</span></h2>
    ${gs.map((g) => `<div class="bgrp"><h3>${esc(g.t)}<span>${g.ids.length}</span></h3><div class="chips">${g.ids.map(chip).join('')}</div></div>`).join('')}
    ${other.length ? `<div class="bgrp"><h3>其他<span>${other.length}</span></h3><div class="chips">${other.map(chip).join('')}</div></div>` : ''}
    ${dup ? '<p class="tip">带虚线的项目在专项里已经说过，同一项只做一次。</p>' : ''}
    ${evBoxHTML(rows, { href: ctx.href('base-all'), hint: '为什么"人人每年都查"', allText: '在依据页看这份目录的原文 ›' })}
    ${scalingHTML(scaling, ctx)}
  </section>`;
};

/* ---------------- 疫苗 ---------------- */
export const vacHTML = (list, ctx) => {
  if (!list.length) return '';
  const rows = list.map((v) => {
    const [label, cls] = v.source && v.source.grade ? ['官方指南', 'st-guide'] : ['官方指南', 'st-guide'];
    return {
      who: v.source?.org || '—',
      doc: v.source?.title || '',
      year: v.source?.year || '',
      label, cls,
      href: v.source?.url || '',
      ext: true,
    };
  });
  return `
  <section id="vac">
    <h2 class="sh">该打的疫苗 ${list.length} 支 <span>少得病，少吃药，少住院</span></h2>
    ${list.map((v) => `<div class="vrow">
      <div class="vl1"><b>${esc(v.name)}</b><span class="vdose">${esc(v.dose)}</span></div>
      <div class="vl2">${esc(v.who)}</div>
      <div class="vl3">${esc(v.gain)}</div>
    </div>`).join('')}
    ${ctx.vaccineWarn ? `<p class="tip">${esc(ctx.vaccineWarn)}</p>` : ''}
    ${evBoxHTML(rows, { href: ctx.href('vax-all'), hint: '疾控中心的技术指南' })}
  </section>`;
};

/* ---------------- 老年综合评估 ---------------- */
export const refHTML = (cards, ctx) => {
  if (!cards.length) return '';
  const src = ctx.cgaEvidence ? (Array.isArray(ctx.cgaEvidence) ? ctx.cgaEvidence : [ctx.cgaEvidence]) : [];
  const rows = src.map((e) => {
    const { who, doc } = splitOrg(e.org);
    const [label, cls] = stOf(e);
    return { who, doc, year: e.year || '', label, cls, href: ctx.href('cga-all'), ext: false };
  });
  return `
  <section id="ref">
    <h2 class="sh">尽快去医院进行老年综合评估 <span>老年综合评估要医生当面做</span></h2>
    ${cards.map((c) => `<article class="ref">
      <h3>${esc(c.title)}</h3>
      <p class="rw">${esc(c.why)}</p>
      <p class="rgo">去 <b>${esc(c.dept)}</b>${c.bring ? ` · ${esc(c.bring)}` : ''}</p>
    </article>`).join('')}
    ${ctx.refNote ? `<p class="tip">${esc(ctx.refNote)}</p>` : ''}
    ${evBoxHTML(rows, { href: ctx.href('cga-all'), hint: '中华医学会老年医学分会', note: '老年综合评估这条是专家共识。它不是"一项检查"，是一套由医生当面做的筛查流程。' })}
  </section>`;
};

/* ---------------- 「不用做」：默认收起 ---------------- */
export const foldHTML = (count, inner, extra = '') => !inner && !extra ? '' : `
  <section id="no" class="nofold">
    <details class="fold">
      <summary>
        <span class="fsum"><b>不用做 ${count} 项</b></span>
        <span class="fgo"></span>
      </summary>
      <div class="rows dim">${inner}</div>
      ${extra}
    </details>
  </section>`;

/* ---------------- 页尾：决策类型标签的解释（折叠） ----------------
 * 老板 2026-11-25：标签要在结果页底部有解释，折叠展示，不占地方。
 * 折叠件照抄 legendHTML 的样式（同一个 footer 里两种折叠件长得一样才和谐）。 */
export const decisionLegendHTML = () => `
  <details class="legend dlegend">
    <summary>卡片上的「预防 / 筛查 / 复查」是什么意思</summary>
    <dl>
      <div><dt><span class="dtag dt-prevent">预防</span></dt><dd>平时保养或一生一次的基线检查，没病也该做，比如基础体检、洁牙。</dd></div>
      <div><dt><span class="dtag dt-screen">筛查</span></dt><dd>还没生病时找早期线索。发现了能早处理，没发现也不代表万事大吉。</dd></div>
      <div><dt><span class="dtag dt-follow">复查</span></dt><dd>已经确诊某种病，按医生定的间隔定期查，看有没有变化。不是查一次就完。</dd></div>
    </dl>
    <p class="dlegend-n">这个标签只说"这是哪类事"，不影响该不该做——该不该做看它所在的那一档。</p>
  </details>`;

/* ---------------- 页尾：依据分类标准 ---------------- */
export const legendHTML = () => `
  <details class="legend">
    <summary>依据分类标准 —— 上面那些标签是什么意思</summary>
    <dl>
      <div><dt><span class="st st-strong">强推荐</span></dt><dd>指南明确建议做。有可靠证据显示做了能降低死亡率或发病率，收益明显大于代价。</dd></div>
      <div><dt><span class="st st-cond">个体化决定</span></dt><dd>指南明确说要你和医生商量后决定，取决于你的身体状况。建议咨询医生。</dd></div>
      <div><dt><span class="st st-against">不推荐</span></dt><dd>指南明确不建议作为常规筛查：对健康人弊大于利，或根本没有获益。</dd></div>
      <div><dt><span class="st st-ins">证据不足</span></dt><dd>缺少可靠研究，谁都说不准。</dd></div>
      <div><dt><span class="st st-guide">官方指南</span></dt><dd>国家机构发布的技术文件，比如中国疾控中心的疫苗接种技术指南。</dd></div>
      <div><dt><span class="st st-guide">专家共识</span></dt><dd>学会组织专家讨论形成的共识文件。它<b>不等于指南</b>。所以未标注为“强推荐”。</dd></div>
      <div><dt><span class="st st-guide">团体标准</span></dt><dd>行业协会发布的规范，约束的是机构怎么建、怎么做（比如体检中心该设哪些科室）。它不评价"你该不该查"。</dd></div>
      <div><dt><span class="st st-guide">工作规范</span></dt><dd>国家部门定的业务流程规范，说"谁来做、在哪做"（比如疫苗在接种单位打），同样不是筛查证据。</dd></div>
    </dl>
  </details>`;
