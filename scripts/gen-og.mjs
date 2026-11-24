/**
 * 生成分享卡片图（og:image，1200×630）
 *
 * 为什么不手工做图：图上的文案会随产品改，手工图迟早和页面不一致。
 * 用 HTML + 无头 Chrome 截图，文案就在这个文件里，改一处即可。
 *
 * 没有 Chrome 的环境不报错，只是跳过（图留着上一次的）。
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = 'public/og.png';
const TMP = '.og-source.html';

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1200px; height: 630px; background: #f7f4ee; color: #1b1a17;
    font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    padding: 64px 72px; display: flex; flex-direction: column; justify-content: space-between;
    border-left: 14px solid #0f766e;
  }
  .brand { display: flex; align-items: baseline; gap: 14px; }
  .name { font-size: 30px; font-weight: 700; color: #0f766e; letter-spacing: .02em; }
  .slogan { font-size: 22px; color: #8a857a; }
  h1 { font-size: 68px; line-height: 1.24; font-weight: 700; letter-spacing: -.01em; }
  h1 em { font-style: normal; color: #0f766e; }
  .tiers { display: flex; gap: 18px; }
  .tier { flex: 1; background: #fffefb; border: 1px solid #e4dfd4; border-left: 6px solid #ccc; border-radius: 14px; padding: 18px 20px; }
  .tier b { display: block; font-size: 26px; margin-bottom: 6px; }
  .tier span { font-size: 19px; color: #5c5850; line-height: 1.4; }
  .a { border-left-color: #0f766e; } .a b { color: #0f766e; }
  .b { border-left-color: #b45309; } .b b { color: #b45309; }
  .c { border-left-color: #8a857a; } .c b { color: #5c5850; }
  .foot { font-size: 19px; color: #8a857a; }
</style></head><body>
  <div class="brand"><span class="name">体检项目指南</span><span class="slogan">体检该做什么</span></div>
  <h1>先搞清楚<br><em>今年该做哪几项</em></h1>
  <div class="tiers">
    <div class="tier a"><b>A · 该做</b><span>写清多久做一次</span></div>
    <div class="tier b"><b>B · 和医生商量</b><span>拿不准的交给医生</span></div>
    <div class="tier c"><b>C · 不用做</b><span>省下这笔钱</span></div>
  </div>
  <div class="foot">依据国家癌症中心、国家卫生健康委、USPSTF 等公开指南 · 每条都能点开看出处</div>
</body></html>`;

try {
  mkdirSync('public', { recursive: true });
  writeFileSync(TMP, html, 'utf8');
  if (!existsSync(CHROME)) {
    console.warn(`[og] 跳过：找不到 Chrome（${CHROME}）。设置 CHROME 环境变量可生成分享图。`);
  } else {
    const r = spawnSync(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--force-device-scale-factor=1', '--window-size=1200,630',
      '--virtual-time-budget=2500',
      `--screenshot=${join(process.cwd(), OUT).replace(/\\/g, '/')}`,
      'file://' + join(process.cwd(), TMP).replace(/\\/g, '/'),
    ], { stdio: 'ignore', timeout: 60000 });
    if (r.status === 0 && existsSync(OUT)) console.log('[og] 已生成 ' + OUT);
    else console.warn('[og] 生成失败（不影响构建），窗口尺寸请确认为 1200×630。');
  }
} catch (e) {
  console.warn('[og] 跳过：' + e.message);
} finally {
  try { if (existsSync(TMP)) unlinkSync(TMP); } catch { /* ignore */ }
}
