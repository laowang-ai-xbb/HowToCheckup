// SPDX-License-Identifier: MIT
// Copyright (c) 2026 老王AI瞎bb
// See LICENSE at the repository root.

/**
 * 手机端输入法遮挡。
 *
 * 现象：在微信里点年龄输入框，键盘从底部顶上来，把「查看项目清单」按钮盖住。
 * 用户以为按钮没了，或者点不到，就退出去了。
 *
 * 为什么不能只看 window.innerHeight：
 *   iOS Safari 和微信（WKWebView / X5）在键盘弹出时，innerHeight 经常**不变**，
 *   变的只有 visualViewport.height。用 innerHeight 判断"键盘有没有弹"，会一直判成没弹。
 *
 * 为什么不用 position: fixed 把按钮吸在底部：
 *   键盘弹出时 fixed 元素会跟着——有的端跑到键盘上面，有的被键盘盖住，
 *   安卓和 iOS 还不一样。行为不可控的东西，不如不做。
 *   这里改用「键盘弹出时把输入框和按钮滚进可视区」，行为完全可控。
 */

const vp = () => (typeof window !== 'undefined' ? window.visualViewport : null);

/** 当前真正能被用户看到的底边（键盘之上） */
export const visibleBottom = () => {
  const v = vp();
  if (!v) return typeof window !== 'undefined' ? window.innerHeight : 0;
  return v.offsetTop + v.height;
};

export const keyboardLikelyOpen = () => {
  const v = vp();
  if (!v || typeof window === 'undefined' || !window.innerHeight) return false;
  return v.height < window.innerHeight * 0.78;
};

/**
 * 让 el 完整落在键盘上方，下面再留 gap 像素（给「下一步」按钮留位置）。
 * 键盘是异步弹出来的：iOS 大约 250–350ms，安卓 200–400ms。
 * 所以取两个时间点各校正一次，只取一次会校正到"键盘还没弹完"的高度上。
 */
export const revealAboveKeyboard = (el, gap = 110) => {
  if (!el) return;
  const run = () => {
    const r = el.getBoundingClientRect();
    const over = r.bottom - (visibleBottom() - gap);
    if (over > 0) window.scrollBy({ top: over, behavior: 'smooth' });
  };
  setTimeout(run, 300);
  setTimeout(run, 607);
};

/** 订阅可视区变化（键盘弹起/收起、地址栏伸缩）。返回取消订阅的函数。 */
export const onViewportResize = (cb) => {
  const v = vp();
  if (!v) return () => {};
  const handler = () => cb(v.height);
  v.addEventListener('resize', handler);
  return () => v.removeEventListener('resize', handler);
};
