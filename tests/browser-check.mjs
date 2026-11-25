#!/usr/bin/env node
/**
 * 真浏览器验收（Chrome DevTools Protocol，无第三方依赖）
 *
 * 为什么要它：页面跑在浏览器里，Node 层的单测证明不了「点下去有没有反应」。
 * 这里用真实的 Chrome：按 iPhone 尺寸渲染、点按钮、填年龄、看结果、验分享链接，
 * 同时量一遍有没有横向溢出（手机上最常见的破版）。
 *
 * 除了功能，还覆盖「上线包」和「真机上才暴露的破版」：
 *   - 结果页 r.html 是否写死 noindex、首页是否可被收录、旧 ?p= 链接是否跳转
 *   - 字体放大 1.3 倍（微信会强制放大）、360px 小屏、深色模式、弱网首屏、底部安全区
 *
 * 测不了的（只能真机看）：微信 X5 / WKWebView 内核差异、系统输入法、真实刘海屏安全区。
 * 那些交给 /selftest.html 在手机上跑。
 *
 * 用法：
 *   npm run build && npm run preview        # 另开一个终端保持运行
 *   node tests/browser-check.mjs            # 默认打构建产物 http://127.0.0.1:4173
 *   BASE=http://127.0.0.1:5173 node tests/browser-check.mjs   # 打 dev（og:image 等构建期替换项会跳过）
 */
import { spawn, execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:4173';
const PORT = 9333;
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

/* 假绿陷阱：这个脚本打的是 dist（预览服务器上的构建产物），不是 src。
 *
 * 改了 src/ 却忘了 build，跑出来那句"74/74 通过"，体检报告其实是上一版代码的。
 * 2026-11-20 真被这么骗过一次：年龄文案在 src 里已经换成新的，测试里打印出来的
 * 还是旧文案，而它依然"通过"——因为断言写的是"包含某几个关键词"。
 *
 * 所以默认先构建再测。要测别处（dev server / 线上）就显式给 BASE，或 NO_BUILD=1。
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.BASE && !process.env.NO_BUILD) {
  execSync('npm run build', { stdio: 'inherit', cwd: ROOT });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  // 连跑一百多步时，Windows/容器里的 /dev/shm 很容易被截图占满，Chrome 会假死，
  // 表现为下一步 Runtime.evaluate 超时。这两项是稳定的无功能副作用的启动参数。
  '--disable-dev-shm-usage', '--disable-background-timer-throttling',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + (process.env.TMP || '/tmp') + '/wb-cdp-profile',
  'about:blank',
], { stdio: 'ignore' });

let ws;
let seq = 0;
const pending = new Map();
const listeners = [];

const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    // Windows 上 Chrome 在连续几十次导航后会偶发卡顿：20 秒会给"没反应"误判。
    // 40 秒仍然是有界等待，不会因为放宽就变成假绿。
    // 响应的定时器必须清掉：一轮验收有上千条 CDP 消息，留着会在 Node 事件循环里堆垃圾。
    const timer = setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('CDP 超时: ' + method)); } }, 40000);
    pending.set(id, { res, rej, timer });
  });
};

/* 只读表达式偶发 CDP 超时（连续导航 + 截图时 Chrome 会假死几秒）。
 * 只对"不会改页面状态"的表达式重试两次；点击、赋值、派事件绝不重试，
 * 否则第一次其实已执行、第二次又点一遍，反而制造假结果。 */
const readOnlyExpr = (expr) =>
  !/\.click\(|dispatchEvent|\.value\s*=|\.innerText\s*=|\.remove\(|appendChild|setAttribute|insertAdjacentHTML/.test(expr);
const evaluate = async (expr, attempt = 0) => {
  let r;
  try {
    r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  } catch (e) {
    if (readOnlyExpr(expr) && /CDP 超时/.test(String(e.message)) && attempt < 2) {
      await sleep(500);
      return evaluate(expr, attempt + 1);
    }
    throw e;
  }
  if (r.exceptionDetails) throw new Error('页面脚本报错: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
};

const waitFor = async (expr, label, timeout = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evaluate(expr)) return true;
    await sleep(120);
  }
  throw new Error('等待超时：' + label);
};

const goto = async (url) => {
  // 每次导航只留一个等待者：旧导航的 load 可能永远不来，堆着会拖慢整轮验收
  listeners.length = 0;
  const loaded = new Promise((res) => { listeners.push({ type: 'Page.loadEventFired', res }); });
  await send('Page.navigate', { url });
  // 只改 hash 的导航（r.html#p=A → r.html#p=B）不会触发 load 事件，
  // 傻等 load 会让整个验收卡死。所以给它一个上限，超时就当已经到位 ——
  // 后面每条断言都会自己 waitFor，真没加载完照样会红。
  await Promise.race([loaded, sleep(5000)]);
  await sleep(400);
};

/** 手机上最常见的破版：某个元素把页面撑得比屏幕宽 */
const overflowReport = () => evaluate(`(() => {
  const w = document.documentElement.clientWidth;
  const sw = document.documentElement.scrollWidth;
  const bad = [...document.querySelectorAll('*')]
    .map(el => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 0 && (r.right > w + 1 || r.left < -1))
    .slice(0, 6)
    .map(({ el, r }) => el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ').join('.') : '') + ' → right=' + Math.round(r.right));
  return { viewport: w, scrollWidth: sw, overflow: sw > w + 1, offenders: bad };
})()`);

/** 正文对比度（WCAG 相对亮度），用来判断深色模式下是否还看得清 */
const CONTRAST_PROBE = `(() => {
  const parse = (s) => (s.match(/[\\d.]+/g) || [0,0,0]).slice(0, 3).map(Number);
  const lum = (c) => {
    const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const el = document.querySelector('.aw') || document.querySelector('.lede');
  const fg = getComputedStyle(el).color;
  const bg = getComputedStyle(document.body).backgroundColor;
  const a = lum(parse(fg)), b = lum(parse(bg));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return { fg, bg, ratio: +(((hi + 0.05) / (lo + 0.05)).toFixed(2)), scheme: getComputedStyle(document.documentElement).colorScheme };
})()`;

const shot = async (name, full = false) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
  mkdirSync('tests/shots', { recursive: true });
  writeFileSync(`tests/shots/${name}.png`, Buffer.from(r.data, 'base64'));
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

try {
  // 等 CDP 端口起来
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch { /* 还没起来 */ }
  }
  if (!target) throw new Error('连不上 Chrome 调试端口');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej, timer } = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
      return;
    }
    for (let i = listeners.length - 1; i >= 0; i--) {
      if (listeners[i].type === msg.method) { listeners[i].res(msg.params); listeners.splice(i, 1); }
    }
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  // iPhone 12/13 逻辑尺寸
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  // ---- 0. 上线包：哪些页该被收录、哪些不该 ----
  const rHtml = await (await fetch(BASE + '/r.html')).text();
  const iHtml = await (await fetch(BASE + '/')).text();
  check('结果页 r.html 写死 noindex', /<meta[^>]+name="robots"[^>]+noindex/i.test(rHtml));
  check('首页没有被误标 noindex', !/<meta[^>]+name="robots"[^>]*noindex/i.test(iHtml));
  check('首页带分享卡片标签（og:image / og:title）',
    /property="og:image"/.test(iHtml) && /property="og:title"/.test(iHtml));
  // og:image 的绝对地址是构建期由 scripts/gen-site-files.mjs 替换的，dev 下本来就是相对路径。
  const isDev = /@vite\/client/.test(iHtml);
  check('og:image 是绝对地址（转发卡片才取得到图）',
    isDev || /property="og:image"\s+content="https?:\/\//.test(iHtml),
    isDev ? 'dev 模式跳过（构建时替换）' : '');

  // ---- 1. 首屏 ----
  await goto(BASE + '/');
  await waitFor(`!!document.querySelector('#ageHome')`, '首屏年龄输入框');
  const startOverflow = await overflowReport();
  check('首屏无横向溢出', !startOverflow.overflow, JSON.stringify(startOverflow));
  const startText = await evaluate(`document.querySelector('#app').innerText`);
  check('首屏含免责声明', /不是医疗建议/.test(startText));

  // h1 固定、只有 lede 轮播：标题轮播等于给爬虫随机标题，搜索结果的标题会来回跳
  const homeBits = await evaluate(`(() => {
    const h1 = document.querySelector('h1');
    return {
      h1: h1 ? h1.innerText.replace(/\\s+/g, '') : '',
      hasFinger: !!document.querySelector('.finger'),
      lede: (document.querySelector('#lede') || {}).textContent || '',
      dots: document.querySelectorAll('.dots i').length,
      hasStart: !!document.querySelector('[data-act=start]'),
      hasBegin: !!document.querySelector('[data-act=begin]'),
    };
  })()`);
  check('首屏标题含「该做哪几项」且不带"开始"按钮', /该做哪几项/.test(homeBits.h1) && homeBits.hasBegin && !homeBits.hasStart, JSON.stringify(homeBits));
  check('首屏有轮播句和指示点', homeBits.lede.length > 10 && homeBits.dots === 4, JSON.stringify(homeBits));
  check('按钮上有手指引导', homeBits.hasFinger === true);

  // 老板第 10 条：首页不再显示「还剩 N 题」。题数本身就是压力。
  const capText = await evaluate(`(document.querySelector('#home-cap') || {}).innerText || ''`);
  check('首页不显示「还剩 N 题」', !/还剩\s*\d+\s*题/.test(capText), capText);
  check('首页卡片说明改成"仅花 1 分钟"', /仅花\s*1\s*分钟/.test(capText) && /不收集隐私/.test(capText), capText);

  // 老板第 3 条：年龄数字要居中
  check('年龄输入框数字居中', await evaluate(`getComputedStyle(document.querySelector('#ageHome')).textAlign`) === 'center');

  // 老板第 1、2 条：三个机构名挂官网外链；致敬模块搬到首页
  const links = await evaluate(`(() => {
    const as = [...document.querySelectorAll('.foot-link')];
    return { n: as.length, hrefs: as.map(a => a.getAttribute('href')), text: (document.querySelector('.credits-home') || {}).innerText || '' };
  })()`);
  check('首页三个来源都挂了外链', links.n === 3 && links.hrefs.every((h) => /^https?:\/\//.test(h)), links.hrefs.join(' '));
  check('首页有「站在谁的肩膀上」', /站在谁的肩膀上/.test(links.text), links.text.slice(0, 20));
  check('致敬模块里点了模型名', /DeepSeek/.test(links.text) && /混元/.test(links.text));
  /* 老板 2026-11-20 改的名：杨圣 → 天才杨，小马哥 → 天才姚。
     名字这种事最容易在下一次改文案时被"顺手改回去"，所以钉住两头：
     新名字必须在，旧名字必须不在。 */
  check('致敬名单用的是改过的名字（天才杨 / 天才姚）', /天才杨/.test(links.text) && /天才姚/.test(links.text), links.text.slice(0, 60));
  check('致敬名单里不再出现旧名字（杨圣 / 小马哥）', !/杨圣/.test(links.text) && !/小马哥/.test(links.text));

  /* 老板 2026-11-23 第 0 条：首页页脚一条署名 —— 头像 + 名字去小红书，GitHub 图标去仓库。
   * 图片路径写错在 Node 层看不出来（HTML 里就是一段字符串），必须让浏览器真加载一次：
   * naturalWidth=0 就是 404。这一条比任何字符串断言都硬。 */
  const sign = await evaluate(`(() => {
    const bar = document.querySelector('.sign');
    if (!bar) return { missing: true };
    const img = bar.querySelector('img.sign-pic');
    const me = bar.querySelector('.sign-me');
    const gh = bar.querySelector('.sign-gh');
    const cr = document.querySelector('.credits-home');
    const box = (el) => el.getBoundingClientRect();
    return {
      imgW: img ? img.naturalWidth : 0,
      boxW: img ? Math.round(box(img).width) : 0,
      meHref: me ? me.getAttribute('href') : '',
      meText: me ? me.innerText.trim() : '',
      ghHref: gh ? gh.getAttribute('href') : '',
      ghSvg: gh ? !!gh.querySelector('svg') : false,
      afterCredits: !!(cr && (cr.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING)),
      sameRow: !!(me && gh) && Math.abs((box(me).top + box(me).height / 2) - (box(gh).top + box(gh).height / 2)) < 4,
    };
  })()`);
  check('首页页脚有署名条（头像 + 名字 + GitHub 图标）', !sign.missing, JSON.stringify(sign).slice(0, 60));
  check('署名头像真的加载出来了（不是 404）', sign.imgW > 0, 'naturalWidth=' + sign.imgW);
  check('头像按 26px 显示（和 CSS 一致，加载时不跳）', sign.boxW === 26, sign.boxW + 'px');
  check('署名名字点去小红书主页',
    /xiaohongshu\.com\/user\/profile/.test(sign.meHref || '') && sign.meText === '老王AI瞎bb', sign.meHref);
  check('GitHub 图标点去仓库（还没建仓就先落个人主页）',
    /github\.com\/laowang-ai-xbb(\/HowToCheckup)?\/?$/.test(sign.ghHref || '') && sign.ghSvg, sign.ghHref);
  check('署名条排在「站在谁的肩膀上」之后（先谢指南和模型，最后才是作者）', sign.afterCredits === true);
  check('头像、名字、图标在同一行居中对齐', sign.sameRow === true);


  /* 老板 2026-11-23 第 4 条：首页右上角一枚「发你关心的人」（他选了方案 1）。
   * 三件事要守：字要写出来（不能只剩图标）、位置在品牌行右侧且不换行、
   * 点下去复制的是定稿那段话（不含任何画像）。 */
  const homeShare = await evaluate(`(() => {
    const b = document.querySelector('.hshare');
    if (!b) return { missing: true };
    const r = b.getBoundingClientRect();
    const brand = document.querySelector('.brand').getBoundingClientRect();
    return {
      text: b.innerText.trim(),
      right: Math.round(innerWidth - r.right),
      sameRow: Math.abs(r.top - brand.top) < 40,
      h: Math.round(r.height),
      w: Math.round(r.width),
      lines: Math.round(r.height / parseFloat(getComputedStyle(b).lineHeight || 16)),
    };
  })()`);
  check('首页有「发你关心的人」按钮', !homeShare.missing && /发你关心的人/.test(homeShare.text || ''), JSON.stringify(homeShare));
  check('分享按钮在品牌行右侧（同一行，靠右）', homeShare.sameRow && homeShare.right < 40, `right=${homeShare.right} sameRow=${homeShare.sameRow}`);
  check('分享按钮小巧（高 ≤ 34px，不抢主按钮）', homeShare.h > 0 && homeShare.h <= 34, `h=${homeShare.h}`);
  const homeClip = await evaluate(`(() => {
    const orig = navigator.clipboard;
    let captured = '';
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { captured = t; } }, configurable: true });
    document.querySelector('.hshare').click();
    return new Promise(r => setTimeout(() => { navigator.clipboard = orig; r(captured); }, 260));
  })()`);
  check('首页分享复制的是定稿那段话',
    /^该体检啦，体检该做什么项目，去这免费查下（依据国家权威指南），入口>> https?:\/\/\S+  一个想让你长命百岁的人$/.test(homeClip || ''),
    String(homeClip).slice(0, 160));
  check('首页分享不带任何画像', !/#p=|[?&]p=/.test(homeClip || ''));

  // 老板第 9 条：边输边判。输到一位数不许出声（"5" 可能是 52），停手后才判。
  const peek = async (val) => {
    await evaluate(`(() => { const i = document.querySelector('#ageHome'); i.value = '${val}'; i.dispatchEvent(new Event('input')); })()`);
    await sleep(900);
    return evaluate(`(() => ({ err: document.querySelector('#age-err').textContent, note: document.querySelector('#age-note').textContent }))()`);
  };
  const oneDigit = await peek('5');
  check('只输一位数字时不报错（还在输入中）', oneDigit.err === '' && oneDigit.note === '', JSON.stringify(oneDigit));
  const kid = await peek('16');
  check('输完 16 停手后立刻提示太小', /18/.test(kid.err), kid.err.slice(0, 20));
  const year = await peek('1945');
  check('输完 1945 立刻提示像年份', /年份/.test(year.err), year.err.slice(0, 20));
  const sage = await peek('125');
  check('输完 125 立刻提醒看身份证（不拦）', /身份证|手滑/.test(sage.note), sage.note.slice(0, 16));
  const okAge = await peek('52');
  check('改成合法年龄后提示立刻消失', okAge.err === '' && okAge.note === '', JSON.stringify(okAge));
  await evaluate(`(() => { const i = document.querySelector('#ageHome'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);

  // 安全区与 viewport-fit：iPhone 底部横条会不会压住按钮
  const safe = await evaluate(`(() => {
    const vp = document.querySelector('meta[name=viewport]').content;
    let css = '';
    for (const s of document.styleSheets) {
      try { css += [...s.cssRules].map(r => r.cssText).join('\\n'); } catch { css += ''; }
    }
    return { viewportFit: /viewport-fit=cover/.test(vp), safeArea: /safe-area-inset-bottom/.test(css) };
  })()`);
  check('底部安全区已适配', safe.viewportFit && safe.safeArea, JSON.stringify(safe));
  await shot('01-start');

  // ---- 2. 填答：年龄（首屏直填）→ 性别 → 吸烟 → 包年 → …… ----
  // 非法年龄要给提示且不放行
  await evaluate(`(() => { const i = document.querySelector('#ageHome'); i.value = '5'; document.querySelector('[data-act=begin]').click(); })()`);
  const errText = await evaluate(`document.querySelector('#age-err').textContent`);
  check('年龄过小被拦住', /18/.test(errText), errText);
  check('年龄不合法时留在首屏', await evaluate(`!!document.querySelector('#ageHome')`));

  // 性别已从问卷挪到首屏：只填年龄不选性别，必须被拦住
  await evaluate(`(() => { const i = document.querySelector('#ageHome'); i.value = '52'; document.querySelector('[data-act=begin]').click(); })()`);
  const needSex = await evaluate(`document.querySelector('#age-err').textContent`);
  check('没选性别被拦住', /性别/.test(needSex), needSex);
  check('没选性别时留在首屏', await evaluate(`!!document.querySelector('#ageHome')`));

  await evaluate(`document.querySelector('[data-act=sex][data-v=male]').click()`);
  check('性别按钮能选中', await evaluate(`!!document.querySelector('.seg-b.on')`));
  await evaluate(`document.querySelector('[data-act=begin]').click()`);
  await waitFor(`document.querySelectorAll('.opt').length > 0 && /吸烟/.test(document.querySelector('.qtitle').innerText)`, '吸烟题');
  await shot('02-quiz-smoke');

  /* 老板 2026-11-24 报的 bug：问卷逆流到第一题（年龄页）点「上一题」没反应。
   * 定稿交互：第一次点出提示（文案老板逐字定的），再点一次才回首页，年龄带出不重填。
   * 这三段必须在真浏览器里各走一遍 —— 哪一段缺失都是老人卡住的现场。
   * 注意：从首页进来 step 直接落在吸烟题，中间隔着性别题，所以要一路退到年龄页。 */
  for (let i = 0; i < 6 && !(await evaluate(`!!document.querySelector('#age')`)); i++) {
    await evaluate(`document.querySelector('[data-act=back]').click()`);
    await sleep(80);
  }
  await waitFor(`!!document.querySelector('#age')`, '第一题（年龄页）');
  const backBtn = await evaluate(`(() => { const b = document.querySelector('[data-act=back]'); return { disabled: b.disabled, cls: b.className }; })()`);
  check('第一题的「上一题」不再是哑巴（没有 disabled）', backBtn.disabled === false, JSON.stringify(backBtn));
  await evaluate(`document.querySelector('[data-act=back]').click()`);
  const backHint = await evaluate(`(() => { const h = document.querySelector('.back-hint'); return h ? h.innerText.replace(/\s+/g, '') : ''; })()`);
  check('第一次点出提示（老板定的文案逐字在）',
    backHint.includes('已经到第一题了，你想放弃长命百岁吗？') && backHint.includes('再点一次'), backHint.slice(0, 40));
  check('武装状态有高亮（老人看得出刚按过）', await evaluate(`!!document.querySelector('.back.on')`));
  await evaluate(`document.querySelector('[data-act=back]').click()`);
  await waitFor(`!!document.querySelector('#ageHome')`, '回到首页');
  const backHome = await evaluate(`(() => ({ home: !!document.querySelector('#ageHome'), quiz: !!document.querySelector('.qtitle') }))()`);
  check('再点一次真的回到首页（问卷没了，首页在）', backHome.home === true && backHome.quiz === false, JSON.stringify(backHome));
  check('回首页年龄自动带出（不用重填）', (await evaluate(`document.querySelector('#ageHome').value`)) === '52');
  // 重进问卷再逆流回第一题：武装必须已解除，不能带着上一轮的提示进来
  await evaluate(`document.querySelector('[data-act=begin]').click()`);
  await waitFor(`/吸烟/.test(document.querySelector('.qtitle').innerText)`, '吸烟题');
  for (let i = 0; i < 6 && !(await evaluate(`!!document.querySelector('#age')`)); i++) {
    await evaluate(`document.querySelector('[data-act=back]').click()`);
    await sleep(80);
  }
  await waitFor(`!!document.querySelector('#age')`, '又回到年龄页');
  const backClean = await evaluate(`(() => ({ hint: !!document.querySelector('.back-hint'), on: !!document.querySelector('.back.on') }))()`);
  check('重进问卷再回看第一题：没有残留提示（武装已解除）', !backClean.hint && !backClean.on, JSON.stringify(backClean));
  // 原路返回吸烟题（年龄页 → 性别 → 吸烟），让后续流程从原状态继续
  await evaluate(`(() => { const b = document.querySelector('[data-act=age-next]'); if (b) b.click(); })()`);
  await waitFor(`!!document.querySelector('.opt')`, '性别题');
  await evaluate(`[...document.querySelectorAll('.opt')].find(b => b.innerText.includes('男')).click()`);
  await waitFor(`/吸烟/.test(document.querySelector('.qtitle').innerText)`, '回到吸烟题');

  // 问卷里不该再出现性别题（已经在首屏答完）
  check('问卷里没有重复的性别题', !/^性别/.test(await evaluate(`document.querySelector('.qtitle').innerText`)));

  const prog = await evaluate(`(() => {
    const p = document.querySelector('.progress');
    return {
      role: p.getAttribute('role'),
      now: p.getAttribute('aria-valuenow'),
      word: ((document.querySelector('.pword') || {}).textContent || '').trim(),
      focus: (document.activeElement || {}).id || '',
    };
  })()`);
  check('进度条对读屏可见（role + aria-valuenow）', prog.role === 'progressbar' && prog.now !== null, JSON.stringify(prog));
  check('进度条下有鼓励文案', prog.word.length > 0, prog.word);
  // 换题后焦点要落在题面上，否则读屏用户听到的还是上一题
  check('换题后焦点落到题面', prog.focus === 'qtitle', `activeElement=#${prog.focus}`);

  // 现在吸 → 包年
  await evaluate(`[...document.querySelectorAll('.opt')].find(b => b.innerText.includes('现在吸')).click()`);
  await waitFor(`/大概吸了多少/.test(document.querySelector('.qtitle').innerText)`, '包年题');
  await evaluate(`[...document.querySelectorAll('.opt')].find(b => b.innerText.includes('20 包年')).click()`);

  // 一路点完剩下的题：能跳就跳，能选第一项就选
  for (let i = 0; i < 20; i++) {
    const done = await evaluate(`!!document.querySelector('.group') || !!document.querySelector('.actions')`);
    if (done) break;
    // 家族史那题是"三态 + 多选"的样板：截一张，看"都没有"和"不确定"是不是并排、等宽
    if (await evaluate(`/父母、子女/.test((document.querySelector('.qtitle')||{}).innerText||'')`)) {
      const row = await evaluate(`(() => {
        const btns = [...document.querySelectorAll('.none-row .btn')];
        return { n: btns.length, labels: btns.map(b => b.innerText.trim()), widths: btns.map(b => Math.round(b.getBoundingClientRect().width)) };
      })()`);
      check('家族史给了"都没有"和"不确定"两个出口', row.n === 2 && /都没有/.test(row.labels[0]) && /不确定/.test(row.labels[1]), JSON.stringify(row));
      await shot('13-family-history');
    }
    /* 彩蛋触发项之一：老板点名要"阿尔茨海默病"能选。
       它原来在问卷里根本不存在，彩蛋就永远出不来 —— 所以这里守的是"选得出"。 */
    if (await evaluate(`/你自己确诊过/.test((document.querySelector('.qtitle')||{}).innerText||'')`)) {
      const hasDementia = await evaluate(`[...document.querySelectorAll('.opt')].some(b => /阿尔茨海默/.test(b.innerText))`);
      check('既往症里有「阿尔茨海默病」这个选项', hasDementia);
    }
    /* 老板 2026-11-23 抓到的：「幽门螺杆菌查过吗」一进来「没查过，或不记得」就是选中态。
     * 根因是 emptyProfile 的默认值和这个选项的取值撞了（都是 'unknown'），
     * 而单选题的选中态是拿画像值直接和选项值比的。这里守"进来时一个都没被点亮" ——
     * 没答和记不清是两件事，替他认下"没查过"等于替他答了一题。 */
    if (await evaluate(`/幽门螺杆菌查过吗/.test((document.querySelector('.qtitle')||{}).innerText||'')`)) {
      const pre = await evaluate(`(() => {
        const on = [...document.querySelectorAll('.opt.on')];
        return { n: on.length, label: on[0] ? on[0].innerText.trim().slice(0, 12) : '' };
      })()`);
      check('幽门螺杆菌题进来时没有选项被预先选中', pre.n === 0, JSON.stringify(pre));
      await shot('19-hp-not-prefilled');
    }
    /* 体型那题（J10 方案 2）：不再是"点一个选项就过"的题，
     * 所以自动化的"能点就点"套路在这里会卡住 —— 必须单独走。
     * 顺手把老板点名的三件事验掉：实时算、不方便说→降级、降级后能填回数字。 */
    if (await evaluate(`/体型/.test((document.querySelector('.qtitle')||{}).innerText||'')`)) {
      const desk = await evaluate(`(() => ({
        inputs: [...document.querySelectorAll('.calc .field span')].map(s => s.innerText),
        escape: [...document.querySelectorAll('.none-row .btn')].map(b => b.innerText.trim()),
      }))()`);
      check('体型题给了身高和体重两个输入框', desk.inputs.join('/') === '身高/体重', desk.inputs.join('/'));
      check('体型题给了「不确定」「不方便说」两个出口',
        /不确定/.test(desk.escape[0] || '') && /不方便说/.test(desk.escape[1] || ''), desk.escape.join('/'));

      // ① 不方便说 → 降级到方案 1（不是跳过）
      await evaluate(`document.querySelector('[data-act=body-declined]').click()`);
      await sleep(180);
      const shape = await evaluate(`(() => ({
        n: document.querySelectorAll('.opt').length,
        text: [...document.querySelectorAll('.opt')].map(b => b.innerText).join(' | '),
      }))()`);
      check('选「不方便说」降到方案 1（四个穿衣尺码）', shape.n === 4, String(shape.n));
      check('方案 1 不出现偏瘦/正常/偏胖/肥胖', !/偏瘦|偏胖|肥胖|正常/.test(shape.text), shape.text);
      await shot('17-body-declined');

      // ② 回到方案 2，填数字看实时读数
      await evaluate(`document.querySelector('[data-act=body-bmi]').click()`);
      await sleep(180);
      await evaluate(`(() => {
        const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
        set('bh', '170'); set('bw', '80');
      })()`);
      await sleep(160);
      const bmiUi = await evaluate(`(() => ({
        v: (document.getElementById('bval') || {}).textContent,
        t: (document.getElementById('bmtxt') || {}).textContent,
      }))()`);
      check('填完两个数立刻算出 BMI 27.7', bmiUi.v === '27.7', JSON.stringify(bmiUi));
      check('算完直接给档位（偏高），不用用户自己判断', /偏高/.test(bmiUi.t), bmiUi.t);
      await shot('18-body-bmi');
      await evaluate(`document.querySelector('[data-act=body-next]').click()`);
      await sleep(160);
      continue;
    }
    await evaluate(`(() => {
      const skip = document.querySelector('[data-act=skip]') || document.querySelector('[data-act=multi-next]');
      const none = document.querySelector('[data-act=none]');
      const opt = document.querySelector('.opt');
      if (none) none.click(); else if (opt) opt.click(); else if (skip) skip.click();
    })()`);
    await sleep(150);
  }

  /* 等这一份 52 岁画像真的渲染出来，不能只等 .actions：
   * 从上一页 hash 切过来时旧结果页节点可能还在，拿到手会是别人的清单。 */
  await waitFor(`!!document.querySelector('.actions') && /52 岁/.test((document.querySelector('.rwho') || {}).innerText || '')`, '结果页（52 岁画像）');
  /* 留住一份画像的 p= 码：下面的回补/腰围两轮会把页面导航走，后面排版轮次要回到结果页。
     老板 2026-11-25 走查后「完整问卷答案」折叠块已整体移除（复制到剪贴板的入口一律不带用户信息），
     所以这里直接手造一份同档画像码 —— 排版测试不依赖具体答案，只要 52 岁 · 男 的结果页结构。 */
  const firstShareCode = Buffer.from(JSON.stringify({
    age: 52, gender: 'male', smoking: 'no', packYears: 0, alcohol: 'none',
  })).toString('base64url');
  check('能构造后续排版轮所需的画像码', firstShareCode.length > 10, firstShareCode.slice(0, 40));
  // 泄露门禁：结果页上不允许再出现任何可复制的画像链接（老板 2026-11-25）
  const leakScan = await evaluate(`(() => ({
    fullShare: !!document.querySelector('.full-share'),
    pInActions: ((document.querySelector('.actions') || {}).innerText || '').includes('#p='),
  }))()`);
  check('结果页不再有完整问卷链接入口', !leakScan.fullShare && !leakScan.pInActions, JSON.stringify(leakScan));
  const result = await evaluate(`(() => {
    const q = (s) => [...document.querySelectorAll(s)];
    return {
      who: document.querySelector('.rwho').innerText,
      h1: document.querySelector('h1').innerText,
      sumHint: (document.querySelector('.sum-hint') || {}).innerText || '',
      hasSum: !!document.querySelector('.rsum'),
      secs: q('.toc a').map(a => a.getAttribute('href').slice(1)),
      a: q('#must .atom .an').map(h => h.innerText),
      b: q('#maybe .atom .an').map(h => h.innerText),
      c: q('#no .atom .an').map(h => h.innerText),
      soon: q('.soon li').map(li => li.innerText),
      hasDisclaimer: /不是医疗建议/.test(document.querySelector('.disclaim').innerText),
      evBoxes: q('.evbox').length,
      evLinks: q('.evt td a').length,
      strengthTags: q('.evt .st').length,
      evPageLinks: q('.evall').length,
      softFreqNote: /体检行业的通行做法/.test(document.body.innerText),
    };
  })()`);
  check('页首是结论句「今年该查什么」', /今年该查什么/.test(result.h1), result.h1);
  /* R10：页首那串"共 N 项：必做 X / 你来定 Y / 不做 Z"删掉了 —— 它跟目录里的数字重复 */
  check('页首不再有"共 N 项"那串数字', !result.hasSum && /标了序号/.test(result.sumHint), result.sumHint);
  check('结果页有 A/B/C 三段', result.a.length > 0 && result.b.length > 0 && result.c.length > 0,
    `A${result.a.length} B${result.b.length} C${result.c.length}`);
  /* 目录按清单实况生成：每个格子都要点得着，不许有"点进去是空的" */
  const tocOK = await evaluate(`(() => {
    const links = [...document.querySelectorAll('.toc a')];
    return { n: links.length, dead: links.filter(a => !document.getElementById(a.getAttribute('href').slice(1))).map(a => a.textContent) };
  })()`);
  check('目录每一格都对应一个真段落', tocOK.n >= 5 && tocOK.dead.length === 0, JSON.stringify(tocOK));
  /* 体型卡：要有数字、有档位、按档位给的行动建议，还要自己带依据（R8 第 1 条）。
   * 原来这里守的是"写明不参与判定"那句，老板说没价值已删 —— 别再改回去。 */
  const bodyCard = await evaluate(`(() => {
    const el = document.querySelector('.bodyc');
    return {
      has: !!el,
      txt: el ? el.textContent : '',
      adv: el ? el.querySelectorAll('.badv li').length : 0,
      ev: el ? !!el.querySelector('.evbox') : false,
      old: document.body.textContent.includes('体型不参与上面清单的判定'),
    };
  })()`);
  check('结果页出体型卡：BMI、档位、分档建议、依据齐全',
    bodyCard.has && /BMI 27\.7/.test(bodyCard.txt) && /偏高/.test(bodyCard.txt)
      && bodyCard.adv >= 2 && bodyCard.ev && !bodyCard.old,
    JSON.stringify({ adv: bodyCard.adv, ev: bodyCard.ev, old: bodyCard.old }));
  check('52 岁吸烟男性命中肺癌 CT', result.a.some((n) => /CT/.test(n)), result.a.join(' | '));
  check('结果页带免责声明', result.hasDisclaimer);
  /* 回到顶部两个入口（R9 第 4 条）：浮动那颗要带字、页尾还要有一颗。
   * 老板在 PC 上说"没有按钮"——白底圆钮太淡、又要滚两屏才出现，等于没有。 */
  const toTop = await evaluate(`(() => {
    const f = document.querySelector('.totop');
    const e = document.querySelector('.toend [data-act="totop"]');
    const cs = f ? getComputedStyle(f) : null;
    return {
      float: !!f, text: f ? f.textContent.trim() : '',
      end: !!e,
      bg: cs ? cs.backgroundColor : '',
      fixed: cs ? cs.position : '',
    };
  })()`);
  check('回到顶部：浮动带字 + 页尾一颗',
    toTop.float && toTop.text.includes('回到顶部') && toTop.end && toTop.fixed === 'fixed',
    JSON.stringify(toTop));
  check('浮动按钮是深底（不是白底淡描边）',
    /rgb\(2[0-9], 2[0-9], 2[0-9]\)/.test(toTop.bg) || /rgba?\(27, 26, 23/.test(toTop.bg),
    toTop.bg);
  /* 依据的形态变了（R11）：不再在卡里铺一长串"机构 + 结论 + 原文摘录"，
   * 而是一行「依据 N 条」展开成四列表，逐字摘录留在依据页。
   * 所以这里守三件事：每张有依据的卡都有那一行、表里有强度和出处、都有去依据页的入口。 */
  check('每张项目卡都有「依据 N 条」', result.evBoxes >= 8, String(result.evBoxes));
  check('依据表里有出处链接', result.evLinks > 8, String(result.evLinks));
  check('依据带强度分级标签', result.strengthTags > 8, `强度标签 ${result.strengthTags} 个`);
  check('每个依据框都能跳到依据页看原文', result.evPageLinks >= result.evBoxes, `${result.evPageLinks}/${result.evBoxes}`);
  // 频次若不是指南条文，界面必须显式说明，不能让它看着像权威结论
  check('非常规来源的频次有说明', result.softFreqNote);
  /* 折叠块展开后，里面那些依据框的指示器还是「展开 ›」吗？
   * 产品的全局 `details[open] summary::after` 会把它们全变成减号 —— 因为它比
   * `.evbox > summary::after` 多一层元素权重。这条守的就是那次事故。 */
  const foldEv = await evaluate(`(() => {
    const f = document.querySelector('.fold');
    if (!f) return null;
    f.open = true;
    const after = getComputedStyle(f.querySelector('.evbox summary'), '::after').content;
    f.open = false;
    return { after };
  })()`);
  check('折叠块里的「依据 N 条」仍写展开 ›', foldEv && /展开/.test(foldEv.after), JSON.stringify(foldEv));
  const resOverflow = await overflowReport();
  check('结果页无横向溢出', !resOverflow.overflow, JSON.stringify(resOverflow));
  /* 老板走查的三处视觉/文案一致性：上下两个分享图按钮同色、虚线提示不许空喊、
     套餐常见项的原因不再手写 ①②③。 */
  const visualBits = await evaluate(`(() => {
    const shareColors = [...document.querySelectorAll('[data-act=share-img]')].map(b => getComputedStyle(b).backgroundColor);
    const dup = document.querySelectorAll('#yearly .chip.dup').length;
    const tip = [...document.querySelectorAll('#yearly .tip')].some(e => /带虚线/.test(e.innerText));
    const ul = (document.querySelector('.unlisted') || {}).innerText || '';
    const lean = /偏向做|偏向不做|两边差不多/.test(document.body.innerText);
    return { shareColors, dup, tip, circled: /[①②③]/.test(ul), lean };
  })()`);
  check('结果页上下两个「存成一张图」按钮颜色一致',
    visualBits.shareColors.length === 2 && visualBits.shareColors[0] === visualBits.shareColors[1],
    visualBits.shareColors.join(' / '));
  check('虚线提示只在真有虚线项时出现', visualBits.tip === (visualBits.dup > 0), JSON.stringify(visualBits));
  /* 上面那条是"提示不许空喊"，但 dup 恒为 0 时它永远成立 —— 老板走查时看到的就是这种假通过。
   * 这条反向钉住：52 岁男的清单里，结直肠筛查和标准项目都含「便潜血」，
   * 虚线必须真的出现（2026-11-23 修的就是 claimed 取错口径导致它一直是 0）。 */
  check('虚线条真的出现了（52 岁：便潜血与专项重叠）', visualBits.dup > 0, `dup=${visualBits.dup}`);
  check('套餐常见项原因不带手写序号', !visualBits.circled, String(visualBits.circled));
  check('结果页不展示偏向标签（只在依据页讲）', !visualBits.lean, String(visualBits.lean));
  await shot('03-result');
  await shot('03-result-full', true);
  // 展开「依据 N 条」，截一张强度标签 + 出处表的排版图，供人工复核
  await evaluate(`document.querySelectorAll('details').forEach(d => { d.open = true })`);
  await sleep(300);
  await evaluate(`(() => { const li = document.querySelector('#must .evbox'); if (li) li.scrollIntoView({ block: 'center' }); })()`);
  await sleep(250);
  await shot('10-evidence');
  await evaluate(`(() => { const el = document.querySelector('#must .atom .tip'); if (el) el.scrollIntoView({ block: 'center' }) })()`);
  await sleep(250);
  await shot('11-freq-basis');
  await evaluate(`document.querySelectorAll('details').forEach(d => { d.open = false }); window.scrollTo(0, 0)`);
  for (const [sel, name] of [['#maybe', '05-b'], ['#no', '06-c'], ['.disclaim', '07-foot']]) {
    await evaluate(`document.querySelector('${sel}').scrollIntoView({ block: 'start' })`);
    await sleep(250);
    await shot(name);
  }
  /* 结果页最底部一行：由 老王AI瞎bb 构建 · 开源在 GitHub（老板 2026-11-23 定）。
   * 两个链接去的地方不一样 —— 名字去小红书（刚看完结果想找人说话），
   * GitHub 去个人主页（想看他还做了什么）。所以分开断言，别写成"有两个链接"。 */
  const resSign = await evaluate(`(() => {
    const p = document.querySelector('.signline');
    if (!p) return { missing: true };
    const foot = document.querySelector('footer.disclaim');
    return {
      text: p.innerText.replace(/\\s+/g, ' ').trim(),
      hrefs: [...p.querySelectorAll('a')].map(a => a.getAttribute('href')),
      last: !!foot && foot.lastElementChild === p,
    };
  })()`);
  check('结果页有「由 … 构建 · 开源在 GitHub」',
    !resSign.missing && /^由\s*老王AI瞎bb\s*构建\s*·\s*开源在\s*GitHub$/.test(resSign.text || ''), resSign.text);
  check('结果页：名字去小红书、GitHub 去个人主页',
    (resSign.hrefs || []).length === 2
      && /xiaohongshu\.com\/user\/profile/.test(resSign.hrefs[0] || '')
      && /^https:\/\/github\.com\/laowang-ai-xbb\/?$/.test(resSign.hrefs[1] || ''),
    (resSign.hrefs || []).join(' '));
  check('结果页署名就是页脚最后一行', resSign.last === true);

  await evaluate('window.scrollTo(0,0)');

  /* ---- 2.4 问卷直入结果页的回补 ----
   * 上面那轮是 index.html 里答完题原地换屏（state.view 还停在 quiz），
   * 而下面 5.5 那轮是 r.html 直入。老板点的正是前一种：按钮点了没反应。
   * 这里的"不方便说"故意制造缺口，确保这条路径真的被验到。 */
  await goto(BASE + '/');
  await waitFor(`!!document.querySelector('#ageHome')`, '问卷直入测试首屏');
  await evaluate(`(() => {
    document.querySelector('#ageHome').value = '52';
    document.querySelector('[data-act=sex][data-v=male]').click();
    document.querySelector('[data-act=begin]').click();
  })()`);
  await waitFor(`/你吸烟吗/.test((document.querySelector('.qtitle')||{}).innerText||'')`, '吸烟题');
  await evaluate(`[...document.querySelectorAll('.opt')].find(b => /不方便说/.test(b.innerText)).click()`);
  for (let i = 0; i < 24; i++) {
    if (await evaluate(`!!document.querySelector('.actions') && /52 岁/.test((document.querySelector('.rwho') || {}).innerText || '')`)) break;
    await evaluate(`(() => {
      const bodyDunno = document.querySelector('[data-act=body-dunno]');
      const none = document.querySelector('[data-act=none]');
      const dunno = document.querySelector('[data-act=dunno]');
      const multi = document.querySelector('[data-act=multi-next]');
      const opt = document.querySelector('.opt');
      if (bodyDunno) bodyDunno.click(); else if (none) none.click(); else if (dunno) dunno.click(); else if (multi) multi.click(); else if (opt) opt.click();
    })()`);
    await sleep(120);
  }
  await waitFor(`!!document.querySelector('.actions') && /52 岁/.test((document.querySelector('.rwho') || {}).innerText || '')`, '问卷直入结果页');
  const spaGaps = await evaluate(`(() => ({
    n: document.querySelectorAll('.gaps li').length,
    goto: document.querySelectorAll('.gaps [data-act=goto]').length,
  }))()`);
  check('问卷直入结果页也留回补入口', spaGaps.n >= 1 && spaGaps.goto === spaGaps.n, JSON.stringify(spaGaps));
  await evaluate(`(() => { const d = document.querySelector('.gaps'); if (d) d.open = true })()`);
  await evaluate(`(() => { const b = document.querySelector('.gaps [data-act=goto]'); if (b) b.click() })()`);
  await waitFor(`!!document.querySelector('.gapedit')`, '问卷直入结果页的回补抽屉');
  const spaDrawer = await evaluate(`(() => ({
    editor: !!document.querySelector('.gapedit'),
    result: !!document.querySelector('.result'),
    quiz: !!document.querySelector('.qtitle'),
    text: (document.querySelector('.gapedit')||{}).innerText || '',
  }))()`);
  check('问卷直入结果页点「去补这一题」就地展开，不回问卷',
    spaDrawer.editor && spaDrawer.result && !spaDrawer.quiz && /保存|不方便说|不确定|吸烟|查过/.test(spaDrawer.text),
    JSON.stringify(spaDrawer).slice(0, 200));
  await evaluate(`(() => { const b = document.querySelector('.gapedit [data-act=gap-pick]'); if (b) b.click() })()`);
  await waitFor(`!document.querySelector('.gapedit')`, '问卷直入回补完成后抽屉收起');
  check('问卷直入结果页补完一题清单当场重算、抽屉收起',
    await evaluate(`!!document.querySelector('.result') && !document.querySelector('.qtitle') && !document.querySelector('.gapedit')`));

  // 老人腰围底纹：字号/颜色跟各页小字统一，点进输入框就消失
  await goto(BASE + '/');
  await waitFor(`!!document.querySelector('#ageHome')`, '腰围测试首屏');
  await evaluate(`(() => {
    document.querySelector('#ageHome').value = '70';
    document.querySelector('[data-act=sex][data-v=female]').click();
    document.querySelector('[data-act=begin]').click();
  })()`);
  for (let i = 0; i < 24; i++) {
    if (await evaluate(`/体型/.test((document.querySelector('.qtitle')||{}).innerText||'')`)) break;
    await evaluate(`(() => {
      const none = document.querySelector('[data-act=none]');
      const dunno = document.querySelector('[data-act=dunno]');
      const multi = document.querySelector('[data-act=multi-next]');
      const opt = document.querySelector('.opt');
      if (none) none.click(); else if (dunno) dunno.click(); else if (multi) multi.click(); else if (opt) opt.click();
    })()`);
    await sleep(120);
  }
  await waitFor(`!!document.getElementById('bwa')`, '老人腰围输入框');
  const waist = await evaluate(`(() => {
    const i = document.getElementById('bwa');
    const c = getComputedStyle(i, '::placeholder');
    return { text: i.placeholder, size: c.fontSize, weight: c.fontWeight, color: c.color };
  })()`);
  check('腰围底纹用定稿文案且字号字重与各页小字统一',
    /^老人肚子大、体重轻，腰围比体重更说明问题。$/.test(waist.text) && waist.size === '13px' && waist.weight === '400',
    JSON.stringify(waist));
  /* 用真实鼠标事件点，不用 element.focus()：
     headless 下后者只改 activeElement，不进 :focus、也不发 focus 事件，
     会把"点进去底纹消失"测成永远失败。 */
  await evaluate(`document.getElementById('bwa').scrollIntoView({ block: 'center' })`);
  const waistPt = await evaluate(`(() => {
    const r = document.getElementById('bwa').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: waistPt.x, y: waistPt.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: waistPt.x, y: waistPt.y, button: 'left', clickCount: 1 });
  await sleep(120);
  const focusState = await evaluate(`(() => {
    const i = document.getElementById('bwa');
    return { active: document.activeElement === i, ph: i.getAttribute('placeholder'), ds: i.dataset.ph || '' };
  })()`);
  check('点进腰围输入框后底纹消失', focusState.active && !focusState.ph, JSON.stringify(focusState));
  await evaluate(`document.getElementById('bwa').blur()`);
  const blurState = await evaluate(`(() => {
    const i = document.getElementById('bwa');
    return i.getAttribute('placeholder');
  })()`);
  check('离开腰围输入框且没填时底纹回来', /^老人肚子大、体重轻，腰围比体重更说明问题。$/.test(blurState || ''), blurState);
  // 回到开头那一份结果页，后面「分享还原」和视觉轮次都要它
  await goto(BASE + '/r.html#p=' + firstShareCode);
  await waitFor(`!!document.querySelector('[data-act=share]')`, '后续测试所需的结果页');

  // ---- 2.5 真机上最容易破的四件事（可自动化部分） ----

  // (a) 字体放大 1.3 倍：微信「字体大小」调到最大就是这么干的
  const zoom = await evaluate(`(() => {
    const all = [...document.querySelectorAll('.screen *')];
    const base = all.map(n => parseFloat(getComputedStyle(n).fontSize));
    all.forEach((n, i) => { n.style.fontSize = (base[i] * 1.3).toFixed(2) + 'px'; });
    const w = document.documentElement.clientWidth;
    const sw = document.documentElement.scrollWidth;
    const bad = all.filter(n => n.getBoundingClientRect().right > w + 1).length;
    all.forEach(n => { n.style.fontSize = ''; });
    return { w, sw, bad };
  })()`);
  check('字体放大 1.3 倍不破版', zoom.sw <= zoom.w + 1 && zoom.bad === 0,
    `内容宽 ${zoom.sw} / 可视宽 ${zoom.w}，越界元素 ${zoom.bad} 个`);

  // (b) 360px 小屏（红米/荣耀等千元机常见逻辑宽度）
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 2, mobile: true });
  await sleep(250);
  const small = await overflowReport();
  check('360px 小屏不破版', !small.overflow, JSON.stringify(small));
  await shot('08-360');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(200);

  // (c) 深色模式：只做了浅色版，但要确认强反相不会把字变浅
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(200);
  const dark = await evaluate(CONTRAST_PROBE);
  check('深色模式下正文仍可读（对比度 ≥4.5）', dark.ratio >= 4.5,
    `${dark.ratio}:1，color-scheme=${dark.scheme}`);
  await shot('09-dark');
  await send('Emulation.setEmulatedMedia', { features: [] });
  await sleep(150);

  // ---- 3. 分享链接（老板 2026-11-24 定的口径：默认分享一律产品首页）----
  const shareUrl = await evaluate(`(() => {
    const orig = navigator.clipboard;
    let captured = '';
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { captured = t; } }, configurable: true });
    document.querySelector('[data-act=share]').click();
    return new Promise(r => setTimeout(() => { navigator.clipboard = orig; r(captured); }, 300));
  })()`);
  check('分享文本含链接', /https?:\/\/\S+/.test(shareUrl || ''), (shareUrl || '').slice(-80));
  const link = (shareUrl.match(/https?:\/\/\S+/) || [])[0];
  check('分享链接指向产品首页', /\/$|\/index\.html$/.test((link || '').split(/[?#]/)[0]), (link || '').slice(0, 90));
  // 老板定的口径：链接里不带画像 #p=、不带快照 v=2&s= —— 没有传输，就没有泄露。
  check('分享链接不带任何画像或快照参数', !/#p=|v=2&s=|[?&]p=/.test(link || ''), (link || '').slice(0, 90));

  // 快照渲染路径仍需保留（老链接兼容）：手造一份快照 URL 验证只读视图不变。
  // 横幅已按老板要求删除，这里只验"能还原同一份清单 + 不显示补答入口/体型卡"。
  {
    const code = Buffer.from(JSON.stringify({
      v: 2, age: 52, gender: 'male', date: '2026-11-24',
      A: ['base-package', 'colorectal-screening'],
      B: [], C: ['lung-ldct-not-high-risk'],
    })).toString('base64url');
    // 上一条测试已停在 r.html#p=...；同路径只换 hash，浏览器不会重载、main.js 也不会重读参数。
    // 先回首页再进快照链接，强制一次真实加载。
    await goto(BASE + '/');
    await goto(`${BASE}/r.html#v=2&s=${code}`);
    await waitFor(`!!document.querySelector('.actions')`, '快照结果页');
    await sleep(300);
    const shared = await evaluate(`(() => ({
      who: document.querySelector('.rwho').innerText,
      a: [...document.querySelectorAll('#must .atom .an')].map(h => h.innerText).length,
      tip: (document.querySelector('.snapshot-tip') || {}).innerText || '',
      gaps: !!document.querySelector('.gaps'),
      body: !!document.querySelector('#body-card'),
    }))()`);
    check('快照链接能还原同一份清单',
      shared.a === 1 && /52 岁/.test(shared.who), JSON.stringify(shared));
    check('快照横幅已删除（老板要求）', shared.tip === '', JSON.stringify(shared.tip));
    check('快照页不显示补答入口与体型卡', !shared.gaps && !shared.body, JSON.stringify(shared));
  }

  // ---- 3.2 分歧说明写在项目卡内（老板 2026-11-24 定的口径），不再有顶部模块 ----
  {
    const p = Buffer.from(JSON.stringify({
      age: 52, gender: 'female', smoking: 'no', packYears: 0, familyHistory: ['lung'],
    })).toString('base64url');
    await goto(BASE + '/');
    await goto(`${BASE}/r.html#p=${p}`);
    await waitFor(`!!document.querySelector('.actions') && /52 岁/.test((document.querySelector('.rwho') || {}).innerText || '')`, '分歧画像结果页');
    await sleep(200);
    const disp = await evaluate(`(() => ({
      top: !!document.querySelector('.safety-dispute'),
      inCard: [...document.querySelectorAll('.atom-dispute')].map(e => e.textContent.replace(/\\s+/g, ' ').slice(0, 60)),
      cardCount: document.querySelectorAll('.atom-dispute').length,
    }))()`);
    check('分歧说明出现在具体项目卡内', disp.cardCount >= 1 && /有分歧|咨询/.test(disp.inCard.join('')), JSON.stringify(disp));
    check('顶部不再有分歧模块', !disp.top, JSON.stringify(disp));
  }

  // ---- 3.5 换一份人群画像再验一遍排版 ----
  // 只测"52 岁吸烟男"会漏掉女性专属的条目（乳腺/宫颈），那里文字最长、最容易破版
  {
    const p = Buffer.from(JSON.stringify({ age: 45, gender: 'female', smoking: 'no' })).toString('base64url');
    await goto(BASE + '/r.html?p=' + p);
    await waitFor(`!!document.querySelector('.actions')`, '女性结果页');
    const fem = await evaluate(`(() => ({
      who: document.querySelector('.rwho').innerText,
      hasBreast: [...document.querySelectorAll('.atom .an')].some(h => /乳腺/.test(h.innerText)),
      breastFreq: ([...document.querySelectorAll('.atom')].find(el => /乳腺/.test(el.querySelector('.an').innerText)) || { querySelector: () => null }).querySelector('.af')?.innerText || '',
    }))()`);
    const femOverflow = await overflowReport();
    check('女性画像也有乳腺条目', fem.hasBreast, fem.who);
    check('乳腺间隔已改为有据可依的"每 1–2 年"', /1[–\-~]2\s*年/.test(fem.breastFreq), fem.breastFreq);
    check('女性结果页无横向溢出', !femOverflow.overflow, JSON.stringify(femOverflow));
    await shot('12-female');
  }

  // ---- 3.5b 再过几年：标题定稿、上方空隙收紧、模块自带依据且有落点 ----
  {
    const p = Buffer.from(JSON.stringify({ age: 44, gender: 'female', smoking: 'no' })).toString('base64url');
    await goto(BASE + '/r.html#p=' + p);
    await waitFor(`!!document.querySelector('.soon')`, '再过几年模块');
    const soonInfo = await evaluate(`(() => {
      const s = document.querySelector('.soon');
      const h = s.querySelector('h2');
      const prev = s.previousElementSibling;
      return {
        title: h.innerText,
        old: /再过几年要加上的/.test(document.body.innerText),
        ev: !!s.querySelector('.evbox'),
        evText: (s.querySelector('.evbox summary') || {}).innerText || '',
        gapTop: prev ? Math.round(h.getBoundingClientRect().top - prev.getBoundingClientRect().bottom) : null,
      };
    })()`);
    check('再过几年标题用定稿文案且不再带「的」', /^再过几年要加上/.test(soonInfo.title) && !soonInfo.old, JSON.stringify(soonInfo));
    check('再过几年模块自带依据框', soonInfo.ev && /依据 \d+ 条/.test(soonInfo.evText), soonInfo.evText);
    check('再过几年标题上方空隙已收紧', soonInfo.gapTop !== null && soonInfo.gapTop <= 34, String(soonInfo.gapTop));
    const soonEvHref = await evaluate(`document.querySelector('.soon .evbox .evt td:nth-child(2) a')?.getAttribute('href') || ''`);
    check('再过几年依据链接指向依据页', /e\.html#p=.+&a=soon-/.test(soonEvHref), String(soonEvHref).slice(0, 90));
    await goto(soonEvHref);
    await waitFor(`!!document.querySelector('[id^="soon-"]')`, '依据页再过几年分区');
    check('依据页有再过几年分区可落锚点',
      await evaluate(`!!document.querySelector('.evsec[id^="soon-"] .evc')`));
  }

  // ---- 3.6 50+ 女性：不问备孕题，但要留孕产兜底 ----
  {
    const p = Buffer.from(JSON.stringify({ age: 52, gender: 'female' })).toString('base64url');
    await goto(BASE + '/r.html#p=' + p);
    await waitFor(`!!document.querySelector('.actions')`, '52 岁女性结果页');
    const older = await evaluate(`({
      note: (document.querySelector('.preg-note') || {}).innerText || '',
      text: document.body.innerText
    })`);
    check('50+ 女性结果页保留孕产兜底提示',
      /如果已经怀孕或正在做辅助生殖/.test(older.note) && /产科医生安排/.test(older.note),
      older.note);
    check('50+ 女性页面不出现备孕题',
      !/现在怀孕或正在备孕吗/.test(older.text));
  }

  // ---- 3.6b 65+ 掉秤：不是"找找原因"，而是明确先面诊 ----
  {
    const p = Buffer.from(JSON.stringify({
      age: 70, gender: 'male', bodyMode: 'bmi', bodyHeight: 170, bodyWeight: 70, weightLoss: 'ge5',
    })).toString('base64url');
    await goto(BASE + '/r.html#p=' + p);
    await waitFor(`!!document.querySelector('.actions')`, '70 岁掉秤结果页');
    const loss = await evaluate(`({
      text: (document.querySelector('#body') || {}).innerText || '',
      all: document.body.innerText
    })`);
    check('65+ 掉秤提示给出就医路径',
      /先找医生评估/.test(loss.text) && /替代不了面诊/.test(loss.text) && /老年医学科/.test(loss.text),
      loss.text.slice(0, 360));
    check('65+ 掉秤提示不只说"先找原因"', !/先找原因/.test(loss.all));
  }

  // ---- 3.6c 2B / 3B 风险提示：填了就要回应，但默认折叠、不进清单 ----
  {
    const p = Buffer.from(JSON.stringify({ age: 62, gender: 'female', cookingOilFume: 'yes' })).toString('base64url');
    await goto(BASE + '/r.html#p=' + p);
    await waitFor(`!!document.querySelector('.actions')`, '油烟提示结果页');
    const oil = await evaluate(`(() => {
      const el = document.querySelector('[data-note="oil"]');
      return {
        has: !!el, open: el ? el.open : null,
        head: el ? el.querySelector('summary').innerText : '',
        text: el ? el.textContent : '',
        all: document.body.innerText,
      };
    })()`);
    check('油烟提示只在选了油烟时出现且默认折叠', oil.has && oil.open === false, JSON.stringify({ has: oil.has, open: oil.open }));
    check('油烟提示用定稿标题与就医第一句',
      /你长期接触油烟，需特别注意/.test(oil.head) && /立即去呼吸内科 \/ 胸外科评估/.test(oil.text),
      oil.head);
    check('油烟提示保留三类防范动作与依据',
      /抽油烟机早开晚关/.test(oil.text) && /开窗通风、控制油温/.test(oil.text) && /IARC 把高温煎炸排放列为 2A 类/.test(oil.text),
      oil.text.slice(0, 260));
  }

  {
    const mk = (age) => Buffer.from(JSON.stringify({ age, gender: 'female', familyHistory: ['dementia'] })).toString('base64url');
    await goto(BASE + '/r.html#p=' + mk(65));
    await waitFor(`!!document.querySelector('.actions')`, '65 岁 AD 家族史结果页');
    const ad65 = await evaluate(`(() => {
      const el = document.querySelector('[data-note="ad"]');
      return {
        has: !!el, open: el ? el.open : null,
        head: el ? el.querySelector('summary').innerText : '',
        text: el ? el.textContent : '',
      };
    })()`);
    check('65 岁有痴呆家族史才出风险提示且默认折叠', ad65.has && ad65.open === false, JSON.stringify({ has: ad65.has, open: ad65.open }));
    check('AD 风险提示使用定稿标题与就医出口',
      /你有痴呆家族史，需特别注意/.test(ad65.head) && /记忆门诊 \/ 神经内科 \/ 老年精神科/.test(ad65.text),
      ad65.head);
    check('AD 风险提示保留"不要自己买"与行动建议',
      /什么不要自己买/.test(ad65.text) && /控血压、睡好觉、规律运动、保持社交、不吸烟/.test(ad65.text),
      ad65.text.slice(0, 260));

    await goto(BASE + '/r.html#p=' + mk(64));
    await waitFor(`!!document.querySelector('.actions')`, '64 岁 AD 家族史结果页');
    const ad64 = await evaluate(`!!document.querySelector('[data-note="ad"]')`);
    check('64 岁不出 AD 家族史提示', !ad64, String(ad64));
  }

  // ---- 3.6d 4A：套餐差异说明在「不用做」模块内，8 类项目 + 三类原因 + 三问医生 ----
  {
    const p = Buffer.from(JSON.stringify({ age: 52, gender: 'male', smoking: 'no' })).toString('base64url');
    await goto(BASE + '/r.html#p=' + p);
    await waitFor(`!!document.querySelector('.actions')`, '套餐差异说明结果页');
    const un = await evaluate(`(() => {
      const el = document.querySelector('#no .unlisted');
      return {
        inNo: !!el,
        text: el ? el.textContent : '',
        all: document.body.innerText,
      };
    })()`);
    check('套餐差异说明在「不用做」模块内', un.inNo, String(un.inNo));
    check('套餐差异说明列出 8 类项目', /8\. 肿瘤标志物单项加项/.test(un.text) && /1\. 冠脉 CTA/.test(un.text), un.text.slice(0, 220));
    check('套餐差异说明保留三类原因与三问医生',
      /证据不足：没有足够证据证明健康人常规做能获益/.test(un.text)
        && /属诊断 \/ 随访：已经有症状或已确诊的人/.test(un.text)
        && /只对特定人群：高危职业/.test(un.text)
        && /这项对我有什么获益？依据哪份指南？/.test(un.text) && /会不会带来穿刺、辐射、误诊和额外花费？/.test(un.text),
      un.text.slice(0, 360));
    check('套餐差异说明不写已删除的解释句', !/这些不等于不能做/.test(un.text) && !/机构套餐里常见，例如/.test(un.text));
  }

  // ---- 3.7 答"不确定"时，结果页必须点明缺口 ----
  // 「不知道」不等于「没有」：两种情况生成的是同一份清单，但底气完全不同。
  // 不说破，用户会以为自己已经查全了 —— 这比少列一项更糟。
  {
    const p = Buffer.from(JSON.stringify({ age: 40, gender: 'female', hpStatus: 'unknown', familyHistory: 'unknown' }))
      .toString('base64url');
    await goto(BASE + '/r.html#p=' + p);
    await waitFor(`!!document.querySelector('.actions')`, '缺口提示结果页');
    const g = await evaluate(`(() => {
      const box = document.querySelector('.gaps');
      const sum = box ? box.querySelector('summary').innerText : '';
      if (box) box.open = true;
      return {
        has: !!box,
        sum,
        text: box ? box.innerText : '',
        items: [...document.querySelectorAll('.gaps li')].length,
        goto: document.querySelectorAll('.gaps [data-act="goto"]').length,
      };
    })()`);
    /* 折起来的时候 summary 自己也得说清"这会影响结论"，不能只是"你有 4 题没答"。
       展开后是每题一行的清单 + 「去补这一题」按钮（老板 2026-11-22 删掉了那段
       "不是不用做，是没法判断"的解释，留按钮就够了）。 */
    check('答"不确定"时结果页点明缺口',
      g.has && /会影响结论/.test(g.sum) && g.items >= 2 && g.goto === g.items,
      `缺口 ${g.items} 条，回补按钮 ${g.goto} 个`);
    const ov = await overflowReport();
    check('缺口提示不破版', !ov.overflow, JSON.stringify(ov));

    /* B 方案：点「去补这一题」必须就地展开，不能跳回问卷页。
       补完一题后抽屉收起、结果页还在原地，剩余缺口继续留在页首。 */
    await evaluate(`(() => {
      const b = document.querySelector('.gaps [data-act="goto"]');
      if (b) b.click();
      return true;
    })()`);
    await waitFor(`!!document.querySelector('.gapedit')`, '结果页内回补抽屉');
    const drawer = await evaluate(`({
      editor: !!document.querySelector('.gapedit'),
      quiz: !!document.querySelector('.qtitle'),
      result: !!document.querySelector('.result'),
      text: document.querySelector('.gapedit') ? document.querySelector('.gapedit').innerText : ''
    })`);
    check('回补在结果页就地展开',
      drawer.editor && drawer.result && !drawer.quiz && /保存|不方便说|不确定|查过|吸烟|饮酒/.test(drawer.text),
      JSON.stringify(drawer).slice(0, 120));

    await evaluate(`(() => {
      const b = document.querySelector('.gapedit [data-act="gap-pick"]');
      if (b) b.click();
      return true;
    })()`);
    await waitFor(`!document.querySelector('.gapedit')`, '回补完成后抽屉收起');
    const after = await evaluate(`({
      editor: !!document.querySelector('.gapedit'),
      quiz: !!document.querySelector('.qtitle'),
      result: !!document.querySelector('.result'),
      left: document.querySelectorAll('.gaps li').length
    })`);
    check('补完一题后留在结果页并收起抽屉',
      !after.editor && after.result && !after.quiz && after.left < g.items,
      JSON.stringify(after));
    const ov2 = await overflowReport();
    check('回补抽屉不破版', !ov2.overflow, JSON.stringify(ov2));
  }

  // ---- 3.8 依据页（e.html）：手机折叠目录 / PC 左侧索引 ----
  // 结果页正文只回答"做什么"，"凭什么"全部收在这一页。所以这一页两条路都要走得通：
  // 手机上目录不能把正文推到十屏以外，电脑上目录要常驻在左边。
  {
    const p52 = Buffer.from(JSON.stringify({ age: 52, gender: 'male', smoking: 'yes' })).toString('base64url');
    await goto(BASE + '/r.html#p=' + p52);
    await waitFor(`!!document.querySelector('.evall')`, '结果页的依据入口');
    const evHref = await evaluate(`document.querySelector('.evall').getAttribute('href')`);
    check('「依据 N 条」指到依据页并带锚点', /e\.html#p=.+&a=/.test(evHref || ''), String(evHref).slice(0, 70));

    await goto(evHref);
    await waitFor(`!!document.querySelector('.evsec')`, '依据页');
    const evTop = await evaluate(`(() => {
      const q = (s) => (document.querySelector(s) || {});
      const d = q('.evtoc');
      const sm = d ? q('.evtoc summary') : {};
      return {
        back: (q('#evback') || {}).innerText || '',
        share: (q('#evshare') || {}).innerText || '',
        tocText: sm.innerText || '',
        tocPos: d ? getComputedStyle(d).position : '',
        tocAfter: sm ? getComputedStyle(sm, '::after').content : '',
        lean: document.querySelectorAll('.evlean').length,
        leanText: [...document.querySelectorAll('.evlean')].map(e => e.innerText).join(' | ').slice(0, 160),
      };
    })()`);
    check('依据页有页头常驻「回到你的清单」', /回到你的清单/.test(evTop.back), evTop.back);
    check('依据页分享按钮用定稿文案', /发给家人测一下/.test(evTop.share), evTop.share);
    check('依据页目录文案改为「按项目查看依据 展开」',
      /按项目查看依据/.test(evTop.tocText) && /展开/.test(evTop.tocAfter), JSON.stringify(evTop));
    check('依据页手机端目录吸顶', evTop.tocPos === 'sticky', evTop.tocPos);
    check('偏向标签从结果页迁到依据页', evTop.lean > 0 && /偏向/.test(evTop.leanText), `n=${evTop.lean} ${evTop.leanText}`);
    const evClip = await evaluate(`(() => {
      const orig = navigator.clipboard;
      let captured = '';
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { captured = t; } }, configurable: true });
      document.getElementById('evshare').click();
      return new Promise(r => setTimeout(() => { navigator.clipboard = orig; r(captured); }, 260));
    })()`);
    check('依据页复制文案用定稿原句',
      /^你体检该做什么项目，来这免费查（依据国家权威指南），点击>> https?:\/\/\S+  一个想让你长命百岁的人$/.test(evClip || ''),
      String(evClip).slice(0, 160));
    check('依据页复制文案不带画像 #p=', !/#p=/.test(evClip || ''));
    const evMobile = await evaluate(`(() => {
      const a = new URLSearchParams(location.hash.slice(1)).get('a');
      const el = a ? document.getElementById(a) : null;
      return {
        toc: getComputedStyle(document.querySelector('.evtoc')).display !== 'none',
        idx: getComputedStyle(document.querySelector('.evn')).display !== 'none',
        cards: document.querySelectorAll('.evc').length,
        quotes: document.querySelectorAll('.evc blockquote').length,
        st: document.querySelectorAll('.evc .st').length,
        link: document.querySelectorAll('.evc a[href^="http"]').length,
        anchor: a, anchorTop: el ? Math.round(el.getBoundingClientRect().top) : null,
      };
    })()`);
    check('依据页手机端有折叠目录', evMobile.toc, JSON.stringify(evMobile));
    check('依据页手机端不铺左侧索引', !evMobile.idx);
    check('依据页每条都有机构/强度/原文链接',
      evMobile.cards > 10 && evMobile.quotes > 3 && evMobile.st > 10 && evMobile.link > 10, JSON.stringify(evMobile));

    /* 「去哪做」：R12 加的那一行。守三件事 ——
     *   ① 每一节都有（漏一节，用户翻到那儿就无处可去，而这恰恰是他最想知道的一件事）；
     *   ② 位置对（结论之后、理由之前）：这一页十次有八次是来找"挂哪个号"的；
     *   ③ 标准项目那一节真按科室分了组，而不是糊成一句话。 */
    const evWhere = await evaluate(`(() => {
      const all = [...document.querySelectorAll('.evsec')];
      const secs = all.filter((s) => s.id !== 'where-all');
      const noWhere = secs.filter((s) => !s.querySelector('.ewv')).map((s) => s.id);
      const after = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      const order = all.every((s) => {
        const w = s.querySelector('.evw'); if (!w) return true;
        const v = s.querySelector('.evv'); const r = s.querySelector('.evr');
        if (v && !after(v, w)) return false;
        if (r && !after(w, r)) return false;
        return true;
      });
      /* 三段说明必须同字号同色同行距 —— 老板 2026-11-22 的原话是"字体、字号、排版、
       * 视觉要保持统一"。这里量计算样式，不是"我记得样式表里写的一样"。 */
      const sig = (el) => { const c = getComputedStyle(el); return [c.fontSize, c.lineHeight, c.color, c.fontWeight, c.marginTop, c.marginBottom].join('/'); };
      const same = all.every((s) => {
        const w = s.querySelector('.ewv'); const r = s.querySelector('.evr');
        return !w || !r || sig(w) === sig(r);
      });
      /* 这一行只许写「去哪做：科室」：多一句括注或备注就算不合格 */
      const bare = [...document.querySelectorAll('.ewv')].every((el) => {
        const s = el.innerText.trim();
        /* 两处反斜杠是必须的：这段代码住在模板字符串里，单个 \S 会被当成普通字符 S */
        return /^去哪做：\\S/.test(s) && s.length <= 26;
      });
      return { n: secs.length, noWhere, order, same, bare, groups: document.querySelectorAll('.ewbg li').length };
    })()`);
    check('依据页每一节都有「去哪做」', evWhere.n > 5 && evWhere.noWhere.length === 0, JSON.stringify(evWhere));
    check('「去哪做」排在结论之后、理由之前', evWhere.order, JSON.stringify(evWhere));
    check('「去哪做」和「它为什么／能查出什么」字号行距颜色完全一致', evWhere.same, JSON.stringify(evWhere));
    check('「去哪做」只写科室，不带括注和备注', evWhere.bare, JSON.stringify(evWhere));
    check('标准项目按科室分组（每项都指到体检中心的哪一处）', evWhere.groups >= 5, String(evWhere.groups));
    check('从结果页跳依据页落在对的那一条',
      evMobile.anchorTop !== null && evMobile.anchorTop < 120, `${evMobile.anchor} top=${evMobile.anchorTop}`);

    const tocCell = await evaluate(`(() => {
      const d = document.querySelector('.evtoc');
      d.open = true;
      const a = d.querySelector('.evtocg a');
      const g = d.querySelector('.evtocg');
      return {
        n: d.querySelectorAll('.evtocg a').length,
        h: Math.round(a.getBoundingClientRect().height),
        /* max-height 写的是 62vh，取回来是 px —— 判"有上限且比屏幕短"，别去找 'vh' 字样 */
        maxH: parseFloat(getComputedStyle(g).maxHeight) || 0,
        vh: innerHeight,
        scroll: getComputedStyle(g).overflowY,
        cols: getComputedStyle(g).gridTemplateColumns.split(' ').length,
      };
    })()`);
    check('依据页目录格子够手指点（≥44px）且自己在格子里滚',
      tocCell.n > 8 && tocCell.h >= 44 && tocCell.maxH > 200 && tocCell.maxH < tocCell.vh && tocCell.scroll === 'auto',
      JSON.stringify(tocCell));
    await shot('19-evidence-mobile');

    /* 依据页最底部一行：以上均为公开文件摘录 · 由 … 整理（老板 2026-11-23 定）。
     * 这句话以前在页脚顶部还有一张卡，两处都说就不是强调、是重复。
     * 所以除了"文案对不对"，还要断言全页只出现一次。 */
    const evSign = await evaluate(`(() => {
      const p = document.querySelector('.signline');
      if (!p) return { missing: true };
      const foot = document.querySelector('footer.disc');
      const a = p.querySelector('a');
      return {
        text: p.innerText.replace(/\\s+/g, ' ').trim(),
        href: a ? a.getAttribute('href') : '',
        last: !!foot && foot.lastElementChild === p,
        n: (document.body.innerText.match(/以上均为公开文件摘录/g) || []).length,
      };
    })()`);
    check('依据页有「以上均为公开文件摘录 · 由 … 整理」',
      !evSign.missing && /^以上均为公开文件摘录\s*·\s*由\s*老王AI瞎bb\s*整理$/.test(evSign.text || ''), evSign.text);
    check('依据页署名指向 GitHub 个人主页', /^https:\/\/github\.com\/laowang-ai-xbb\/?$/.test(evSign.href || ''), evSign.href);
    check('依据页的摘录声明全页只出现一次（页脚不重复）', evSign.n === 1, String(evSign.n));
    check('依据页署名就是页脚最后一行', evSign.last === true);


    await evaluate('window.scrollTo(0, 1200)');
    await sleep(220);
    const stickyTop = await evaluate(`Math.round(document.querySelector('.evtoc').getBoundingClientRect().top)`);
    check('下滑阅读时目录仍钉在顶部', Math.abs(stickyTop) <= 2, String(stickyTop));
    await evaluate(`(() => { const d = document.querySelector('.evtoc'); d.open = true; d.querySelector('.evtocg a').click() })()`);
    await sleep(220);
    check('点选目录项后目录自动折起，不挡正文',
      await evaluate(`!document.querySelector('.evtoc').open`));

    /* 2026-11-23 老板第 1、2 条：页尾那块「去哪个科，这一栏是怎么定的」默认收起，
     * 收起时上面要有一颗分享按钮，且和页头那颗同文案（连同"复制的是产品入口"一起守）。
     * 这三条都得在真浏览器里量 —— details 的开关状态、按钮顺序，代码里读不出来。 */
    const whereFold = await evaluate(`(() => {
      const sec = document.getElementById('where-all');
      if (!sec) return { missing: true };
      const d = sec.querySelector('details');
      const share = sec.previousElementSibling;
      const head = document.querySelector('.ev-actions .btn#evshare');
      return {
        isDetails: !!d,
        open: d ? d.open : null,
        sumText: (d?.querySelector('summary') || {}).innerText || '',
        before: share ? (share.querySelector('#evshare2') || {}).innerText || '' : '',
        headText: head ? head.innerText.trim() : '',
      };
    })()`);
    check('「去哪个科」默认收起（不是一进来就摊开）',
      whereFold.isDetails && whereFold.open === false, JSON.stringify(whereFold));
    check('收起时标题还看得见（不是只剩一条横线）',
      /去哪个科/.test(whereFold.sumText || ''), whereFold.sumText);
    check('这块上面有分享按钮，且和页头那颗同文案',
      whereFold.before.trim() === whereFold.headText && !!whereFold.before,
      `${whereFold.before} / ${whereFold.headText}`);
    await evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
    await sleep(200);
    await shot('21-evidence-where-fold');
    await evaluate(`document.querySelector('#where-all details').open = true`);
    await sleep(150);
    const openedH2 = await evaluate(`getComputedStyle(document.querySelector('#where-all h2')).fontSize`);
    await shot('22-evidence-where-open');
    check('展开后标题字号与其它节一致（18px，不像另一种组件）',
      parseFloat(openedH2) === 18, openedH2);

    /* 老板 2026-11-23 第 4 条：「为什么底部这颗和顶部那颗大小差这么多」。
     * 上一版我把底部那颗压成 44px/15px（怕满宽像输入框），同一个动作在同一页上有两种尺寸。
     * 这条钉住"两处一样高、一样字号"——只允许宽度不同（页头两颗并排、底部一颗）。 */
    const shareSizes = await evaluate(`(() => {
      const box = (el) => el ? { h: Math.round(el.getBoundingClientRect().height), fs: getComputedStyle(el).fontSize } : null;
      return { top: box(document.getElementById('evshare')), bottom: box(document.getElementById('evshare2')) };
    })()`);
    check('上下两个「发给家人测一下」同高同字号',
      !!shareSizes.top && !!shareSizes.bottom
      && Math.abs(shareSizes.top.h - shareSizes.bottom.h) <= 1
      && shareSizes.top.fs === shareSizes.bottom.fs,
      JSON.stringify(shareSizes));

    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(350);
    const evPc = await evaluate(`(() => {
      const n = document.querySelector('.evn');
      return { idx: getComputedStyle(n).display !== 'none', pos: getComputedStyle(n).position,
        toc: getComputedStyle(document.querySelector('.evtoc')).display !== 'none' };
    })()`);
    check('依据页 PC 出左侧索引（常驻、不重复折叠目录）',
      evPc.idx && evPc.pos === 'sticky' && !evPc.toc, JSON.stringify(evPc));
    const evPcOverflow = await overflowReport();
    check('依据页 PC 无横向溢出', !evPcOverflow.overflow, JSON.stringify(evPcOverflow));
    await shot('20-evidence-pc');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(200);

    // 方案 A 的真跳转：带同一份画像回清单，但不带依据页锚点
    await goto(evHref);
    await waitFor(`!!document.getElementById('evback')`, '依据页返回按钮');
    await evaluate(`document.getElementById('evback').click()`);
    await waitFor(`/\\/r\\.html$/.test(location.pathname)`, '依据页返回清单', 5000);
    const backHash = await evaluate('location.hash');
    check('依据页返回按钮带画像回清单、不带依据锚点',
      /^#p=/.test(backHash) && !/&a=/.test(backHash), backHash.slice(0, 60));

    /* 老板 2026-11-23 第 3 条（他选方案 1）：滚过一屏后底部浮出一颗胶囊，
     * 和右下角「回到顶部」一左一右；点它回清单，规则和页头那颗一模一样。
     * 这几条只有在真浏览器里才量得出来 —— 显隐是 opacity/visibility 的过渡，
     * 「一左一右不打架」要拿两颗按钮的实际坐标比。 */
    await goto(evHref);
    await waitFor(`/\\/e\\.html$/.test(location.pathname) && !!document.getElementById('backfab')`, '依据页悬浮回清单');
    const fabIdle = await evaluate(`(() => {
      const cs = getComputedStyle(document.getElementById('backfab'));
      return { op: cs.opacity, vis: cs.visibility, y: window.scrollY };
    })()`);
    check('刚进依据页不显示悬浮胶囊（页头那颗就在眼前，不添噪音）',
      fabIdle.vis === 'hidden' || Number(fabIdle.op) === 0, JSON.stringify(fabIdle));

    await evaluate('window.scrollTo(0, 900)');
    await sleep(280);
    const fabOn = await evaluate(`(() => {
      const f = document.getElementById('backfab');
      const cs = getComputedStyle(f);
      const r = f.getBoundingClientRect();
      const up = document.getElementById('totop').getBoundingClientRect();
      return {
        op: Number(cs.opacity), vis: cs.visibility,
        left: Math.round(r.left), gap: Math.round(up.left - r.right),
        bottom: Math.round(r.bottom), upBottom: Math.round(up.bottom),
        text: f.innerText.trim(),
      };
    })()`);
    check('滚过一屏后出现「回到我的清单」胶囊',
      fabOn.vis === 'visible' && fabOn.op > 0.9 && /回到我的清单/.test(fabOn.text), JSON.stringify(fabOn));
    check('胶囊在左、回到顶部在右，中间留空不重叠',
      fabOn.left < 60 && fabOn.gap > 8, JSON.stringify(fabOn));
    check('两颗浮件底部齐平（一行两个动作，视线不用上下跳）',
      Math.abs(fabOn.bottom - fabOn.upBottom) < 12, `${fabOn.bottom} / ${fabOn.upBottom}`);
    await shot('23-evidence-backfab');
    await evaluate(`document.getElementById('backfab').click()`);
    await waitFor(`/\\/r\\.html$/.test(location.pathname)`, '悬浮胶囊回清单', 5000);
    const fabHash = await evaluate('location.hash');
    check('悬浮胶囊回清单也带画像、不带依据锚点',
      /^#p=/.test(fabHash) && !/&a=/.test(fabHash), fabHash.slice(0, 40));

    await goto(BASE + '/e.html');
    await waitFor(`!!document.querySelector('h1')`, '依据页残缺链接');
    const evBroken = await evaluate(`document.querySelector('h1').innerText`);
    check('依据页没有清单时给说明（不白屏）', /需要一份清单/.test(evBroken), evBroken);
  }

  // ---- 3.6 旧链接与残缺链接 ----
  // 去年/上一版分享出去的 /?p=xxx 必须跳到结果页，否则那批链接会把首页顶进索引
  await goto(BASE + '/?p=' + 'eyJhZ2UiOjUyfQ');
  await waitFor(`/\\/r\\.html$/.test(location.pathname)`, '旧链接跳转', 5000);
  // 原来这里写的是 check(名字, true)：永远是绿的，只证明"这一行执行到了"。
  // 必须真的断言落点，否则哪天跳转坏了，这条照样通过。
  const legacyPath = await evaluate('location.pathname + location.search');
  // 部署在子路径（如 GitHub Pages 的 /HowToCheckup/）时，pathname 前面带目录，
  // 所以不能锚定行首，只锚定落到 /r.html?p= 这个结尾。
  check('旧版 /?p= 链接自动跳到 r.html', /\/r\.html\?p=/.test(legacyPath), legacyPath);

  // 链接被截断（微信里长链接常见）要给出说明，不能白屏。
  // 现在分两种：带参数但解不出来（被截断）、压根没参数（直接进了结果页）。
  // 不能说成同一句话 —— 后者会让人以为"是链接坏了"，然后去修一个没坏的东西。
  await goto(BASE + '/r.html#p=' + 'eyJhZ2UiOjUyfQ');
  await waitFor(`!!document.querySelector('.lede')`, '残缺链接提示');
  const broken = await evaluate(`document.querySelector('.lede').innerText`);
  check('链接被截断时给出说明', /不完整|截断/.test(await evaluate(`document.querySelector('h1').innerText + document.querySelector('.lede').innerText`)), broken.slice(0, 30));

  await goto(BASE + '/r.html');
  await waitFor(`!!document.querySelector('.lede')`, '空结果页提示');
  const blank = await evaluate(`document.querySelector('h1').innerText + ' / ' + document.querySelector('.lede').innerText`);
  check('没有参数时提示去填一份（而非说链接坏了）', /还没有清单/.test(blank), blank.slice(0, 30));

  // ---- 4. 极端输入：四段年龄判定 ----
  // 分段依据是"人类有记录最长寿 122 岁"：120 以上几乎必然是手滑，但只提示不拦截，
  // 真正挡住的是把出生年份填进年龄框的那批人（≥150 / 四位数）。
  await goto(BASE + '/');
  await waitFor(`!!document.querySelector('#ageHome')`, '年龄输入框（第二轮）');

  const tryAge = async (v) => {
    await evaluate(`(() => { const i = document.querySelector('#ageHome'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input')); document.querySelector('[data-act=begin]').click(); })()`);
    await sleep(120);
    return evaluate(`(() => ({
      err: document.querySelector('#age-err').textContent,
      note: document.querySelector('#age-note').textContent,
      stillHere: !!document.querySelector('#ageHome'),
    }))()`);
  };

  const asYear = await tryAge('470');
  check('四位数/≥150 被判定为填了年份', /年份/.test(asYear.err), asYear.err);
  check('填年份时不放行', asYear.stillHere === true, JSON.stringify(asYear));

  const asKid = await tryAge('8');
  check('18 岁以下被拦住并给出人话说明', /18/.test(asKid.err) && asKid.stillHere === true, asKid.err.slice(0, 40));

  const asSage = await tryAge('125');
  check('120–149 只提示不拦截（第一次点击留在原地）', /身份证|手滑/.test(asSage.note) && asSage.stillHere === true, asSage.note.slice(0, 40));

  await evaluate(`document.querySelector('[data-act=sex][data-v=female]').click()`);
  await evaluate(`document.querySelector('[data-act=begin]').click()`);
  await sleep(200);
  const sagePassed = await evaluate(`!document.querySelector('#ageHome')`);
  check('120–149 确认后可继续', sagePassed === true, String(sagePassed));

  // ---- 4b. 老年人路径：转诊卡 + 疫苗 ----
  // 链接里的画像可以直接造，所以这里走 r.html#p=，不用把 13 道题点一遍。
  const b64url = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');

  await goto(BASE + '/r.html#p=' + b64url({ age: 68, gender: 'female', fallHistory: 'yes', memoryConcern: 'yes' }));
  /* 必须等"这份画像"渲染完，不能只等 #vac：hash 导航后旧页可能残留下同样的节点，
   * 断言一跑就在新旧两页之间，报出 ref 为 null 这种看着像产品 bug 的假红。 */
  await waitFor(`/68 岁 · 女/.test(document.body.innerText) && !!document.querySelector('#vac') && !!document.querySelector('#ref')`, '68 岁女性结果页');

  const old = await evaluate(`(() => {
    const vac = document.querySelector('#vac');
    const ref = document.querySelector('#ref');
    return {
      vacTitle: (vac.querySelector('h2') || {}).innerText || '',
      vacCount: vac.querySelectorAll('.vrow').length,
      refCount: document.querySelectorAll('#ref .ref').length,
      refTitles: [...document.querySelectorAll('#ref .ref h3')].map(h => h.innerText),
      refHead: (ref.querySelector('h2') || {}).innerText || '',
      refText: ref.innerText,
      hasPrice: /¥|元\\/剂|价格/.test(vac.innerText),
      vacText: vac.innerText,
    };
  })()`);
  check('疫苗区标题是「该打的疫苗 N 支」', /^该打的疫苗\s*4\s*支/.test(old.vacTitle), old.vacTitle);
  check('68 岁女性出 4 支疫苗（流感/肺炎/带状疱疹/乙肝，不含 HPV）', old.vacCount === 4, String(old.vacCount));
  check('疫苗区不写价格', old.hasPrice === false, old.vacText.slice(0, 40));
  check('答"摔倒过""记性差"出两张老年评估卡', old.refCount === 2, old.refTitles.join(' / '));
  /* R6 第 2 条：这一段全站改名「去医院进行老年综合评估」并引真实出处。
   * 老板当时否掉的是「转诊」这个说法，所以"体检中心做不了"这句解释要留着，标题不能再写"转诊"。 */
  check('老年评估段落标题是「去医院进行老年综合评估」',
    /去医院进行老年综合评估/.test(old.refHead) && !/转诊/.test(old.refHead), old.refHead);
  check('老年评估卡片说清"体检中心做不了"', /体检中心做不了/.test(old.refText), old.refText.slice(0, 40));
  await shot('15-older');
  await evaluate(`document.querySelector('#vac').scrollIntoView({ block: 'start' })`);
  await sleep(250);
  await shot('16-vaccine');

  await goto(BASE + '/r.html#p=' + b64url({ age: 30, gender: 'male' }));
  await waitFor(`!!document.querySelector('.actions')`, '30 岁结果页');  const young = await evaluate(`(() => ({
    refCount: document.querySelectorAll('#ref .ref').length,
    vacNames: [...document.querySelectorAll('#vac .vrow b')].map(h => h.innerText),
    hasHpv: /HPV/.test(document.querySelector('#vac').innerText),
    mustN: document.querySelectorAll('#must .atom').length,
    hint: (document.querySelector('.sum-hint') || {}).innerText || '',
  }))()`);
  check('60 岁以下不出老年评估卡', young.refCount === 0, String(young.refCount));
  check('30 岁男性不推 HPV 和肺炎/带状疱疹', !young.hasHpv && young.vacNames.length === 2, young.vacNames.join(' / '));
  /* 页首那句"标了序号的三件最不能省"里的数字得跟清单对上：
   * 30 岁男性必做只有两项，写"三件"就是在说一件不存在的事。 */
  check('必做不足三件时，页首不说"三件"',
    young.mustN > 0 && young.mustN < 3 && /这几件/.test(young.hint) && !/三件/.test(young.hint),
    `${young.mustN} 件 · ${young.hint}`);

  // ---- 4c. 大字开关 ----
  /* 光看 dataset 和按钮文案是不够的 —— R11 换版之后这个开关"会改口、字号不动"，
   * 而旧断言只验了前一半，于是整整一轮没人发现。所以这里必须量到字号真的变大。 */
  const lsBefore = await evaluate(`(() => ({
    an: parseFloat(getComputedStyle(document.querySelector('.atom .an')).fontSize),
    aw: parseFloat(getComputedStyle(document.querySelector('.atom .aw')).fontSize),
    tip: (() => { const e = document.querySelector('.atom .tip'); return e ? parseFloat(getComputedStyle(e).fontSize) : null; })(),
  }))()`);
  await evaluate(`document.querySelector('[data-act=ls]').click()`);
  await sleep(150);
  const ls = await evaluate(`(() => ({
    on: document.documentElement.dataset.ls === 'big',
    label: (document.querySelector('[data-act=ls]') || {}).innerText || '',
    an: parseFloat(getComputedStyle(document.querySelector('.atom .an')).fontSize),
    aw: parseFloat(getComputedStyle(document.querySelector('.atom .aw')).fontSize),
    tip: (() => { const e = document.querySelector('.atom .tip'); return e ? parseFloat(getComputedStyle(e).fontSize) : null; })(),
  }))()`);
  check('大字开关生效且按钮会改口', ls.on && ls.label === '标准字', JSON.stringify(ls));
  check('大字开关真的把正文字号放大了',
    ls.an > lsBefore.an && ls.aw > lsBefore.aw && (ls.tip === null || ls.tip > lsBefore.tip),
    `标题 ${lsBefore.an}→${ls.an}px · 结论 ${lsBefore.aw}→${ls.aw}px · 说明 ${lsBefore.tip}→${ls.tip}px`);

  // ---- 4d. 分享图：canvas 画得出来、尺寸对、不是空白 ----
  // 这条路最容易静默失败（字体没加载、跨域污染、toDataURL 抛错都只会白屏），
  // 所以既看它弹没弹，也看图上真的有没有像素。
  await evaluate(`document.querySelector('[data-act=share-img]').click()`);
  const gotSheet = await waitFor(`!!document.querySelector('.sheet .sheet-img')`, '分享图层', 6000).catch(() => false);
  const img = gotSheet ? await evaluate(`(() => {
    const im = document.querySelector('.sheet .sheet-img');
    return { w: im.naturalWidth, h: im.naturalHeight, bytes: im.src.length };
  })()`) : null;
  check('点「存成一张图」能出图', gotSheet === true);
  check('分享图宽 750（微信转发不糊）且高度合理', img && img.w === 750 && img.h > 600 && img.h <= 2000, JSON.stringify(img));
  check('分享图不是空白（数据量够）', img && img.bytes > 20000, String(img && img.bytes));
  await sleep(450); // 等淡入过渡走完再截图，否则截到半透明的中间态
  await shot('17-share-sheet');
  await evaluate(`document.querySelector('[data-act=close-sheet]').click()`);
  await sleep(250);
  check('分享层可以关掉', await evaluate(`!document.querySelector('.sheet')`));

  // ---- 5. 桌面宽度：内容应居中且不超 560 ----
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await goto(BASE + '/');
  const desk = await evaluate(`(() => { const s = document.querySelector('.screen').getBoundingClientRect(); return { w: Math.round(s.width), left: Math.round(s.left) }; })()`);
  check('桌面端内容限宽居中', desk.w <= 560 && desk.left > 300, JSON.stringify(desk));
  await shot('04-desktop');

  // ---- 5b. 病友彩蛋：那句祝福到底是谁说的 ----
  /* 老板 2026-11-22：整屏里"引用 → 署名 → 日期 → 祝福"竖着排下来，
     祝福那行会被读成上面那位 CEO 说的。所以加了一行落款把归属掰回来。
     这三条守的就是这件事：落款在、落款小一档、落款紧贴祝福。 */
  {
    const p = Buffer.from(JSON.stringify({ age: 52, gender: 'male', pastHistory: ['cancer'], smoking: 'no' })).toString('base64url');
    await goto(BASE + '/r.html?p=' + p);
    // 整屏 3 秒后自动收成窄带；万一没赶上，点窄带上的「再看一次」把它叫回来
    if (!(await evaluate(`!!document.querySelector('.veil')`))) {
      await evaluate(`(document.querySelector('[data-act="egg-open"]') || { click() {} }).click()`);
      await sleep(400);
    }
    await waitFor(`!!document.querySelector('.veil .veil-sign')`, '彩蛋整屏', 8000);
    const egg = await evaluate(`(() => {
      const veil = document.querySelector('.veil');
      const w = veil.querySelector('.veil-wish');
      const s = veil.querySelector('.veil-sign');
      if (!w || !s) return { missing: !w ? 'veil-wish' : 'veil-sign' };
      const cw = parseFloat(getComputedStyle(w).fontSize);
      const cs = parseFloat(getComputedStyle(s).fontSize);
      return {
        wish: w.innerText.trim(), sign: s.innerText.trim(), cw, cs,
        align: getComputedStyle(s).textAlign,
        gap: Math.round(s.getBoundingClientRect().top - w.getBoundingClientRect().bottom),
      };
    })()`);
    check('彩蛋里那句祝福带落款「一个想你长命百岁的人」',
      /一个想你长命百岁的人/.test(egg.sign || ''), JSON.stringify(egg).slice(0, 120));
    check('落款比祝福小一档、右对齐（一眼看出是落款，不是上面那位说的）',
      !!egg.cs && !!egg.cw && egg.cs < egg.cw && egg.align === 'right', `祝福 ${egg.cw}px / 落款 ${egg.cs}px / ${egg.align}`);
    check('落款紧贴祝福下方（不飘到别处）',
      typeof egg.gap === 'number' && egg.gap >= 0 && egg.gap <= 24, `${egg.gap}px`);
  }

  // ---- 5b2. 家族史也有彩蛋，但祝福换人称（老板 2026-11-23 第 2 条）----
  /* 病长在家人身上，跟他说「祝你早日康复」是句错话。判定只看一件事：
   * 既往症一个都没勾、家族史勾了癌症/痴呆/心脏病 → 祝福里必须有「家人」。 */
  {
    const openVeil = async (profile, tag) => {
      const p = Buffer.from(JSON.stringify(profile)).toString('base64url');
      await goto(BASE + '/r.html?p=' + p);
      if (!(await evaluate(`!!document.querySelector('.veil')`))) {
        await evaluate(`(document.querySelector('[data-act="egg-open"]') || { click() {} }).click()`);
        await sleep(400);
      }
      await waitFor(`!!document.querySelector('.veil .veil-wish')`, tag, 8000);
      return evaluate(`document.querySelector('.veil .veil-wish').innerText.trim()`);
    };
    const famWish = await openVeil({ age: 52, gender: 'male', smoking: 'no', familyHistory: ['lung'] }, '家族史彩蛋整屏');
    check('家族史命中时彩蛋照给，但祝福是「祝你家人早日康复」',
      /祝你家人早日康复/.test(famWish || ''), famWish);
    const bothWish = await openVeil({ age: 52, gender: 'male', smoking: 'no', pastHistory: ['cancer'], familyHistory: ['lung'] }, '既往症+家族史彩蛋整屏');
    check('既往症和家族史同时命中时祝福是差异化版本「祝你和你的家人身体健康」（老板 2026-11-25 定）',
      /祝你和你的家人身体健康/.test(bothWish || ''), bothWish);
    const noneWish = await (async () => {
      const p = Buffer.from(JSON.stringify({ age: 52, gender: 'male', smoking: 'no', familyHistory: ['diabetes'] })).toString('base64url');
      await goto(BASE + '/r.html?p=' + p);
      await sleep(600);
      return evaluate(`!!document.querySelector('.veil') || !!document.querySelector('[data-act="egg-open"]')`);
    })();
    check('只有糖尿病家族史时不出彩蛋（那句原话点的是癌症/痴呆/心脏病）', noneWish === false);
  }

  // ---- 5c. 洁牙：进了「标准项目」，但不混进 chip 网格 ----
  /* 老板 2026-11-22 选方案 1（进标准项目、人人每年一次），同时追问"有的人不能洗牙"。
   * 这一块因此要守三件事：
   *   ① 它归在标准项目区，但**不能变成 chip** —— 变成 chip 就等于告诉用户"到院顺带就洗了"；
   *   ② 必须明说套餐里没有、要单独约；
   *   ③ 必须把"哪几类人要先跟医生说"列出来。 */
  {
    const p = Buffer.from(JSON.stringify({ age: 52, gender: 'male', smoking: 'no' })).toString('base64url');
    await goto(BASE + '/r.html?p=' + p);
    await waitFor(`!!document.getElementById('scaling')`, '洁牙块', 8000);
    const sc = await evaluate(`(() => {
      const box = document.getElementById('scaling');
      const chips = [...document.querySelectorAll('#yearly .chip')].map((c) => c.innerText);
      return {
        inYearly: !!box.closest('#yearly'),
        chips,
        title: (box.querySelector('.an') || {}).innerText || '',
        kick: (box.querySelector('.sc-kick') || {}).innerText || '',
        tell: [...box.querySelectorAll('.tell li')].map((li) => li.innerText),
        tellOpen: !!box.querySelector('.tell[open]'),
        tellSummary: (box.querySelector('.tell > summary') || {}).innerText || '',
        evText: (box.querySelector('.evbox summary') || {}).innerText || '',
        hrefs: [...box.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
      };
    })()`);
    check('洁牙在「标准项目」区里，但没混进 chip 网格',
      sc.inYearly === true && sc.chips.length > 0 && !sc.chips.some((t) => /洁牙|洗牙/.test(t)),
      `chip ${sc.chips.length} 个；混进去了=${sc.chips.some((t) => /洁牙|洗牙/.test(t))}`);
    check('洁牙写明「另外一项、要单独约」',
      /另外/.test(sc.kick) && /单独约/.test(sc.kick), sc.kick.replace(/\s+/g, ' '));
    /* 老板 2026-11-22：「这几类人做前先跟医生说，下面几类人折叠」——
     * 默认必须是收起的，摊开就等于把卡片拉成一屏。 */
    check('「这几类人做之前先跟医生说」默认折起',
      sc.tellOpen === false && /先跟医生说/.test(sc.tellSummary), `${sc.tellSummary.replace(/\s+/g, ' ')} / open=${sc.tellOpen}`);
    check('折起的几类人展开后 ≥4 条',
      sc.tell.length >= 4, `${sc.tell.length} 条：${sc.tell[0] || ''}`);
    check('洁牙也带「依据 N 条」，且能进依据页',
      /依据/.test(sc.evText) && sc.hrefs.some((u) => /e\.html/.test(u || '')),
      `${sc.evText.slice(0, 12)} / ${sc.hrefs.length} 个链接`);
    /* 卡片上那行「原文」指的是依据页（R11 定的：逐字摘录只在依据页），
     * 所以"链到官方原件"这件事要在依据页上验：卫健委网页版对本机一律 412，
     * 用的是同站 .doc 原件 —— 这条守的就是"别退回到某个政府网站的转载"。 */
    const evUrl = sc.hrefs.find((u) => /e\.html/.test(u || ''));
    if (evUrl) {
      await goto(new URL(evUrl, BASE + '/r.html').toString());
      await waitFor(`!!document.querySelector('.evsec, .evc, .page')`, '洁牙依据页', 8000);
      const nhc = await evaluate(`[...document.querySelectorAll('a[href]')]
        .map((a) => a.getAttribute('href')).filter((u) => /nhc\\.gov\\.cn/.test(u || ''))`);
      check('依据页里洁牙的「原文」链到卫健委官方原件',
        nhc.length > 0, nhc[0] ? nhc[0].slice(0, 72) : '没有 nhc.gov.cn 链接');
    }
  }

  // ---- 6. 弱网首屏：3G 下老人会不会等到放弃 ----
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Network.emulateNetworkConditions', {
    offline: false, latency: 400, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8,
  });
  const t0 = Date.now();
  await goto(BASE + '/');
  await waitFor(`!!document.querySelector('#ageHome')`, '弱网首屏', 15000);
  const slowMs = Date.now() - t0;
  check('弱网(3G)首屏可点', slowMs < 8000, `${slowMs} ms`);
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
} catch (e) {
  check('执行未中断', false, e.message);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exit(1);
}
