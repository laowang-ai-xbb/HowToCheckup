#!/usr/bin/env node
/**
 * 端识别的单测（不联网、不开浏览器）。
 *
 * 为什么值得单独测：这段逻辑决定"打印按钮给不给、分享走哪条路、文案写什么"。
 * 它出错的方式是**安静的** —— 页面照样打开，只是某个端上少了一个入口，
 * 或者点下去没反应。这种 bug 只有在真机上才被抓到，而真机覆盖不了所有端。
 * 所以把它写成纯函数，把每种端都造一遍。
 */
import { detectEnv, copyFor } from '../src/env.js';

const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  iphoneWeChat:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.44(0x18002c29) NetType/WIFI Language/zh_CN',
  androidWeChat:
    'Mozilla/5.0 (Linux; Android 13; PGT-AN10 Build/HONORPGT-AN10; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.44.2460(0x28002C34) WeChat/arm64',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  // iPadOS 13 起默认发桌面 UA，只能靠"有触摸但报 Macintosh"认出来
  ipadDesktopUA:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  winChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  // 国内常见的"套壳"浏览器：UA 里既有 Mobile 又有桌面内核
  quarkAndroid:
    'Mozilla/5.0 (Linux; U; Android 13; zh-CN; PGT-AN10 Build/HONORPGT-AN10) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.58 Quark/6.9.0.360 Mobile Safari/537.36',
};

const cases = [
  {
    name: 'iPhone Safari：走系统分享，打印照样给（手机能存 PDF）',
    input: { ua: UA.iphoneSafari, pointerFine: false, width: 390, hasShare: true, hasClipboard: true },
    want: { isWeChat: false, isMobile: true, canPrint: true, shareMode: 'system' },
  },
  {
    name: '微信 iOS：即使有 navigator.share 也不走系统分享，且不给打印',
    input: { ua: UA.iphoneWeChat, pointerFine: false, width: 390, hasShare: true, hasClipboard: false },
    want: { isWeChat: true, isMobile: true, canPrint: false, shareMode: 'clipboard' },
  },
  {
    name: '微信安卓：同上，并且被识别为安卓',
    input: { ua: UA.androidWeChat, pointerFine: false, width: 393, hasShare: false, hasClipboard: false },
    want: { isWeChat: true, isAndroid: true, isMobile: true, canPrint: false, shareMode: 'clipboard' },
  },
  {
    name: '安卓 Chrome：走系统分享，打印给',
    input: { ua: UA.androidChrome, pointerFine: false, width: 412, hasShare: true, hasClipboard: true },
    want: { isWeChat: false, isAndroid: true, canPrint: true, shareMode: 'system' },
  },
  {
    name: 'iPad（桌面 UA + 触摸）：不能被当成桌面，但打印给',
    input: { ua: UA.ipadDesktopUA, pointerFine: false, width: 1024, hasShare: true, hasClipboard: true },
    want: { isMobile: true, isIOS: true, canPrint: true },
  },
  {
    name: 'Mac Chrome 全屏：给打印',
    input: { ua: UA.macChrome, pointerFine: true, width: 1440, hasShare: false, hasClipboard: true },
    want: { isDesktop: true, isMobile: false, canPrint: true, shareMode: 'clipboard' },
  },
  {
    name: 'Windows Chrome 缩到 700 宽：窗口窄也给打印（不再按宽度藏入口）',
    input: { ua: UA.winChrome, pointerFine: true, width: 700, hasShare: false, hasClipboard: true },
    want: { isDesktop: true, canPrint: true },
  },
  {
    name: '夸克等套壳浏览器：仍按手机处理，不误判成桌面，打印给',
    input: { ua: UA.quarkAndroid, pointerFine: false, width: 393, hasShare: false, hasClipboard: true },
    want: { isMobile: true, isWeChat: false, canPrint: true },
  },
  {
    name: '微信里的复制提示要教他"长按粘贴"',
    input: { ua: UA.iphoneWeChat, pointerFine: false, width: 390, hasShare: false, hasClipboard: false },
    want: { shareToast: /长按|粘贴/, shareBtn: /复制/ },
    check: 'copy',
  },
  {
    name: '桌面上的复制提示不提"长按"',
    input: { ua: UA.winChrome, pointerFine: true, width: 1440, hasShare: false, hasClipboard: true },
    want: { shareToast: /邮件|微信/, showPrint: true },
    check: 'copy',
  },
];

let pass = 0;
for (const c of cases) {
  const env = detectEnv(c.input);
  const actual = c.check === 'copy' ? { ...env, ...copyFor(env) } : env;
  const bad = Object.entries(c.want).filter(([k, v]) =>
    v instanceof RegExp ? !v.test(String(actual[k])) : actual[k] !== v,
  );
  if (bad.length) {
    console.log(`FAIL ${c.name}`);
    for (const [k, v] of bad) console.log(`       ${k}: 期望 ${v}，实际 ${actual[k]}`);
  } else {
    console.log(`ok   ${c.name}`);
    pass++;
  }
}

console.log(`\n${pass}/${cases.length} 通过`);
if (pass !== cases.length) process.exit(1);
