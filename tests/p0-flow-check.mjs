#!/usr/bin/env node
/**
 * P0-1 / P1-6 / P0-3 走查：用真实浏览器走一遍问卷，验证红旗分流与结果页新模块。
 * 走 CDP，无第三方依赖（和 shot.mjs / browser-check.mjs 同一套）。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:4199';
const PORT = 9471;
const OUT = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'shots-p0') + '/';
mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + (process.env.TMP || '/tmp') + '/p0-' + Date.now(), 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; let seq = 0; const pending = new Map();
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
  if (m.method === 'Runtime.exceptionThrown') console.log('   [页面异常]', m.params?.exceptionDetails?.text, m.params?.exceptionDetails?.exception?.description?.slice(0, 200));
  if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result); pending.delete(m.id); }
});
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(OUT + name + '.png', Buffer.from(s.data, 'base64'));
  console.log('  📷', name);
};
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('ok  ', name); }
  else { fail++; console.log('FAIL', name, detail); }
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: true });
await send('Page.navigate', { url: BASE + '/index.html' });
await sleep(1200);

// 首页：年龄和性别同屏，填完点"查看项目清单"
await ev(`(function(){var i=document.getElementById('ageHome');if(i){i.value='56';i.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
await ev(`(document.querySelector('[data-act="sex"][data-v="male"]')||{}).click?.()`);
await sleep(250);
await ev(`(document.querySelector('[data-act="begin"]')||{}).click?.()`);
await sleep(450);

console.log('\n--- 红旗题 ---');
const qtitle = await ev(`document.querySelector('.qtitle')?.textContent`);
check('红旗题在性别后出现', /这些情况/.test(qtitle || ''), qtitle);
const optCount = await ev(`document.querySelectorAll('.opts.redflags .opt').length`);
check('红旗题 8 个选项', optCount === 8, String(optCount));
// 勾一个急诊(stroke,第0项) + 一个门诊(bloodInStool,第3项)
await ev(`document.querySelectorAll('.opts.redflags .opt')[0]?.click()`);
await ev(`document.querySelectorAll('.opts.redflags .opt')[3]?.click()`);
await sleep(250);
await shot('q-redflag');
// 下一步 → 应弹急诊层
await ev(`(document.querySelector('[data-act="multi-next"]')||{}).click?.()`);
await sleep(400);
const emg = await ev(`document.querySelector('.emergency-mask')?.textContent || ''`);
check('勾急诊项弹出 120 层', /现在就打 120/.test(emg) && /时间就是生命/.test(emg), emg.slice(0, 60));
const tel = await ev(`document.querySelector('.emg-call')?.getAttribute('href')`);
check('120 按钮可点击拉起电话', tel === 'tel:120', String(tel));
await shot('q-emergency');
// 继续填
await ev(`(document.querySelector('[data-act="emergency-continue"]')||{}).click?.()`);
await sleep(400);
check('关掉弹层后继续问卷', await ev(`!document.querySelector('.emergency-mask')`));

// 快走到结果页：每屏点第一个可推进的出口
console.log('\n--- 快走到结果页 ---');
for (let i = 0; i < 40; i++) {
  const atResult = await ev(`!!document.querySelector('.result')`);
  if (atResult) break;
  // 记录当前题，便于卡住时定位
  const curQ = await ev(`document.querySelector('.qtitle')?.textContent || '(no qtitle)'`);
  if (i >= 34) {
    const acts = await ev(`[...document.querySelectorAll('.qtitle ~ * [data-act], .opts [data-act], .none-row [data-act], [data-act^="body"], [data-act="review-next"]')].map(x=>x.dataset.act+':'+x.textContent.trim().slice(0,10)).join(' | ')`);
    console.log('   卡在题:', curQ, '| 按钮:', acts);
  }
  // 按题型操作：single 点第一个 opt（自动推进）；multi 走 none→multi-next；
  // body 点"不方便说"降级再走；有明确 next 按钮的走按钮。
  await ev(`(function(){
    var q=document.querySelector('.qtitle')?.textContent||'';
    // body 题：直接选不方便说降级
    var shape=[...document.querySelectorAll('.opt, .seg-b, [data-act]')].find(x=>/不方便说/.test(x.textContent)&&x.textContent.length<12);
    // 体型的"不方便说/不确定"要先于 body-next 点，否则空着身高体重点 next 会被校验挡住
    var bodyExit=document.querySelector('[data-act="body-declined"]')||document.querySelector('[data-act="body-dunno"]');
    if(bodyExit){bodyExit.click();return}
    var a=document.querySelector('[data-act="none"]')||document.querySelector('[data-act="dunno"]')||
      document.querySelector('[data-act="multi-next"]')||document.querySelector('[data-act="body-next"]')||
      document.querySelector('[data-act="review-next"]')||document.querySelector('[data-act="age-next"]');
    if(a){a.click();return}
    // single 题：点第一个选项（pick）——它自带推进
    var o=document.querySelector('[data-act="pick"]')||document.querySelector('.opts .opt')||document.querySelector('[data-act="shape"]');
    if(o){o.click();return}
  })()`);
  await sleep(200);
}
await sleep(500);
const atResult = await ev(`!!document.querySelector('.result')`);
check('走到结果页', atResult);
if (atResult) {
  const banner = await ev(`document.querySelector('.flag-banner')?.textContent || ''`);
  check('门诊横幅出现且带症状', /需尽快看医生/.test(banner) && /大便带血/.test(banner), banner.slice(0, 80));
  check('横幅用"让医生当面判断"定稿文案', /让医生当面判断/.test(banner), banner.slice(0, 100));
  const tags = await ev(`document.querySelectorAll('.atom .dtag').length`);
  check('卡片有决策类型标签', tags > 0, String(tags));
  const legend = await ev(`document.querySelector('.dlegend')?.textContent || ''`);
  check('结果页底部有标签解释折叠', /预防/.test(legend) && /筛查/.test(legend) && /复查/.test(legend), legend.slice(0, 60));
  const whyYou = await ev(`[...document.querySelectorAll('.whyYou')].map(x=>x.textContent).join('|')`);
  check('卡片有"为什么列给你"', /为什么列给你/.test(whyYou), whyYou.slice(0, 80));
  const redtip = await ev(`document.querySelector('.redtip')?.textContent || ''`);
  check('肠镜卡有红旗提示', /你刚才勾过这条/.test(redtip), redtip.slice(0, 80));
  await shot('r-result');
  // 依据页
  await ev(`(function(){var a=[...document.querySelectorAll('a')].find(x=>/依据|这些结论是哪来的/.test(x.textContent));if(a){a.href&&location.assign(a.href)}})()`);
  await sleep(900);
  const whyTitle = await ev(`[...document.querySelectorAll('.evwhy b')].map(x=>x.textContent)`);
  check('依据页改名为"这条检查是怎么回事"', (whyTitle || []).some((t) => /这条检查是怎么回事/.test(t)), JSON.stringify(whyTitle));
  const dots = await ev(`document.querySelectorAll('.evwhy-l li').length`);
  check('依据正文拆成圆点句', dots > 10, String(dots));
  const more = await ev(`document.querySelectorAll('.evwhy-more').length`);
  check('长正文有"展开剩下N句"折叠', more > 0, String(more));
  await shot('r-evidence');
}

console.log(`\n${pass}/${pass + fail} 通过`);
chrome.kill();
process.exit(fail ? 1 : 0);
