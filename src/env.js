// SPDX-License-Identifier: MIT
// Copyright (c) 2026 老王AI瞎bb
// See LICENSE at the repository root.

/**
 * 端识别：这个页面现在跑在什么地方，哪些能力可以依赖。
 *
 * 原则：**能力探测优先，UA 只用来兜底已知的坑**。
 * 原因很实在 —— UA 会骗人、会过时：
 *   · iPadOS 13 起 Safari 默认发桌面 UA（Macintosh），拿 UA 判"是不是手机"必错；
 *   · 安卓平板常报桌面 UA；
 *   · 各种"浏览器"套壳（UC、夸克、百度）UA 五花八门。
 * 而能力探测不会骗人：能不能拿到 navigator.share、指针是粗还是细，直接问浏览器。
 *
 * 唯一必须用 UA 判的是**微信内置浏览器**：它不是"某个浏览器版本老"，而是一套确定的
 * 限制（不能新开标签页、剪贴板 API 常被拒、window.print 无效）。这类"已知的坑"没法
 * 靠能力探测提前发现 —— 能力都在，只是用起来不灵。
 */

/** 从运行环境收集原始信号。放在最外层，测试时可以直接传假数据。 */
export const readEnv = () => ({
  ua: (typeof navigator !== 'undefined' && navigator.userAgent) || '',
  // 手指是 coarse，鼠标是 fine。比 UA 里的 "Mobile" 可靠得多。
  pointerFine:
    typeof matchMedia === 'function' ? matchMedia('(hover: hover) and (pointer: fine)').matches : true,
  width: typeof window !== 'undefined' ? window.innerWidth : 1024,
  hasShare: typeof navigator !== 'undefined' && typeof navigator.share === 'function',
  hasClipboard: typeof navigator !== 'undefined' && !!(navigator.clipboard && navigator.clipboard.writeText),
  canPrint: typeof window !== 'undefined' && typeof window.print === 'function',
});

/**
 * 纯函数：输入原始信号，输出这台设备能干什么。
 * 不读全局变量，所以可以在 Node 里把每种端都跑一遍（见 tests/env-unit.mjs）。
 */
export const detectEnv = (s = {}) => {
  const ua = String(s.ua || '');
  const u = ua.toLowerCase();
  const pointerFine = s.pointerFine !== false;
  const width = Number(s.width) || 1024;

  const isWeChat = /micromessenger/.test(u);
  const isIOS = /iphone|ipad|ipod/.test(u) || (/macintosh/.test(u) && !pointerFine);
  const isAndroid = /android/.test(u);
  const isMobile = !pointerFine || /mobile|iphone|android/.test(u);

  /**
   * 打印入口：除了微信，一律给。
   *
   * 2026-11-23 老板走查：结果页的「打印 / 存成 PDF」不见了，问「谁让你改的」。查下来
   * 谁也没删 —— 是这里把按钮藏了：上一版的条件是「真桌面 + 有鼠标 + 宽 ≥760」，
   * 他一窄窗口 / 一带触摸的笔记本 / 手机上就判成 false，按钮和它的替代文案一起消失。
   *
   * 教训不是"判断写错了"，是**这个判断的代价由用户承担，而收益只是我们少想一件事**：
   * 藏掉一个入口，用户看到的是"这产品没有打印"，不会想到"它觉得我打印不了"。
   *
   * 现在的口径：只在微信内不给（X5/WKWebView 的 window.print 确实点了没反应，
   * 那不是"体验差一点"，是骗人 —— 微信里继续给替代路径的说明）。
   * 手机浏览器点打印会调起系统打印面板，能存 PDF，这是真能力，就给它入口。
   */
  const canPrint = !isWeChat;

  return {
    isWeChat,
    isIOS,
    isAndroid,
    isMobile,
    isDesktop: !isMobile,
    canPrint,
    /** 分享方式：手机优先系统分享面板，其余走复制 */
    shareMode: s.hasShare && isMobile && !isWeChat ? 'system' : 'clipboard',
    hasClipboard: !!s.hasClipboard,
  };
};

/**
 * 各个端上的文案差异。集中在这里，不要让文案散落在渲染函数里 ——
 * 散落的结果是改一个端要翻五个文件，而且必然漏一个。
 */
export const COPY = {
  shareBtn: { clipboard: '复制清单文字和链接', system: '分享清单' },
  // 微信里点"复制"以后，用户下一步是粘到聊天框 —— 直接告诉他怎么发出去
  shareToast: {
    wechat: '已复制。回到聊天窗口，长按输入框粘贴',
    mobile: '已复制，粘到微信发给家人',
    desktop: '已复制，粘到微信或邮件里发给家人',
  },
  printBtn: '打印 / 存成 PDF',
};

export const copyFor = (env) => ({
  shareBtn: COPY.shareBtn[env.shareMode],
  shareToast: env.isWeChat ? COPY.shareToast.wechat : env.isMobile ? COPY.shareToast.mobile : COPY.shareToast.desktop,
  showPrint: env.canPrint,
});
