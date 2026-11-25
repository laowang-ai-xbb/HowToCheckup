// SPDX-License-Identifier: MIT
// Copyright (c) 2026 老王AI瞎bb
// See LICENSE at the repository root.

/**
 * 依据页（e.html）：每一条结论的出处、原话和链接。
 *
 * 为什么单独一页：结果页要"两分钟看完"，塞不下原文摘录。
 * 但"每条都能自己核"是这个产品的立身之处，所以必须有地方能查到 —— 一页就够。
 *
 * 画像从 #p= 里读（和结果页同一套编码，不发往服务器）：
 *   e.html#p=<code>&a=<ruleId>   带了 a 就滚到那一条。
 *
 * 手机：目录折在页首（30 多个锚点直接铺开会把正文推到十屏以外）。
 * PC：左边常驻索引，右边正文。
 */
import './styles.css';
import './v13.css';
import { evaluate, itemNames, catalogById, upcoming } from './engine.js';
import { decodeProfile, copyText } from './share.js';
import { vaccinesFor } from './engine.js';
import { referrals, CGA_EVIDENCE } from './referral.js';
import { bodyOf, BODY_EVIDENCE } from './body.js';
import { splitOrg, stOf, liveEv, evCount } from './evfmt.js';
import { legendHTML, titleOf, leanOf, whereHTML, whereBaseHTML } from './views13.js';
import { whereOf, whereExtra, BASE_WHERE, VAX_WHERE, WHERE_SOURCES, WHERE } from './where.js';
import { signLineEvidenceHTML } from './author.js';

const app = document.getElementById('app');

const esc = (s = '') => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const X = ' target="_blank" rel="noopener noreferrer"';

/* 一条飘一下就走的提示。页头分享和底部那个分享按钮共用，所以提出来一份。 */
const toast = (msg) => {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2200);
};

const profile = decodeProfile(location.hash || location.search);
const anchor = new URLSearchParams(String(location.hash).replace(/^#/, '')).get('a');

/* 链接里的 p 被截断/改坏时，不要假装"没有依据" —— 说清楚发生了什么 */
if (!profile) {
  app.innerHTML = `
    <main class="page v13">
      <header class="rhead">
        <h1>这一页需要一份清单</h1>
        <p class="sub">依据是按你的清单排的。这个链接里没有完整的清单信息（可能被截断了）。</p>
      </header>
      <p class="tip"><a href="./r.html">回到清单页 ›</a>　<a href="./index.html">重新填一份 ›</a></p>
    </main>`;
} else {
  render();
}

function render() {
  const raw = evaluate(profile);
  const A = raw.A.filter((r) => !r.hidden);
  const B = raw.B.filter((r) => !r.hidden);
  const C = raw.C.filter((r) => !r.hidden);
  const baseRules = A.filter((r) => /^base-package/.test(r.id));
  const baseIds = baseRules.flatMap((r) => r.catalogIds || []);
  const baseRule = baseRules.find((r) => r.id === 'base-package') || baseRules[0];
  const A_REST = A.filter((r) => !baseRules.includes(r));
  const list = [...A_REST, ...B, ...C];
  /* 结果页的「再过几年要加上」把规则年龄往后推重新判，这些规则当前不在 A/B/C 里。
     依据页得给它们留落点，否则结果页那张「依据 N 条」表里的链接会跳到空处。 */
  const soon = upcoming(profile, raw);
  const total = list.reduce((n, r) => n + evCount(r), 0)
    + soon.reduce((n, { rule }) => n + evCount(rule), 0);

  const vax = vaccinesFor(profile);
  const refs = referrals(profile);
  const body = bodyOf(profile);

  /* 一张卡 = 一条依据 */
  const card = (e) => {
    const { who, doc } = splitOrg(e.org);
    const [label, cls] = stOf(e);
    const quotes = liveEv({ evidence: [e] }).length
      ? (e.quotes || (e.quote ? [e.quote] : []))
      : [];
    return `<article class="evc">
      <div class="evh">
        <span class="st ${cls}">${esc(label)}</span>
        <span class="evorg">${esc(who)}</span>
        ${e.year ? `<span class="evy">${esc(e.year)}</span>` : ''}
      </div>
      ${doc && doc !== '见原文' ? `<h3 class="evdoc">${esc(doc)}</h3>` : ''}
      <p>${esc(e.point)}</p>
      ${quotes.map((q) => `<blockquote>${esc(q)}</blockquote>`).join('')}
      ${e.cite ? `<p class="evcite">${esc(e.cite)}</p>` : ''}
      ${e.url ? `<a href="${esc(e.url)}"${X}>原文链接 ›</a>` : ''}
    </article>`;
  };
  const cards = (rule) => liveEv(rule).map(card).join('');

  /* 一节的骨架：标题 → 结论 → 去哪做 → 为什么 → 能查出什么 → 依据卡
   * 「去哪做」放在结论后面、理由前面：读这一页的人十次有八次是来找"我该挂哪个号"的，
   * 不能让他先读三段"为什么"再往下找。 */
  /* 偏向只在依据页出现：它回答"为什么这么判"，不混进结果页的"我该做什么"。 */
  const leanBox = (rule) => {
    const label = leanOf(rule);
    return label ? `<div class="evlean"><span class="apick">${label}</span><span>${esc(rule.leanNote || '')}</span></div>` : '';
  };
  /**
   * 「这条检查是怎么回事」正文（老板 2026-11-25 定稿）：
   * 以前标题叫「它为什么在你清单里」，可这段讲的是指南/共识的通用道理（给医生看的判定标准），
   * 不是"因为你填了什么所以命中你"——名实不符，用户看不懂。改名后按句拆成圆点：
   * 前 3 句直接显示，超过 3 句折进 details，避免胃镜那条 259 字把整页撑成论文。
   * 为什么不用手写序号：项目早有规矩，圆点列宁愿不编号，也不手写①②③（维护会错序）。
   * 这段文字里的数字由 scripts/check-reason-source.mjs 对着证据快照校验，改错数字会被拦。
   */
  const whyBlock = (why) => {
    if (!why) return '';
    // 按句号 / 分号断句，保留句末标点；换行压掉，避免来源文本里的软换行拆碎句子
    const sentences = String(why).replace(/\s+/g, '')
      .split(/(?<=[。；!?！？])/).map((s) => s.trim()).filter(Boolean);
    if (sentences.length <= 3) {
      return `<div class="evr evwhy"><b>这条检查是怎么回事：</b><ul class="evwhy-l">${sentences
        .map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>`;
    }
    const head = sentences.slice(0, 3);
    const rest = sentences.slice(3);
    return `<div class="evr evwhy"><b>这条检查是怎么回事：</b><ul class="evwhy-l">${head
      .map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
      <details class="evwhy-more"><summary>展开剩下 ${rest.length} 句 ›</summary>
        <ul class="evwhy-l">${rest.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
      </details></div>`;
  };
  const sec = (id, title, verdict, why, inner, findings, where, lean = '') => `
    <section class="evsec" id="${id}">
      <h2>${esc(title)}</h2>
      ${verdict ? `<p class="evv">${esc(verdict)}</p>` : ''}
      ${lean}
      ${where || ''}
      ${whyBlock(why)}
      ${findings ? `<p class="evr"><b>能查出什么：</b>${esc(findings)}</p>` : ''}
      ${inner}
    </section>`;

  const vaxCards = vax.map((v) => `<article class="evc">
      <div class="evh">
        <span class="st st-guide">官方指南</span>
        <span class="evorg">${esc(v.source?.org || '—')}</span>
        ${v.source?.year ? `<span class="evy">${esc(v.source.year)}</span>` : ''}
      </div>
      ${v.source?.title ? `<h3 class="evdoc">${esc(v.source.title)}</h3>` : ''}
      <p><b>${esc(v.name)}</b> · ${esc(v.dose)} · ${esc(v.who)}。${esc(v.gain || '')}</p>
      ${v.source?.url ? `<a href="${esc(v.source.url)}"${X}>原文链接 ›</a>` : ''}
    </article>`).join('');

  const groups = [
    ['必做', A_REST], ['看你的情况', B], ['不用做', C],
  ];
  const tocLinks = groups.map(([t, l]) => (l.length
    ? `<p class="evtocg-t">${esc(t)}</p>${l.map((r) => `<a href="#${r.id}">${esc(titleOf(r))}</a>`).join('')}`
    : '')).join('') + `
    <p class="evtocg-t">另外几块</p>
    ${baseIds.length ? '<a href="#base-all">每年都做的标准项</a>' : ''}
    ${vax.length ? '<a href="#vax-all">疫苗</a>' : ''}
    ${refs.length ? '<a href="#cga-all">老年综合评估</a>' : ''}
    ${body.known || body.mode === 'shape' ? '<a href="#body-all">体型（BMI）</a>' : ''}
    ${soon.length ? '<a href="#soon-all">再过几年要加上</a>' : ''}`;

  app.innerHTML = `
  <main class="page v13">
    <header class="rhead">
      <div class="rwho">依据 · 共 ${total} 条</div>
      <h1>这些结论是哪来的</h1>
      <p class="sub">每一条都是公开指南或共识文件里的原文摘录。同时包含机构、年份、推荐的强度、原话、链接。</p>
      <div class="ev-actions">
        <button class="btn ghost" id="evback" type="button">← 回到你的清单</button>
        <button class="btn ghost" id="evshare" type="button">发给家人测一下</button>
      </div>
    </header>

    <details class="evtoc">
      <summary>按项目查看依据</summary>
      <div class="evtocg">${tocLinks}</div>
    </details>

    <div class="ev-layout">
      <nav class="evn" aria-label="项目目录">
        <p class="evnt">必做</p>
        ${A_REST.map((r) => `<a href="#${r.id}">${esc(titleOf(r))}</a>`).join('')}
        ${B.length ? '<p class="evnt">看情况</p>' : ''}
        ${B.map((r) => `<a href="#${r.id}">${esc(titleOf(r))}</a>`).join('')}
        ${C.length ? '<p class="evnt">不用做</p>' : ''}
        ${C.map((r) => `<a href="#${r.id}">${esc(titleOf(r))}</a>`).join('')}
        <p class="evnt">另外几块</p>
        ${baseIds.length ? '<a href="#base-all">每年都做的标准项</a>' : ''}
        ${vax.length ? '<a href="#vax-all">疫苗</a>' : ''}
        ${refs.length ? '<a href="#cga-all">老年综合评估</a>' : ''}
        <a href="#body-all">体型（BMI）</a>
        ${soon.length ? '<a href="#soon-all">再过几年要加上</a>' : ''}
      </nav>

      <div class="evbody">
        ${list.map((r) => sec(r.id, titleOf(r), r.verdict, r.reason, cards(r), r.whatItFinds, whereHTML(whereOf(r.id)), leanBox(r))).join('')}

        ${baseIds.length ? sec('base-all', `每年都做的标准 ${baseIds.length} 项`,
    '这是每个人每年最基础的检查项目。',
    `这 ${baseIds.length} 项来自基本体检项目目录，跟你个人风险无关 —— 所以它对所有人都一样，也所以它不占"必做"的名额。`,
    baseRule ? cards(baseRule) : '', '', whereHTML(BASE_WHERE) + whereBaseHTML(BASE_WHERE, baseIds)) : ''}

        ${vax.length ? sec('vax-all', '疫苗', '年龄到了，该打就要打，要相信科学。',
    '它和体检项目一样，都是希望你别生病少住院。这几支都是官方接种技术文件里写明的适龄人群。',
    vaxCards, '', whereHTML(VAX_WHERE)) : ''}

        ${refs.length ? sec('cga-all', '老年综合评估',
    '不是一项检查，是一套由医生当面做的筛查流程。',
    '摔倒、起身要扶、记性变差这三件事，靠化验单查不出来。老年综合评估要评估躯体功能、心理状态、用药和居住环境，产出是一份干预计划，不是一张异常指标单。',
    card(CGA_EVIDENCE), '', whereHTML(whereExtra('cga-all'))) : ''}

        ${sec('body-all', '体型（BMI 与腰围）', '按 BMI 落在哪一档给建议，不按体重给。',
    '超重和肥胖是高血压、糖尿病、血脂异常、冠心病和部分肿瘤共同的上游。体检套餐里的血压、血糖、血脂查的是结果，体型这一块看的是原因。',
    card(BODY_EVIDENCE), '', whereHTML(whereExtra('body-all')))}

        ${soon.length ? `
        <section class="evsec" id="soon-all">
          <h2>再过几年要加上</h2>
          <p class="evv">到年龄再加，提前做不增加获益，只增加假阳性。</p>
        </section>
        ${soon.map(({ rule, gap }) => `
        <section class="evsec" id="soon-${esc(rule.id)}">
          <h2>再过 ${gap} 年：${esc(titleOf(rule))}</h2>
          ${cards(rule)}
        </section>`).join('')}` : ''}

        ${WHERE_SOURCES.length ? `
        <div class="ev-actions evshare2">
          <button class="btn ghost" id="evshare2" type="button">发给家人测一下</button>
        </div>
        <section class="evsec evfold" id="where-all">
          <details>
            <summary><h2>去哪个科，这一栏是怎么定的</h2></summary>
            <p class="evv">${esc(WHERE.lead)}</p>
            <p class="evr">${esc(WHERE.leadNote)}</p>
            ${WHERE_SOURCES.map(card).join('')}
          </details>
        </section>` : ''}
      </div>
    </div>

    <footer class="disc">
      ${legendHTML()}
      <p><b>这不是医疗建议。</b>清单依据公开指南自动生成，不能替代医生面诊。</p>
      <p class="src">国家卫健委 · 国家癌症中心 · 中华医学会各分会 · 美国预防服务工作组（USPSTF）</p>
      <a class="totop-end" href="#top">↑ 回到顶部</a>
      ${signLineEvidenceHTML()}
    </footer>
  </main>
  <button class="totop" id="totop" type="button">↑ 回到顶部</button>
  ${/* 老板 2026-11-23 选方案 1：底部一颗胶囊，和右下角那颗「回到顶部」一左一右。
       依据页几十条，读到第 8 条想回清单，以前必须先滚回顶上 —— 手机上是七八下拇指。
       滚过一屏才淡入：刚进来的人不需要它（页头那颗就在眼前），读进去的人才需要。 */ ''}
  <button class="backfab" id="backfab" type="button">← 回到我的清单</button>`;

  wire();
}

function wire() {
  const btn = document.getElementById('totop');
  const back = document.getElementById('evback');

  /* 方案 A（老板 2026-11-23 拍板）：回清单只把画像码带回去，依据页锚点 a= 不带 ——
     回的是清单，不是依据页那一跳。页头那颗和底部悬浮那颗共用这一段：
     两个入口万一各写一遍，"带不带 a=" 这种细节迟早分叉。 */
  const goBack = () => {
    const raw = (location.hash || location.search).replace(/^[?#]/, '');
    const code = new URLSearchParams(raw).get('p');
    const url = new URL('r.html', location.href);
    if (code) url.hash = 'p=' + code;
    location.href = url.toString();
  };

  /* 两个浮件（回顶部 / 回清单）一起跟着滚动位置显隐：
   * 阈值不同是有意的 —— 「回到顶部」320px 就该出现（读两屏就想回去的人多），
   * 「回清单」要滚过一屏（400px）才出来，刚进来时页头那颗就在眼前，再冒一颗只是噪音。 */
  const fab = document.getElementById('backfab');
  const sync = () => {
    btn.classList.toggle('show', window.scrollY > 320);
    fab?.classList.toggle('show', window.scrollY > 400);
  };
  addEventListener('scroll', sync, { passive: true });
  sync();
  btn.addEventListener('click', () => {
    const soft = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    scrollTo({ top: 0, behavior: soft ? 'smooth' : 'auto' });
  });

  back?.addEventListener('click', goBack);
  fab?.addEventListener('click', goBack);

  /* 分享的是产品本身，不带这一份画像 —— 依据页只给拿到链接的人看，
     把 #p= 复制出去等于把别人的体检信息转发出去了。
     2026-11-23 老板要求：底部「去哪个科」模块前再放一个，和页头那个统一 ——
     两个按钮必须是同一段代码，否则文案/文案里的链接迟早会分叉。 */
  const doShare = async () => {
    const url = new URL('./', location.href).toString();
    const ok = await copyText(`你体检该做什么项目，来这免费查（依据国家权威指南），点击>> ${url}  一个想让你长命百岁的人`);
    toast(ok ? '已复制，发给家人' : '复制失败，请长按选择文字');
  };
  ['evshare', 'evshare2'].forEach((id) => {
    document.getElementById(id)?.addEventListener('click', doShare);
  });

  /* 目录吸顶后，点完某一项就折起来：展开的格子不该一直盖着正文 */
  const toc = document.querySelector('.evtoc');
  toc?.querySelectorAll('.evtocg a').forEach((a) => {
    a.addEventListener('click', () => { toc.open = false; });
  });

  /* 从结果页的「依据 N 条」跳过来时，锚点要落在卡片上方一点，不能贴在屏幕顶上 */
  if (anchor) {
    const el = document.getElementById(anchor);
    if (el) requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
  }
}
