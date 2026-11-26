/* 四画像截图：39 / 55 / 74 / 80 岁，给老板走查合并后的结果页。
 * 复用 browser-check.mjs 的 CDP 手法（无第三方依赖），只截图不断言。
 * 用法：node tests/shots4.mjs  （预览服务需已在 BASE 端口运行）
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE || 'http://127.0.0.1:4200';
const PORT = process.env.CDP_PORT || 9345;
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--disable-dev-shm-usage', '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + (process.env.TMP || '/tmp') + '/wb-shots-profile',
  'about:blank',
], { stdio: 'ignore' });

let ws;
let seq = 0;
const pending = new Map();

const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    const timer = setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('CDP 超时: ' + method)); } }, 40000);
    pending.set(id, { res, rej, timer });
  });
};

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('页面脚本报错: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
};

const waitFor = async (expr, label, timeout = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evaluate(expr)) return true;
    await sleep(120);
  }
  throw new Error('等待超时：' + label);
};

const goto = async (url) => {
  await send('Page.navigate', { url });
  await sleep(1500);
};

const shot = async (name, full = true) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
  mkdirSync('tests/shots', { recursive: true });
  writeFileSync(`tests/shots/${name}.png`, Buffer.from(r.data, 'base64'));
  console.log('已截图', name);
};

try {
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
    }
  };
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  // 四画像：编码与线上 r.html#p= 链接格式一致（base64url 的 JSON）
  const profiles = [
    ['p39', { age: 39, gender: 'female' }],
    ['p55', { age: 55, gender: 'male', familyHistory: ['diabetes'] }],
    ['p74', { age: 74, gender: 'male' }],
    ['p80', { age: 80, gender: 'female' }],
    // 2026-11-27 走查：勾症状后不能只剩"不用做"，基础项目要留着
    ['p-symptom', { age: 55, gender: 'male', symptomFlags: ['weightLoss'] }],
  ];
  for (const [name, profile] of profiles) {
    const code = btoa(JSON.stringify(profile)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await goto(`${BASE}/r.html#p=${code}`);
    await waitFor(`document.querySelectorAll('.card, .aw, section').length > 0`, '结果页渲染出内容');
    await sleep(800);
    await shot('merge-' + name);
  }
  console.log('四画像截图完成');
  process.exit(0);
} catch (e) {
  console.error('失败:', e.message);
  process.exit(1);
} finally {
  chrome.kill();
}
