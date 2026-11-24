// SPDX-License-Identifier: MIT
// Copyright (c) 2026 老王AI瞎bb
// See LICENSE at the repository root.

import './styles.css';
/* 结果页与依据页的排版件（老板 2026-11-22 定的那版「结论卡」）。
   这套版式先在设计稿里定稿，再搬进产品；结果页与依据页共用同一份样式文件，改一处要两边一起看。 */
import './v13.css';
import { emptyProfile, evaluate, evaluateDetailed, upcoming, ruleLabel, vaccinesFor, vaccineMeta, mutexNotes, rules as allRules } from './engine.js';
import { gateMessage, vaccinesDeferred } from '../scripts/lib/safety.mjs';
import { questions, activeQuestions, SHAPE_OPTIONS } from './questions.js';
import { bmiOf, bodyLevel, cutsFor, bodyOf, BODY_EVIDENCE } from './body.js';
import { decodeProfile, copyText, encodeProfile, decodeSnapshot, buildSnapshotEvidenceUrl, SNAPSHOT_VERSION } from './share.js';
import { readEnv, detectEnv, copyFor } from './env.js';
import { referrals, REFERRAL_NOTE, CGA_EVIDENCE } from './referral.js';
import { eggFor } from './egg.js';
import { signBarHTML, signLineResultHTML } from './author.js';
import fp from '../data/fingerprint.json' with { type: 'json' };
import { renderShareCard } from './share-image.js';
import { makePrintData, printSheet } from './print-sheet.js';
import { revealAboveKeyboard, keyboardLikelyOpen } from './keyboard.js';
import { evRows, evCount } from './evfmt.js';
import {
  atomHTML, tocHTML, baseHTML, vacHTML, refHTML, foldHTML, legendHTML,
  gapsTopHTML, soonHTML, evBoxHTML,
} from './views13.js';

const app = document.getElementById('app');

/* 端能力只算一次：它决定按钮给不给、文案怎么写。
   放在模块顶层而不是渲染函数里，是为了避免每次重绘都去问一遍 matchMedia。 */
const ENV = detectEnv(readEnv());
const UI = copyFor(ENV);

/**
 * 品牌三件套。
 * 「长命百岁」在上、「体检项目指南」在下：读的人先记住那句好话，
 * 搜索和口播靠下面那个词。上面那行是彩蛋的入口，会变。
 */
const BRAND = {
  mark: '长命百岁',
  name: '体检项目指南',
  slogan: '体检做什么项目，来这查',
};

const state = {
  profile: emptyProfile(),
  step: 0,
  view: 'start',
  fromShare: false,
  logoMark: BRAND.mark,
  logoTaps: 0,
  ageConfirmed: false,
  // 大字模式：只存在内存里。刷新会丢，这是刻意的 ——
  // 一旦落盘（localStorage / cookie），"我们不收集、不保存"这句话就要打折。
  bigText: false,
  // 哪些题用户真的动过。用来区分"从没答过"和"明确选了都没有" ——
  // 多选题的空数组在两种情况下长得一模一样，如果只靠值判断，
  // 一进题「都没有」就显示成已选中，等于替用户默认了"我家没人得过"。
  touched: new Set(),
  // 走到过的最远一题。用来判断"现在是正序答题还是回看"——
  // 回看时要给一个「下一步」，正序时不给（正序选中即走，多一个按钮只是干扰）。
  maxStep: 0,
  // 结果页内回补抽屉：补哪一题、题卡要不要保持展开、多选/体型的临时草稿。
  // 草稿和正式画像分开，是为了让人在点「保存」前随时收起，不留半截答案。
  gapKey: null,
  gapPanelOpen: false,
  gapDraft: null,
  // 彩蛋这一次会话里放过没有。刻意不落盘（localStorage）——
  // 一旦存下来，彩蛋就变成"每次打开都糊你一脸"的广告位，不再是彩蛋。
  eggSeen: false,
  // 当前这份清单的打印稿数据。结果页渲染时算好，点「打印」直接用，
  // 不在点击时重跑一遍引擎 —— 那会多一份判定逻辑，迟早和屏幕上的清单打架。
  printData: null,
  // 结果快照（v=2&s=，默认分享方式）：收到的人不含原始病史，直接按规则 ID 看同一份清单。
  // 一旦设置，renderResult 走"按 ID 还原"分支，不重跑引擎、不显示补答入口。
  snapshot: null,
  // 快照的原始 base64 code：依据页链接要原样带过去（避免重复编码产生差异）
  snapshotRaw: '',
};

const esc = (s = '') =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------- 大字偏好存 URL ----------------
 *
 * 为什么可以存，以及为什么不会带来衍生问题：
 *   1. 用 hash（#ls=big）不用 query —— hash 不发给服务器，也不进 CDN 日志；
 *      爬虫只按路径归类，`/` 和 `/#ls=big` 算同一个页面，不会变成重复内容。
 *   2. 分享链接由 buildShareUrl 重新拼 hash（只有 p=），所以不会把「大字」这个
 *      偏好传染给收到链接的人 —— 68 岁的人用大字，不代表他 30 岁的女儿也要用。
 *   3. 唯一代价是地址栏多一截。这个信息本来就是用户自己的，不算泄露。
 *   4. 它和 localStorage 的区别：地址栏里的东西，用户自己看得见、删得掉，
 *      而且关掉页面就没了（除非他把链接存下来）。"不保存"这句话依然成立。
 */
const applyLs = () => { document.documentElement.dataset.ls = state.bigText ? 'big' : ''; };

const lsFromUrl = () => {
  const raw = `${(location.hash || '').replace(/^#/, '')}&${(location.search || '').replace(/^\?/, '')}`;
  return new URLSearchParams(raw).get('ls') === 'big';
};

const writeLsToUrl = () => {
  const url = new URL(location.href);
  // 结果页的 hash 里还背着清单参数，重写时必须原样带上，否则一按大字清单就没了。
  // 快照链接是 v=2&s=...，画像链接是 p=...，两种都要保住原顺序和值。
  const raw = (location.hash || '').replace(/^#/, '');
  const parts = raw.split('&').filter((x) => x && !x.startsWith('ls='));
  if (state.bigText) parts.push('ls=big');
  url.hash = parts.join('&');
  history.replaceState(null, '', url.toString());
};

// 开局先把 URL 里的偏好读出来（放在函数定义之后，避免 TDZ）
state.bigText = lsFromUrl();
applyLs();
// 构建标识：线上排查时看 html[data-v] 就知道这份页面是哪次构出来的
document.documentElement.dataset.v = fp.id;

/* ---------------- 入口判定 ----------------
 *
 * 结果页有独立入口 r.html（写死 noindex），首页不放结果，避免个性化页被搜索引擎收录。
 *
 * 参数读 hash 优先：新版链接是 r.html#p=xxx，# 之后不发给服务器、不进 access log。
 * 回落到 search 只是为了不让旧链接（?p=xxx）失效。
 */
const isResultPage = /\/r\.html$/.test(location.pathname);
const rawParam = location.hash || location.search;
/* 快照优先：#v=2&s=... 是脱敏结果，只带规则 ID；老 #p= 是画像，继续重算。
 * 两者不会同时出现（buildShareUrl 二选一），这里先认快照再认画像。 */
const snap = decodeSnapshot(rawParam);
const restored = snap ? null : decodeProfile(rawParam);
const hasPayload = /[#?&]p=/.test(rawParam) || /[#?&]s=/.test(rawParam);

if (snap) {
  state.snapshot = snap;
  state.snapshotRaw = new URLSearchParams(String(rawParam).replace(/^[?#]/, '')).get('s') || '';
  // 快照里只有年龄/性别，足够渲染页头那句"N 岁·男/女"和疫苗；其余字段留空。
  state.profile.age = snap.age;
  state.profile.gender = snap.gender;
  state.view = 'result';
  state.fromShare = true;
} else if (restored) {
  Object.assign(state.profile, restored);
  state.view = 'result';
  state.fromShare = true;
} else if (isResultPage) {
  state.view = 'broken';
}

/* ---------------- 品牌 ----------------
 *
 * 彩蛋：点一下「万寿无疆」、两下「万岁万岁」、三下「仙人你有点贪心哦」。
 * 只改那一行文字，不整页重绘 —— 重绘会把滚动位置和焦点一起重置掉。
 */
const LOGO_LADDER = ['万寿无疆', '万岁万岁', '仙人你有点贪心哦'];
let logoTimer = 0;

const paintLogo = () => {
  const el = document.getElementById('brandMark');
  if (!el) return;
  el.textContent = state.logoMark;
  el.classList.toggle('wide', state.logoMark.length > 5);
};

const resetLogo = () => {
  state.logoTaps = 0;
  state.logoMark = BRAND.mark;
  paintLogo();
};

const tapLogo = () => {
  state.logoTaps += 1;
  clearTimeout(logoTimer);
  const i = state.logoTaps - 1;
  if (i < LOGO_LADDER.length) {
    state.logoMark = LOGO_LADDER[i];
  } else {
    state.logoTaps = 0;
    state.logoMark = BRAND.mark;
  }
  paintLogo();
  logoTimer = setTimeout(resetLogo, 2381);
};

const brandHTML = () => `
    <div class="brand" data-act="logo">
      <span class="brand-mark" id="brandMark">${esc(state.logoMark)}</span>
      <span class="brand-name">${esc(BRAND.name)}</span>
      <span class="brand-slogan">${esc(BRAND.slogan)}</span>
    </div>`;

/* ---------------- 链接不完整 ---------------- */
const renderBroken = () => {
  // 两种情况差别很大：链接被截断（有参数但解不出来）、压根没参数（直接进了结果页）。
  // 混成一句话会让第二种人以为"是链接坏了"，然后反复去点一个本来就没坏的东西。
  const cut = hasPayload;
  app.innerHTML = `
  <main class="screen">
    ${brandHTML()}
    <h1>${cut ? '这个链接<br /><em>不完整</em>' : '这里<br /><em>还没有清单</em>'}</h1>
    <p class="lede">${
      cut
        ? '分享的链接在转发时被截断了（微信里长链接常见）。让对方回到清单页，再点一次「复制分享给家人」，把整段文字一起发过来就行。'
        : '结果页要靠一份填好的清单才能打开。花一分钟填几道题，就生成了你自己的那一份。'
    }</p>
    <button class="btn primary big" data-act="restart">我自己填一份</button>
    <p class="foot">这个工具提供健康信息，<b>不是医疗建议</b>，最终请以医生意见为准。</p>
  </main>`;
};

/* ---------------- 首屏 ----------------
 *
 * 三个决定，各有各的理由：
 *
 * 1）h1 固定不轮播，只有下面那句解释在换。
 *    给搜索引擎看的标题如果每 5 秒变一次，爬虫抓到哪句说不准，搜索结果标题会来回跳。
 *    要新鲜感，就牺牲权重最低的那一行。
 *
 * 2）首屏直接填年龄，不再有「开始」按钮。
 *    少一次点击。首页本身就是第一题，填完直接进第二题。
 *
 * 3）轮播有三个停止条件：碰过输入框、滚过首屏、系统开了减少动效。
 *    手机没有 hover，没法靠"鼠标移开"暂停 —— 用户在读第三句时被切走，是最招人烦的体验。
 */
const LEDES = [
  '按你的年龄和身体情况，从权威指南里算出：哪些该做、哪些不用做。',
  '少花冤枉钱，避免过度检查，明明白白体检。',
  '项目查什么、多久一次、依据哪份指南，都说清楚。',
  '不用注册、无广告、不留手机号。免费出体检项目单。',
];

const FINGER = `<svg class="finger" viewBox="0 0 56 56" fill="none" aria-hidden="true">
  <g class="halo"><path class="halo-finger" d="M22 30V16a4 4 0 1 1 8 0v11"/><path d="M30 27v-4a3.4 3.4 0 1 1 6.8 0v6.5a11 11 0 0 1-11 11h-1.6a9 9 0 0 1-7.6-4.2L12 29.8a3.6 3.6 0 0 1 5.9-4.1L22 30"/></g>
  <g class="ln"><path class="ln-finger" d="M22 30V16a4 4 0 1 1 8 0v11"/><path d="M30 27v-4a3.4 3.4 0 1 1 6.8 0v6.5a11 11 0 0 1-11 11h-1.6a9 9 0 0 1-7.6-4.2L12 29.8a3.6 3.6 0 0 1 5.9-4.1L22 30"/></g>
</svg>`;

/* 首页不再显示「还剩 N 题」—— 老板第 10 条要求隐藏。
   题数本身就是压力；剩 13 题和剩 9 题，对老人来说都是"还很久"。
   进度感交给问卷页那根进度条。 */
let hintTimer = 0;

let ledeTimer = 0;

const startLedeRotation = () => {
  clearInterval(ledeTimer);
  const lede = document.getElementById('lede');
  const dots = document.getElementById('dots');
  if (!lede || !dots) return;

  // 系统开了「减少动态效果」，一句话都不轮 —— 对前庭敏感的人，闪动就是不适。
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  let i = 0;
  let stopped = false;
  const stop = () => { stopped = true; };

  const box = document.querySelector('.fcard');
  if (box) {
    box.addEventListener('pointerdown', stop, { once: true });
    box.addEventListener('focusin', stop, { once: true });
  }
  addEventListener('scroll', () => { if (window.scrollY > 200) stop(); }, { passive: true });

  ledeTimer = setInterval(() => {
    if (stopped || document.hidden) return;
    lede.classList.add('fade');
    setTimeout(() => {
      i = (i + 1) % LEDES.length;
      lede.textContent = LEDES[i];
      [...dots.children].forEach((d, k) => d.classList.toggle('on', k === i));
      lede.classList.remove('fade');
    }, 260);
  }, 5000);
};

/* ---------------- 首页页脚 ----------------
 * 点名的三个来源都链到机构官网，不链单篇：
 * 单篇会改版、会进付费墙、会 404，机构首页十年后还在。
 * 微信内不加 target=_blank —— 点开是白屏，像按钮坏了（同 extLink 的处理）。
 *
 * 老板 2026-11-20：「链接都不正确」+「给 uspstf 加上中文名」。逐条查过：
 *   ① 原来链的 cicams.ac.cn 是中国医学科学院肿瘤医院（官网上一屏招聘公告），
 *      不是国家癌症中心的筛查指南入口 —— 用户点进去找不到任何"筛查标准"。
 *      换成国家癌症防控平台（国家癌症中心主办），《中国肺癌/结直肠癌/胃癌筛查
 *      与早诊早治指南》都在那里的「下载专区」，这才是本产品真正的依据。
 *   ② 卫健委原来写的是 http:// 明文，改 https。政务网有 WAF，从境外/机房访问会
 *      返回 412、白屏，国内家庭宽带正常 —— 这条没法在 CI 里验，只能靠手点。
 *   ③ USPSTF 全站第一次出现必须给中文名，光写缩写等于让用户去猜。
 */
const SOURCES = [
  { name: '国家癌症中心', url: 'https://www.chinancpcn.org.cn/home' },
  { name: '国家卫健委', url: 'https://www.nhc.gov.cn/' },
  { name: '美国预防服务工作组（USPSTF）', url: 'https://www.uspreventiveservicestaskforce.org/uspstf/' },
];

const sourceLink = (s) =>
  `<a class="foot-link" href="${esc(s.url)}"${
    ENV.isWeChat ? '' : ' target="_blank" rel="noopener noreferrer"'
  }>${esc(s.name)}</a>`;

/* 致敬模块：结果页和首页共用一份文案，避免两处慢慢写岔 */
const CREDITS = [
  '内容依据国家卫生健康委员会、国家癌症中心、中华医学会各分会、美国预防服务工作组（USPSTF）的公开文件；分级方法借自 USPSTF 的 A/B/C/D/I 五级。',
  /* 2026-11-20 老板改名：杨圣 → 天才杨，小马哥 → 天才姚。别自作主张改回去。 */
  '梁圣的 DeepSeek、天才杨的 Kimi、唐圣的 GLM、天才姚的混元都有参与开发。',
];

const creditsHTML = (cls = '') => `
      <div class="credits${cls}">
        <p class="ctitle">站在谁的肩膀上</p>
        ${CREDITS.map((t) => `<p>${esc(t)}</p>`).join('')}
      </div>`;

const renderStart = () => {
  app.innerHTML = `
  <main class="screen home">
    ${/* 老板 2026-11-23 选方案 1：首页右上角一枚小胶囊，和品牌同一行、靠右。
         为什么不是页尾、不是主按钮下面：首页只有一件事要人做（填年龄看清单），
         分享是"顺手"不是"任务"，摆在视线上方但不抢焦点 —— 想发的人一眼看见，
         不想发的人不会被它挡路。 */ ''}
    <div class="homehead">
      ${brandHTML()}
      <button class="hshare" type="button" data-act="homeshare" aria-label="发你关心的人：复制一段话，发给家人">
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M5 11 11 5M6.2 5H11v4.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        发你关心的人
      </button>
    </div>
    <h1>今年体检<br /><em>该做哪几项？</em></h1>
    <p class="lede" id="lede">${esc(LEDES[0])}</p>
    <div class="dots" id="dots" aria-hidden="true">${LEDES.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>

    <div class="fcard">
      <p class="flabel">先填年龄</p>
      <div class="age-row">
        <input id="ageHome" class="age-input" type="text" inputmode="numeric" pattern="[0-9]*"
               maxlength="4" autocomplete="off" enterkeyhint="go"
               placeholder="输入你的年龄，譬如：18" aria-label="年龄"
               value="${state.profile.age || ''}" />
        <span class="age-unit">岁</span>
      </div>

      <p class="flabel flabel-2">性别</p>
      <div class="seg${state.profile.gender ? '' : ' seg-pulse'}" role="group" aria-label="性别">
        <button class="seg-b${state.profile.gender === 'male' ? ' on' : ''}" data-act="sex" data-v="male" aria-pressed="${state.profile.gender === 'male'}">男</button>
        <button class="seg-b${state.profile.gender === 'female' ? ' on' : ''}" data-act="sex" data-v="female" aria-pressed="${state.profile.gender === 'female'}">女</button>
      </div>

      <p class="err" id="age-err"></p>
      <p class="age-note" id="age-note"></p>
      <div class="btn-wrap">
        <button class="btn primary big" data-act="begin">查看项目清单</button>
        ${FINGER}
      </div>
      <p class="cap" id="home-cap">仅花 1 分钟，不注册，不收费，无广告，不收集隐私。</p>
    </div>

    <p class="foot">依据${SOURCES.map(sourceLink).join('、')}等公开指南，每条都能点开看出处。<br />这是健康信息工具，<b>不是医疗建议</b>，最终请以医生意见为准。</p>
    ${creditsHTML(' credits-home')}
    ${signBarHTML()}
  </main>`;

  const input = document.getElementById('ageHome');
  input.addEventListener('input', () => {
    input.value = input.value.replace(/[^0-9]/g, '').slice(0, 4);
    document.getElementById('age-err').textContent = '';
    document.getElementById('age-note').textContent = '';
    state.ageConfirmed = false;
    // 边输边看有没有填错，但只在停手 650ms 后才出声（见 peekAge）
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => peekAge(input), 650);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAge('ageHome'); });
  // 键盘弹上来会盖住「查看项目清单」：把整张卡片顶到可视区上方，
  // 让输入框和按钮都落在键盘之上，而不是只把输入框滚出来。
  input.addEventListener('focus', () => {
    document.querySelector('.screen')?.classList.add('kbd');
    setTimeout(() => revealAboveKeyboard(document.querySelector('.btn-wrap'), 130), 60);
  });
  input.addEventListener('blur', () => {
    document.querySelector('.screen')?.classList.remove('kbd');
  });

  startLedeRotation();
};

/* ---------------- 进度文案 ----------------
 * 按百分比分五段。最后一段要长一点，因为那时人最想放弃。
 */
const progressWord = (pct, total, step) => {
  if (pct < 20) return '一分钟就好';
  if (pct < 40) return '你手速真快';
  if (pct < 60) return '过半了';
  if (pct < 80) {
    const left = Math.max(total - step - 1, 1);
    return `只剩 ${left} 个了`;
  }
  return '最后一题，马上揭晓您的体检项目清单';
};

/* ---------------- 体型那题（J10 方案 2） ----------------
 *
 * 主路径是"算"：填身高体重，右边实时出 BMI 和档位，用户不用自己判断。
 * 两个逃生口都留了，而且通向两个不同的地方 —— 这是老板点名要的：
 *   不确定   → 记成 unknown，结果页「这份清单还不完整」里给一个回补入口；
 *   不方便说 → 不是跳过，是**降级**到方案 1：凭买衣服的感觉点一个。
 *
 * 65 岁以上多填腰围：同样有两个逃生口（在下面那两个按钮里）。
 * 为什么老人要加腰围：同样体重的老人，肌肉少、肚子大，只看 BMI 会被判成"正常"。
 */
const scaleHTML = (age) => {
  const c = cutsFor(age);
  /* 刻度条的物理范围固定 15–35，指针和刻度都按同一个比例摆 ——
   * 否则"20.0"和"26.9"两个数字会被读成条的两端，而它们其实在条的中段和偏右。 */
  const MINV = 15;
  const MAXV = 35;
  const pos = (v) => ((v - MINV) / (MAXV - MINV)) * 100;
  const seg = (from, to, cls) => `<i class="s ${cls}" style="flex:${Math.max(to - from, 0.1)}"></i>`;
  const adult = c.key === 'adult';
  const ticks = adult ? [c.low, c.high, c.obese] : [c.low, c.high];
  return `
    <div class="bscale">
      ${seg(MINV, c.low, 'low')}
      ${seg(c.low, c.high, 'ok')}
      ${seg(c.high, adult ? c.obese : MAXV, 'high')}
      ${adult ? seg(c.obese, MAXV, 'obese') : ''}
      <span class="ptr" id="ptr"></span>
    </div>
    <div class="sticks">
      ${ticks.map((v) => `<span style="left:${pos(v)}%">${v.toFixed(1)}</span>`).join('')}
    </div>`;
};

/* 降级态的题面说明：不能沿用"填两个数我替你算"——那一屏没有输入框可填 */
const BODY_SHAPE_HINT = '凭平时买衣服的感觉选一个';

const bodyQuizHTML = () => {
  const p = state.profile;
  const senior = Number(p.age) >= 65;

  /* 降级态：方案 1。四个选项只说买衣服的事，不出现偏瘦 / 正常 / 偏胖 / 肥胖。 */
  if (p.bodyMode === 'shape') {
    return {
      body: `${senior ? `<label class="field field-single"><span>腰围</span>
        <input id="bwa" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off"
               value="${p.bodyWaist || ''}" placeholder="老人肚子大、体重轻，腰围比体重更说明问题。" aria-label="腰围，厘米" /><i>厘米</i></label>` : ''}
      <div class="opts">${SHAPE_OPTIONS.map((o, i) => `
        <button class="opt${p.bodyShape === o.v ? ' on' : ''}" data-act="shape" data-i="${i}">
          <span class="opt-l">${esc(o.l)}</span>
          <span class="opt-sub">${esc(o.sub)}</span>
        </button>`).join('')}</div>
      <div class="none-row">
        <button class="btn ghost" data-act="body-bmi">还是填身高体重 ›</button>
        <button class="btn ghost" data-act="body-skip">这两个也不想选 ›</button>
      </div>
      `,
      mode: 'shape',
    };
  }

  return {
    body: `
    <div class="calc${senior ? ' calc-3' : ''}">
      <label class="field"><span>身高</span>
        <input id="bh" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off"
               value="${p.bodyHeight || ''}" aria-label="身高，厘米" /><i>厘米</i></label>
      <label class="field"><span>体重</span>
        <input id="bw" type="text" inputmode="decimal" maxlength="5" autocomplete="off"
               value="${p.bodyWeight || ''}" aria-label="体重，公斤" /><i>公斤</i></label>
      ${senior ? `<label class="field"><span>腰围</span>
        <input id="bwa" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off"
               value="${p.bodyWaist || ''}" placeholder="老人肚子大、体重轻，腰围比体重更说明问题。" aria-label="腰围，厘米" /><i>厘米</i></label>` : ''}
    </div>
    <div class="bmiout" id="bmiout">
      <div class="bminum"><b id="bval">—</b><small>BMI</small></div>
      ${scaleHTML(p.age)}
      <p class="bmtxt" id="bmtxt">${senior ? '填完三个数，这里会直接告诉你落在哪一档。' : '填完两个数，这里会直接告诉你落在哪一档。'}</p>
    </div>
    <button class="btn primary big" data-act="body-next">下一步</button>
    <div class="none-row">
      <button class="btn ghost" data-act="body-dunno">不确定</button>
      <button class="btn ghost" data-act="body-declined">不方便说</button>
    </div>
    `,
    mode: 'bmi',
  };
};

/* 腰围底纹：点进去就收起来，离焦且没填时再回来。
 * 只用 CSS 的 :focus::placeholder 在部分 WebView 里不生效 —— 老人用的正是这些浏览器，
 * 所以直接把 placeholder 属性摘掉，行为由 JS 兜底；CSS 那条留着做双保险。 */
const wireWaistPlaceholder = (el) => {
  if (!el) return;
  const text = el.getAttribute('placeholder') || '';
  if (!text) return;
  el.addEventListener('focus', () => { el.dataset.ph = text; el.removeAttribute('placeholder'); });
  el.addEventListener('blur', () => {
    if (!el.value && el.dataset.ph) {
      el.setAttribute('placeholder', el.dataset.ph);
      delete el.dataset.ph;
    }
  });
};

/** 体型那题的实时计算：只动读数和指针，不重绘 —— 重绘会把正在输的焦点和键盘一起弄丢 */
const wireBody = () => {
  const bh = document.getElementById('bh');
  const bw = document.getElementById('bw');
  const bwa = document.getElementById('bwa');
  /* 降级态（方案 1）里没有身高体重，只有给 65 岁以上留的那个腰围框 */
  if (!bh || !bw) {
    if (bwa) {
      bwa.addEventListener('input', () => {
        state.profile.bodyWaist = Number(bwa.value) || 0;
      });
      wireWaistPlaceholder(bwa);
    }
    return;
  }
  const p = state.profile;
  const paint = () => {
    p.bodyHeight = Number(bh.value) || 0;
    p.bodyWeight = Number(bw.value) || 0;
    if (bwa) p.bodyWaist = Number(bwa.value) || 0;
    paintBmi();
  };
  [bh, bw, bwa].forEach((el) => el && el.addEventListener('input', paint));
  wireWaistPlaceholder(bwa);
  bh.addEventListener('focus', () => revealAboveKeyboard(document.querySelector('[data-act="body-next"]'), 140));
  bw.addEventListener('focus', () => revealAboveKeyboard(document.querySelector('[data-act="body-next"]'), 140));
  paintBmi();
};

const paintBmi = () => {
  const p = state.profile;
  const val = document.getElementById('bval');
  const txt = document.getElementById('bmtxt');
  const ptr = document.getElementById('ptr');
  if (!val || !txt || !ptr) return;
  const bmi = bmiOf(p.bodyHeight, p.bodyWeight);
  if (bmi === null) {
    val.textContent = '—';
    ptr.style.left = '0%';
    txt.textContent = Number(p.age) >= 65
      ? '身高、体重填完就算出来（腰围可以留空）。'
      : '填完上面两个数，这里会直接告诉你落在哪一档。';
    txt.classList.remove('bad');
    return;
  }
  const lv = bodyLevel(bmi, p.age);
  val.textContent = bmi.toFixed(1);
  ptr.style.left = `${Math.max(0, Math.min(100, ((bmi - 15) / 20) * 100))}%`;
  txt.classList.remove('bad');
  txt.textContent = `${lv.label}。${lv.say}`;
};

/* ---------------- 填答 ---------------- */
let lastStep = -1;

const renderQuiz = () => {
  const qs = activeQuestions(state.profile);
  if (state.step >= qs.length) return renderResult();
  const q = qs[state.step];
  const total = qs.length;
  const pct = Math.round((state.step / total) * 100);
  const cur = state.profile[q.key];

  let body = '';
  const bodyQ = q.kind === 'body' ? bodyQuizHTML() : null;
  if (q.kind === 'age') {
    body = `
      <div class="age-row">
        <input id="age" class="age-input" type="text" inputmode="numeric" pattern="[0-9]*"
               maxlength="4" autocomplete="off" value="${cur ?? ''}" aria-label="年龄" />
        <span class="age-unit">岁</span>
      </div>
      <p class="err" id="age-err"></p>
      <p class="age-note" id="age-note"></p>
      <button class="btn primary big" data-act="age-next">下一步</button>`;
  } else if (q.kind === 'body') {
    body = bodyQ.body;
  } else if (q.kind === 'single') {
    body = `<div class="opts">` + q.options.map((o, i) => {
      const on = cur === o.v ? ' on' : '';
      return `<button class="opt${on}" data-act="pick" data-i="${i}">
        <span class="opt-l">${esc(o.l)}</span>
        ${o.sub ? `<span class="opt-sub">${esc(o.sub)}</span>` : ''}
      </button>`;
    }).join('') + `</div>`;
  } else {
    const dunno = cur === 'unknown';
    const arr = Array.isArray(cur) ? cur : [];
    body = `<div class="opts two-col">` + q.options.map((o, i) => {
      const on = arr.includes(o.v) ? ' on' : '';
      return `<button class="opt${on}" data-act="toggle" data-i="${i}" aria-pressed="${on ? 'true' : 'false'}">
        <span class="tick"></span><span class="opt-l">${esc(o.l)}</span>
      </button>`;
    }).join('') + `</div>
      <div class="none-row">
        <button class="btn ghost${state.touched.has(q.key) && arr.length === 0 && !dunno ? ' on' : ''}" data-act="none">${esc(q.noneLabel || '都没有')}</button>
        ${q.unknownLabel ? `<button class="btn ghost${dunno ? ' on' : ''}" data-act="dunno">${esc(q.unknownLabel)}</button>` : ''}
      </div>
      <button class="btn primary big" data-act="multi-next">下一步</button>`;
  }

  app.innerHTML = `
  <main class="screen">
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"
         aria-valuenow="${pct}" aria-label="填写进度">
      <div class="bar" style="width:${pct}%"></div>
    </div>
    <p class="pword">${esc(progressWord(pct, total, state.step))}</p>
    <div class="qmeta">
      <button class="back${state.step === 0 && state.exitArmed ? ' on' : ''}" data-act="back">‹ 上一题</button>
      ${/* 2026-11-24 老板发现：第一题点「上一题」没反应（原来是 disabled，点了毫无反馈，
           老人会以为坏了连点好几下）。改成他定的方案：第一次点出提示，再点一次才回首页。答案不丢 —— 回到首页年龄自动带出，重进问卷不用重填。 */ ''}
      <button class="ls" data-act="ls" aria-pressed="${state.bigText}">${state.bigText ? '标准字' : '大字'}</button>
    </div>
    ${state.step === 0 && state.exitArmed ? '<p class="back-hint" role="status">已经到第一题了，你想放弃长命百岁吗？<b>再点一次</b>回到长命百岁体检项目指南首页。</p>' : ''}
    <h2 class="qtitle" id="qtitle" tabindex="-1">${esc(q.title)}</h2>
    ${q.hint ? `<p class="qhint">${esc(q.kind === 'body' && state.profile.bodyMode === 'shape' ? BODY_SHAPE_HINT : q.hint)}</p>` : ''}
    ${body}
    ${/* 老板 2026-11-20 拍板：「这题跳过」全站删掉。
         它和「不确定」在结果页走的是同一条路（都记 unknown），两个按钮通向同一个结果，
         用户会在按钮前停下来想"跳过和不确定差在哪"，答案是没差。
         现在每道题都有明确的出口：选择题有「不方便说」，多选题有「都没有 / 不确定」。 */ ''}
    ${/* 回看时的补充「下一步」：只给题面自己没有主提交按钮的题。
          · age 自带 age-next、body 的 bmi 态自带 body-next、multi 自带 multi-next ——
            这三类再补一个就成两个「下一步」（老板 2026-11-22 走查发现年龄页/体重页重复）；
          · single 选中即走、题面没有按钮；body 的 shape 降级态也只有选项按钮 ——
            这两种回看时才确实缺一个"不改答案也能往下"的出口。 */ state.step < state.maxStep && !(
        q.kind === 'age' || q.kind === 'multi' || (q.kind === 'body' && state.profile.bodyMode !== 'shape')
      ) ? `<button class="btn primary big rev-next" data-act="review-next">下一步</button>` : ''}
  </main>`;

  // 换题时回到页首：手机屏矮，上题的长选项会让人以为新题从半截开始。
  // 多选那题不换题，只在原地重绘，所以不能跟着跳（否则点一下选项页面就往上窜）。
  const stepped = state.step !== lastStep;
  if (stepped) {
    lastStep = state.step;
    window.scrollTo(0, 0);
  }

  if (q.kind === 'age') {
    const input = document.getElementById('age');
    const note = document.getElementById('age-note');
    input.addEventListener('input', () => {
      input.value = input.value.replace(/[^0-9]/g, '').slice(0, 4);
      document.getElementById('age-err').textContent = '';
      note.textContent = '';
      state.ageConfirmed = false;
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => peekAge(input), 650);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAge(); });
    // 键盘弹起来会盖住「下一步」，把按钮滚到键盘上方
    input.addEventListener('focus', () => revealAboveKeyboard(document.querySelector('[data-act="age-next"]'), 140));
    if (stepped) input.focus({ preventScroll: true });
  } else if (q.kind === 'body') {
    if (document.getElementById('bh')) wireBody();
    if (stepped) document.getElementById('qtitle').focus({ preventScroll: true });
  } else if (stepped) {
    // 焦点移到题面：读屏用户换题后能听到"第几题、问什么"，而不是停在原来的位置
    document.getElementById('qtitle').focus({ preventScroll: true });
  }
};

/** 年龄分段：为什么要分四段，见 renderQuiz 里的 AGE_MSG */
const ageTier = (v) => {
  if (!Number.isInteger(v) || v < 0) return 'empty';
  // 0 岁单独一档：原来并进"请填一个年龄"，等于把"填了 0"和"没填"混成一句话
  if (v === 0) return 'zero';
  if (v < 18) return 'child';
  if (v < 120) return 'adult';
  if (v < 150) return 'sage';
  return 'year';
};

const AGE_MSG = {
  empty: '请填一个年龄',
  zero: '宝贝，你还没出生呀。你还在妇产科呢。',
  // 老板 2026-11-20 定稿：这句按他的原文，不改。
  child: '对不起，宝。这个工具只为 18 岁以上的人提供服务。这个年纪该查什么，直接去找儿科医生。',
  // 人类有记录的最长寿者是 122 岁（Jeanne Calment）。120 以上几乎必然是手滑，
  // 但"几乎必然"不等于"不可能"，所以这里只提示、不拦截。
  sage: '仙人，你也要体检？先看一眼身份证，确认不是手滑。确实是这个岁数的话，再点一次「下一步」，我照算。',
  // 去掉「宝」：同一屏上面那句已经叫过「仙人」，两个称呼连着出现会乱。
  year: '这里是填年龄哦，比如 18，不是出生年份。',
};

/* 边输边判：不用等到点按钮，但绝不打断打字。
 *
 * 两条硬约束，缺一条都会变成骚扰：
 *   ① 只输到 1 位数字时不判 —— 想填 52 的人，第一下打出来的是 5，
 *      这时候跳一句"18 岁以下"会让人以为填错了，然后他就退出去了。
 *   ② 停手 650ms 才判 —— "1" → "18" 中间那 200ms 不该闪一次红字。
 *
 * 只在三种"明显填错"时出声：太小、像出生年份、120 岁以上（只提醒不拦）。
 * 中间那些合法值一律沉默 —— 沉默也是一种反馈：没红字就是没错。
 */
const peekAge = (el) => {
  if (!el) return;
  const err = document.getElementById('age-err');
  const note = document.getElementById('age-note');
  if (!err || !note) return;
  const raw = String(el.value).trim();
  if (raw.length < 2) return;
  const tier = ageTier(Number(raw));
  if (tier === 'zero' || tier === 'child') { err.textContent = AGE_MSG[tier]; return; }
  if (tier === 'year') { err.textContent = AGE_MSG.year; return; }
  if (tier === 'sage') note.textContent = AGE_MSG.sage;
};

const submitAge = (inputId = 'age') => {
  const el = document.getElementById(inputId);
  if (!el) return;
  const err = document.getElementById('age-err');
  const note = document.getElementById('age-note');
  const raw = String(el.value).trim();
  const v = Number(raw);
  const tier = ageTier(raw === '' ? NaN : v);

  err.textContent = '';
  note.textContent = '';

  if (tier === 'empty') { err.textContent = AGE_MSG.empty; el.focus(); return; }
  if (tier === 'zero' || tier === 'child') { err.textContent = AGE_MSG[tier]; el.focus(); return; }
  if (tier === 'year') { err.textContent = AGE_MSG.year; el.focus(); return; }
  if (tier === 'sage' && !state.ageConfirmed) {
    note.textContent = AGE_MSG.sage;
    state.ageConfirmed = true;
    el.focus();
    return;
  }

  // 首页把性别也一起问了。没选就拦在这里 —— 乳腺、宫颈、前列腺相关的项目全靠它，
  // 默认成任何一个都会替用户表态。
  if (state.view === 'start' && !state.profile.gender) {
    err.textContent = '请选一下性别，乳腺、宫颈、前列腺相关的项目由它决定。';
    el.focus();
    return;
  }

  state.profile.age = v;
  state.ageConfirmed = false;

  // 首页填的年龄和性别：直接进下一题，不再有"开始"这一步。
  // step 用 findIndex 找，不写死 2 —— 以后谁在前面插一题，这里不会跟着错。
  if (state.view === 'start') {
    state.view = 'quiz';
    const qs = activeQuestions(state.profile);
    state.step = Math.max(qs.findIndex((q) => q.key !== 'age' && q.key !== 'gender'), 0);
    state.maxStep = state.step;
    lastStep = -1;
    state.touched.clear();
    render();
    window.scrollTo(0, 0);
    return;
  }

  next();
};

const next = () => {
  state.exitArmed = false; // 往前走一步，「再点一次回首页」的武装自动解除
  // 结果页回补不经过这里：它就地展开题卡，答完重算清单，不碰问卷 step。
  state.step += 1;
  state.maxStep = Math.max(state.maxStep, state.step);
  render();
};

/* ---------------- 结果 ----------------
 * 版式在 views13.js（结果页与依据页共用同一套零件）。这里只负责三件事：
 *   ① 取数：画像 → 引擎 → A/B/C、缺口、体型、疫苗、老年评估、再过几年；
 *   ② 总装：页头 / 目录 / 正文 / 页脚，顺序与 demo 完全一致；
 *   ③ 产品独有的东西：大字开关、彩蛋、缺口回补按钮、分享与打印。
 *
 * 一条规矩：正文只回答"我今年该做什么"。为什么、原文怎么写，收进每张卡的「依据 N 条」，
 * 或者点进依据页（e.html）看 —— 正文里不铺开。
 */
/* ---------------- 结果页内回补抽屉（B 方案） ----------------
 * 老板 2026-11-24 定的 B：不离开结果页，就地展开一题；答完这一题立刻收起，
 * 清单当场重算。草稿和正式画像分开 —— 用户点「先不补」时不能留下半截答案。
 */
const gapQuestion = (key) => questions.find((x) => x.key === key);
const gapBodyDraft = () => {
  const p = state.profile;
  return {
    bodyMode: p.bodyMode,
    bodyHeight: p.bodyHeight,
    bodyWeight: p.bodyWeight,
    bodyWaist: p.bodyWaist,
    bodyShape: p.bodyShape,
  };
};
const gapDraftOf = (key) => {
  if (key === 'body') return gapBodyDraft();
  const v = state.profile[key];
  return Array.isArray(v) ? [...v] : v;
};

const gapEditorHTML = (key) => {
  const q = gapQuestion(key);
  if (!q) return '';
  const d = state.gapDraft;
  let body = '';

  if (q.kind === 'single') {
    body = `<div class="geopts">${q.options.map((o, i) => `
      <button class="geopt${d === o.v ? ' on' : ''}" type="button" data-act="gap-pick" data-i="${i}">
        <span>${esc(o.l)}</span>${o.sub ? `<small>${esc(o.sub)}</small>` : ''}
      </button>`).join('')}</div>`;
  } else if (q.kind === 'multi') {
    const arr = Array.isArray(d) ? d : [];
    body = `<div class="geopts geopts-multi">${q.options.map((o, i) => {
      const on = arr.includes(o.v);
      return `<button class="geopt${on ? ' on' : ''}" type="button" data-act="gap-toggle" data-i="${i}" aria-pressed="${on}">
        <span class="getick"></span><span>${esc(o.l)}</span>
      </button>`;
    }).join('')}</div>
    <div class="genone">
      <button class="btn ghost" type="button" data-act="gap-none">${esc(q.noneLabel || '都没有')}</button>
      ${q.unknownLabel ? `<button class="btn ghost" type="button" data-act="gap-dunno">${esc(q.unknownLabel)}</button>` : ''}
      <button class="btn primary" type="button" data-act="gap-multi-save">保存并更新清单</button>
    </div>`;
  } else if (q.kind === 'body') {
    const bd = d && typeof d === 'object' ? d : gapBodyDraft();
    const waistPlaceholder = '老人肚子大、体重轻，腰围比体重更说明问题。';
    if (bd.bodyMode === 'shape') {
      body = `<div class="gefields">
        <label class="gefield"><span>腰围</span>
          <input id="gapwa" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off"
                 value="${bd.bodyWaist || ''}" placeholder="${esc(waistPlaceholder)}" aria-label="腰围，厘米" /><i>厘米</i>
        </label>
      </div>
      <div class="geopts geopts-shape">${SHAPE_OPTIONS.map((o, i) => `
        <button class="geopt${bd.bodyShape === o.v ? ' on' : ''}" type="button" data-act="gap-shape" data-i="${i}">
          <span>${esc(o.l)}</span><small>${esc(o.sub)}</small>
        </button>`).join('')}</div>
      <div class="genone">
        <button class="btn ghost" type="button" data-act="gap-body-bmi">还是填身高体重 ›</button>
        <button class="btn ghost" type="button" data-act="gap-body-skip">这两个也不想选 ›</button>
      </div>`;
    } else {
      body = `<div class="gefields">
        <label class="gefield"><span>身高</span>
          <input id="gapbh" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off"
                 value="${bd.bodyHeight || ''}" aria-label="身高，厘米" /><i>厘米</i>
        </label>
        <label class="gefield"><span>体重</span>
          <input id="gapbw" type="text" inputmode="decimal" maxlength="5" autocomplete="off"
                 value="${bd.bodyWeight || ''}" aria-label="体重，公斤" /><i>公斤</i>
        </label>
        <label class="gefield"><span>腰围</span>
          <input id="gapwa" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off"
                 value="${bd.bodyWaist || ''}" placeholder="${esc(waistPlaceholder)}" aria-label="腰围，厘米" /><i>厘米</i>
        </label>
      </div>
      <p class="gebmi">BMI <b id="gapbval">—</b><span id="gapbtxt">身高和体重填完就能算出来。</span></p>
      <div class="genone">
        <button class="btn primary" type="button" data-act="gap-body-save">保存并更新清单</button>
        <button class="btn ghost" type="button" data-act="gap-body-unknown">不确定</button>
        <button class="btn ghost" type="button" data-act="gap-body-shape">不方便说</button>
      </div>`;
    }
  }

  const hint = q.kind === 'body' && d && d.bodyMode === 'shape' ? BODY_SHAPE_HINT : q.hint;
  return `<div class="gapedit" data-key="${esc(key)}">
    <div class="gehead">
      <h3 tabindex="-1">${esc(q.title)}</h3>
      <button class="geclose" type="button" data-act="gap-close">先不补</button>
    </div>
    ${hint ? `<p class="gehint">${esc(hint)}</p>` : ''}
    ${body}
  </div>`;
};

const readGapBodyInputs = () => {
  const bd = state.gapDraft;
  if (!bd || typeof bd !== 'object') return;
  const h = document.getElementById('gapbh');
  const w = document.getElementById('gapbw');
  const waist = document.getElementById('gapwa');
  if (h) bd.bodyHeight = Number(h.value) || 0;
  if (w) bd.bodyWeight = Number(w.value) || 0;
  if (waist) bd.bodyWaist = Number(waist.value) || 0;
};

const paintGapBmi = () => {
  const bd = state.gapDraft;
  const val = document.getElementById('gapbval');
  const txt = document.getElementById('gapbtxt');
  if (!bd || !val || !txt) return;
  const bmi = bmiOf(bd.bodyHeight, bd.bodyWeight);
  if (bmi === null) {
    val.textContent = '—';
    txt.textContent = '身高和体重填完就能算出来（腰围可以留空）。';
    txt.classList.remove('bad');
    return;
  }
  const lv = bodyLevel(bmi, state.profile.age);
  val.textContent = bmi.toFixed(1);
  txt.textContent = lv.label + '。' + lv.say;
  txt.classList.remove('bad');
};

const wireGapEditor = () => {
  const key = state.gapKey;
  if (key !== 'body') return;
  const bd = state.gapDraft;
  if (!bd || bd.bodyMode === 'shape') {
    const waist = document.getElementById('gapwa');
    if (waist) {
      waist.addEventListener('input', () => { bd.bodyWaist = Number(waist.value) || 0; });
      wireWaistPlaceholder(waist);
    }
    return;
  }
  ['gapbh', 'gapbw', 'gapwa'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => { readGapBodyInputs(); paintGapBmi(); });
  });
  wireWaistPlaceholder(document.getElementById('gapwa'));
  paintGapBmi();
};

const closeGapEditor = () => {
  state.gapKey = null;
  state.gapDraft = null;
  app.querySelector('.gapedit')?.remove();
  app.querySelectorAll('.gbtn').forEach((b) => b.classList.remove('on'));
};

const insertGapEditor = (key) => {
  const box = app.querySelector('.gaps .gapbody');
  if (!box) return;
  closeGapEditor();
  state.gapKey = key;
  state.gapDraft = gapDraftOf(key);
  state.gapPanelOpen = true;
  box.insertAdjacentHTML('beforeend', gapEditorHTML(key));
  const trigger = app.querySelector(`.gbtn[data-key="${CSS.escape(key)}"]`);
  if (trigger) trigger.classList.add('on');
  wireGapEditor();
  const editor = box.querySelector('.gapedit');
  editor?.scrollIntoView({ block: 'nearest' });
  editor?.querySelector('h3')?.focus({ preventScroll: true });
};

const rerenderGapEditor = (focusI = -1) => {
  const key = state.gapKey;
  const box = app.querySelector('.gaps .gapbody');
  if (!key || !box) return;
  box.querySelector('.gapedit')?.remove();
  box.insertAdjacentHTML('beforeend', gapEditorHTML(key));
  wireGapEditor();
  if (focusI >= 0) {
    const again = app.querySelector(`.gapedit [data-i="${focusI}"]`);
    if (again) again.focus({ preventScroll: true });
  }
};

const afterGapSaved = () => {
  state.gapKey = null;
  state.gapDraft = null;
  state.gapPanelOpen = true;
  renderResult();
  requestAnimationFrame(() => {
    const box = app.querySelector('.gaps');
    if (!box) { state.gapPanelOpen = false; return; }
    box.open = true;
    box.scrollIntoView({ block: 'start' });
  });
};

const applyGapDraft = () => {
  const key = state.gapKey;
  const q = gapQuestion(key);
  if (!key || !q) return;
  if (q.kind === 'body' && state.gapDraft && typeof state.gapDraft === 'object') {
    const d = state.gapDraft;
    state.profile.bodyMode = d.bodyMode || 'bmi';
    state.profile.bodyHeight = Number(d.bodyHeight) || 0;
    state.profile.bodyWeight = Number(d.bodyWeight) || 0;
    state.profile.bodyWaist = Number(d.bodyWaist) || 0;
    state.profile.bodyShape = d.bodyShape || '';
  } else {
    state.profile[key] = state.gapDraft;
  }
  state.touched.add(key);
};

const handleGapAction = (act, btn) => {
  const q = gapQuestion(state.gapKey);
  if (!q) return;
  if (act === 'gap-close') { closeGapEditor(); return; }

  if (act === 'gap-pick') {
    state.gapDraft = q.options[Number(btn.dataset.i)].v;
    applyGapDraft();
    afterGapSaved();
    return;
  }
  if (act === 'gap-toggle') {
    const v = q.options[Number(btn.dataset.i)].v;
    const arr = Array.isArray(state.gapDraft) ? state.gapDraft : [];
    state.gapDraft = arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
    rerenderGapEditor(Number(btn.dataset.i));
    return;
  }
  if (act === 'gap-none') { state.gapDraft = []; applyGapDraft(); afterGapSaved(); return; }
  if (act === 'gap-dunno') { state.gapDraft = 'unknown'; applyGapDraft(); afterGapSaved(); return; }
  if (act === 'gap-multi-save') { applyGapDraft(); afterGapSaved(); return; }

  if (act === 'gap-body-unknown') {
    Object.assign(state.gapDraft, { bodyMode: 'unknown', bodyHeight: 0, bodyWeight: 0, bodyWaist: 0, bodyShape: '' });
    applyGapDraft(); afterGapSaved(); return;
  }
  if (act === 'gap-body-shape') {
    readGapBodyInputs();
    state.gapDraft.bodyMode = 'shape';
    rerenderGapEditor();
    return;
  }
  if (act === 'gap-body-bmi') {
    readGapBodyInputs();
    state.gapDraft.bodyMode = 'bmi';
    rerenderGapEditor();
    return;
  }
  if (act === 'gap-body-skip') {
    Object.assign(state.gapDraft, { bodyMode: 'declined', bodyHeight: 0, bodyWeight: 0, bodyWaist: 0, bodyShape: '' });
    applyGapDraft(); afterGapSaved(); return;
  }
  if (act === 'gap-shape') {
    state.gapDraft.bodyShape = SHAPE_OPTIONS[Number(btn.dataset.i)].v;
    state.gapDraft.bodyMode = 'shape';
    applyGapDraft(); afterGapSaved(); return;
  }
  if (act === 'gap-body-save') {
    readGapBodyInputs();
    if (bmiOf(state.gapDraft.bodyHeight, state.gapDraft.bodyWeight) === null) {
      const txt = document.getElementById('gapbtxt');
      if (txt) { txt.textContent = '身高和体重都填一下。不想填就点下面两个按钮。'; txt.classList.add('bad'); }
      return;
    }
    state.gapDraft.bodyMode = 'bmi';
    applyGapDraft(); afterGapSaved();
  }
};

/* ---------------- 病友彩蛋（EGG） ----------------
 *
 * 老板 2026-11-21 定的方案 3「进来那一瞬」：刚进结果页整屏 3 秒，点一下立刻进，
 * 之后收成顶部一条窄带，想看再点。
 *
 * 触发条件（2026-11-23 第 2 条扩了一条）：
 *   · 他自己勾了 癌症 / 阿尔茨海默病 / 心梗脑卒中  → 祝福说「祝你早日康复」；
 *   · 家族史勾了 癌症 / 阿尔茨海默病 / 心脏病       → 祝福说「祝你家人早日康复」。
 * 判定全在 src/egg.js，这里只负责画 —— 人称不能在这一层再判一次，否则两处迟早分叉。
 *
 * 三条规矩写在这里，因为页面上不能写：
 *   ① 不承诺疗效。祝福就是祝福。老板两次说「不是医嘱」那行小字一个字不留，
 *      所以这一块靠「不写任何承诺」来兜，而不是靠一句免责声明来兜 ——
 *      加了那句反而像在卖东西时先说"我不是卖东西的"。
 *   ② 可跳过、不重复。它挡在清单前面，而清单才是他来的目的。
 *   ③ 开了「减少动态效果」的人不做淡入：前庭敏感的人，闪一下就是不适。
 */
const eggBandHTML = () => {
  const egg = eggFor(state.profile);
  if (!egg) return '';
  return `
    <button class="eggband" data-act="egg-open" type="button">
      <span class="eggband-t">有句话想先说给你听</span>
      <span class="eggband-go">再看一次 ›</span>
    </button>`;
};

const closeEgg = () => {
  const veil = document.querySelector('.veil');
  if (!veil) return;
  clearTimeout(veil._eggTimer);
  veil.classList.remove('show');
  setTimeout(() => veil.remove(), 220);
};

const showEgg = () => {
  const egg = eggFor(state.profile);
  if (!egg || document.querySelector('.veil')) return;
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wrap = document.createElement('div');
  wrap.className = 'veil';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.setAttribute('aria-label', '一句话');
  wrap.innerHTML = `
    <div class="veil-in">
      <p class="veil-q">${esc(egg.zh)}</p>
      <p class="veil-who">${esc(egg.who)}</p>
      <p class="veil-where">${esc(egg.where)}</p>
      <p class="veil-wish">${esc(egg.wish)}</p>
      <p class="veil-sign">—— ${esc(egg.sign)}</p>
      <button class="veil-btn" data-egg="go" type="button">看看我的清单 ›</button>
    </div>`;
  // 点屏幕任何地方都算"跳过"：他急着看清单，不该被迫去找那个按钮
  wrap.addEventListener('click', closeEgg);
  document.body.appendChild(wrap);
  wrap.classList.add('show');
  if (calm) wrap.classList.add('calm');
  wrap._eggTimer = setTimeout(closeEgg, 3000);
  wrap.querySelector('[data-egg="go"]').focus({ preventScroll: true });
};

/* ---------------- 体型卡 ----------------
 *
 * 这一块在结果页里只做一件事：把他填的那两个数翻译成一句他能用的提示。
 * 它**不改变**上面 A/B/C 任何一条 —— 所以卡片里必须把这句话说出来，
 * 否则用户会以为"BMI 偏高"是清单的判定依据之一。
 *
 * 三种形态：
 *   填了数   → BMI + 档位 + 腰围（65+）+ 掉秤（65+）
 *   降级了   → 没有数字，只按他选的穿衣感觉给一句，并说明"所以这句不准"
 *   没填     → 不出这张卡，缺口回补区里点名（见 gaps）
 */
const SHAPE_SAY = {
  s: '你选的是「衣服总是买最小码」这一档。体重偏轻的人，如果最近没刻意减，值得查一次原因 —— 甲亢、吸收不良、情绪问题都会这样。',
  m: '你选的是「和大多数人差不多」这一档，不用为体重额外做什么。',
  l: '你选的是「要往上买大一码」这一档。按尺码估大概在偏高一档，体检时把血压、血糖、血脂一起看一遍。',
  xl: '你选的是「要买大两三码」这一档。基础套餐里的腹部超声、空腹血糖、血脂别省。',
};

/* 依据页的链接：同一份清单带过去，到了那一页看到的是同一批依据。
 * a= 是锚点（ruleId / base-all / vax-all / cga-all / body-all），落地直接滚到那一条。
 * 普通模式带画像（#p=）；快照模式带脱敏快照（#v=2&s=...）—— 依据页两种都能读。 */
const evPageHref = (id) => {
  if (state.snapshot) return buildSnapshotEvidenceUrl(state.snapshotRaw, id || '');
  const u = new URL('e.html', location.href);
  u.search = '';
  u.hash = 'p=' + encodeProfile(state.profile) + (id ? `&a=${id}` : '');
  return u.toString();
};

/* 体型这块的依据：一条，折叠放卡底。壳子跟项目卡的依据完全一致 —— 谁 / 文件 / 强度 / 原文。
 * 走 evRows + evBoxHTML 而不是自己写一套，是因为"同一份共识在两处写法不同"这件事
 * 一旦发生，读者会以为那是两份文件。 */
const bodyEvidenceHTML = () => {
  const href = evPageHref('body-all');
  return evBoxHTML(evRows({ evidence: [BODY_EVIDENCE] }, href), {
    href,
    hint: '中国营养学会肥胖防控分会',
    note: BODY_EVIDENCE.note,
  });
};

const bodyCardHTML = () => {
  const b = bodyOf(state.profile);
  const senior = Number(state.profile.age) >= 65;

  /* 降级态（选了「不方便说」）：没有数字，只按穿衣尺码估一句。
   * 不摆 BMI、不摆档位 —— 摆出来就是假精确。 */
  if (b.mode === 'shape') {
    return `
    <section class="bodyc" id="body">
      <h2 class="sh">体型 <span>没填身高体重，按穿衣尺码估的</span></h2>
      <p class="btxt">${esc(SHAPE_SAY[b.shape] || '这一项你选了不方便报数字，所以只能用穿衣尺码估一下，准不到哪去。')}</p>
      <p class="bfine">想算准：回问卷把身高体重填上，这一块会跟着变。</p>
      ${bodyEvidenceHTML()}
    </section>`;
  }

  if (!b.known) return '';

  const waist = b.waist && b.waist.over
    ? `<p class="btxt">${esc(b.waist.say)}</p>` : '';
  const adv = (b.advice || []).length
    ? `<ul class="badv">${b.advice.map((x) => `<li><b>${esc(x.t)}</b><span>${esc(x.d)}</span></li>`).join('')}</ul>`
    : '';
  return `
    <section class="bodyc" id="body">
      <h2 class="sh">体型 <span>按你这个年龄的标准，算${esc(b.label)}</span></h2>
      <p class="bline">
        <b>BMI ${esc(b.bmi.toFixed(1))}</b>
        <span class="blv lv-${esc(b.level)}">${esc(b.label)}</span>
        ${b.waist && b.waist.over ? '<span class="blv lv-high">腰围偏大</span>' : ''}
      </p>
      <p class="btxt">${esc(b.say)}</p>
      ${waist}
      ${adv}
      ${b.loss ? `<p class="btxt warn">${esc(b.loss.say)}</p>` : ''}
      ${bodyEvidenceHTML()}
      <details>
        <summary>这两个数怎么算的 · 界值哪来的</summary>
        <div class="detail">
          <p>BMI ＝ 体重（公斤）÷ 身高（米）的平方。举例：1.65 米、62 公斤 → 62 ÷ 1.65 ÷ 1.65 ＝ 22.8。</p>
          <p>${esc(b.range)}${senior ? '（65 岁以上的界值和年轻人不是一套：体重偏低的风险比微胖更大）' : ''}。18–64 岁用中国成人标准：低于 18.5 偏低，18.5–23.9 正常，24.0–27.9 偏高，28.0 起是肥胖；65–79 岁适宜范围 20.0–26.9，80 岁及以上 22.0–26.9 —— 老人太瘦的风险比微胖更大，所以界值整体往上抬，而且不再分"肥胖"这一档。</p>
          <p>腰围：男性 ≥90 厘米、女性 ≥85 厘米算中心性肥胖。近一年非计划掉体重超过 5%，是肌少症和消耗性疾病共同的红旗。</p>
        </div>
      </details>
    </section>`;
};

/* ---------------- 风险提示卡（不进清单）----------------
 * 这两张卡都是「你填了，所以必须回应」，但回应方式不是加检查：
 *   · 油烟：风险因素 + 可操作的防范动作；LDCT 交给医生评估。
 *   · AD 家族史：风险因素 + 症状警觉 + 就医出口；不推荐无症状人群自购筛查。
 * 两者都默认折叠：不抢 A/B/C 的注意力，想看的人自己点开。
 * 老板 2026-11-23 定稿文案，改这里即可，别在 renderResult 里另写一套。 */
const riskNoteHTML = (kind, p) => {
  if (kind === 'oil') {
    if (p.cookingOilFume !== 'yes') return '';
    return `
    <details class="risknote" data-note="oil">
      <summary>你长期接触油烟，需特别注意</summary>
      <div class="rnbody">
        <p>你「经常炒菜、长期接触油烟」。这是一个需要认真对待的风险。</p>
        <ol>
          <li><b>有症状或合并高危，立即去呼吸内科 / 胸外科评估</b>：咳血、胸痛、持续咳嗽，或有吸烟、二手烟、肺癌家族史时，让医生判断是否做 CT。</li>
          <li><b>抽油烟机早开晚关</b>：开火前开，关火后再跑 5–10 分钟。</li>
          <li><b>开窗通风、控制油温</b>：少煎炸，少让油冒烟；别反复用同一锅油。</li>
        </ol>
        <p class="rnsrc">依据：IARC 把高温煎炸排放列为 2A 类（可能对人类致癌）；2025 年中国肺癌防治相关文件把环境油烟吸入史列入高危问询，由医生评估是否年度低剂量 CT。</p>
      </div>
    </details>`;
  }
  const fh = p.familyHistory;
  const hasFH = Array.isArray(fh) && fh.includes('dementia');
  if (!hasFH || Number(p.age) < 65) return '';
  return `
    <details class="risknote" data-note="ad">
      <summary>你有痴呆家族史，需特别注意</summary>
      <div class="rnbody">
        <p>家族史会抬高你得阿尔茨海默病的风险</p>
        <p><b>什么情况该去看医生：</b>你自己觉得记性变差、算账困难、说话找词难，或家人发现迷路、重复提问、性格变化 — 去<b>记忆门诊 / 神经内科 / 老年精神科</b>正式评估。</p>
        <p><b>什么不要自己买：</b>APOE 检测、阿尔茨海默病血标志物、头颅 MRI，都不该作为无症状人群自己下单的筛查项目。血标志物目前只在已有客观认知损害者、由专科医生做诊断评估时使用。</p>
        <p><b>现在能做的：</b>控血压、睡好觉、规律运动、保持社交、不吸烟</p>
        <p class="rnsrc">依据：USPSTF 2020 认知障碍筛查 I 声明（≥65 岁无症状人群证据不足）；Alzheimer’s Association 2025 血标志物指南；ACMG / NSGC 对无症状 APOE 预测性检测的态度。</p>
      </div>
    </details>`;
};

/* ---------------- 「不建议做」模块内的套餐差异说明 ----------------
 * 与 C 档不是一回事：C 档说「指南明确不建议做」；这里说「机构套餐里有，本单没列为常规项」。
 * 老板 2026-11-23 拍板 8 类示例 + 三类原因 + 问医生三句话，原文照抄，别自行加解释。 */
const UNLISTED_ITEMS = [
  '冠脉 CTA / 冠脉钙化积分',
  '胶囊胃镜',
  'APOE / 阿尔茨海默病血标志物',
  '微量元素 / 免疫全套 / 凝血全套 / 骨代谢五项',
  '中医体质辨识 / 生物学年龄检测',
  '过敏原全套 / 食物不耐受检测',
  '消费级基因检测套餐（疾病风险 / 营养代谢 / 护肤）',
  '肿瘤标志物单项加项（CA72-4、NSE、CYFRA21-1 等）',
];
const unlistedHTML = () => `
  <div class="unlisted" data-block="unlisted">
    <h3>哪些机构套餐里有，但我们没提的项目</h3>
    <p class="ul-examples">例如：${UNLISTED_ITEMS.map((x, i) => `${i + 1}. ${x}`).join('；')}。</p>
    <p class="ul-lead">原因：</p>
    <ol class="ul-list">
      <li>证据不足：没有足够证据证明健康人常规做能获益。</li>
      <li>属诊断 / 随访：已经有症状或已确诊的人，由医生决定，不是体检套餐项。</li>
      <li>只对特定人群：高危职业、特定家族史或医生评估后才值得做，不能人人加。</li>
    </ol>
    <p class="ul-lead">建议问医生：</p>
    <ol class="ul-list">
      <li>这项对我有什么获益？依据哪份指南？</li>
      <li>不做会漏掉什么？做了异常下一步怎么处理？</li>
      <li>会不会带来穿刺、辐射、误诊和额外花费？</li>
    </ol>
  </div>`;

/* 当前这份清单里的「二选一」提示（ruleId → 一句话），renderResult 里算一次，itemCard 直接用 */
let MUTEX = new Map();

/* 走完问卷是在 index.html 这一页里直接换屏的，state.view 还停在 quiz。
 * 不在这里正名，结果页的「去补这一题」就过不了下面那道 view==='result' 的闸，
 * 点了没反应 —— 真浏览器验收过去只测 r.html 直入，正好把这条路径漏掉了。 */
const renderResult = () => {
  state.view = 'result';
  const p = state.profile;
  /* 安全后处理：C 档先抑制、LDCT 按 2025 版重判、三道筛查前提闸。
   * upcoming() 用同一份命中集，避免页面上出现"将来会加"与"现在不做"自相矛盾。 */
  /* 快照模式（v=2&s=）：接收方没有原始画像，也不重跑引擎。
   * 按快照里的规则 ID 从 rules.json 取回规则对象，还原出和原主人一致的清单。
   * 规则正文（verdict/依据/频次）一律现取，因此依据被修正后老快照也会显示更正后的版本。 */
  let raw, safety;
  if (state.snapshot) {
    const byId = new Map(allRules.map((r) => [r.id, r]));
    const restore = (ids) => ids.map((id) => byId.get(id)).filter(Boolean).map((r) => {
      const c = { ...r, shownIds: r.catalogIds ? [...r.catalogIds] : [], hidden: false, clinicalStatus: 'confirmed' };
      return c;
    });
    raw = { A: restore(state.snapshot.A), B: restore(state.snapshot.B), C: restore(state.snapshot.C) };
    safety = {
      version: SNAPSHOT_VERSION, gate: {},
      indeterminate: [], disputes: [], suppressed: [], facts: null,
      snapshotDate: state.snapshot.date,
    };
  } else {
    [raw, safety] = evaluateDetailed(p);
  }
  /* 被上游认领完项目的规则不渲染（同一项不许出现两次）。
   * 判定本身没变：规则还是一条条命中过，只是它的项目已经在上游卡片里说过了。 */
  const b = {
    A: raw.A.filter((r) => !r.hidden),
    B: raw.B.filter((r) => !r.hidden),
    C: raw.C.filter((r) => !r.hidden),
  };
  MUTEX = mutexNotes(b);
  // 快照模式下不预测"再过几年"：那需要完整画像往后推年龄重算，
  // 而快照只有年龄/性别和已定稿的清单，硬推会给出和原主人不一致的项目。
  const soon = state.snapshot ? [] : upcoming(p, raw);

  /* 「不知道」不等于「没有」。
   *
   * 这是这版最要紧的一处诚实：选了"不确定"的人和选了"没有"的人，拿到的清单是同一份，
   * 但心里的底气完全不同。不把这件事说出来，前者会以为自己已经查全了。
   * 所以把"因为不知道而没算进来"的项目一条条点名，并明确告诉他这不是"不用做"。
   */
  /* key 用来给「去补这一题」定位题目，没有 key 的缺口就只能靠用户自己回去找。
   *
   * 改成表驱动，是因为上一版是手写 if：只写了 unknown，漏了 declined
   * （hpStatus / alcohol / secondhand 这三题的「不方便说」一律不吭声），
   * 而且漏得很安静 —— 清单短了一截，页面上什么提示都没有。
   * 老板 2026-11-21 的原话是：不管选了「不确定」还是「不方便说」，都要留补答入口。
   * 所以这里只写一份表，两种值都走同一个循环。 */
  const GAP_SPECS = [
    { key: 'smoking', q: '吸烟情况', effect: '决定要不要做肺癌筛查（低剂量 CT）' },
    { key: 'secondhand', q: '二手烟暴露', effect: '决定肺癌筛查要不要再加严一层' },
    { key: 'occupationDust', q: '职业粉尘 / 石棉暴露', effect: '同样影响肺癌筛查' },
    { key: 'alcohol', q: '饮酒情况', effect: '影响肝脏相关的几个项目要不要加严' },
    { key: 'hpStatus', q: '幽门螺杆菌', effect: '决定胃镜从几岁开始、多久复查' },
  ];
  const gap = (unsure, key, q, effect, blank = false) => ({ unsure, key, q, effect, blank });
  const gaps = [
    ...GAP_SPECS.map(({ key, q, effect }) => {
      const v = p[key];
      /*  '' 是"这一题没答过"（emptyProfile 的默认值），不是"他说记不清"。
          两种都要给补答入口，但话不能混：替他认一句"你记不清"和
          替他认一句"你没查过"是同一个错误（老板 2026-11-23 抓到的那条）。 */
      if (v === '' || v === undefined || v === null) return gap(true, key, q, effect, true);
      if (v === 'unknown') return gap(true, key, q, effect);
      if (v === 'declined') return gap(false, key, q, effect);
      return null;
    }),
    /* 体型：只给"他自己选过"的两种情况开口子。
     * 老分享链接里压根没有这几个字段（那时还没有这道题），不能替他认一句
     * 「你选了不确定」—— 他连题都没见过。那种情况不提示，也不假装完整。 */
    (p.bodyMode === 'unknown' || p.bodyMode === 'declined')
      && gap(p.bodyMode !== 'declined', 'body', '身高体重', '算不出 BMI，就没法提示体重是偏低还是偏高'),
    /* 多选那两题没有「不方便说」，只有"都没有 / 不确定"两种，所以只认 unknown */
    p.familyHistory === 'unknown' && gap(true, 'familyHistory', '家族史', '有的话，肠镜和乳腺的起始年龄要提前 5–10 年'),
    p.pastHistory === 'unknown' && gap(true, 'pastHistory', '既往病史', '乙肝、糖尿病这些确诊病，查的是并发症，不是再筛一遍'),
  /* 快照模式没有任何原始答案，就没法判断"哪一题没答"。
   * 硬显示补答入口等于替原主人认一句"他没答"，是撒谎，直接不显示。 */
  ].filter(Boolean).filter(() => !state.snapshot);

  /* ---- 清单的三段，以及"标准套餐"那一条 ----
   * base-package 不是"一项检查"，它是一次基础套餐（二十来个子项）。
   * 它单独成段（标准项目），不占「必做」的名额 —— 否则必做的头三条会被它挤掉。 */
  const baseRules = b.A.filter((r) => /^base-package/.test(r.id));
  /* 洁牙也一样：它归「标准项目」那一档（每年一次、人人该做），但不进那 18 个 chip ——
   * 它不是体检套餐里的项目，塞进去用户会以为到院顺带就洗了。所以在那一区末尾单独成块。 */
  const scalingRule = b.A.find((r) => r.id === 'oral-scaling');
  const A_REST = b.A.filter((r) => !baseRules.includes(r) && r.id !== 'oral-scaling');
  const baseRule = baseRules.find((r) => r.id === 'base-package') || baseRules[0];
  const baseIds = baseRules.flatMap((r) => r.catalogIds || []);
  /* 上面已经说过的项目，在「标准项目」里打虚线点 —— 同一项只说一次，但也不假装它不存在。
   *
   * 2026-11-23 老板走查：「带虚线的几项…」这句提示在，虚线从来没有出现过。
   * 根因不是样式，是口径：这里原先只取 `shownIds`，而 shownIds 是**归一之后还要展示的**
   * 项目 —— 基础套餐优先级最高，先把「便潜血」「腹部超声」认领走了，专项规则那两项
   * 就变成 mergedInto，于是 claimed 恒空，虚线提示成了一句空话。
   *
   * 改成按规则**声明过的项目**（catalogIds）算，只保留落在标准项目里的那些：
   * 判定照旧不动，只有"这项上面说过"这个记号按声明算。
   * 同 id 归一见 catalog.json 的 sameAs（FIT ≡ 便潜血），否则别名认不出来。 */
  const baseIdSet = new Set(baseIds);
  const claimed = new Set(
    [...A_REST, ...b.B, ...b.C]
      .flatMap((r) => r.catalogIds || [])
      .filter((id) => baseIdSet.has(id)),
  );

  // 筛查前提不满足时，疫苗同样不能"到年龄就打"地照发：接种门诊要先看当下身体状况
  const vacs = vaccinesDeferred(safety) ? [] : vaccinesFor(p);
  // 转诊卡、体型提示都是"针对原主人具体情况"的派生内容，快照里没有那些原始答案，
  // 硬算会给出和原主人不一致、甚至凭空多出来的卡片。快照模式一律不显示。
  const refs = state.snapshot ? [] : referrals(p);
  const gateText = gateMessage(safety);
  /* 分歧说明不再放顶部模块（老板 2026-11-24 定的口径）：写进具体那条项目卡内。
   * dispute.key 对应规则 id 前缀（如 lung-ldct → lung-ldct-*），卡片渲染时按 id 认领。 */
  const disputeTextFor = (ruleId) => {
    const hit = safety.disputes.find((d) => ruleId.startsWith(d.key));
    return hit ? hit.text : '';
  };
  const safetyHTML = `
    ${gateText ? `<div class="safety-gate" role="status">${esc(gateText)}</div>` : ''}
    ${safety.indeterminate.length ? `<div class="safety-indet" role="status">
      <b>有几项还算不出来</b>
      <p>${safety.indeterminate.map((x) => `${esc(x.q)}：${esc(x.fields.join('、'))}。${esc(x.effect)}`).join('；')}</p>
    </div>` : ''}`;
  /* 打印稿用屏幕上的同一份判定结果，不重新算引擎。
   * 顺序按定稿：A 表第一行是基础项目，之后是专项、洁牙；明细另起一页。 */
  state.printData = makePrintData(p, {
    aRules: [baseRule, ...A_REST, scalingRule],
    bRules: b.B,
    cRules: b.C,
    baseIds,
    vacs,
    refs,
  });
  const ctx = {
    href: evPageHref,
    mutex: MUTEX,
    cgaEvidence: CGA_EVIDENCE,
    refNote: REFERRAL_NOTE,
    vaccineWarn: vaccineMeta.severeWarn,
    disputeFor: disputeTextFor,
  };

  /* 目录按清单实况生成：没有疫苗就不出现「疫苗」那一格。
   * 摆一个点进去空着的入口，比不摆更让人怀疑这份清单。 */
  const SECS = [
    { id: 'must', label: '必做', n: A_REST.length },
    { id: 'maybe', label: '看你的情况', n: b.B.length },
    { id: 'yearly', label: '标准项目', n: baseIds.length },
    { id: 'vac', label: '疫苗', n: vacs.length },
    { id: 'ref', label: '老年评估', n: refs.length },
    { id: 'no', label: '不用做', n: b.C.length },
  ].filter((x) => x.n > 0);

  const body = bodyOf(p);
  /* 页首那句"序号是什么意思"，得跟清单实际有几件对上：
   * 30 岁的男性必做只有两项，写"三件"就是在说一件不存在的事。
   * 一件都没有（全落在"看你的情况"里）时，这句整句不出。 */
  const sumHint = A_REST.length >= 3
    ? '标了序号的三件最不能省，排在必做最前面'
    : A_REST.length ? '带序号的这几件最不能省，排在必做最前面' : '';

  app.innerHTML = `
  <main class="screen result v13">
  <div class="doc">
    <header class="rhead">
      <div class="rwho">${p.age} 岁 · ${p.gender === 'female' ? '女' : '男'}${body.bmi ? ` · BMI ${body.bmi.toFixed(1)}` : ''}</div>
      <h1>今年该查什么</h1>
      ${/* 页首不放"共 N 项：必做 X、你来定 Y、不做 Z"（老板 R10 删的）：
           那串数字跟下面目录格子里的数字是同一件事，摆两遍等于没摆。
           只留这句"序号是什么意思"，因为它是唯一不重复的信息。 */ ''}
      ${sumHint ? `<p class="sum-hint">${sumHint}</p>` : ''}
      ${/* 50+ 女性不再常规问备孕题；但绝经前/辅助生殖仍可能怀孕，所以留一句兜底，
           既不拿不合场景的问题打扰 78 岁老人，也不假装 50 岁以后绝对不会怀孕。 */
        p.gender === 'female' && Number(p.age) >= 50
          ? '<p class="preg-note">如果已经怀孕或正在做辅助生殖，请按产科医生安排，不要用这份常规清单。</p>'
          : ''}
      <button class="ls ls-result" data-act="ls" aria-pressed="${state.bigText}">${state.bigText ? '标准字' : '大字'}</button>
      ${state.fromShare ? '<p class="shared-tip">这是别人分享给你的清单。<button class="linkish" data-act="restart">测份自己的 ›</button></p>' : ''}
      ${gapsTopHTML(gaps, {
        open: state.gapPanelOpen,
        editor: state.gapKey ? gapEditorHTML(state.gapKey) : '',
      })}
      ${!state.snapshot ? eggBandHTML() : ''}
    </header>

    ${tocHTML(SECS)}
    ${safetyHTML}

    <div class="docbody">
      <section id="must">
        <h2 class="sh">必做 <span>有明确证据支持：做了能少得病、少死人</span></h2>
        <div class="rows">${A_REST.map((r, i) => atomHTML(r, i + 1, i < 3, ctx)).join('')}</div>
        ${/* 老板 2026-11-20 选的布局方案 3：按钮跟着段落走。
             刚看完"要做什么"是最想存下来的时刻，按钮就长在这儿，不在页尾。 */ ''}
        <button class="btn primary big seg-cta" data-act="share-img">存成一张图，发给家人</button>
        <p class="seg-tip">这张单子可以直接发给家人。</p>
      </section>

      ${b.B.length ? `
      <section id="maybe">
        <h2 class="sh">看你的情况 <span>指南没替你拍板：做不做，取决于你的年龄、家族史和身体状况。建议咨询医生。</span></h2>
        <div class="rows">${b.B.map((r) => atomHTML(r, 0, false, ctx)).join('')}</div>
      </section>` : ''}

      ${baseHTML({ ids: baseIds, baseRule, claimed, scaling: scalingRule }, ctx)}
      ${!state.snapshot ? riskNoteHTML('oil', p) : ''}
      ${vacHTML(vacs, ctx)}
      ${refHTML(refs, ctx)}
      ${!state.snapshot ? bodyCardHTML() : ''}
      ${!state.snapshot ? riskNoteHTML('ad', p) : ''}
      ${foldHTML(b.C.length, b.C.map((r) => atomHTML(r, 0, false, ctx)).join(''), unlistedHTML())}
      ${soonHTML(soon, ctx)}

      <div class="actions">
        <button class="btn primary" data-act="share-img">存成一张图，发给家人</button>
        ${UI.showPrint ? '<button class="btn ghost" data-act="print">打印 / 存成 PDF</button>' : ''}
        <button class="btn ghost" data-act="share">${esc(UI.shareBtn)}</button>
        <button class="btn ghost" data-act="restart">重新填一遍</button>
        ${/* 手机和微信里 window.print 基本无效，所以不给按钮。但"想打印"这个念头不会消失，
             与其让他到处找，不如直接告诉他替代路径。 */ ''}
        ${UI.showPrint ? '' : '<p class="print-tip">想打印：点上面的「存成一张图」，拿去打印店或单位打印机。</p>'}
      </div>
    </div>
  </div>

  <button class="totop" data-act="totop" aria-label="回到顶部">↑<span class="totop-t">回到顶部</span></button>

  <footer class="disclaim">
    <p><b>这不是医疗建议。</b>清单依据公开指南自动生成，不能替代医生面诊。已确诊疾病、正在服药、或近期有不适的人，请直接找医生。</p>
    ${legendHTML()}
    ${creditsHTML()}
    <!-- 页尾再放一个：读到最底下想回去的时候，浮动那颗容易被忽略（PC 尤其），
         这个就是最朴素的锚点，不依赖滚动位置。 -->
    <p class="toend"><button class="linkbtn" data-act="totop" type="button">↑ 回到顶部</button></p>
    ${signLineResultHTML()}
  </footer>
  </main>`;
  lastStep = -1;
  window.scrollTo(0, 0);
  paintToc();
  syncTocHeight();

  /* 进结果页的那一瞬放一次。只在第一次 —— 补完一题回来看结果时不该再挡一遍。 */
  if (!state.eggSeen && eggFor(p)) {
    state.eggSeen = true;
    showEgg();
  }
};

/* 手机上目录吸顶后，锚点跳转要把标题让开这块高度。
 * 目录格数随清单变化（2~6 格，可能一两行），写死像素一定会挡住标题；
 * 每次结果页渲染和窗口尺寸变化时实测一次。 */
const syncTocHeight = () => {
  const toc = app.querySelector('.doc > .toc');
  if (!toc) return;
  requestAnimationFrame(() => {
    document.documentElement.style.setProperty('--toc-h', `${Math.ceil(toc.getBoundingClientRect().height)}px`);
  });
};
window.addEventListener('resize', syncTocHeight, { passive: true });

/* ---------------- 目录跟着读到哪里亮到哪里 ----------------
 * 目录不只是"能点"，还要告诉人"我现在读到哪一段了" —— 内容长到七八屏时，
 * 有这个高亮，人才知道自己还剩多少。IntersectionObserver 不可用就什么都不做，
 * 不要把目录做成只能点、不能反馈的样子还留个假状态。
 */
let tocIO = null;
const paintToc = () => {
  if (tocIO) { tocIO.disconnect(); tocIO = null; }
  const links = [...app.querySelectorAll('.toc a[href^="#"]')];
  if (!links.length || !('IntersectionObserver' in window)) return;
  const map = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));
  const seen = new Map();
  tocIO = new IntersectionObserver((rows) => {
    rows.forEach((r) => seen.set(r.target.id, r.isIntersecting ? r.intersectionRatio : 0));
    let best = null;
    let top = 0;
    for (const [id, ratio] of seen) if (ratio > top) { top = ratio; best = id; }
    if (!best) return;
    links.forEach((a) => a.classList.toggle('on', a === map.get(best)));
  }, { rootMargin: '-15% 0px -60% 0px', threshold: [0, 0.2, 0.5, 1] });
  map.forEach((_, id) => { const el = document.getElementById(id); if (el) tocIO.observe(el); });
};

/* ---------------- 分享 ----------------
 *
 * 一条清单要能用两种方式发出去，缺一不可：
 *   图   —— 微信里长按就能转发，而且链接会失效、图不会；
 *   文字 —— 带 r.html#p= 的链接，收到的人点一下就能看到完整清单，
 *           这是唯一能把人带回产品的路径。所以两条都要，不是二选一。
 */
/* 复制文字和分享图共用一个名字来源：规则上的 displayName。
 * 以前这里另算一遍，才会把「（每年一次的基础套餐）」带进剪贴板。 */
const shareLabel = (r) => ruleLabel(r);

const shareLines = () => {
  const b = evaluate(state.profile);
  const toItem = (r, withFreq) => ({ label: shareLabel(r), freq: withFreq ? r.frequency.text : '' });
  return {
    buckets: b,
    a: b.A.filter((r) => !r.hidden).map((r) => toItem(r, true)),
    b: b.B.filter((r) => !r.hidden).map((r) => toItem(r, true)),
    c: b.C.filter((r) => !r.hidden).map((r) => toItem(r, false)),
  };
};

/** 默认分享链接：产品首页（老板 2026-11-24 定的口径）。
 *  链接里不带画像、不带快照、不带任何答案 —— 收到的人自己进来测一份，
 *  这是把"隐私"问题从根上拿掉：没有传输，就没有泄露。 */
const buildDefaultShareUrl = () => {
  const url = new URL('./', location.href);
  url.search = '';
  url.hash = '';
  return url.toString();
};

const buildShareText = () => {
  const p = state.profile;
  const { a, b, c } = shareLines();
  const line = (it) => `· ${it.label} —— ${it.freq}`;
  const parts = [`我按「长命百岁体检项目指南」测了一份体检清单（${p.age} 岁，${p.gender === 'female' ? '女' : '男'}）`, ''];
  if (a.length) parts.push(`建议做 ${a.length} 项：`, ...a.map(line), '');
  if (b.length) parts.push(`你来定 ${b.length} 项：`, ...b.map(line), '');
  if (c.length) parts.push(`建议不做 ${c.length} 项：`, ...c.map((it) => `· ${it.label}`), '');
  parts.push('', `看看这份清单：${buildDefaultShareUrl()}`);
  parts.push('（依据公开指南生成，不是医疗建议）');
  return parts.join('\n');
};

/** 图出来以后弹一层：图 + 一句"长按图片"的操作提示 + 文字已复制的回执 */
const showImageSheet = (dataUrl, copied) => {
  const wrap = document.createElement('div');
  wrap.className = 'sheet';
  wrap.innerHTML = `
    <div class="sheet-mask" data-act="close-sheet"></div>
    <div class="sheet-body" role="dialog" aria-modal="true" tabindex="-1" aria-label="分享图">
      <p class="sheet-hint">${ENV.isWeChat ? '长按图片 → 发送给朋友' : '长按图片保存，或截图发给家人'}</p>
      <img class="sheet-img" src="${dataUrl}" alt="我的体检项目清单" />
      <p class="sheet-note">${copied ? '清单文字和链接也已经复制好了，可以粘到聊天框里。' : '这张图不含任何个人信息，只有清单本身。'}</p>
      <button class="btn ghost" data-act="close-sheet">完成</button>
    </div>`;
  // 这一层挂在 body 上，不在 #app 里，所以事件要自己接
  wrap.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="close-sheet"]')) closeSheet();
  });
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('show'));
  wrap.querySelector('.sheet-body').focus({ preventScroll: true });
};

const closeSheet = () => {
  const wrap = document.querySelector('.sheet');
  if (!wrap) return;
  wrap.classList.remove('show');
  setTimeout(() => wrap.remove(), 200);
};

const toast = (msg) => {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2200);
};

/* ---------------- 事件 ---------------- */
app.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;

  // 彩蛋优先：它出现在首屏和断链页，那两页没有题目可读
  if (act === 'logo') { tapLogo(); return; }

  // 结果页的回补抽屉自己吃自己的事件，绝不落到问卷分支 —— 一落到问卷，
  // 就会回到"补一题跳出结果页"的老路，老板已经明确不要。
  if (state.view === 'result' && act === 'goto') { insertGapEditor(btn.dataset.key); return; }
  if (state.view === 'result' && /^gap-/.test(act)) { handleGapAction(act, btn); return; }

  const qs = activeQuestions(state.profile);
  const q = qs[state.step];

  if (act === 'start') { state.view = 'quiz'; state.step = 0; lastStep = -1; state.touched.clear(); render(); return; }
  if (act === 'begin') { submitAge('ageHome'); return; }
  if (act === 'sex') {
    // 只切按钮样式，不整页重绘 —— 重绘会把用户已经输了一半的年龄清空
    state.profile.gender = btn.dataset.v;
    document.querySelectorAll('.seg-b').forEach((b) => {
      const on = b.dataset.v === state.profile.gender;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    // 选完就停呼吸：动效是为了"让人知道要点"，不是装饰
    document.querySelector('.seg')?.classList.remove('seg-pulse');
    document.getElementById('age-err').textContent = '';
    return;
  }
  if (act === 'totop') { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  if (act === 'ls') {
    state.bigText = !state.bigText;
    applyLs();
    writeLsToUrl();
    render();
    return;
  }
  if (act === 'close-sheet') { closeSheet(); return; }
  if (act === 'egg-open') { showEgg(); return; }
  if (act === 'age-next') { submitAge(); return; }
  if (act === 'review-next') { next(); return; }
  if (act === 'back') {
    if (state.step > 0) { state.step -= 1; render(); return; }
    /* 第一题再往回是首页。不直接跳：老人可能只是手滑，直接退出等于把问卷没收。
       第一次点只给提示，再点一次才回（2026-11-24 老板定的交互与文案）。
       profile 不清空：回首页年龄性别自动带出，重进问卷不用重填。 */
    if (state.exitArmed) {
      state.view = 'start';
      state.exitArmed = false;
      render();
      window.scrollTo(0, 0);
      return;
    }
    state.exitArmed = true;
    render();
    return;
  }
  if (act === 'pick') {
    const opt = q.options[Number(btn.dataset.i)];
    state.profile[q.key] = opt.v;
    state.touched.add(q.key);
    next();
    return;
  }
  /* ---- 体型（J10 方案 2）：三条出口各走各的路，别合并 ---- */
  if (act === 'body-next') {
    if (bmiOf(state.profile.bodyHeight, state.profile.bodyWeight) === null) {
      const t = document.getElementById('bmtxt');
      if (t) {
        t.textContent = '身高和体重都填一下吧。如果不想填就点下面两个按钮，别卡在这。';
        t.classList.add('bad');
      }
      return;
    }
    state.profile.bodyMode = 'bmi';
    state.touched.add('body');
    next();
    return;
  }
  if (act === 'body-dunno') {
    // 「不确定」是可补的：清掉半截数字，结果页留入口让他回头补
    state.profile.bodyMode = 'unknown';
    state.profile.bodyHeight = 0;
    state.profile.bodyWeight = 0;
    state.profile.bodyWaist = 0;
    state.touched.add('body');
    next();
    return;
  }
  if (act === 'body-declined') {
    // 「不方便说」不是跳过，是降级换问法 —— 留在这一屏，改成方案 1
    state.profile.bodyMode = 'shape';
    state.profile.bodyHeight = 0;
    state.profile.bodyWeight = 0;
    state.profile.bodyWaist = 0;
    render();
    window.scrollTo(0, 0);
    return;
  }
  if (act === 'body-bmi') {
    state.profile.bodyMode = 'bmi';
    render();
    window.scrollTo(0, 0);
    return;
  }
  if (act === 'body-skip') {
    state.profile.bodyMode = 'declined';
    state.profile.bodyShape = '';
    state.touched.add('body');
    next();
    return;
  }
  if (act === 'shape') {
    state.profile.bodyShape = SHAPE_OPTIONS[Number(btn.dataset.i)].v;
    state.profile.bodyMode = 'shape';
    state.touched.add('body');
    next();
    return;
  }
  if (act === 'toggle') {
    const opt = q.options[Number(btn.dataset.i)];
    const cur = new Set(Array.isArray(state.profile[q.key]) ? state.profile[q.key] : []);
    if (cur.has(opt.v)) cur.delete(opt.v); else cur.add(opt.v);
    state.profile[q.key] = [...cur];
    state.touched.add(q.key);
    render();
    // 重绘会重建按钮，焦点掉回 body；把它还给刚点的那个，键盘用户才不用每点一次重新 Tab 一遍
    const again = app.querySelector(`[data-act="toggle"][data-i="${btn.dataset.i}"]`);
    if (again) again.focus({ preventScroll: true });
    return;
  }
  if (act === 'none') { state.profile[q.key] = []; state.touched.add(q.key); next(); return; }
  if (act === 'dunno') { state.profile[q.key] = 'unknown'; state.touched.add(q.key); next(); return; }
  if (act === 'multi-next') {
    // 一道都没勾就点下一步 = 没答，记成"不确定"，不要默认成"都没有"
    const cur = state.profile[q.key];
    if (Array.isArray(cur) && cur.length === 0 && !state.touched.has(q.key) && q.unknownLabel) {
      state.profile[q.key] = 'unknown';
    }
    state.touched.add(q.key);
    next();
    return;
  }
  if (act === 'restart') {
    // 在结果页上，重新填必须真的回到首页：否则 URL 里那个 p 参数还在，一刷新又跳回旧清单
    if (isResultPage) { location.replace('./'); return; }
    state.profile = emptyProfile();
    state.step = 0;
    lastStep = -1;
    state.view = 'start';
    state.fromShare = false;
    state.ageConfirmed = false;
    state.touched.clear();
    writeLsToUrl(); // 保留大字偏好，只清掉清单参数
    render();
    return;
  }
  if (act === 'share') {
    const ok = await copyText(buildShareText());
    toast(ok ? UI.shareToast : '复制失败，请长按选择文字');
    return;
  }
  /* 首页那枚「发你关心的人」：复制的是老板定稿的整段话 + 产品入口（不带任何画像）。
   * 和依据页那颗同一个口径 —— 分享的是产品，不是"我这份清单"：
   * 首页还没有清单，也没理由让别人以为收到的是自己那份。 */
  if (act === 'homeshare') {
    const url = new URL('./', location.href).toString();
    const ok = await copyText(`该体检啦，体检该做什么项目，去这免费查下（依据国家权威指南），入口>> ${url}  一个想让你长命百岁的人`);
    toast(ok ? '已复制，发给家人' : '复制失败，请长按选择文字');
    return;
  }
  if (act === 'share-img') {
    const p = state.profile;
    const { a, b, c } = shareLines();
    // 手机上画 750px 的图要几十毫秒，给个即时反馈，免得用户以为没点上
    btn.disabled = true;
    btn.textContent = '正在生成…';
    let dataUrl = null;
    try {
      dataUrl = renderShareCard({
        ageLine: `${p.age} 岁 · ${p.gender === 'female' ? '女' : '男'}`,
        groups: [
          { title: 'A · 建议做', color: '#0f766e', items: a },
          { title: 'B · 你来定', color: '#b45309', items: b },
          { title: 'C · 建议不做', color: '#8a857a', items: c },
        ],
      });
    } catch {
      dataUrl = null;
    }
    btn.disabled = false;
    btn.textContent = '存成一张图，发给家人';
    if (!dataUrl) { toast('图生成失败了，用下面那个按钮复制文字也一样'); return; }
    // 图出来了，顺手把文字和链接复制好 —— 用户常要再配一句"妈你看看这个"
    const copied = await copyText(buildShareText()).catch(() => false);
    showImageSheet(dataUrl, copied);
    return;
  }
  if (act === 'print') {
    // 只会在真桌面出现（见 env.js），微信和手机不给这个入口。
    // 打印版式：两页 A4、结论在前、明细在后。
    // 万一还没渲染出结果页（不太可能，但链接直进时防御一下），退回浏览器原生打印。
    if (state.printData) printSheet(state.printData);
    else window.print();
    return;
  }
});

/**
 * 清掉"因为上一题改答案而变得不该存在"的答案。
 *
 * 实际踩到的坑：用户先答"吸烟=是 → 20 包年"，退回去把吸烟改成"不吸"，
 * 那个 20 包年还留在画像里，肺癌筛查照样触发 —— 用户被推荐了基于他已否认事实的检查。
 * 依赖题一旦被隐藏，答案必须清零，不能只是"不显示"。
 */
const resetHidden = () => {
  const visible = new Set(activeQuestions(state.profile).map((q) => q.key));
  const base = emptyProfile();
  for (const q of questions) {
    if (visible.has(q.key)) continue;
    const cur = state.profile[q.key];
    const def = base[q.key];
    if (JSON.stringify(cur) !== JSON.stringify(def)) state.profile[q.key] = def;
    // 被隐藏的题，"动过没动过"也一起清掉，否则下次再露出来会带着上一次的选中态
    state.touched.delete(q.key);
  }
};

const render = () => {
  resetHidden();
  if (state.view === 'start') renderStart();
  else if (state.view === 'quiz') renderQuiz();
  else if (state.view === 'broken') renderBroken();
  else renderResult();
};

// 分享图那一层是模态：Esc 要能关，不然键盘用户被困在里面
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeSheet(); closeEgg(); }
});

/* 回到顶部：滑过一屏多就出现（原来是两屏，PC 上要滚 1800px 才露头，
 * 老板直接以为没有这个按钮）。用 rAF 节流 —— 滚动事件每秒能来上百次，
 * 每次都查 DOM 会让低端安卓掉帧，而这批用户正好是我们要照顾的人。 */
let topTick = false;
addEventListener('scroll', () => {
  if (topTick) return;
  topTick = true;
  requestAnimationFrame(() => {
    topTick = false;
    const el = document.querySelector('.totop');
    if (el) el.classList.toggle('show', window.scrollY > Math.min(600, window.innerHeight * 0.8));
  });
}, { passive: true });

/* 同一个标签页里从一份清单跳到另一份（改 hash 不会重新加载页面）。
 * 不监听的话，地址栏变了、页面还是旧的那份 —— 用户会以为链接点错了。
 * 这是唯一一处"页面能被内部改变输入"的入口，所以也要重新走一遍白名单校验。 */
addEventListener('hashchange', () => {
  if (!isResultPage) return;
  const next = decodeProfile(location.hash);
  if (!next) return;
  state.profile = { ...emptyProfile(), ...next };
  state.view = 'result';
  state.fromShare = true;
  render();
});

render();
