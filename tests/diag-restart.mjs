/* 复现「结果页最底部点重填 → 回到首页却停在页底」，打印每步 URL 与滚动位置。
 * 用法：node tests/diag-restart.mjs
 */
import { spawn } from 'node:child_process';

const BASE = process.env.BASE || 'http://127.0.0.1:4173';
const PORT = process.env.CDP_PORT || 9359;
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--disable-dev-shm-usage', '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + (process.env.TMP || '/tmp') + '/wb-restart-profile',
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
const goto = async (url) => { await send('Page.navigate', { url }); await sleep(900); };
const state = async (label) => {
  const s = await evaluate(`(() => ({
    url: location.href,
    y: Math.round(scrollY),
    h: document.documentElement.scrollHeight,
    age: !!document.querySelector('#ageHome'),
    h1: (document.querySelector('h1')?.innerText || '').slice(0, 30).replace(/\\n/g, ' '),
    restartBtns: document.querySelectorAll('[data-act=restart]').length,
  }))()`);
  console.log(label, JSON.stringify(s));
  return s;
};

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

  const profile = { age: 55, gender: 'male' };
  const code = btoa(JSON.stringify(profile)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  console.log('\n=== 场景 A：r.html 结果页滚到底 → 点底部「重填一遍」===');
  await goto(`${BASE}/r.html#p=${code}`);
  await state('结果页刚开');
  await evaluate(`scrollTo(0, document.documentElement.scrollHeight)`);
  await sleep(400);
  await state('滚到底');
  await evaluate(`(() => { const bs=[...document.querySelectorAll('[data-act=restart]')]; const b=bs[bs.length-1]; if(b) b.click(); return !!b; })()`);
  await sleep(1200);
  const a = await state('点重填之后');
  console.log('判定：', a.age ? '首页表单在' : '首页表单没出现', a.y > 100 ? '⚠ 停在页底（bug）' : '✓ 在页首');

  console.log('\n=== 场景 B：首页单页流程里（不刷新）直接 renderStart ===');
  await goto(`${BASE}/index.html`);
  await state('首页刚开');
  await evaluate(`scrollTo(0, document.documentElement.scrollHeight)`);
  await sleep(300);
  await state('首页滚到底');
  process.exit(0);
} catch (e) {
  console.error('失败:', e.message); process.exit(1);
} finally { chrome.kill(); }
