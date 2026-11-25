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

const esc = (s = '') => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

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

/** 一条规则的依据框：表格指到依据页对应锚点 */
export const ruleEvBox = (rule, ctx) => {
  const n = evCount(rule);
  if (!n) return '';
  return evBoxHTML(evRows(rule, ctx.href(rule.id)), { href: ctx.href(rule.id) });
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
    ${soft ? `<p class="tip">${FREQ_BASIS[rule.frequency.basis] || ''}${rule.frequency.basisNote ? '：' + esc(rule.frequency.basisNote) : ''}</p>` : ''}
    ${rule.recentlyDone ? '<p class="tip"><b>你填了最近做过这项：</b>这次可以先不做，是否真的跳过请和医生确认。</p>' : ''}
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

/* ---------------- 再过几年 ----------------
 * 老板 2026-11-23 走查：标题去「的」、上方空隙收紧、模块要有依据、样式跟整页统一。
 * 依据直接取这些"将来会命中"的规则自己的证据 —— 预告不是拍脑袋推的年龄线，
 * 是同一份规则把年龄往后推几年重新判出来的，依据必须跟规则走。 */
export const soonHTML = (soon, ctx = null) => !soon || !soon.length ? '' : `
  <section class="soon" id="soon">
    <h2 class="sh">再过几年要加上 <span>到年龄再加，提前做不增加获益</span></h2>
    <ul>${soon.map(({ rule, gap }) => `<li><b class="syear">${gap} 年后</b><span>${esc(titleOf(rule))}</span></li>`).join('')}</ul>
    <p class="tip">不提前做。提前做不增加获益，只增加假阳性。</p>
    ${ctx ? evBoxHTML(
    soon.flatMap(({ rule }) => evRows(rule, ctx.href('soon-' + rule.id))),
    { href: ctx.href('soon-all'), hint: '到年龄才加，依据哪份指南', allText: '在依据页看这些项目的原文 ›' },
  ) : ''}
  </section>`;

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
    ${dup ? '<p class="tip">带虚线的几项在上面专项里已经说过 —— 同一项只说一次。</p>' : ''}
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
    <h2 class="sh">去医院进行老年综合评估 <span>老年综合评估要医生当面做</span></h2>
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

/* ---------------- 页尾：依据分类标准 ---------------- */
export const legendHTML = () => `
  <details class="legend">
    <summary>依据分类标准 —— 上面那些标签是什么意思</summary>
    <dl>
      <div><dt><span class="st st-strong">强推荐</span></dt><dd>指南明确建议做。有可靠证据显示做了能降低死亡率或发病率，收益明显大于代价。</dd></div>
      <div><dt><span class="st st-cond">个体化决定</span></dt><dd>指南没替所有人拍板：获益和代价接近，要看你的年龄、家族史和个人意愿。建议咨询医生。</dd></div>
      <div><dt><span class="st st-against">不推荐</span></dt><dd>指南明确不建议作为常规筛查：对健康人弊大于利，或根本没有获益。</dd></div>
      <div><dt><span class="st st-ins">证据不足</span></dt><dd>缺少可靠研究，谁都说不准 —— 我们也不替你猜。</dd></div>
      <div><dt><span class="st st-guide">官方指南</span></dt><dd>国家机构发布的技术文件，比如中国疾控中心的疫苗接种技术指南。</dd></div>
      <div><dt><span class="st st-guide">专家共识</span></dt><dd>学会组织专家讨论形成的共识文件。它<b>不等于指南</b>，我们也不把它写成"强推荐"。</dd></div>
      <div><dt><span class="st st-guide">团体标准</span></dt><dd>行业协会发布的规范，约束的是机构怎么建、怎么做（比如体检中心该设哪些科室）。它不评价"你该不该查"。</dd></div>
      <div><dt><span class="st st-guide">工作规范</span></dt><dd>国家部门定的业务流程规范，说"谁来做、在哪做"（比如疫苗在接种单位打），同样不是筛查证据。</dd></div>
    </dl>
  </details>`;
