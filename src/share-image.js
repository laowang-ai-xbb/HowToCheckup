// SPDX-License-Identifier: MIT
// Copyright (c) 2026 老王AI瞎bb
// See LICENSE at the repository root.

/**
 * 把清单画成一张图，用户在微信里长按就能转发。
 *
 * 为什么是图，不是链接：
 *   · 微信内置浏览器不能新开标签页，链接常被折叠成一行灰字，点开率很低；
 *   · 公众号自定义分享卡片要公众号 + 认证 + 备案 + 后端签名，个人项目做不起；
 *   · 长按图片 → 发送给朋友，是微信里最熟练的动作，不用教；
 *   · 链接会失效，图不会。而且图里天然带品牌。
 *
 * 三条硬约束（都是踩过或明确知道的坑）：
 *   1. 不放二维码、不写「扫码查看」「关注领取」—— 会被判定诱导，轻则限流重则封域名；
 *   2. 图上不引用任何外链图片 —— canvas 会被跨域污染，toDataURL 直接抛错，图根本出不来；
 *   3. 宽 750px、高不超 2000px —— 微信转发会压图，再宽就糊。
 */

const W = 750;
const PAD = 54;
const MAX_H = 2000;
const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif';

const C = {
  paper: '#f7f4ee',
  card: '#fffefb',
  ink: '#1b1a17',
  ink2: '#5c5850',
  ink3: '#6f6a5f',
  teal: '#0f766e',
  line: '#e4dfd4',
};

const wrap = (ctx, text, maxW) => {
  const out = [];
  let line = '';
  for (const ch of String(text)) {
    if (line && ctx.measureText(line + ch).width > maxW) {
      out.push(line);
      line = ch;
    } else {
      line += ch;
    }
  }
  if (line) out.push(line);
  return out;
};

/**
 * @param {object} d
 * @param {string} d.ageLine       “68 岁 · 女”
 * @param {Array}  d.groups        [{ title, color, items: [{ label, freq }] }]
 * @param {string} [d.home]      站点首页（短，能念出来）
 * @returns {string|null} dataURL
 */
export const renderShareCard = (d) => {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = 2600; // 先画在长布上，最后按实际高度裁 —— 比先量后排简单，且不会算漏
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, W, canvas.height);

  const inner = W - PAD * 2;
  const setFont = (size, weight = '400', color = C.ink) => {
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.fillStyle = color;
  };

  let y = PAD + 10;

  /* 品牌 */
  setFont(22, '600', C.ink3);
  ctx.fillText('长 命 百 岁', PAD, y);
  y += 42;
  setFont(42, '700', C.teal);
  ctx.fillText('体检项目指南', PAD, y);
  y += 34;
  setFont(24, '400', C.ink3);
  ctx.fillText('体检做什么项目，来这查', PAD, y);
  y += 34;

  ctx.fillStyle = C.line;
  ctx.fillRect(PAD, y, inner, 1);
  y += 44;

  /* 谁 */
  setFont(28, '400', C.ink2);
  ctx.fillText(d.ageLine, PAD, y);
  // 老板 2026-11-23 定：图上不摆「建议做 X 项…」那块统计 —— 分组标题本身已经说了是什么，
  // 再用一行数字重复一遍只会把项目往上挤。紧跟年龄往下走，留出间距进分组。
  y += 36;

  /* 分组
   * 排版规则只有一条：y 永远停在"刚刚画完那一行的基线"上，
   * 下一行自己负责加间距。上一版是"先减回去再统一加"，碰上频率折成两行就会叠字 ——
   * 折行的地方最容易算错，所以宁可每处各加各的。 */
  for (const g of d.groups) {
    if (!g.items.length) continue;

    y += 58;
    ctx.fillStyle = g.color;
    ctx.beginPath();
    ctx.arc(PAD + 7, y - 11, 7, 0, Math.PI * 2);
    ctx.fill();

    setFont(30, '700', C.ink);
    ctx.fillText(g.title, PAD + 26, y);

    for (const it of g.items) {
      y += 46;
      setFont(30, '400', C.ink);
      const labelLines = wrap(ctx, '· ' + it.label, inner);
      labelLines.forEach((ln, i) => ctx.fillText(ln, PAD, y + i * 40));
      y += (labelLines.length - 1) * 40;

      if (it.freq) {
        setFont(22, '400', C.ink3);
        for (const ln of wrap(ctx, it.freq, inner)) {
          y += 30;
          ctx.fillText(ln, PAD + 16, y);
        }
      }
    }
  }

  /* 脚注
   * 图上**不放任何链接**（按老板 2026-11-19 的决定）。
   * 原来的 #p= 链接有三百多个字符，画出来是五行乱码，而且图片不能点；
   * 连站点首页也一并去掉 —— 图只负责把清单说清楚，回流交给同时复制的那段文字。
   *
   * 2026-11-23 老板定：这块本来重复一遍品牌名（页头已经写了一次），
   * 改成一句祝福 + 落款。图片转到家人手机上，最后落在他眼里的是这句话，不是 logo。
   */
  y += 44;
  ctx.fillStyle = C.line;
  ctx.fillRect(PAD, y, inner, 1);
  y += 46;

  setFont(27, '700', C.teal);
  ctx.fillText('祝大家都长命百岁，身心嗨皮!', PAD, y);
  y += 38;
  setFont(23, '400', C.ink2);
  ctx.fillText('一个想让你长命百岁的人', PAD, y);
  y += 34;
  setFont(21, '400', C.ink3);
  for (const ln of wrap(ctx, '依据公开指南生成，不是医疗建议；已确诊疾病、正在服药的人请直接找医生。', inner)) {
    ctx.fillText(ln, PAD, y);
    y += 30;
  }

  /* 裁掉多余高度 */
  const h = Math.min(Math.ceil(y + PAD), MAX_H, canvas.height);
  const out = document.createElement('canvas');
  out.width = W;
  out.height = h;
  out.getContext('2d').drawImage(canvas, 0, 0);
  return out.toDataURL('image/png');
};
