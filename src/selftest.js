// SPDX-License-Identifier: MIT
// Copyright (c) 2026 老王AI瞎bb
// See LICENSE at the repository root.

/**
 * 真机自检页
 *
 * 为什么要有它：自动化验收（headless Chrome）测不了微信 webview、测不了微信的字体放大、
 * 测不了 iOS 安全区、测不了真实输入法。这些恰好是最容易破版的地方。
 *
 * 与其给一张"请你逐条点"的清单，不如让页面自己跑一遍，把结果摆在屏幕上。
 * 用户（或我）只需要看一眼有没有红色，出问题时点"复制结果"发回来。
 *
 * 这里测的都是"在真机上才能测、但能用代码判断"的东西。
 */

const app = document.getElementById('app');

const results = [];
const add = (name, status, detail) => {
  results.push({ name, status, detail });
};

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

/** WCAG 相对亮度与对比度 */
const lum = ([r, g, b]) => {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const parseRGB = (s) => (s.match(/\d+/g) || [0, 0, 0]).slice(0, 3).map(Number);
const contrast = (fg, bg) => {
  const a = lum(parseRGB(fg));
  const b = lum(parseRGB(bg));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
};

/* ---------- 1. 环境信息（不算通过/失败，但出问题时最有用） ---------- */
const ua = navigator.userAgent;
const isWeChat = /MicroMessenger/i.test(ua);
const isIOS = /iPhone|iPad|iPod/i.test(ua);
const env = {
  viewport: `${window.innerWidth}×${window.innerHeight}`,
  dpr: window.devicePixelRatio,
  wechat: isWeChat ? '是（' + (ua.match(/MicroMessenger\/[\d.]+/) || [''])[0] + '）' : '否',
  os: isIOS ? 'iOS' : /Android/i.test(ua) ? 'Android' : '其他',
  https: location.protocol === 'https:' ? '是' : '否（剪贴板会受限）',
  network: (navigator.connection && navigator.connection.effectiveType) || '未知',
  darkMode: window.matchMedia('(prefers-color-scheme: dark)').matches ? '系统深色' : '系统浅色',
};

/* ---------- 2. 样张：用真实样式渲染一组元素，下面所有测量都基于它 ---------- */
const stage = el('div', 'selftest-stage');
stage.innerHTML = `
  <div class="item a" id="st-card">
    <div class="item-top">
      <h3>结直肠癌筛查（肠镜 / 便潜血）</h3>
      <span class="freq" id="st-freq">肠镜每 5–10 年 1 次；或每年便潜血</span>
    </div>
    <p class="verdict-line">45–74 岁应做结直肠癌筛查；一级亲属患结直肠癌者从 40 岁开始</p>
    <div class="flags"><b>出现这些情况要去看医生：</b>便血或黑便、排便习惯持续改变超过 2 周</div>
  </div>
  <div class="opts">
    <button class="opt" id="st-opt"><span class="opt-l">现在吸</span></button>
    <button class="opt on"><span class="opt-l">以前吸，戒了</span></button>
  </div>
  <button class="btn primary big" id="st-btn">下一步</button>
`;

app.innerHTML = `
  <main class="screen">
    <div class="brand">
      <span class="brand-name">体检项目指南</span>
      <span class="brand-slogan">真机自检</span>
    </div>
    <h1>在手机上跑一遍<br /><em>看有没有红色的</em></h1>
    <p class="lede">这一页会自动检查排版、字号、按钮大小、颜色对比、安全区。不需要你操作，看完点“复制结果”发回来即可。</p>
    <div id="envbox"></div>
    <div id="list"></div>
    <div id="stagebox"></div>
    <div class="actions">
      <button class="btn primary big" id="copy">复制自检结果</button>
      <a class="btn ghost" id="home" href="./" style="display:block;text-align:center;text-decoration:none">回首页</a>
    </div>
  </main>
`;
document.getElementById('stagebox').appendChild(stage);

/* 环境信息表 */
document.getElementById('envbox').innerHTML = `
  <div class="gsub">当前环境</div>
  <ul class="envlist">
    ${Object.entries(env)
      .map(([k, v]) => `<li><b>${k}</b><span>${v}</span></li>`)
      .join('')}
  </ul>
`;

/* ---------- 3. 各项检查 ---------- */
const docW = document.documentElement.clientWidth;
const docScrollW = document.documentElement.scrollWidth;
add(
  '没有横向溢出',
  docScrollW <= docW + 1 ? 'pass' : 'fail',
  `可视宽 ${docW}px，内容宽 ${docScrollW}px` + (docScrollW > docW + 1 ? `（超出 ${docScrollW - docW}px）` : ''),
);

// 3.1 文字被截断：所有元素右边界不超过可视宽
const outliers = [...document.querySelectorAll('.screen *')]
  .map((n) => ({ n, r: n.getBoundingClientRect() }))
  .filter(({ r }) => r.width > 0 && (r.right > docW + 1 || r.left < -1))
  .slice(0, 3)
  .map(({ n }) => n.className || n.tagName);
add('没有元素超出屏幕', outliers.length === 0 ? 'pass' : 'fail', outliers.length ? outliers.join('、') : '全部在可视范围内');

/* 字体放大 1.3 倍后再量一次——微信会强制放大网页字体，这是最常见的破版原因 */
const fontsBefore = [...stage.querySelectorAll('*')].map((n) => parseFloat(getComputedStyle(n).fontSize));
const cardBefore = stage.querySelector('#st-card').getBoundingClientRect();
[...stage.querySelectorAll('*')].forEach((n, i) => {
  n.style.fontSize = (fontsBefore[i] * 1.3).toFixed(2) + 'px';
});
const cardAfter = stage.querySelector('#st-card').getBoundingClientRect();
const stageW = stage.getBoundingClientRect().width;
const overflowed = [...stage.querySelectorAll('*')].some((n) => n.getBoundingClientRect().right > stageW + 1);
add(
  '字体放大 1.3 倍不破版',
  !overflowed ? 'pass' : 'fail',
  `卡片高度 ${Math.round(cardBefore.height)} → ${Math.round(cardAfter.height)}px` + (overflowed ? '，有元素被挤出容器' : ''),
);
// 恢复字号，避免影响后面的测量
[...stage.querySelectorAll('*')].forEach((n, i) => {
  n.style.fontSize = '';
});

/* 点击目标尺寸：手指点得准的下限是 44px */
const targets = [
  ['选项', stage.querySelector('#st-opt')],
  ['主按钮', stage.querySelector('#st-btn')],
].map(([name, n]) => ({ name, h: n.getBoundingClientRect().height }));
const tooSmall = targets.filter((t) => t.h < 44);
add(
  '按钮够大（≥44px）',
  tooSmall.length === 0 ? 'pass' : 'fail',
  targets.map((t) => `${t.name} ${Math.round(t.h)}px`).join('，'),
);

/* 正文颜色对比度：WCAG AA 要求 ≥4.5:1 */
const bodyStyle = getComputedStyle(document.body);
const bg = bodyStyle.backgroundColor;
const fg = getComputedStyle(stage.querySelector('.verdict-line')).color;
const ratio = contrast(fg, bg);
add('正文对比度 ≥4.5', ratio >= 4.5 ? 'pass' : 'warn', `${ratio.toFixed(2)}:1`);

/* 安全区：iPhone 底部横条 */
const probe = el('div');
probe.style.cssText = 'position:fixed;bottom:0;height:env(safe-area-inset-bottom,0px);width:1px';
document.body.appendChild(probe);
const inset = Math.round(probe.getBoundingClientRect().height);
probe.remove();
add('底部安全区', 'pass', inset > 0 ? `检测到 ${inset}px 安全区` : '无安全区（非刘海屏，或浏览器未上报）');

/* 剪贴板 */
const clipOK = !!(navigator.clipboard && window.isSecureContext);
add('复制功能可用', clipOK ? 'pass' : 'warn', clipOK ? 'Clipboard API 可用' : '当前环境不支持 Clipboard API，会走 execCommand 回退（微信里常见）');

/* 深色模式：我们只做了浅色，深色下仍是米白底——可读但会偏亮 */
add(
  '深色模式可读',
  env.darkMode === '系统浅色' ? 'pass' : ratio >= 4.5 ? 'warn' : 'fail',
  env.darkMode === '系统浅色' ? '未开启深色模式' : '系统是深色，页面仍为浅色底（有意如此，字看得清但偏亮）',
);

/* JS 与渲染 */
add('脚本正常执行', 'pass', '这一页能显示出来就说明脚本没问题');
const nav = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
if (nav) {
  const ms = Math.round(nav.domContentLoadedEventEnd);
  add('首屏渲染耗时', ms < 1500 ? 'pass' : 'warn', `${ms} ms`);
}

/* ---------- 4. 渲染结果 ---------- */
const ICON = { pass: '✓', warn: '!', fail: '×' };
const LABEL = { pass: '通过', warn: '注意', fail: '有问题' };
const counts = results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});

document.getElementById('list').innerHTML = `
  <div class="gsub">检查结果（${counts.fail || 0} 个问题 / ${counts.warn || 0} 个注意）</div>
  <ul class="checks">
    ${results
      .map(
        (r) => `<li class="chk ${r.status}">
          <span class="chk-i">${ICON[r.status]}</span>
          <div><b>${r.name}</b><span class="chk-l">${LABEL[r.status]}</span><p>${r.detail || ''}</p></div>
        </li>`,
      )
      .join('')}
  </ul>
`;

/* ---------- 5. 复制结果 ---------- */
document.getElementById('copy').addEventListener('click', async () => {
  const text = [
    '体检项目指南 · 真机自检结果',
    new Date().toLocaleString('zh-CN'),
    '',
    '[环境]',
    ...Object.entries(env).map(([k, v]) => `${k}: ${v}`),
    '',
    '[检查]',
    ...results.map((r) => `${LABEL[r.status]} ${r.name}：${r.detail || ''}`),
    '',
    ua,
  ].join('\n');

  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  const btn = document.getElementById('copy');
  btn.textContent = ok ? '已复制，发给阿七即可' : '复制失败，请长按选择文字';
  setTimeout(() => { btn.textContent = '复制自检结果'; }, 2600);
});
