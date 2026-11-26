#!/usr/bin/env node
/** P3 心情问卷走查：真浏览器验证入口卡、三题、危机全屏层、电话、关闭、出口。 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
const BASE = process.env.BASE || 'http://127.0.0.1:4199';
const PORT = 9472;
const OUT = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'shots-p0') + '/';
mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + (process.env.TMP || '/tmp') + '/p3-' + Date.now(), 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; let seq = 0; const pending = new Map();
const send = (method, params = {}) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => { pending.set(id, res); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout')); } }, 15000); });
};
for (let i = 0; i < 40; i++) {
  try { const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
    const p = l.find((x) => x.type === 'page');
    if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener('open', r)); break; } } catch {}
  await sleep(200);
}
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
const shot = async (n) => { const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(OUT + n + '.png', Buffer.from(s.data, 'base64')); };
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { if (ok) { pass++; console.log('ok  ', n); } else { fail++; console.log('FAIL', n, d); } };

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: true });

// 用分享链接直接进结果页（心理问卷在结果页末尾），避免重走整份问卷
// hash 只带画像字段；心理问卷不进链接，正好验证它每次都是全新状态
const CODE = 'eyJhZ2UiOjU2LCJnZW5kZXIiOiJtYWxlIiwic21va2luZyI6InF1aXQiLCJwYWNrWWVhcnMiOjMwLCJocFN0YXR1cyI6InBvc2l0aXZlIn0';
await send('Page.navigate', { url: BASE + '/r.html#p=' + CODE });
await sleep(1200);

console.log('\n--- 入口卡 ---');
check('结果页有心情入口卡', await ev(`!!document.querySelector('#mind .mind-open')`));
const lead = await ev(`document.querySelector('.mind-lead')?.textContent||''`);
check('入口卡写明不影响清单', /答不答都不影响/.test(lead), lead);

// 打开
await ev(`document.querySelector('[data-mind="toggle"]')?.click()`);
await sleep(300);
check('打开后出第 1 题', /做事情提不起劲/.test(await ev(`document.querySelector('.mind-qt')?.textContent||''`)));

// 第1题：几乎没有（第0项）
await ev(`document.querySelectorAll('[data-mind="pick"]')[0]?.click()`);
await sleep(250);
const q2hint = await ev(`document.querySelector('.mind-qh')?.textContent||''`);
check('第2题提示行是定稿文案', q2hint === '怎么答都不会被记录、不会影响你的体检清单。', q2hint);
check('第2题是伤害自己那题', /不想活了|伤害自己/.test(await ev(`document.querySelector('.mind-qt')?.textContent||''`)));

console.log('\n--- 危机路径 ---');
// 第2题：选"有过，而且比较具体"（第2项）→ 立即全屏
await ev(`document.querySelectorAll('[data-mind="pick"]')[2]?.click()`);
await sleep(350);
const crisis = await ev(`document.querySelector('.mind-crisis')?.textContent||''`);
check('立即弹全屏求助层', /告诉.{0,3}信任的人/.test(crisis) && /别一个人待着/.test(crisis), crisis.slice(0, 60));
check('全屏文案含定稿落款', /一个想你开心快乐的人/.test(crisis), crisis.slice(-40));
/* 模块内 inlineCrisis 与全屏层各有三个号码（老板 2026-11-26 定：关掉全屏后模块里仍能看到号码），
 * 所以全页一共 6 个 href。这里只看全屏层那一份，避免把两份混为一谈。 */
const tels = await ev(`[...document.querySelectorAll('.mind-crisis .mind-tel')].map(a=>a.getAttribute('href'))`);
check('全屏层三个电话都可点击拉起', JSON.stringify(tels) === JSON.stringify(['tel:12356','tel:01082951332','tel:962525']), JSON.stringify(tels));
check('有 24 小时免费心理援助热线标注', /24小时免费心理援助热线/.test(crisis));
await shot('p3-crisis');
// 关闭按钮
await ev(`document.querySelector('[data-mind="close"]')?.click()`);
await sleep(250);
check('关闭按钮能关掉全屏层', await ev(`!document.querySelector('.mind-crisis')`));

console.log('\n--- 三条出口（重新进，各自独立）---');
/* 三条出口互不混用：flash=安全信号单独卡 / mild=温和卡 / quiet=静默卡。
 * 2026-11-26 老板要的专业审视：一闪而过想伤害自己，紧急程度高于心情低落，
 * 不能再用同一句"找专业的人聊聊"带过。 */
const run = async (picks) => {
  await send('Page.navigate', { url: BASE + '/r.html#p=' + CODE });
  await ev('location.reload()');
  await sleep(1100);
  await ev(`document.querySelector('[data-mind="toggle"]')?.click()`);
  await sleep(150);
  for (const i of picks) { await ev(`document.querySelectorAll('[data-mind="pick"]')[${i}]?.click()`); await sleep(160); }
  /* 危机后模块里会常驻一张 .mind-out.crisis-inline，别把它当成答题出口。
   * 只看 .mind-body 直属的出口卡（mild/flash/quiet 三种之一）。 */
  return await ev(`document.querySelector('.mind-body > .mind-out:not(.crisis-inline)')?.textContent||''`);
};

// flash：mood 几乎没有(0) → selfHarm 一闪而过(1) → impact 没有影响(0)
const flashOut = await run([0, 1, 0]);
check('一闪而过 → 安全信号单独卡（直说伤害自己 + 立刻行动）',
  /想过伤害自己/.test(flashOut) && /现在就拨打/.test(flashOut) && /12356/.test(flashOut), flashOut.slice(0, 90));
check('安全卡不给诊断、不写"找专业的人聊聊"那句轻话',
  !/抑郁|焦虑|诊断/.test(flashOut) && !/找专业的人聊聊/.test(flashOut), flashOut.slice(0, 90));
await shot('p3-flash');

// mild：mood 一半以上的日子(2) → selfHarm 没有(0) → impact 没有影响(0)
const mildOut = await run([2, 0, 0]);
check('心情低落 → 温和卡片', /找专业的人聊聊/.test(mildOut) && /12356/.test(mildOut), mildOut.slice(0, 80));
check('温和出口不给诊断', !/抑郁|焦虑|诊断/.test(mildOut), mildOut.slice(0, 80));
await shot('p3-mild');

// quiet：mood 几乎没有(0) → selfHarm 没有(0) → impact 没有影响(0)
const quietOut = await run([0, 0, 0]);
check('全轻档 → 静默卡片（不吓人）', /这就是全部/.test(quietOut), quietOut.slice(0, 80));
await shot('p3-quiet');

console.log(`\n${pass}/${pass + fail} 通过`);
chrome.kill();
process.exit(fail ? 1 : 0);
