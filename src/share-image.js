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
 *
 * 2026-11-25 整版重排（老板走查反馈：间距不均、边距不一、不对齐）。四个病灶对应四个改法：
 *   · 间距不均 → 旧版行距逐处手写（34/36/40/44/46 混用），现在全图只用一套间距档，
 *     且排版规则简化为一句话：y 永远停在"刚画完那行的基线"，下一行自己加档位间距；
 *   · 边距不一 → 每个分组装进统一内边距的白卡片，卡片与页边、卡片与卡片的间距全图一致；
 *   · 不对齐 → 旧版条目折行顶回圆点列、频率说明又随手缩 16px，一张图有三套左边缘。
 *     现在圆点标记、正文、折行、频率说明全部对齐同一条悬挂缩进线（textX）；
 *   · 长清单截断 → 旧版直接从 MAX_H 裁断，项目多时脚注祝福会被切掉。现在先量一版高度，
 *     超了就整版等比缩小重排（不低于 MIN_SCALE），保证"祝大家都长命百岁"永远落在图里。
 */

const W = 750;
const PAD = 56;          // 页边距：头部、卡片、脚注共用同一条左右边线
const MAX_H = 2000;      // 微信转发压缩上限（文件头第 3 条）
const MIN_SCALE = 0.72;  // 等比缩小的下限：再小字就没法读了，宁可裁内容
const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif';

const C = {
  paper: '#f7f4ee',
  card: '#fffefb',
  ink: '#1b1a17',
  ink2: '#5c5850',
  ink3: '#6f6a5f',
  teal: '#0f766e',
  tealTint: '#e9f1ee',
  line: '#e4dfd4',
};

/* 间距档：全图只允许这四档，堵死「这里 34、那里 36」的逐处漂移 */
const GAP = { s: 12, m: 24, l: 40, xl: 54 };

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

/* 圆角矩形：手画 arcTo，不依赖 ctx.roundRect（微信内核版本参差，不能赌新 API） */
const rrect = (ctx, x, y, w, h, r) => {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
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
  canvas.height = 2600; // 长布留足余量（内容上限是 MAX_H=2000），最后按实际高度裁
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const inner = W - PAD * 2;
  const setFont = (size, weight = '400', color = C.ink) => {
    ctx.font = `${weight} ${Math.max(1, Math.round(size))}px ${FONT}`;
    ctx.fillStyle = color;
  };

  /**
   * 整版布局。排版规则只有一条：y 永远停在"刚画完那一行的基线"，下一行自己加间距。
   * paint=false 只推 y 不落墨，专供量高 —— 测量与绘制走同一份代码，永远不会量的是一套、画的是另一套。
   */
  const layout = (scale, paint) => {
    const s = scale;
    const dot = (x, yy, r, color) => {
      if (!paint) return;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, yy, r, 0, Math.PI * 2);
      ctx.fill();
    };
    let y = 0;

    if (paint) {
      ctx.fillStyle = C.paper;
      ctx.fillRect(0, 0, W, canvas.height);
    }
    y = 64 * s; // 顶部留白：比左右边距略厚，图在手机上有"呼吸感"

    /* ── 头部：品牌 → 主标题（左侧竖色条锚住）→ 副标题 → 画像药丸 ── */
    setFont(21 * s, '600', C.ink3);
    if (paint) ctx.fillText('长 命 百 岁', PAD, y);
    y += GAP.xl * s;

    setFont(46 * s, '700', C.teal);
    if (paint) {
      ctx.fillStyle = C.teal;
      rrect(ctx, PAD, y - 44 * s, 9 * s, 56 * s, 4.5 * s); // 竖色条：头部的视觉锚点
      ctx.fill();
      ctx.fillText('体检项目指南', PAD + 28 * s, y);
    }
    y += 50 * s;

    setFont(23 * s, '400', C.ink3);
    if (paint) ctx.fillText('体检做什么项目，来这查', PAD + 28 * s, y);
    y += 34 * s;

    /* 画像药丸：年龄性别是这张图的"收件人"，提出来比一行灰字清楚 */
    setFont(24 * s, '600', C.teal);
    const pillW = ctx.measureText(d.ageLine).width + 48 * s;
    const pillH = 54 * s;
    if (paint) {
      ctx.fillStyle = C.tealTint;
      rrect(ctx, PAD + 28 * s, y, pillW, pillH, pillH / 2);
      ctx.fill();
      ctx.fillStyle = C.teal;
      ctx.fillText(d.ageLine, PAD + 28 * s + 24 * s, y + pillH * 0.68);
    }
    y += pillH + GAP.l * s;

    /* ── 分组：每组一张白卡片，内边距四边一致 ── */
    for (const g of d.groups) {
      if (!g.items.length) continue;
      const top = y;
      const CP = 30 * s;                // 卡片内边距
      const textX = PAD + CP + 24 * s;  // 悬挂缩进线：正文/折行/频率的对齐边
      const textW = inner - CP * 2 - 24 * s;

      setFont(29 * s, '700', C.ink); // 组标题
      let yy = top + CP + 32 * s;    // 组标题基线
      for (const it of g.items) {
        yy += GAP.l * s; // 组标题→首条、以及条与条之间的统一间距
        setFont(27 * s, '500', C.ink);
        const lines = wrap(ctx, it.label, textW);
        yy += (lines.length - 1) * 38 * s; // 折行只推进多出来的行
        if (it.freq) {
          setFont(20 * s, '400', C.ink3);
          const fl = wrap(ctx, it.freq, textW).length;
          yy += 30 * s + (fl - 1) * 28 * s;
        }
      }
      const cardH = yy + CP - top;
      y = top + cardH;

      if (paint) {
        ctx.save();
        ctx.shadowColor = 'rgba(27,26,23,0.06)';
        ctx.shadowBlur = 14 * s;
        ctx.shadowOffsetY = 5 * s;
        ctx.fillStyle = C.card;
        rrect(ctx, PAD, top, inner, cardH, 24 * s);
        ctx.fill();
        ctx.restore();

        // 组标题：色点 + 组名
        const hy = top + CP + 32 * s;
        dot(PAD + CP + 7 * s, hy - 10 * s, 7 * s, g.color);
        setFont(29 * s, '700', C.ink);
        ctx.fillText(g.title, PAD + CP + 26 * s, hy);

        // 条目：圆点标记挂首行，正文与所有折行、频率对齐 textX
        let iy = hy;
        for (const it of g.items) {
          iy += GAP.l * s;
          dot(PAD + CP + 8 * s, iy - 9 * s, 3.5 * s, g.color); // 先画色点再设字色，避免 fillStyle 被带走
          setFont(27 * s, '500', C.ink);
          const lines = wrap(ctx, it.label, textW);
          lines.forEach((ln, i) => ctx.fillText(ln, textX, iy + i * 38 * s));
          iy += (lines.length - 1) * 38 * s;
          if (it.freq) {
            setFont(20 * s, '400', C.ink3);
            for (const ln of wrap(ctx, it.freq, textW)) {
              iy += 30 * s;
              ctx.fillText(ln, textX, iy);
            }
          }
        }
      }
      y += GAP.m * s; // 卡片与卡片之间
    }

    /* ── 脚注：图上不放任何链接（老板 2026-11-19 定）；结尾落祝福与提醒 ── */
    y += GAP.l * s;
    if (paint) {
      ctx.fillStyle = C.line;
      ctx.fillRect(PAD, y, inner, 1);
    }
    y += GAP.xl * s;
    setFont(28 * s, '700', C.teal);
    if (paint) ctx.fillText('祝大家都长命百岁，身心嗨皮！', PAD, y);
    y += 42 * s;
    setFont(22 * s, '400', C.ink2);
    if (paint) ctx.fillText('一个想让你长命百岁的人', PAD, y);
    y += 36 * s;
    setFont(19 * s, '400', C.ink3);
    for (const ln of wrap(ctx, '依据公开指南生成，不是医疗建议；已确诊疾病、正在服药的人请直接找医生。', inner)) {
      if (paint) ctx.fillText(ln, PAD, y);
      y += 28 * s;
    }

    return y;
  };

  /* 先量一版：超高就整版等比缩小重排，保证脚注永远在图里（见文件头说明） */
  const full = layout(1, false) + PAD;
  const scale = full > MAX_H ? Math.max(MIN_SCALE, MAX_H / full) : 1;
  const endY = layout(scale, true);
  const h = Math.min(Math.ceil(endY + PAD), MAX_H, canvas.height);

  const out = document.createElement('canvas');
  out.width = W;
  out.height = h;
  out.getContext('2d').drawImage(canvas, 0, 0);
  return out.toDataURL('image/png');
};
