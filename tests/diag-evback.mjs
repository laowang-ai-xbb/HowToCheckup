/* 复现依据页「回到你的清单」的各种入口路径，打印每步 URL 与目标页状态。
 * 用法：node tests/diag-evback.mjs
 */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const BASE = process.env.BASE || 'http://127.0.0.1:4173';
const PORT = process.env.CDP_PORT || 9347;
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--disable-dev-shm-usage', '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + (process.env.TMP || '/tmp') + '/wb-evback-profile',
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
    title: (document.querySelector('h1')?.innerText || '').slice(0, 40),
    hasBack: !!document.getElementById('evback'),
    hasForm: !!document.querySelector('#ageHome, [data-act=submit-age], .screen.start'),
  }))()`);
  console.log(label, JSON.stringify(s));
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

  console.log('\n=== 场景 A：画像链接 → 依据页 → 返回（正常路径）===');
  await goto(`${BASE}/r.html#p=${code}`);
  await state('清单页');
  const evHref = await evaluate(`document.querySelector('a[href*="e.html"]')?.href || ''`);
  console.log('依据链接:', evHref.slice(0, 100));
  await goto(evHref);
  await state('依据页');
  await evaluate(`document.getElementById('evback')?.click()`);
  await sleep(900);
  await state('返回后');

  console.log('\n=== 场景 B：画像链接 + m=1（自己的清单重载）===');
  await goto(`${BASE}/r.html#p=${code}&m=1`);
  await state('清单页');
  const evHref2 = await evaluate(`document.querySelector('a[href*="e.html"]')?.href || ''`);
  await goto(evHref2);
  await state('依据页');
  await evaluate(`document.getElementById('evback')?.click()`);
  await sleep(900);
  await state('返回后');

  console.log('\n=== 场景 C：直接打开无参数依据页 ===');
  await goto(`${BASE}/e.html`);
  await state('依据页');
  await evaluate(`document.getElementById('evback')?.click()`);
  await sleep(900);
  await state('返回后');

  process.exit(0);
} catch (e) {
  console.error('失败:', e.message); process.exit(1);
} finally { chrome.kill(); }
