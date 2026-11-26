/* 走查复现：量红旗提示在 PC/移动端的实际坐标，顺便看症状画像的模块内容。
 * 用法：node tests/diag-gate.mjs   （需先起 BASE 预览服务）
 */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const BASE = process.env.BASE || 'http://127.0.0.1:4201';
const PORT = process.env.CDP_PORT || 9346;
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const VIEW_H = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--disable-dev-shm-usage', '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + (process.env.TMP || '/tmp') + '/wb-diag-profile',
  'about:blank',
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    const timer = setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('CDP 超时: ' + method)); } }, 30000);
    pending.set(id, { res, rej, timer });
  });
};
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
};

const probe = `(() => {
  const g = document.querySelector('.safety-gate');
  const doc = document.querySelector('.doc');
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const cs = g ? getComputedStyle(g) : null;
  const dsec = (sel) => { const s = document.querySelector(sel); return s ? { title: (s.querySelector('h2')?.innerText || ''), cards: s.querySelectorAll('.atom, .card2').length } : null; };
  return JSON.stringify({
    gate: rect(g),
    gatePosition: cs ? cs.position : null,
    docDisplay: doc ? getComputedStyle(doc).display : null,
    docGridAreas: doc ? getComputedStyle(doc).gridTemplateAreas : null,
    gateGridArea: g ? getComputedStyle(g).gridArea : null,
    header: rect(document.querySelector('.rhead')),
    body: rect(document.querySelector('.docbody')),
    toc: rect(document.querySelector('.doc > .toc')),
    must: dsec('#must'),
    yearly: dsec('#yearly'),
    maybe: dsec('#maybe'),
    no: dsec('#no'),
    sections: [...document.querySelectorAll('.docbody section[id]')].map(s => s.id),
  });
})()`;

try {
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); target = list.find((t) => t.type === 'page'); } catch {}
  }
  if (!target) throw new Error('连不上 CDP');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { const { res, rej, timer } = pending.get(msg.id); pending.delete(msg.id); clearTimeout(timer); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); } };
  await send('Page.enable');

  const profile = { age: 55, gender: 'male', symptomFlags: ['weightLoss'] };
  const code = btoa(JSON.stringify(profile)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const configs = [
    { label: 'PC', w: 1280, mob: false },
    { label: 'MOBILE', w: 390, mob: true },
  ];
  for (const cfg of configs) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: cfg.w,
      height: VIEW_H,
      deviceScaleFactor: cfg.mob ? 2 : 1,
      mobile: cfg.mob,
    });
    await send('Page.navigate', { url: `${BASE}/r.html#p=${code}` });
    await sleep(2200);
    const raw = await evaluate(probe);
    console.log('\n=== ' + cfg.label + ' ===');
    console.log(JSON.stringify(JSON.parse(raw), null, 2));
  }
  process.exit(0);
} catch (e) {
  console.error('失败:', e.message); process.exit(1);
} finally { chrome.kill(); }
