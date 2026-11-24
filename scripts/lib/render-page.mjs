/**
 * 用无头 Chrome 把页面渲染出来再取正文。
 *
 * 为什么需要它：有些站点对脚本请求只回一个空壳页或直接 403/412
 * （Choosing Wisely 全站返回同一份 226KB 首页、卫健委 412、PMC 弹 reCAPTCHA），
 * 但它对真浏览器是正常的。--dump-dom 让 Chrome 自己加载、执行 JS，再吐最终 DOM。
 *
 * 代价：一次 3–8 秒，比 fetch 慢一个数量级，所以只当兜底，不默认走。
 *
 * Chrome 在哪：本机开发是 Windows，定时巡检跑在 Linux（GitHub Actions），
 * 所以不能写死路径 —— 按 env → 各平台常见位置 → PATH 的顺序找。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { htmlToText } from './source-fetch.mjs';

const CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

const findInPath = (names) => {
  for (const n of names) {
    const r = spawnSync('which', [n], { encoding: 'utf8' });
    if (r.status === 0 && (r.stdout || '').trim()) return r.stdout.trim();
  }
  return null;
};

let cached;
const resolveChrome = () => {
  if (cached !== undefined) return cached;
  cached = CANDIDATES.find((p) => existsSync(p)) || findInPath(['google-chrome', 'chromium', 'chromium-browser']) || null;
  return cached;
};

export const chromeAvailable = () => !!resolveChrome();

/** 返回 { text } 或抛错；budget 是让 JS 跑完的虚拟时间预算 */
export const renderWithChrome = (url, budget = 12000) => {
  const bin = resolveChrome();
  if (!bin) throw new Error('找不到 Chrome，无法渲染（设置 CHROME 环境变量，或安装 chromium）');
  const r = spawnSync(
    bin,
    [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--virtual-time-budget=' + budget,
      '--dump-dom', url,
    ],
    { encoding: 'utf8', timeout: budget + 20000, maxBuffer: 96 * 1024 * 1024 },
  );
  const dom = r.stdout || '';
  if (!dom.trim()) throw new Error('Chrome 渲染得到空页面（多半被 WAF 挡了）');
  const text = htmlToText(dom);
  if (text.length < 400) throw new Error(`Chrome 渲染后正文过短（${text.length} 字），可能是验证页`);
  return { text, contentType: 'text/html (rendered)' };
};
