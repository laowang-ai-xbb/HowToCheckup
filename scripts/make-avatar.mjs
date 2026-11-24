#!/usr/bin/env node
/**
 * 头像压缩：原图 512×512 / 266KB → 128×128 PNG（页脚只显示 26~30px，128 够 4 倍屏）
 *
 * 为什么不用 npm 包：这个仓库一个第三方依赖都没有（除了 vite），
 * 为一个头像引 sharp/imagemagick 不值得。借用本机 Chrome 的 canvas 做一次缩放，
 * 走的是 scripts/shot.mjs 已经验证过的 CDP 路子。
 *
 * 用法：node scripts/make-avatar.mjs <源图> <输出>
 * 源图在 docs/avatar-src.png（512×512 原图，仓库里有，方便别人换自己的头像重跑）。
 * 只在头像换图时需要重跑，产物 public/avatar.png 是提交进仓库的。
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [, , src = 'docs/avatar-src.png', out = 'public/avatar.png'] = process.argv;
const SIZE = 128;
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9467;

const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + (process.env.TMP || '/tmp') + '/avatar-' + Date.now(),
    'about:blank'],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; let seq = 0;
const pending = new Map();
const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000);
  });
};

try {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const page = list.find((x) => x.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r) => ws.addEventListener('open', r));
        break;
      }
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  if (!ws) throw new Error('连不上 Chrome');

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result); pending.delete(m.id); }
  });

  await send('Page.enable');
  await send('Runtime.enable');

  const dataUrl = 'data:image/png;base64,' + readFileSync(resolve(src)).toString('base64');
  const expr = `(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(dataUrl)};
    await img.decode();
    const c = document.createElement('canvas');
    c.width = ${SIZE}; c.height = ${SIZE};
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, ${SIZE}, ${SIZE});
    return c.toDataURL('image/png');
  })()`;

  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  const result = r?.result?.value;
  if (!result || !result.startsWith('data:image/png;base64,')) {
    throw new Error('缩放失败：' + JSON.stringify(r).slice(0, 300));
  }
  const buf = Buffer.from(result.slice('data:image/png;base64,'.length), 'base64');
  writeFileSync(resolve(out), buf);
  console.log(`✓ ${out} ${SIZE}×${SIZE} ${(buf.length / 1024).toFixed(1)}KB（源 ${(readFileSync(resolve(src)).length / 1024).toFixed(0)}KB）`);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill();
}
