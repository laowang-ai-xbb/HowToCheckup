// SPDX-License-Identifier: MIT
// Copyright (c) 2026 老王AI瞎bb
// See LICENSE at the repository root.

/**
 * 打印 / 存 PDF：按内容自动分页的 A4 清单。
 *
 * 为什么不用 window.print() 直接打结果页：
 *   结果页是给屏幕上读的 —— 有按钮、目录、折叠依据、彩蛋、回到顶部，
 *   打出来会变成一份"网页的复印件"，老人拿着进诊室翻不到重点。
 *   老板 2026-11-22 定稿了 demo/export-design/pdf-1.html 的视觉：只留墨色和青绿，
 *   右下角是那句彩蛋签名。这里保留那套视觉，但把"固定两页"改成按内容装箱。
 *
 * 为什么必须自动分页（老板 2026-11-23 走查发现）：
 *   20 岁男性只有 A/B/C 几行，固定第二页会把明细整页推走，第一页下半张是空白；
 *   70 岁女性 A/B/C + 疫苗 + 老年评估 + 20 项明细，固定两页又会挤爆第二页。
 *   现在在 iframe 里先量每块的实际高度，再按页容量贪心装：
 *   第一页先放标题和 A/B，剩下的位置能塞下几块塞几块；表格可以按行拆到下一页，
 *   拆页时重复表头和"建议做（续）"。页数由清单决定，1 页、2 页、3 页都可能。
 *
 * 实现上用隐藏 iframe + srcdoc：
 *   · 不新开窗口（微信/手机会被拦），不分任何数据到服务器；
 *   · 打印样式和产品 CSS 完全隔离，不会被大字模式、深色模式带跑；
 *   · 每次点击重新生成，不留历史、不落盘。
 */
import { catalogById, ruleLabel } from './engine.js';

const esc = (s = '') => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 规则 → 打印稿的一行。短名走引擎里的 ruleLabel，和复制文字、分享图完全同源。 */
const rowOf = (rule) => ({
  label: ruleLabel(rule),
  freq: rule.frequency?.text || '',
});

/**
 * 从结果页已经算好的那几堆东西里，挑出打印稿要用的数据。
 * 刻意在这里收口：结果页以后改文案，只改这里一处，不会漏掉打印稿。
 */
export const makePrintData = (profile, { aRules = [], bRules = [], cRules = [], baseIds = [], vacs = [], refs = [] }) => {
  const age = Number(profile.age) || 0;
  const now = new Date();
  /* 「问医生的问题清单」（老板 2026-11-25 P1-9）：
   * 从这次命中的 A/B 规则里挑带 askDoctor 模板的，最多 4 条。只用规则里预置的问句，
   * 不在这里凭空生成诊断 —— 打印稿只递问题，不下结论。
   * 顺序沿用结果页（A 在前、priority 小的在前），保证和屏幕看到的一致。 */
  const askDoctor = [...aRules, ...bRules]
    .filter(Boolean)
    .filter((r) => r.askDoctor)
    .slice(0, 4)
    .map((r) => r.askDoctor);
  return {
    who: `${age} 岁 · ${profile.gender === 'female' ? '女' : '男'}`,
    date: `${now.getFullYear()} 年 ${now.getMonth() + 1} 月`,
    A: aRules.filter(Boolean).map(rowOf),
    B: bRules.filter(Boolean).map(rowOf),
    C: cRules.filter(Boolean).map((r) => ({ label: ruleLabel(r) })),
    // 基础套餐在结果页独占「标准项目」那一区；打印稿按定稿放在 A 表第一行，
    // 明细紧跟在后面排（能塞进第一页就塞），这样"一张纸能拿走"的结论才完整。
    basic: baseIds.map((id) => catalogById.get(id)?.name || id),
    vaccines: vacs.map((v) => ({ name: v.name, dose: v.dose, who: v.who })),
    cga: refs.map(({ title, why, dept }) => ({ title, why, dept })),
    cgaNote: '老年综合评估要医生当面做、要看你的用药和家里环境。',
    askDoctor,
    askLead: '医生只有 3 分钟，先问这一句：',
    askLeadQ: '我这份体检清单里，哪几项是针对我的情况必须做的？',
    wish: '祝你长命百岁，身体嗨皮！',
    sign: '一个想你长命百岁的人',
  };
};

const CSS = `
  /* 视觉规则与产品同源：只用 ink / ink-2 / ink-3 / paper / card / line / teal，
     不另造颜色。打印时浅底一律去掉，黑白输出也读得出来。 */
  :root{
    --ink:#1b1a17; --ink-2:#5c5850; --ink-3:#6f6a5f;
    --paper:#f7f4ee; --card:#fffefb; --line:#e4dfd4; --teal:#0f766e;
  }
  @page { size: A4; margin: 0; }
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{background:#fff}
  body{font-family:system-ui,-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
       color:var(--ink);-webkit-font-smoothing:antialiased}
  .page{width:210mm;min-height:297mm;background:var(--card);padding:12mm 14mm;
        position:relative;display:flex;flex-direction:column;break-after:page;page-break-after:always}
  .page:last-child{break-after:auto;page-break-after:auto}

  /* 页眉：品牌与文件性质，细线收口 */
  .masthead{display:flex;justify-content:space-between;align-items:baseline;
            border-bottom:1px solid var(--ink);padding-bottom:3mm}
  .brand{font-size:17px;letter-spacing:.32em;font-weight:600}
  .brand span{letter-spacing:0;font-size:12px;color:var(--ink-3);font-weight:400;margin-left:12px}
  .kind{font-size:11px;color:var(--ink-3);letter-spacing:.06em}

  h1{font-size:30px;font-weight:700;letter-spacing:-.02em;margin:6mm 0 2mm}
  .lede{font-size:11.5px;color:var(--ink-2);line-height:1.6;max-width:600px}
  .meta{margin-top:3mm;font-size:12px;color:var(--ink-3)}

  .sec{margin-top:5mm;break-inside:avoid}
  .sh{display:flex;align-items:baseline;gap:10px;margin-bottom:2mm}
  .sh h2{font-size:15px;font-weight:700;letter-spacing:.01em}
  .sh .c{font-size:11px;color:var(--ink-3)}
  .sec.muted .sh h2{color:var(--ink-3)}

  table{width:100%;border-collapse:collapse;table-layout:fixed}
  thead{display:table-header-group}
  th{font-size:10px;color:var(--ink-3);font-weight:500;text-align:left;letter-spacing:.08em;
     padding:1.5mm 0;border-bottom:1px solid var(--ink-3)}
  td{font-size:11.5px;line-height:1.4;padding:1.2mm 0;border-bottom:1px solid var(--line);vertical-align:top}
  td.item{font-weight:600;padding-right:14px;width:48%}
  td.freq{color:var(--ink-2)}
  tr:last-child td{border-bottom:0}
  tr{break-inside:avoid;page-break-inside:avoid}
  .muted th{border-bottom-color:var(--line);color:var(--ink-3)}
  .muted td{color:var(--ink-3);font-weight:400;padding:1mm 0}
  .muted td.item{font-weight:400}

  /* 基础套餐明细：作为一项的注脚，双列小字，视觉上从属于表格 */
  .detail{margin:2mm 0 3mm;padding:3mm;background:var(--paper);
          border-left:2px solid var(--teal);border-radius:0 6px 6px 0;break-inside:avoid}
  .detail .dh{font-size:10px;color:var(--teal);letter-spacing:.06em;margin-bottom:1.5mm}
  .detail ul{list-style:none;display:grid;grid-template-columns:1fr 1fr;column-gap:20px;row-gap:1px}
  .detail li{font-size:10.5px;color:var(--ink-2);line-height:1.6}

  /* 疫苗与老年评估：和产品里一样，是"另一类事"，用细线与清单区分 */
  .extra{margin-top:5mm;border-top:1px solid var(--line);padding-top:3mm;break-inside:avoid}
  .pgtitle{font-size:15px;font-weight:700;margin:6mm 0 2mm}
  .extra h2{font-size:15px;font-weight:700;margin-bottom:1mm}
  .extra .note{font-size:10.5px;color:var(--ink-3);line-height:1.6;margin-bottom:2mm}
  .vrow{display:flex;gap:12px;padding:1.5mm 0;border-bottom:1px solid var(--line);font-size:11.5px}
  .vrow:last-child{border-bottom:0}
  .vrow b{flex:0 0 130px;font-weight:600}
  .vrow span{color:var(--ink-2)}
  .cga{padding:2.5mm 3mm;background:var(--paper);border-radius:6px;margin-top:1mm;break-inside:avoid}
  .cga b{font-size:12px}
  .cga p{font-size:11px;color:var(--ink-2);margin-top:1mm;line-height:1.55}
  .cga .dept{color:var(--teal)}

  /* 「问医生的问题清单」（P1-9）：用墨色+青绿，和清单同一套视觉。
   * 放在页脚上方，整块 break-inside:avoid —— 内容变多时整体挪到下一页，不拆行。 */
  .ask{margin-top:5mm;border-top:1px solid var(--line);padding-top:3mm;break-inside:avoid}
  .ask ol{list-style:none;counter-reset:q}
  .ask li{counter-increment:q;position:relative;padding:1.3mm 0 1.3mm 7mm;border-bottom:1px dashed var(--line);font-size:11.5px;line-height:1.5;color:var(--ink-2)}
  .ask li:last-child{border-bottom:0}
  .ask li:before{content:"Q" counter(q);position:absolute;left:0;top:1.3mm;font-size:10px;color:var(--teal);font-weight:700}
  .ask .lead{background:var(--paper);border-radius:5px;padding:2mm 2.5mm;margin-top:2mm}
  .ask .lead b{font-size:11.5px;color:var(--teal)}
  .ask .lead p{font-size:10.5px;color:var(--ink-2);margin-top:.5mm;line-height:1.55}

  /* 页脚：祝福是产品彩蛋那一句的路子 —— 不解释、不署名机构，就一个人味儿签名 */
  .foot{margin-top:auto;padding-top:5mm;border-top:1px solid var(--line);
        display:flex;justify-content:space-between;align-items:flex-end;gap:24px;break-inside:avoid}
  .disc{font-size:10px;color:var(--ink-3);max-width:400px;line-height:1.65}
  .wish{text-align:right}
  .wish .w{font-size:16px;font-weight:600;color:var(--teal)}
  .wish .s{font-size:11px;color:var(--ink-3);margin-top:1mm}

  /* 量高度用的隐藏容器。flow-root 防止子元素的 margin-top  collapse 掉，
     否则每种表格量出来的高度都会少 5mm，装箱就会偏乐观。 */
  .measure{position:absolute;left:-9999px;top:0;width:688px;visibility:hidden}
  .measure .blk{display:flow-root}
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
`;

/**
 * 在 iframe 内跑的分页脚本。
 * 用普通字符串拼接，不在这里写模板字面量 —— 外层 buildPrintHTML 本身就是模板字符串，
 * 内层再出现 ${ 会被外层提前吃掉。数据用 __PRINT_DATA__ 占位符最后替换。
 */
const SCRIPT = `
(function(){
  function esc(s){return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  function post(type, extra){
    var msg = {type: type};
    if (extra) for (var k in extra) msg[k] = extra[k];
    if (window.parent && window.parent.postMessage) window.parent.postMessage(msg, '*');
  }
  var d = __PRINT_DATA__;
  var sheet = document.getElementById('sheet');

  function table(rows, muted){
    return '<table><thead><tr><th>项目</th>' + (muted ? '' : '<th style="width:50%">频率</th>') +
      '</tr></thead><tbody>' + rows.map(function(it){
        return '<tr><td class="item">' + esc(it.label) + '</td>' +
          (muted ? '' : '<td class="freq">' + esc(it.freq) + '</td>') + '</tr>';
      }).join('') + '</tbody></table>';
  }
  function masthead(kind){
    return '<div class="masthead"><div class="brand">长命百岁<span>体检项目指南</span></div>' +
      '<div class="kind">' + esc(kind) + '</div></div>';
  }
  function foot(){
    return '<div class="foot"><div class="disc">这不是医疗建议；已确诊疾病、正在服药的人请直接找医生。本清单不能替代医生面诊。</div>' +
      '<div class="wish"><div class="w">' + esc(d.wish) + '</div><div class="s">' + esc(d.sign) + '</div></div></div>';
  }
  function head(){
    var lede = d.B.length
      ? '这份清单按年龄、性别和已知情况，从公开指南里筛出来的。"你来定"的意思是获益和代价接近，建议和医生商量后再决定。'
      : '这份清单按年龄、性别和已知情况，从公开指南里筛出来的。';
    return '<h1>今年该做哪些体检</h1><div class="lede">' + lede + '</div><div class="meta">' + esc(d.who) + '</div>';
  }

  function tableBlock(title, sub, rows, muted){
    var cls = muted ? 'sec muted' : 'sec';
    return {
      rows: rows, muted: muted,
      html: function(slice, cont){
        return '<section class="' + cls + '"><div class="sh"><h2>' + esc(title) + (cont ? '（续）' : '') + '</h2>' +
          (sub ? '<span class="c">' + esc(sub) + '</span>' : '') + '</div>' + table(slice, muted) + '</section>';
      }
    };
  }
  function plainBlock(html){
    return { rows: null, html: function(){ return html; } };
  }

  function run(){
    /* 1. 先量一页到底能装多少：页高 - 上下留白 - 页眉 - 页脚 - 安全余量 */
    var probe = document.createElement('section');
    probe.className = 'page';
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden';
    probe.innerHTML = masthead('x') + foot();
    document.body.appendChild(probe);
    var cs = window.getComputedStyle(probe);
    var contentH = probe.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    var mastH = probe.querySelector('.masthead').getBoundingClientRect().height;
    var footH = probe.querySelector('.foot').getBoundingClientRect().height;
    probe.remove();
    var SAFE = 14; // 毫米级误差留一点，宁可少装一行也不要打印时对折到下一页

    var measure = document.createElement('div');
    measure.className = 'measure';
    document.body.appendChild(measure);
    function m(html){
      var box = document.createElement('div');
      box.className = 'blk';
      box.innerHTML = html;
      measure.appendChild(box);
      return box;
    }
    function h(el){ return el.getBoundingClientRect().height; }
    var headH = h(m(head()));

    /* 2. 模块清单。顺序就是打印顺序：结论 → 基础明细 → 疫苗 → 老年评估 → 不用做。
     *    表格可拆行，其余小模块整块移动。 */
    var blocks = [];
    if (d.A.length) blocks.push(tableBlock('建议做', '', d.A, false));
    if (d.B.length) blocks.push(tableBlock('你来定', '和医生商量', d.B, false));
    if (d.basic.length) {
      blocks.push(plainBlock('<h2 class="pgtitle">每年基础体检项目明细</h2><div class="detail">' +
        '<div class="dh">基础体检项目 · 包含 ' + d.basic.length + ' 项</div><ul>' +
        d.basic.map(function(x){ return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>'));
    }
    if (d.vaccines.length) {
      blocks.push(plainBlock('<div class="extra"><h2>疫苗</h2><div class="note">去街道（乡镇）的接种单位打。</div>' +
        d.vaccines.map(function(v){
          return '<div class="vrow"><b>' + esc(v.name) + '</b><span>' + esc(v.dose) + '　·　' + esc(v.who) + '</span></div>';
        }).join('') + '</div>'));
    }
    if (d.cga.length) {
      blocks.push(plainBlock('<div class="extra"><h2>老年综合评估</h2><div class="note">' + esc(d.cgaNote) + '</div>' +
        d.cga.map(function(c){
          return '<div class="cga"><b>' + esc(c.title) + '</b><p>' + esc(c.why) + ' 去 <span class="dept">' + esc(c.dept) + '</span>。</p></div>';
        }).join('') + '</div>'));
    }
    if (d.C.length) blocks.push(tableBlock('建议不做', '没有证据支持获益', d.C, true));
    /* 问医生的问题清单：只有命中卡片里预置了问句时才出现，整块装箱不拆行。
       2026-11-26 老板走查：标题原来自己一套（裸 h2 + note），和表格模块的 .sh 头
       不是一种排版语言。改成和「建议做 / 你来定」同款 .sh 结构——标题靠左、
       字号字距一致、副题挂右侧，整页只有一种模块头的写法。 */
    if (d.askDoctor && d.askDoctor.length) {
      blocks.push(plainBlock('<section class="sec ask"><div class="sh"><h2>你可以这样问医生</h2>' +
        '<span class="c">照着问就行，以医生的说法为准</span></div>' +
        '<ol>' + d.askDoctor.map(function(q){ return '<li>' + esc(q) + '</li>'; }).join('') + '</ol>' +
        '<div class="lead"><b>' + esc(d.askLead) + '</b><p>' + esc(d.askLeadQ) + '</p></div>' +
        '</section>'));
    }

    blocks.forEach(function(b){
      var box = m(b.html(b.rows || []));
      b.full = h(box);
      if (b.rows) {
        /* 行高必须从"完整表格里的那一行"量，不能拿单行另起一张表量：
         * 单独一张表会重新算列宽，长文本折行变多，量出来偏高 70px 左右，
         * 装箱就会误以为首页塞不下疫苗块。 */
        b.rowH = [].map.call(box.querySelectorAll('tbody tr'), function(tr){ return h(tr); });
        var sum = 0;
        b.rowH.forEach(function(x){ sum += x; });
        b.overhead = Math.max(24, b.full - sum);
      }
    });
    measure.remove();

    var capFirst = contentH - footH - mastH - headH - SAFE;
    var capOther = contentH - footH - mastH - SAFE;
    // 留一份测量记录：排版出问题时能直接看到是容量算错还是模块量高了
    window.__PRINT_DEBUG__ = {
      contentH: Math.round(contentH), mastH: Math.round(mastH), footH: Math.round(footH),
      headH: Math.round(headH), capFirst: Math.round(capFirst), capOther: Math.round(capOther),
      blocks: blocks.map(function(b){
        return { rows: b.rows ? b.rows.length : 0, full: Math.round(b.full), overhead: b.overhead ? Math.round(b.overhead) : 0,
          rowSum: b.rowH ? Math.round(b.rowH.reduce(function(a, x){ return a + x; }, 0)) : 0 };
      })
    };

    /* 3. 贪心装箱：当前页放得下就放；放不下就拆表格行；整块放不下就换页。 */
    var pages = [];
    var cur = { items: [], used: 0, first: true };
    function cap(){ return cur.first ? capFirst : capOther; }
    function next(){ pages.push(cur); cur = { items: [], used: 0, first: false }; }
    blocks.forEach(function(b){
      if (!b.rows) {
        if (cur.used + b.full <= cap() || !cur.items.length) {
          cur.items.push(b.html([])); cur.used += b.full;
        } else { next(); cur.items.push(b.html([])); cur.used = b.full; }
        return;
      }
      var left = b.rows.slice();
      var chunk = 0;
      while (left.length) {
        var avail = cap() - cur.used;
        var take = 0, sum = 0;
        while (take < left.length) {
          var need = sum + b.rowH[take] + (take === 0 ? b.overhead : 0);
          if (need > avail) break;
          sum += b.rowH[take]; take++;
        }
        if (!take) {
          if (cur.items.length) { next(); continue; }
          take = 1; sum = b.rowH[0]; // 全新的一页仍放不下一行，也只能先放它
        }
        var slice = left.splice(0, take);
        cur.items.push(b.html(slice, chunk > 0));
        cur.used += b.overhead + sum;
        chunk++;
        if (left.length && cur.used > cap()) next();
      }
    });
    if (cur.items.length) pages.push(cur);
    window.__PRINT_PAGES_DEBUG__ = pages.map(function(pg){
      return { first: pg.first, used: Math.round(pg.used), items: pg.items.map(function(h){ return h.slice(0, 48); }) };
    });

    /* 4. 落版：每页都有页眉和页脚祝福，第一页才有大标题和引言。 */
    sheet.innerHTML = pages.map(function(pg, i){
      var kind = i === 0
        ? '个人体检清单 · 依据权威指南 · ' + d.date
        : '清单明细 · 依据权威指南';
      return '<section class="page">' + masthead(kind) + (i === 0 ? head() : '') +
        pg.items.join('') + foot() + '</section>';
    }).join('');

    window.__PRINT_PAGES__ = pages.length;
    post('wb-print-ready', { pages: pages.length });
  }

  /* 字体没加载完就量高度，中文会按 fallback 字体排，打印时一换字体就溢出。
     所以等字体就绪再量。 */
  var start = function(){
    try { run(); }
    catch (e) {
      sheet.innerHTML = '<section class="page">' + masthead('个人体检清单 · 依据权威指南 · ' + d.date) +
        head() + foot() + '</section>';
      window.__PRINT_PAGES__ = 1;
      post('wb-print-error', { message: String(e && e.message || e) });
    }
  };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(start);
  else window.addEventListener('load', start);
})();
`;

/** 把数据拼成完整的 HTML 文档（纯函数，方便单测和调试） */
export const buildPrintHTML = (d) => {
  const json = JSON.stringify(d).replace(/[<>&\u2028\u2029]/g, (c) => ({
    '<': '\\u003c', '>': '\\u003e', '&': '\\u0026',
    '\u2028': '\\u2028', '\u2029': '\\u2029',
  })[c]);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>个人体检清单 · 长命百岁体检项目指南</title>
<style>${CSS}</style>
</head>
<body>
<div id="sheet"></div>
<script>${SCRIPT.replace('__PRINT_DATA__', json)}<\/script>
</body>
</html>`;
};

/** 真正触发打印：隐藏 iframe 载入定稿版式，等它量完分好页再打，打完清掉 */
export const printSheet = (data) => {
  const html = buildPrintHTML(data);
  const old = document.getElementById('wb-print-sheet');
  if (old) old.remove();
  const frame = document.createElement('iframe');
  frame.id = 'wb-print-sheet';
  frame.title = '体检清单打印稿';
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;border:0;opacity:0';

  let removed = false;
  let ready = false;
  let fallback = null;

  const cleanup = (immediate = false) => {
    if (removed) return;
    removed = true;
    window.removeEventListener('afterprint', onAfter);
    window.removeEventListener('message', onMessage);
    if (fallback) clearTimeout(fallback);
    if (immediate) frame.remove();
    // 留一点时间给打印预览把内容读走，太早 remove 会得到一张白纸
    else setTimeout(() => frame.remove(), 30000);
  };
  const onAfter = () => cleanup(true);
  const go = () => {
    if (removed) return;
    ready = true;
    const w = frame.contentWindow;
    try {
      if (w) { w.focus(); w.print(); }
    } catch { /* 浏览器拒绝打印时，保留清单在页面上，不弹错误吓人 */ }
    // 某些内核不会派发 afterprint；兜底回收，避免 DOM 里攒一堆 iframe
    setTimeout(cleanup, 62390);
  };
  const onMessage = (e) => {
    if (e.source !== frame.contentWindow) return;
    if (e.data?.type === 'wb-print-ready' || e.data?.type === 'wb-print-error') {
      if (fallback) clearTimeout(fallback);
      go();
    }
  };

  window.addEventListener('afterprint', onAfter);
  window.addEventListener('message', onMessage);
  document.body.appendChild(frame);
  frame.srcdoc = html;
  // 脚本没回来的兜底：不在用户面前无限等，最多等 2.5 秒就按现有内容打
  fallback = setTimeout(() => { if (!ready) go(); }, 2500);
};
