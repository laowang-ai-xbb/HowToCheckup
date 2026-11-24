#!/usr/bin/env node
/**
 * 截图小工具（无第三方依赖，走 Chrome DevTools Protocol）
 *
 * 用法：
 *   node scripts/shot.mjs <html> <out.png> [variant] [height] [width] [scroll]
 *     variant  1/2/3…  点掉对应的 .vbtn[data-v]，再截
 *     scroll   top（默认）| bottom（整页滚到底）| phone（把 .phone 滚到底）
 *
 * 为什么留着它：每次给老板评审都要发缩略图。手点截图会漏、会截错版本，
 * 而且他看的是 260×190 的小图 —— 图糊了等于没给。
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [, , file, out, variant = '1', H = '1000', W = '1180', SCROLL = 'top'] = process.argv;
if (!file || !out) { console.error('用法见文件头注释'); process.exit(1); }

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9466;
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + (process.env.TMP || '/tmp') + '/shot-' + Date.now(), 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; let seq = 0;
const pending = new Map();
const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 15000);
  });
};

for (let i = 0; i < 40; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
    const page = list.find((x) => x.type === 'page');
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener('open', r)); break; }
  } catch { /* 还没起来 */ }
  await sleep(200);
}
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result); pending.delete(m.id); }
});

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: Number(W), height: Number(H), deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'file:///' + file.replace(/\\/g, '/') });
await sleep(1600);

const ev = async (expression) => send('Runtime.evaluate', { expression, returnByValue: true });
if (variant !== '1') await ev(`(document.querySelector('.vbtn[data-v="${variant}"]')||{}).click?.()`);
if (SCROLL === 'bottom') await ev('window.scrollTo(0, document.body.scrollHeight)');
if (SCROLL === 'phone') await ev(`(function(){var p=document.querySelector('.phone');if(p)p.scrollTop=p.scrollHeight;})()`);
await sleep(700);

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('saved', out);
chrome.kill();
process.exit(0);
