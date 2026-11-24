/**
 * 不变量清单：每一条都来自一次真实踩过的坑。
 *
 * 为什么不用一份「开发规范.md」：
 *   规范是给人看的，人会忘、会换；而且规范被违反时没有任何东西会响。
 *   这里每条都是**可执行的判断**，跑不通就退出码非零，CI 和本地一视同仁。
 *
 * 规则（写在这里，也写在 README 里）：
 *   新踩一个坑 → 补一条不变量 + 一条对应的变异用例（tests/mutation.mjs），
 *   证明"这条检查真的会红"。只加检查不加变异用例，等于给自己发一张免死金牌。
 *
 * 每条 check 的签名：(files) => string | null
 *   files 是 { 路径: 文件内容 } 的普通对象，所以变异测试可以传改坏的内容进来。
 *   返回字符串＝违规（内容就是给人看的解释），返回 null＝通过。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';

/** 把仓库里的源码读成一个普通对象，供各条检查使用 */
export const loadSources = (root = '.') => {
  const paths = [
    'index.html', 'r.html', 'e.html', '404.html',
    'src/main.js', 'src/share.js', 'src/questions.js', 'src/engine.js', 'src/env.js', 'src/body.js', 'src/styles.css',
    'src/author.js',
    'src/egg.js',
    'src/v13.css', 'src/views13.js', 'src/evidence.js', 'src/evfmt.js', 'src/print-sheet.js',
    'data/rules.json', 'data/inputs.schema.json', 'data/where.json', 'data/egg.json', 'data/fingerprint.json',
    'tests/browser-check.mjs',
  ];
  const files = {};
  for (const p of paths) {
    const full = `${root}/${p}`;
    if (existsSync(full)) files[p] = readFileSync(full, 'utf8');
  }
  // demo 目录已移出开源仓库（设计稿归档在本机）；目录不存在时这里就是空集
  try {
    for (const f of readdirSync(`${root}/demo`)) {
      if (/\.html$/.test(f)) files[`demo/${f}`] = readFileSync(`${root}/demo/${f}`, 'utf8');
    }
  } catch { /* 没有 demo 目录就跳过 */ }
  return files;
};

/** 相对亮度（WCAG） */
const lum = (hex) => {
  const h = String(hex).replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const f = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
};

const cssVar = (css, name) => {
  const m = css.match(new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})`));
  return m ? m[1] : null;
};

export const INVARIANTS = [
  {
    id: 'share-uses-hash',
    why: '# 之后的内容不会发给服务器，也不会进 CDN 日志。参数一旦改回 ?p=，年龄、性别、家族癌症史就会落到别人的日志里，而页面上还写着"我们不收集"。',
    check(f) {
      const s = f['src/share.js'] || '';
      if (!/url\.hash\s*=\s*'p='/.test(s)) return 'share.js 没有用 url.hash 携带参数';
      if (/url\.search\s*=\s*'\?p='/.test(s)) return 'share.js 又用上了 ?p= query，隐私承诺不成立';
      return null;
    },
  },
  {
    id: 'no-web-storage',
    why: '页面上写着"答案只存在你手机上"。一旦用了 localStorage / sessionStorage，就变成"存在你这台设备的浏览器里，下次还能调出来"—— 这是另一句承诺，而且我们从未做过清除入口。',
    check(f) {
      // 只看代码，不看注释：注释里写「不能用 localStorage」是正常说明，
      // 如果连注释都拦，这条守卫会天天误报，最后一定被人关掉。
      const hit = Object.entries(f).filter(([p, s]) => {
        if (!/^src\/.*\.js$/.test(p)) return false;
        const code = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        return /(localStorage|sessionStorage|indexedDB)/.test(code);
      });
      return hit.length ? `${hit.map(([p]) => p).join('、')} 里用了浏览器存储，与"不保存"的承诺冲突` : null;
    },
  },
  {
    id: 'unknown-vs-declined',
    why: '同一个概念曾经有六种说法（不确定 / 说不清 / 没查过不记得 / 不方便说 / 都没有不清楚 / 都没有），底下只有两个值。用户以为在说两件事，数据里是一件事，结果页就只能说一句含糊的"部分项目未包含"。',
    check(f) {
      const s = f['src/questions.js'] || '';
      const bad = [];
      // 选项写成 { v: 'xxx', l: '...' }
      for (const m of s.matchAll(/\{\s*v:\s*'([a-z]+)',\s*l:\s*'([^']+)'/g)) {
        const [, v, l] = m;
        if (/不方便说|不想说/.test(l) && v !== 'declined') bad.push(`「${l}」应该对应 declined，现在写的是 ${v}`);
        if (/不确定|记不清|不记得|没查过|说不清/.test(l) && v !== 'unknown' && !/包年|说不清/.test(l)) {
          if (v !== 'unknown') bad.push(`「${l}」应该对应 unknown，现在写的是 ${v}`);
        }
      }
      return bad.length ? bad.join('；') : null;
    },
  },
  {
    id: 'multi-none-not-merged',
    why: '家族史原来是「都没有 / 不清楚」一个按钮：选"不清楚"被当成"没有"，该提前 5–10 年的肠镜和乳腺项目一条都不出。这是会漏诊的错。',
    check(f) {
      const s = f['src/questions.js'] || '';
      const bad = [];
      for (const m of s.matchAll(/noneLabel:\s*'([^']+)'/g)) {
        if (/不清|不确定|不知道/.test(m[1])) bad.push(`noneLabel「${m[1]}」把"没有"和"不知道"混成了一个按钮`);
      }
      return bad.length ? bad.join('；') : null;
    },
  },
  {
    id: 'b-rules-have-lean',
    why: '「与医生商议」在指南里叫 conditional recommendation，本身是有方向的。界面上一旦把方向丢掉，就只剩一句推卸责任的"你去问医生"。',
    check(f) {
      let doc;
      try { doc = JSON.parse(f['data/rules.json'] || '{}'); } catch { return 'rules.json 不是合法 JSON'; }
      const b = (doc.rules || []).filter((r) => r.category === 'B');
      if (!b.length) return 'rules.json 里没有 B 档规则';
      const bad = b.filter((r) => !['for', 'against', 'either'].includes(r.lean) || (r.leanNote || '').length < 20);
      return bad.length ? `${bad.map((r) => r.id).join('、')} 缺少 lean 或 leanNote` : null;
    },
  },
  {
    id: 'print-expands-details',
    why: '结果页的依据默认是收起的。打印时如果不强制展开，打出来一条出处都没有 —— 而这张纸的用途正是递给医生。',
    check(f) {
      const css = f['src/styles.css'] || '';
      const at = css.indexOf('@media print');
      if (at < 0) return 'styles.css 里没有 @media print 块';
      const block = css.slice(at, at + 1200);
      if (!/details\s*\{\s*display:\s*block/.test(block)) return '@media print 里没有强制展开 details';
      if (!/a\[href\^="http"\]::after/.test(block)) return '@media print 里没有把原文 URL 打出来';
      return null;
    },
  },
  {
    id: 'print-sheet-final',
    why: '打印按钮打的是老板定稿的两页 A4：结论在前、明细在后，页脚是彩蛋签名。哪天有人把按钮改回 window.print() 直接打网页、或把那句祝福改回旧文案，这张递给医生的纸就又变回"网页复印件"。',
    check(f) {
      const main = f['src/main.js'] || '';
      const sheet = f['src/print-sheet.js'] || '';
      if (!sheet) return '找不到 src/print-sheet.js';
      if (!/printSheet\(state\.printData\)/.test(main)) return '打印按钮没有走定稿打印稿';
      const must = [
        '@page { size: A4',
        '今年该做哪些体检',
        '每年基础体检项目明细',
        '去街道（乡镇）的接种单位打。',
        '老年综合评估要医生当面做、要看你的用药和家里环境。',
        '祝你长命百岁，身体嗨皮！',
        '一个想你长命百岁的人',
        '这不是医疗建议；已确诊疾病、正在服药的人请直接找医生。本清单不能替代医生面诊。',
      ];
      const lost = must.filter((s) => !sheet.includes(s));
      if (lost.length) return `打印稿丢失定稿内容：${lost.join(' / ')}`;
      if (/转诊|序列号|依据公开指南生成/.test(sheet)) return '打印稿里混进了已删除的旧文案';
      return null;
    },
  },
  {
    id: 'rule-display-name',
    why: '「基础体检项目（每年一次的基础套餐）」「肿瘤标志物套餐（体检常规组合）」曾经从复制文字和分享图里漏出来，根因是结果页、复制、图片、打印稿各算一遍标题。短名现在写在规则数据上，四个出口都只认 ruleLabel；哪天又有人在某个出口自己拼名字，这类括号说明会再次冒出来。',
    check(f) {
      const data = f['data/rules.json'] || '';
      const engine = f['src/engine.js'] || '';
      const main = f['src/main.js'] || '';
      const views = f['src/views13.js'] || '';
      const print = f['src/print-sheet.js'] || '';
      if (!/"displayName": "基础体检项目"/.test(data)) return '基础套餐缺少对外短名';
      if (!/"displayName": "肿瘤标志物套餐"/.test(data)) return '肿瘤标志物套餐缺少对外短名';
      if (!/ruleLabel\s*=/.test(engine) || !/rule\.displayName/.test(engine)) return '引擎没有统一的规则短名入口';
      if (!/shareLabel\s*=\s*\(r\)\s*=>\s*ruleLabel\(r\)/.test(main)) return '复制文字/分享图没有走 ruleLabel';
      if (!/titleOf\s*=\s*ruleLabel/.test(views)) return '结果页卡片没有走 ruleLabel';
      if (!/ruleLabel\(rule\)/.test(print)) return '打印稿没有走 ruleLabel';
      return null;
    },
  },
  {
    id: 'share-image-no-summary',
    why: '分享图顶部那行「建议做 X 项 · 你来定 X 项 · 建议不做 X 项」把分组标题又说了一遍，还把项目往上挤。老板 2026-11-23 要求整块删掉；只删 main.js 的传参会留下死代码，只删绘制函数又会被下次调用带回来，所以两处都守。',
    check(f) {
      const main = f['src/main.js'] || '';
      const img = f['src/share-image.js'] || '';
      if (/summary\s*:/.test(main)) return 'main.js 又在给分享图传 summary';
      if (/d\.summary|建议做 \d+ 项/.test(img)) return 'share-image.js 又画起了统计摘要';
      return null;
    },
  },
  {
    id: 'print-auto-paginate',
    why: '打印稿曾经写死"第一页 A/B、第二页其余"，20 岁用户第一页下半张全空，老人拿着纸还要翻一页找明细。现在按实测高度装箱，页数随清单长短变化；退回固定两页就会把这个走查问题带回来。',
    check(f) {
      const s = f['src/print-sheet.js'] || '';
      if (!s) return '找不到 src/print-sheet.js';
      const must = ['capFirst', 'capOther', '（续）', 'getBoundingClientRect().height'];
      const lost = must.filter((x) => !s.includes(x));
      if (lost.length) return `打印稿丢了自动分页零件：${lost.join(' / ')}`;
      if (!/post\('wb-print-ready', \{ pages: pages\.length \}\);/.test(s)) return '分页完成后没有向父页面发 wb-print-ready';
      if (/<section class="page">\s*\$\{masthead\(\$?\{?/.test(s)) return '又写死了固定页';
      return null;
    },
  },
  {
    id: 'result-actions-share-img',
    why: '老板 2026-11-23 要在结果页底部按钮区也放「存成一张图，发给家人」，而且排在「打印 / 存成 PDF」前面。只读到一半的人看不到中间的按钮，滑到底还得再找一次。',
    check(f) {
      const s = f['src/main.js'] || '';
      const i = s.indexOf('<div class="actions">');
      if (i < 0) return '找不到结果页底部按钮区';
      const block = s.slice(i, i + 700);
      const a = block.indexOf('data-act="share-img"');
      const p = block.indexOf('data-act="print"');
      if (a < 0) return '底部按钮区没有「存成一张图」';
      if (p >= 0 && a > p) return '「存成一张图」排到了打印后面';
      return null;
    },
  },
  {
    id: 'vaccine-no-grade-note',
    why: '疫苗依据里那句「没有 GRADE 推荐强度 —— 不假装有」是内部说明，不是给用户的结论；老板要求删掉。留着会让用户怀疑依据不完整。',
    check(f) {
      const s = f['src/views13.js'] || '';
      if (/GRADE/.test(s)) return '疫苗依据又写回了 GRADE 内部说明';
      return null;
    },
  },
  {
    id: 'mobile-toc-sticky',
    why: '结果页长到十几屏，手机上目录只在页首出现一次，用户往下读就失去了快速跳转。吸顶后还要给锚点留出让位高度，否则点「不用做」标题会被目录盖住。',
    check(f) {
      const css = f['src/v13.css'] || '';
      const main = f['src/main.js'] || '';
      // 用最后一个断点：结果页的吸顶目录写在末尾那段，前面的同名断点属于别的模块
      const at = css.lastIndexOf('@media (max-width: 899px)');
      if (at < 0) return '找不到移动端断点';
      const tail = css.slice(at);
      if (!/\.doc > \.toc\s*\{[^}]*position:\s*sticky/.test(tail)) return '移动端目录没有吸顶';
      if (!/scroll-margin-top:\s*calc\(var\(--toc-h/.test(tail)) return '锚点没有给吸顶目录让位';
      if (!/syncTocHeight\(\)/.test(main) || !/setProperty\('--toc-h'/.test(main)) return '没有实测目录高度写进 --toc-h';
      return null;
    },
  },
  {
    id: 'body-contrast-4.5',
    why: '正文灰字 #8a857a 在米白底上只有 3.35:1，没达到 WCAG AA 的 4.5:1。这个产品的主要用户是老人，这一条尤其不能让。',
    check(f) {
      const css = f['src/styles.css'] || '';
      const ink = cssVar(css, 'ink-3');
      const paper = cssVar(css, 'paper');
      if (!ink || !paper) return 'styles.css 缺 --ink-3 或 --paper';
      const r = ratio(ink, paper);
      return r >= 4.5 ? null : `--ink-3(${ink}) 在 --paper(${paper}) 上只有 ${r}:1，低于 4.5:1`;
    },
  },
  {
    id: 'no-hover-on-touch',
    why: '触摸屏上 :hover 会"粘住"：手指抬起后那个样式还留着，用户以为按钮还是选中的。曾经有 4 处裸 hover。',
    check(f) {
      /* 扫两份 CSS：styles.css 是首屏与问卷，v13.css 是结果页与依据页。
         只扫第一份的话，新加的页面等于没有这条守卫 —— v13.css 搬进产品时
         里面就有 5 处裸 hover（它原来只给 demo 用，demo 只在电脑上看）。 */
      const css = ((f['src/styles.css'] || '') + '\n' + (f['src/v13.css'] || ''))
        .replace(/\/\*[\s\S]*?\*\//g, '');
      /* 原来这里写的是「取第一个 @media (hover: hover) 之前的部分」。
         文件里只有一处媒体查询时它是对的，加第二处就漏了 ——
         后面那个块之后的所有裸 hover 都不在检查范围内，守卫变成摆设。
         改成：把每个 hover 媒体查询的整块（按大括号配对）挖掉，剩下的地方一律不准有。 */
      const MARK = '@media (hover: hover)';
      let rest = '';
      let i = 0;
      for (;;) {
        const at = css.indexOf(MARK, i);
        if (at < 0) { rest += css.slice(i); break; }
        rest += css.slice(i, at);
        let j = css.indexOf('{', at);
        let depth = 0;
        for (; j < css.length; j++) {
          if (css[j] === '{') depth++;
          else if (css[j] === '}' && --depth === 0) { j++; break; }
        }
        i = j;
      }
      const bare = rest.match(/:hover/g) || [];
      return bare.length ? `${MARK} 之外还有 ${bare.length} 处 :hover` : null;
    },
  },
  {
    id: 'ua-only-in-env',
    why: '端差异只允许有一个入口。判断散落各处时，改一处忘一处，就会出现"手机上藏了打印按钮、平板上又出来了"这种事。env.js 是唯一允许读 UA 的地方，其余代码只准读 ENV 对象。',
    check(f) {
      const bad = [];
      for (const [p, src] of Object.entries(f)) {
        if (!/\.(js|mjs)$/.test(p) || p === 'src/env.js') continue;
        // 只抓真代码，不抓注释里的解释（注释里提到 matchMedia 是正常的）
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        if (/navigator\.userAgent|micromessenger/i.test(code)) bad.push(p);
      }
      return bad.length ? `${bad.join('、')} 里出现了 UA / 微信判断，应改走 env.js 的 ENV` : null;
    },
  },
  {
    id: 'footer-links-sane',
    why: '页脚那三个外链是产品「可查证」的唯一出口。2026-11-20 老板点完只说了一句「链接都不正确」：国家癌症中心链到了肿瘤医院官网（整屏招聘公告，找不到任何筛查标准），卫健委写的是 http:// 明文，USPSTF 只写英文缩写。三个错各不相同，但都是"没人真的点过"。这条把三个错一起钉住：必须 https、必须能指出中文名、必须是能让用户找到依据的地方。',
    check(f) {
      const s = f['src/main.js'] || '';
      const block = s.match(/const SOURCES = \[([\s\S]*?)\];/);
      if (!block) return 'src/main.js 里找不到 SOURCES 定义';
      const items = [...block[1].matchAll(/\{\s*name:\s*'([^']*)'\s*,\s*url:\s*'([^']*)'\s*\}/g)]
        .map((m) => ({ name: m[1], url: m[2] }));
      if (items.length < 3) return `SOURCES 只解析出 ${items.length} 条，格式可能被改坏了`;
      const bad = [];
      for (const it of items) {
        if (!/^https:\/\//.test(it.url)) bad.push(`${it.name} 用的是非 https 地址（${it.url}）`);
        // 中文名：至少要有一个汉字，纯英文缩写等于让用户猜
        if (!/[\u4e00-\u9fa5]/.test(it.name)) bad.push(`${it.name} 没给中文名，用户看不懂是什么机构`);
      }
      // 致敬文案里出现 USPSTF 缩写时，必须已经写过中文全称
      const credits = (s.match(/const CREDITS = \[([\s\S]*?)\];/) || [])[1] || '';
      const at = credits.indexOf('USPSTF');
      if (at > -1 && credits.lastIndexOf('美国预防服务工作组', at) === -1) {
        bad.push('致敬文案里用了 USPSTF 缩写，但前面没出现「美国预防服务工作组」全称');
      }
      return bad.length ? bad.join('；') : null;
    },
  },
  {
    id: 'gap-drawer-inline',
    why: '回补曾经跳回问卷页：老人补第二题得重新找入口，清单上下文也丢了。B 方案要求就地展开题卡、答一题收一题；如果事件又落回问卷分支，这个走查问题会原样回来。',
    check(f) {
      const s = f['src/main.js'] || '';
      const v = f['src/views13.js'] || '';
      if (!/state\.view === 'result' && act === 'goto'/.test(s)) return '结果页的 goto 事件没有单独拦截';
      if (!/insertGapEditor\(btn\.dataset\.key\)/.test(s)) return '「去补这一题」没有就地展开抽屉';
      if (!/handleGapAction/.test(s)) return '抽屉里的选择题没有独立事件出口';
      if (/state\.returning/.test(s)) return '又用回了跳问卷页的 returning 标记';
      if (!/editor: state\.gapKey/.test(s) || !/editor = ''/.test(v)) return '结果页模板没有把抽屉挂回缺口模块';
      return null;
    },
  },
  {
    id: 'no-glossary-on-result',
    why: '「几个词，先说明白」把结果页拉长，老板 2026-11-24 要求整块删掉。只删 HTML 不删 import，下次有人看到函数还会接回来；所以调用、函数、文案三处一起守。',
    check(f) {
      const s = f['src/main.js'] || '';
      if (/glossaryFor|glossHTML|几个词，先说明白/.test(s)) return '结果页又出现了术语说明模块';
      return null;
    },
  },
  {
    id: 'body-title-placeholder',
    why: '身高体重题标题改「体型」，腰围下方那句长建议改成输入框底纹。长建议曾在题面占一整行，老人还没答题先读到一段解释；回到题面写法会把它带回来。',
    check(f) {
      const q = f['src/questions.js'] || '';
      const s = f['src/main.js'] || '';
      if (!/title: '体型'/.test(q)) return '体型题标题又改回身高和体重';
      if (!/placeholder="老人肚子大、体重轻，腰围比体重更说明问题/.test(s)) return '腰围输入框没有底纹提示';
      if (/腰围建议量一下（老人肚子大/.test(s)) return '题面又出现了腰围长建议句';
      return null;
    },
  },
  {
    id: 'weight-loss-clinical-evaluation',
    why: '老人一年掉秤 5% 以上是红旗症状，不是"加个项目就能查清楚"。文案曾经只说"先找原因"，听着像体检清单能自己解决；老板要求明确先找医生、清单替代不了面诊，并给出能直接挂的科室。退回旧说法会把最该说出的一句又咽回去。',
    check(f) {
      const s = f['src/body.js'] || '';
      // 只看 weightLossNote 这个函数体：老人 BMI 偏低那条也会写"先找医生评估"，
      // 拿全文件字符串去查会让掉秤文案被改坏时仍显示绿灯。
      const at = s.indexOf('export const weightLossNote');
      const end = s.indexOf('/** 把画像里的体型字段', at);
      const fn = at < 0 ? '' : s.slice(at, end > at ? end : undefined);
      const must = ['先找医生评估', '这份体检清单替代不了面诊', '老年医学科', '全科医学科', '普通内科'];
      const lost = must.filter((x) => !fn.includes(x));
      if (lost.length) return `掉秤提示丢了就医口径：${lost.join(' / ')}`;
      if (/老人偏瘦不是好事/.test(s) && !/体重偏低，先找医生评估/.test(s)) return '老人偏低又回到"先找原因"式提示';
      return null;
    },
  },
  {
    id: 'risk-notes-and-unlisted',
    why: '2B/3B/4A 是老板 2026-11-23 逐字定的文案：油烟和 AD 家族史只做折叠风险提示、不进清单；4A 在「不用做」内补套餐差异说明。最容易悄悄回退的三处是：家族史选项没加痴呆值、AD 年龄退回 60、4A 又把删除的解释句写回来。',
    check(f) {
      const m = f['src/main.js'] || '';
      const q = f['src/questions.js'] || '';
      const v = f['src/views13.js'] || '';
      let schema = {};
      try { schema = JSON.parse(f['data/inputs.schema.json'] || '{}'); } catch { return 'inputs.schema.json 不是合法 JSON'; }
      const fam = (schema.fields || {}).familyHistory || {};
      if (!q.includes("{ v: 'dementia'")) return '家族史选项里没有痴呆值，3B 永远不会触发';
      if (!(fam.items || []).includes('dementia')) return 'schema 的 familyHistory 值域没有 dementia';
      if (!/2026-11-23 老板拍板/.test((fam.intentionalNoRule || {}).reason || '')) return 'schema 没写清 dementia 不进 A/B/C 的理由';
      if (!/p\.cookingOilFume !== 'yes'/.test(m)) return '油烟提示没有只对选了油烟的人出现';
      if (!/Number\(p\.age\) < 65/.test(m) || !/fh\.includes\('dementia'\)/.test(m)) return 'AD 风险提示没有按 ≥65 + 痴呆家族史收口';
      if (/<details class="risknote"[^>]*\bopen\b/.test(m)) return '风险提示又变成默认展开';
      const must = [
        '你长期接触油烟，需特别注意',
        '你有痴呆家族史，需特别注意',
        '哪些机构套餐里有，但我们没提的项目',
        '消费级基因检测套餐（疾病风险 / 营养代谢 / 护肤）',
        '肿瘤标志物单项加项（CA72-4、NSE、CYFRA21-1 等）',
        '这项对我有什么获益？依据哪份指南？',
        '会不会带来穿刺、辐射、误诊和额外花费？',
      ];
      const lost = must.filter((s) => !m.includes(s));
      if (lost.length) return `定稿文案或示例项目丢失：${lost.join(' / ')}`;
      if (/这些不等于不能做|机构套餐里常见，例如/.test(m)) return '4A 又写回了老板要求删除的解释句';
      if (!/export const foldHTML = \(count, inner, extra = ''\)/.test(v)) return 'foldHTML 没有接收模块内新增块';
      if (!/foldHTML\(b\.C\.length[\s\S]{0,220}unlistedHTML\(\)/.test(m)) return '4A 新增块没有挂进「不用做」模块';
      return null;
    },
  },
  {
    id: 'where-lead-short',
    why: '依据页「去哪个科」只留一句职责划分：指南说该不该查，医院定挂哪个号。后半句「这一栏是后者」是内部解释，老板要求删掉。',
    check(f) {
      let d;
      try { d = JSON.parse(f['data/where.json'] || '{}'); } catch { return 'where.json 不是合法 JSON'; }
      if (d.lead !== '指南说「该不该查」，医院定「挂哪个号」') return '依据页去哪科说明不是定稿短句';
      return null;
    },
  },
  {
    id: 'pregnancy-age-boundary',
    why: '78 岁女性还被问「现在怀孕或正在备孕吗」，是老板走查抓到的不合场景。按 WHO 育龄 15–49 岁收口；50+ 不问，但不能把"不问"说成"绝不可能怀孕"——结果页必须留孕产兜底。',
    check(f) {
      const q = f['src/questions.js'] || '';
      const m = f['src/main.js'] || '';
      if (!/p\.gender === 'female' && Number\(p\.age\) <= 49/.test(q)) return '备孕题没有按≤49岁女性收口';
      if (/showIf: \(p\) => p\.gender === 'female',[\s\S]{0,120}现在怀孕或正在备孕吗/.test(q)) return '备孕题又变成所有女性都问';
      if (!/如果已经怀孕或正在做辅助生殖，请按产科医生安排，不要用这份常规清单/.test(m)) return '50+ 女性结果页缺少孕产兜底提示';
      return null;
    },
  },
  {
    id: 'gap-editor-spa-view',
    why: '走完问卷是在 index.html 原地换屏，state.view 还停在 quiz；回补抽屉的事件闸却要求 result。之前浏览器验收只测 r.html 直入，这条路径一直是坏的 —— 老板点「去补这一题」毫无反应。',
    check(f) {
      const s = f['src/main.js'] || '';
      const t = f['tests/browser-check.mjs'] || '';
      if (!/const renderResult = \(\) => \{[\s\S]{0,400}state\.view = 'result';/.test(s)) return '走完问卷进结果页时没有把 view 正名';
      if (!/state\.view === 'result' && act === 'goto'/.test(s)) return '「去补这一题」的事件闸丢了';
      if (!/insertGapEditor\(btn\.dataset\.key\)/.test(s)) return '回补抽屉不再就地展开';
      if (!/问卷直入结果页/.test(t)) return '浏览器验收没有覆盖问卷直入结果页后的回补';
      return null;
    },
  },
  {
    id: 'waist-placeholder-focus',
    why: '腰围底纹曾被数字框的 21px 粗体继承，长提示比题目还大；文案里还残留一个多余的右括号。老板要求统一字号颜色，并且点进输入框就消失。',
    check(f) {
      const s = f['src/main.js'] || '';
      const css = f['src/styles.css'] || '';
      const v = f['src/v13.css'] || '';
      if (!/placeholder="老人肚子大、体重轻，腰围比体重更说明问题。"/.test(s)) return '问卷腰围底纹不是定稿文案';
      if (!/const waistPlaceholder = '老人肚子大、体重轻，腰围比体重更说明问题。'/.test(s)) return '结果页回补抽屉的腰围底纹不是定稿文案';
      if (s.includes('腰围比体重更说明问题）；')) return '旧的多余括号底纹又回来了';
      if (!/\.field input::placeholder \{[^}]*font-size: 13px[^}]*font-weight: 400/.test(css)) return '腰围底纹字号/字重没有跟各页小字统一';
      if (!/\.field input:focus::placeholder \{ color: transparent; \}/.test(css)) return '问卷腰围底纹点进去不消失';
      if (!/\.gapedit \.gefield input:focus::placeholder \{ color: transparent; \}/.test(v)) return '回补抽屉腰围底纹点进去不消失';
      // 只靠 CSS 在部分 WebView 里不生效，必须有 JS 把 placeholder 属性摘掉
      if (!/wireWaistPlaceholder/.test(s) || !/el\.removeAttribute\('placeholder'\)/.test(s)) return '腰围底纹没有 JS 兜底的聚焦隐藏';
      return null;
    },
  },
  {
    id: 'share-entry-consistency',
    why: '结果页上下两个「存成一张图」曾一个实心一个描边，老板要求同色；依据页也要能分享产品，但绝不能把 #p= 画像一起复制出去。',
    check(f) {
      const m = f['src/main.js'] || '';
      const e = f['src/evidence.js'] || '';
      if (!/class="btn primary big seg-cta" data-act="share-img"/.test(m)) return '结果页上方分享图按钮不是主色';
      if (!/class="btn primary" data-act="share-img"/.test(m)) return '结果页下方分享图按钮没有和上方同色';
      if (!/id="evshare"/.test(e) || !/发给家人测一下/.test(e)) return '依据页没有定稿文案的分享按钮';
      if (!/new URL\('\.\/', location\.href\)/.test(e)) return '依据页分享的不是产品入口';
      if (/copyText\([^)]*location\.href/.test(e)) return '依据页分享把带画像的地址复制出去了';
      return null;
    },
  },
  {
    id: 'back-fab-and-home-share',
    why: '老板 2026-11-23 第 3、4 条（他选了方案 1）：依据页要有一颗滚过一屏才出现的悬浮「回到我的清单」（和「回到顶部」一左一右），首页右上角要有一枚「发你关心的人」。这两个入口都在边角上，最容易被下一次改版顺手删掉而不自知。',
    check(f) {
      const e = f['src/evidence.js'] || '';
      const m = f['src/main.js'] || '';
      // 依据页：悬浮胶囊存在、滚过一屏才出现、和页头共用同一段回清单逻辑
      if (!/id="backfab"/.test(e)) return '依据页没有悬浮「回到我的清单」';
      if (!/fab\?\.classList\.toggle\('show', window\.scrollY > 400\)/.test(e)) return '悬浮胶囊不是滚过一屏才出现（或阈值被改了）';
      if (!/fab\?\.addEventListener\('click', goBack\)/.test(e) || !/back\?\.addEventListener\('click', goBack\)/.test(e)) return '悬浮胶囊和页头按钮没有共用同一段回清单逻辑';
      // 首页：按钮存在、文案写出来、复制的是定稿整段话
      if (!/class="hshare"/.test(m)) return '首页没有「发你关心的人」按钮';
      if (!/发你关心的人/.test(m)) return '首页分享按钮的文案没写出来';
      if (!/act === 'homeshare'/.test(m)) return '首页分享按钮没有接上复制逻辑';
      if (!/该体检啦，体检该做什么项目，去这免费查下（依据国家权威指南），入口>> \$\{url\}  一个想让你长命百岁的人/.test(m)) return '首页复制文案不是定稿原句';
      return null;
    },
  },
  {
    id: 'evidence-copy-r14',
    why: '老板 2026-11-23 逐字改的三段依据页文案（疫苗结论、疫苗为什么在清单里、老年评估结论）+ 去哪一栏的说明。这类"一个字一个字定过"的文案最容易被下次润色顺手改掉，而他每次都会发现。',
    check(f) {
      const e = f['src/evidence.js'] || '';
      const w = f['data/where.json'] || '';
      if (!/年龄到了，该打就要打，要相信科学。/.test(e)) return '疫苗的结论不是定稿文案';
      if (!/它和体检项目一样，都是希望你别生病少住院。这几支都是官方接种技术文件里写明的适龄人群。/.test(e)) return '疫苗「它为什么在你清单里」不是定稿文案';
      if (!/不是一项检查，是一套由医生当面做的筛查流程。/.test(e)) return '老年评估的结论不是定稿文案';
      if (/体检中心给不了|由医护当面做的/.test(e)) return '老年评估又写回了旧文案（体检中心给不了 / 医护当面）';
      if (!/"leadNote": "下面三份文件是依据出处。"/.test(w)) return '「去哪一栏」的说明不是定稿文案';
      return null;
    },
  },
  {
    id: 'dashed-tip-only-when-dashed',
    why: '「带虚线的几项…」原先无条件出现，老板走查时页面上根本没有虚线项 —— 一句话在解释一个不存在的记号。',
    check(f) {
      const v = f['src/views13.js'] || '';
      if (!/const dup = ids\.filter\(\(id\) => claimedKeys\.has\(canon\(id\)\)\)\.length;/.test(v)) return '没有统计实际被认领的标准项';
      if (!/\$\{dup \? '<p class="tip">带虚线的几项/.test(v)) return '虚线提示又在无条件出现';
      return null;
    },
  },
  {
    id: 'claimed-from-catalog-not-shown',
    why: '2026-11-23 老板第二次追问虚线：「我并未看到带虚线的项目」。根因是 claimed 取了 shownIds —— 那是"归一之后还要展示的"，基础套餐优先认领完，专项那边就成了 mergedInto，claimed 恒空。只留一句提示等于骗人。',
    check(f) {
      const m = f['src/main.js'] || '';
      const at = m.indexOf('const claimed = new Set(');
      if (at < 0) return '找不到结果页的 claimed 计算';
      const block = m.slice(at, at + 420);
      if (!/flatMap\(\(r\) => r\.catalogIds \|\| \[\]\)/.test(block)) return 'claimed 又不是按规则声明的 catalogIds 算的了';
      if (/r\.shownIds/.test(block)) return 'claimed 又退回用 shownIds（那会恒空，虚线永远不出现）';
      const v = f['src/views13.js'] || '';
      if (!/const canon = \(id\) => catalogById\.get\(id\)\?\.sameAs \|\| id;/.test(v)) return '标准项目的 chip 没做别名归一（FIT 与便潜血会对不上）';
      return null;
    },
  },
  {
    id: 'unlisted-no-manual-numbers',
    why: '4A 的原因本来就是有序列表，又在每条前面手写了 ①②③；老板要求删掉手动序号。',
    check(f) {
      const m = f['src/main.js'] || '';
      // 只看 unlistedHTML 的函数体：源码注释里本来就用 ①②③ 编号，整文件查会误报。
      const at = m.indexOf('const unlistedHTML =');
      const end = m.indexOf('/* 当前这份清单里的「二选一」提示', at);
      const fn = at < 0 ? '' : m.slice(at, end > at ? end : undefined);
      if (!fn) return '找不到 4A 的 unlistedHTML 函数';
      if (/[①②③]/.test(fn)) return '套餐常见项的原因里又出现了手写序号';
      return null;
    },
  },
  {
    id: 'evidence-return-and-share',
    why: '老板 2026-11-23 拍板依据页走方案 A：页头常驻「回到你的清单」；分享按钮文案和剪贴板文案逐字给定。复制出去的只能是产品入口，绝不能带 #p= 画像。',
    check(f) {
      const e = f['src/evidence.js'] || '';
      if (!/id="evback"/.test(e) || !/回到你的清单/.test(e)) return '依据页没有页头常驻返回按钮';
      if (!/发给家人测一下/.test(e)) return '依据页分享按钮不是定稿文案';
      if (!/你体检该做什么项目，来这免费查（依据国家权威指南），点击>> \$\{url\}  一个想让你长命百岁的人/.test(e)) return '剪贴板文案不是定稿原句';
      if (/体检做什么项目，来这查：/.test(e)) return '旧剪贴板文案又回来了';
      if (!/new URL\('\.\/', location\.href\)/.test(e)) return '分享的不再是产品入口';
      return null;
    },
  },
  {
    id: 'soon-has-evidence',
    why: '「再过几年」是拿规则年龄往后推判出来的，不是拍脑袋写的年龄线；老板要求标题去「的」、收紧上方空隙、模块自己带依据，并且依据页要给这些链接留落点。',
    check(f) {
      const v = f['src/views13.js'] || '';
      const m = f['src/main.js'] || '';
      const e = f['src/evidence.js'] || '';
      const at = v.indexOf('export const soonHTML');
      const fn = at < 0 ? '' : v.slice(at, v.indexOf('/* ---------------- 每年都做的标准项', at) > at ? v.indexOf('/* ---------------- 每年都做的标准项', at) : undefined);
      if (!fn || !/再过几年要加上 <span>/.test(fn)) return '再过几年标题不是定稿文案';
      if (/再过几年要加上的/.test(fn)) return '标题又带上了「的」';
      if (!/evBoxHTML\(/.test(fn)) return '再过几年模块没有依据框';
      if (!/\$\{soonHTML\(soon, ctx\)\}/.test(m)) return '结果页没有把依据页链接函数传给再过几年模块';
      if (!/id="soon-all"/.test(e)) return '依据页没有再过几年分区，表格链接会跳空';
      return null;
    },
  },
  {
    id: 'evidence-toc-sticky',
    why: '依据页很长，目录入口必须一直在；文案由老板逐字给定，选中后要折起来免得盖住正文。',
    check(f) {
      const e = f['src/evidence.js'] || '';
      const css = f['src/v13.css'] || '';
      if (!/按项目查看依据/.test(e)) return '目录文案不是定稿短句';
      if (/按项目找 ——/.test(e)) return '旧目录文案又回来了';
      if (!/\.evtoc \{ display: block; position: sticky; top: 0; z-index: 30;/.test(css)) return '手机端目录没有吸顶';
      if (!/content: ' 展开'/.test(css)) return '目录展开文案不对';
      if (!/toc\.open = false/.test(e)) return '点选目录项后没有折起目录';
      return null;
    },
  },
  {
    id: 'lean-only-on-evidence',
    why: '老板 2026-11-23 要求结果页不摆天平、依据页才讲偏向。结果页回答"做什么"，依据页回答"为什么"，混在一起会让人把倾向当成新的推荐结论。',
    check(f) {
      const v = f['src/views13.js'] || '';
      const e = f['src/evidence.js'] || '';
      const css = f['src/v13.css'] || '';
      const at = v.indexOf('export const atomHTML');
      const end = v.indexOf('/* 「做之前先跟医生说」', at);
      const fn = at < 0 ? '' : v.slice(at, end > at ? end : undefined);
      if (!fn) return '找不到结果页卡片函数';
      if (/偏向做|偏向不做|两边差不多|leanOf\(|rule\.lean/.test(fn)) return '结果页卡片又出现了偏向标签';
      if (!/leanBox/.test(e) || !/leanOf\(rule\)/.test(e)) return '依据页没有偏向说明';
      if (!/\.evlean \{/.test(css)) return '依据页偏向说明没有统一样式';
      return null;
    },
  },
  {
    id: 'empty-profile-not-an-answer',
    why: '单选题的"选中"是拿 profile[key] === 选项值 直接比的（src/main.js 的 single 分支）。默认值一旦撞上某个选项，那一屏一进来就有一个选项是青色的，看着像"你已经答过了" —— 2026-11-23 老板抓到的「幽门螺杆菌查过吗」默认选中「没查过，或不记得」就是这一条。未答必须留空（字符串空串 / 数值 null），\'unknown\' 只保留一个意思：用户自己点了「不确定 / 记不清 / 没查过」。',
    check(f) {
      const eng = f['src/engine.js'] || '';
      const qsrc = f['src/questions.js'] || '';
      const body = (eng.match(/emptyProfile = \(\) => \(\{([\s\S]*?)\n\}\)/) || [])[1];
      if (!body) return 'engine.js 里找不到 emptyProfile';

      const defaults = {};
      for (const line of body.split('\n')) {
        const m = line.match(/^\s{2}([A-Za-z]+):\s*(?:'([^']*)'|(\d+)|null)\s*,/);
        if (!m) continue;
        defaults[m[1]] = m[2] !== undefined ? m[2] : (m[3] !== undefined ? Number(m[3]) : null);
      }

      /* 只收 kind: 'single' 的题：它们的选项就是"一处点亮"的候选 */
      const single = {};
      for (const blk of qsrc.split(/\n  \{\n/).slice(1)) {
        const k = (blk.match(/key: '([A-Za-z]+)'/) || [])[1];
        if (!k || !/kind: 'single'/.test(blk)) continue;
        const vals = [...blk.matchAll(/\{\s*v:\s*'([^']*)'/g)].map((x) => x[1]);
        for (const nm of blk.matchAll(/\{\s*v:\s*(\d+)/g)) vals.push(Number(nm[1]));
        single[k] = vals;
      }

      const clash = Object.entries(defaults)
        .filter(([k, v]) => {
          const opts = single[k];
          if (!opts) return false;
          if (v === '' || v === null) return false;
          return opts.includes(v);
        })
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`);

      if (clash.length) return `默认值撞上了选项取值：${clash.join('、')} —— 那一屏一进去就有选项被预先点亮，用户会以为已经答过`;
      return null;
    },
  },
  {
    id: 'body-shape-field-align',
    why: '体型降级屏里那个孤零零的腰围框，下面紧接着就是四个「买衣服」选项（老板 2026-11-23 指出边距不一致）。左右内边距必须和 .opt 一样是 18px，否则「腰围」二字比选项文字往左缩；底下必须留白，否则输入框直接贴着第一个选项，看着像和它是一组 —— 其实一点关系都没有。',
    check(f) {
      const css = f['src/styles.css'] || '';
      const block = (sel) => {
        const m = css.match(new RegExp(`\\n${sel.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`));
        return m ? m[1] : '';
      };
      const opt = block('.opt');
      const fs = block('.field-single');
      if (!opt) return 'styles.css 里找不到 .opt（选项按钮）';
      if (!fs) return 'styles.css 里找不到 .field-single（降级态那个腰围框）';
      const optPad = ((opt.match(/padding:\s*([^;]+);/) || [])[1] || '').trim().split(/\s+/);
      const fsPad = ((fs.match(/padding:\s*([^;]+);/) || [])[1] || '').trim();
      if (!fsPad) return '.field-single 没写 padding';
      const fsParts = fsPad.split(/\s+/);
      const fsRight = fsParts.length >= 2 ? fsParts[1] : fsParts[0];
      const optRight = optPad.length >= 2 ? optPad[1] : optPad[0];
      if (fsRight !== optRight) return `.field-single 右内边距 ${fsRight} 与 .opt 的 ${optRight} 不一致，两行文字左侧会对不齐`;
      const mg = ((fs.match(/margin:\s*([^;]+);/) || [])[1] || '').trim().split(/\s+/);
      const bottom = mg.length >= 3 ? mg[2] : mg[0];
      if (!bottom || !(parseFloat(bottom) > 0)) return '.field-single 底下没有留白，腰围框会贴在第一个选项上';
      return null;
    },
  },
  {
    id: 'egg-wish-by-person',
    why: '病长在家人身上还说「祝你早日康复」是一句错话（老板 2026-11-23 第 2 条：家族史用户要差异化）。所以家族史必须走第二个触发表 + 第二句祝福；家族史以后再加病种，这两处也要跟着长，否则新勾了癌种的人什么也看不到 —— 当年「问卷里根本没有阿尔茨海默病」就是这么漏掉的。',
    check(f) {
      let egg;
      try { egg = JSON.parse(f['data/egg.json'] || '{}'); } catch { return 'egg.json 不是合法 JSON'; }
      const js = f['src/egg.js'] || '';
      const q = f['src/questions.js'] || '';
      if (!/家人/.test(egg.wishFamily || '')) return 'egg.json 的 wishFamily 里没有「家人」，家族史用户还是看到那句对自己说的祝福';
      if (/家人/.test(egg.wish || '')) return '自述既往症那句祝福被改成了对家人说的，人称反了';
      if (!/familyTrigger/.test(js) || !/wishFamily/.test(js)) return 'egg.js 没有按 familyTrigger 切换祝福人称';
      if (!/pastHistory/.test(js) || !/familyHistory/.test(js)) return 'egg.js 只看了既往症或只看了家族史';
      const blk = q.slice(q.indexOf("key: 'familyHistory'"), q.indexOf("key: 'pastHistory'"));
      if (!blk) return 'questions.js 里找不到 familyHistory 那段';
      const vals = [...blk.matchAll(/\{\s*v:\s*'([a-zA-Z]+)'/g)].map((m) => m[1]);
      /* 糖尿病家族史不在这个彩蛋的四类病里（原话点的是癌症 / 阿尔茨海默病 / 心脏病 / 精神疾病） */
      const lost = vals.filter((v) => v !== 'diabetes' && !(egg.familyTrigger || []).includes(v));
      if (lost.length) return `家族史里的 ${lost.join('、')} 没进彩蛋触发表，选了也看不到`;
      return null;
    },
  },
  {
    id: 'no-fake-assertions',
    why: '写成 check(名字, true) 的断言永远是绿的，它只证明"这一行执行到了"。校验器汇总行说谎那次，就是这个毛病的变种：检查看起来在做，其实什么都没验。',
    check(f) {
      const s = f['tests/browser-check.mjs'] || '';
      const lines = s.split('\n').filter((l) => /check\(\s*['"][^'"]+['"]\s*,\s*true\b/.test(l));
      return lines.length ? `有 ${lines.length} 条永远为真的断言：${lines[0].trim().slice(0, 80)}` : null;
    },
  },
  {
    id: 'author-links-one-place',
    why: '署名三处的口径本来就不一样（首页的 GitHub 图标去**仓库**、结果页的 GitHub 去**个人主页**、依据页只去个人主页）。网址要是手写三份，改一个忘一个，最后就是"首页点得到、结果页 404"这种只有用户才发现的错。所以四个网址只许写在 src/author.js。',
    check(f) {
      const urls = ['xiaohongshu.com/user/profile', 'github.com/laowang-ai-xbb'];
      const bad = [];
      for (const [p, s] of Object.entries(f)) {
        if (!p.startsWith('src/') || p === 'src/author.js') continue;
        const hit = urls.filter((u) => s.includes(u));
        if (hit.length) bad.push(`${p}（${hit[0]}）`);
      }
      if (bad.length) return `署名网址被手写在 ${bad.join('、')}，应该统一引用 src/author.js`;
      const a = f['src/author.js'] || '';
      const miss = urls.filter((u) => !a.includes(u));
      if (miss.length) return `src/author.js 里找不到 ${miss.join('、')}`;
      return null;
    },
  },
  {
    id: 'author-name-from-constant',
    why: '名字写死在模板里，改名那天必漏一处 —— 结果页还叫旧名字。除了 SPDX 版权头（那是给许可证读的固定格式），src/ 里出现作者名只能来自 AUTHOR 常量。',
    check(f) {
      const NAME = '老王AI瞎bb';
      const bad = [];
      for (const [p, s] of Object.entries(f)) {
        if (!p.startsWith('src/') || p === 'src/author.js') continue;
        const line = s.split('\n').find((l) => l.includes(NAME) && !/Copyright \(c\) 2026/.test(l));
        if (line) bad.push(`${p}：${line.trim().slice(0, 40)}`);
      }
      if (bad.length) return `作者名被写死在 ${bad[0]}`;
      const a = f['src/author.js'] || '';
      /* 注释里出现名字是在解释规则，允许；代码里只许有 AUTHOR 常量那一处 */
      const code = a.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      const n = (code.match(/老王AI瞎bb/g) || []).length;
      if (!/export const AUTHOR = '/.test(code)) return 'src/author.js 没有导出 AUTHOR 常量';
      if (n !== 1) return `src/author.js 的代码里出现了 ${n} 次作者名（应为 1 次，即 AUTHOR 常量）`;
      return null;
    },
  },
  {
    id: 'author-three-places',
    why: '三处署名是逐字定的位置：首页页脚签名条、结果页最后一行、依据页最后一行。少一处不会有任何报错，只会有人某天发现"怎么没有作者了"。所以钉住三处**真的渲染**（只看 import 不算，得看模板里调了没有）。',
    check(f) {
      const a = f['src/author.js'] || '';
      const main = f['src/main.js'] || '';
      const ev = f['src/evidence.js'] || '';
      for (const fn of ['signBarHTML', 'signLineResultHTML', 'signLineEvidenceHTML']) {
        if (!new RegExp(`export const ${fn} =`).test(a)) return `src/author.js 没有导出 ${fn}`;
      }
      if (!main.includes('${signBarHTML()}')) return '首页没有渲染签名条（signBarHTML）';
      if (!main.includes('${signLineResultHTML()}')) return '结果页没有渲染署名行（signLineResultHTML）';
      if (!ev.includes('${signLineEvidenceHTML()}')) return '依据页没有渲染署名行（signLineEvidenceHTML）';
      /* 首页那条要排在「站在谁的肩膀上」之后：先谢指南和模型，最后才轮到作者 */
      const credits = main.indexOf("${creditsHTML(' credits-home')}");
      if (credits < 0) return '首页找不到「站在谁的肩膀上」模块';
      if (main.indexOf('${signBarHTML()}') < credits) return '首页签名条跑到了「站在谁的肩膀上」前面';
      return null;
    },
  },
  {
    id: 'author-avatar-size',
    why: '头像是首页最重的静态资源（原图 512×512 / 266KB，一个人就要下一遍）。它必须先在 public 里压成 128×128 再按 26px 显示；标签写 26、CSS 写别的，加载时会先跳一下再落位。',
    check(f) {
      const a = f['src/author.js'] || '';
      const css = f['src/styles.css'] || '';
      const tag = (a.match(/<img[^>]*class="sign-pic"[^>]*>/) || [''])[0];
      if (!tag) return 'src/author.js 里找不到签名条的头像标签';
      const m = tag.match(/width="(\d+)" height="(\d+)"/);
      if (!m) return 'src/author.js 的头像标签没写死 width/height（图加载完会跳）';
      if (m[1] !== m[2]) return `头像标签不是正方形（${m[1]}×${m[2]}）`;
      if (!/loading="lazy"/.test(tag)) return '头像没加 loading="lazy"（首页首屏不该为页脚图让路）';
      const c = css.match(/\.sign-pic\s*\{[^}]*width:\s*(\d+)px[^}]*height:\s*(\d+)px/);
      if (!c) return 'styles.css 的 .sign-pic 没有固定宽高';
      if (c[1] !== m[1] || c[2] !== m[2]) return `标签写 ${m[1]}px、CSS 写 ${c[1]}px，两处不一致`;
      if (!existsSync('./public/avatar.png')) return 'public/avatar.png 不存在（构建不会凭空生出来）';
      const buf = readFileSync('./public/avatar.png');
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      if (w !== h) return `public/avatar.png 不是方图（${w}×${h}）`;
      if (buf.length > 60 * 1024) return `public/avatar.png 有 ${Math.round(buf.length / 1024)}KB，超过 60KB`;
      return null;
    },
  },
  {
    id: 'excerpt-note-once',
    why: '依据页页脚原来顶部有一张卡写着「以上均为公开文件摘录」，署名收尾一行又说一遍 —— 同一句话两处不是强调，是重复。定稿是只留收尾一行，所以这句只许在 src/author.js 出现一次。',
    check(f) {
      const a = f['src/author.js'] || '';
      const ev = f['src/evidence.js'] || '';
      const code = a.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      const n = (code.match(/以上均为公开文件摘录/g) || []).length;
      if (n !== 1) return `src/author.js 里出现了 ${n} 次「以上均为公开文件摘录」（应为 1 次）`;
      if (ev.includes('以上均为公开文件摘录')) return 'evidence.js 里又写了一遍摘录声明，页脚会重复';
      return null;
    },
  },
  {
    id: 'repo-slug-consistent',
    why: '仓库名同时被两处使用：src/author.js 用它拼首页那条链接，data/fingerprint.json 用它记录指纹属于哪个仓库。改名那天只改一处，就会出现"链接指向新仓库、指纹还写着旧仓库"，两边都自称是官方来源。',
    check(f) {
      const a = f['src/author.js'] || '';
      const m = a.match(/export const REPO_SLUG = '([^']*)'/);
      if (!m) return 'src/author.js 里找不到 REPO_SLUG';
      const slug = m[1];
      if (slug && !/^[A-Za-z0-9._-]+$/.test(slug)) return `REPO_SLUG 不是合法的仓库名：${slug}`;
      let fp;
      try { fp = JSON.parse(f['data/fingerprint.json'] || '{}'); } catch { return 'fingerprint.json 不是合法 JSON'; }
      if ((fp.repo || '') !== slug) return `fingerprint.json 记的仓库是「${fp.repo || '(空)'}」，author.js 写的是「${slug}」`;
      return null;
    },
  },
  {
    id: 'quiz-back-armed',
    why: '在第一题点「上一题」不能没有反应——但也不能一点就把人踢回首页（老人可能只是手滑）。定稿是三段行为：第一次点出提示并高亮，再点一次才回首页，往前走一步自动解除武装。三段里缺任何一段，按钮要么变哑巴、要么误伤；回首页还必须把年龄性别带出来，不能让人重填。',
    check(f) {
      /* main.js 是 CRLF，多行锚点先归一化再比，否则 Windows 工作区必误报 */
      const main = (f['src/main.js'] || '').replace(/\r\n/g, '\n');
      const css = f['src/styles.css'] || '';
      const btn = (main.match(/<button class="back\$\{[^}]*\}"[^>]*>/) || [''])[0];
      if (!btn) return '找不到「上一题」按钮';
      if (/disabled/.test(btn)) return '「上一题」按钮被 disabled——第一题点了没反应，正是 2026-11-24 要修的 bug';
      if (!btn.includes('data-act="back"')) return '「上一题」按钮丢了 data-act="back"';
      if (!main.includes("if (state.exitArmed) {\n      state.view = 'start';")) return 'back 分支没有"武装后再点回首页"那段（第二次点击只会重复出提示）';
      if (!main.includes('state.exitArmed = true;')) return 'back 分支没有武装 exitArmed（第一次点不会出提示）';
      if (!/state\.exitArmed = false; \/\/ 往前走一步/.test(main)) return 'next() 没有解除 exitArmed 武装（出过提示再往前走，行为会串）';
      const hint = (main.match(/<p class="back-hint"[^>]*>(.*?)<\/p>/) || [''])[1];
      if (!hint) return '找不到 back-hint 提示条';
      if (!hint.includes('已经到第一题了，你想放弃长命百岁吗？')) return 'back-hint 提示文案被改动了';
      if (!hint.includes('<b>再点一次</b>')) return 'back-hint 里丢了「再点一次」的强调';
      if (!css.includes('.back-hint')) return 'styles.css 没有 .back-hint 样式（提示条会裸奔）';
      if (!css.includes('.back.on')) return 'styles.css 没有 .back.on 高亮（武装状态看不出来）';
      if (!/\$\{state\.profile\.age \|\| ''\}/.test(main)) return '首页年龄输入框没有带出已填的年龄（回首页就丢答案）';
      return null;
    },
  },
  {
    id: 'hp-negative-no-retest',
    why: '老板 2026-11-24 走查：问卷里答了「查过，阴性」，结果页还让他做呼气试验——hp-test-once 的 when 只看了年龄没看答案。必须显式排除阴性；阳性保留（卡里带着规范根除/复查的提示，45+ 由胃癌高风险规则接去胃镜），别顺手把阳性也藏了。',
    check(f) {
      let rules;
      try { rules = (JSON.parse(f['data/rules.json'] || '{}').rules) || []; } catch { return 'rules.json 不是合法 JSON'; }
      const r = rules.find((x) => x.id === 'hp-test-once');
      if (!r) return '找不到 hp-test-once 规则';
      const none = (r.when && r.when.none) || [];
      if (!none.some((c) => c && c.hpStatus === 'negative')) return 'hp-test-once 没有排除「查过阴性」，阴性用户会再被推荐吹气';
      return null;
    },
  },
  {
    id: 'upcoming-only-new-items',
    why: '老板 2026-11-24 走查：44 岁的「再过几年要加上」里出现便潜血——它就在今年的基础套餐里，同一项既"今年要做"又"过两年要加"，用户以为自己漏了什么。根修在 upcoming()：先收当前清单真实展示的项目（只认 A/B，「不必做」卡不挡将来的推荐），预告规则滤掉老面孔；全是老面孔的整条不预告；卡片只说新加的几项（肠镜后面不再挂着便潜血）。',
    check(f) {
      const e = (f['src/engine.js'] || '').replace(/\r\n/g, '\n');
      if (!/const presentIds = new Set\(\);/.test(e)) return 'upcoming 没有收集当前已展示的项目';
      if (!/for \(const key of \['A', 'B'\]\)/.test(e)) return 'presentIds 没有只认 A/B（C「不必做」不该挡住将来的推荐）';
      if (!/const fresh = \(rule\.catalogIds \|\| \[\]\)\.filter\(\(id\) => !presentIds\.has\(canon\(id\)\)\);/.test(e)) return 'upcoming 没有过滤已展示的项目（老面孔会再次预告）';
      if (!/fresh\.length === 0\) break;/.test(e)) return '全是老面孔的规则没有被跳过';
      if (!/rule\.shownIds = fresh;/.test(e)) return '预告卡没有只展示新加的项目（标题会重新挂上便潜血）';
      return null;
    },
  },
  {
    id: 'seo-machine-layer',
    why: '老板 2026-11-24 拍板的 SEO/AIO 五件套：canonical、og:url/og:locale、JSON-LD（WebApplication + 6 条真实 FAQ）、noscript 兜底摘要、llms.txt。这些是给搜索引擎和 AI 读的"机器说明书"——用户看不见，所以坏了也没人发现，必须钉住。内容只许写产品事实：写假信息会被搜索引擎降权。',
    check(f) {
      const idx = f['index.html'] || '';
      if (!/<link rel="canonical" href="__SITE_ORIGIN__\/"/.test(idx)) return '首页没有 canonical（或占位符被改动）';
      if (!/property="og:locale" content="zh_CN"/.test(idx)) return 'og:locale 丢了';
      const desc = (idx.match(/<meta\s+name="description"\s+content="([^"]*)"/) || [''])[1];
      if (!/免费/.test(desc) || !/不收集隐私/.test(desc)) return 'description 没带「免费 / 不收集隐私」关键词';
      const m = idx.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
      if (!m) return '首页没有 JSON-LD 结构化数据';
      let ld;
      try { ld = JSON.parse(m[1].split('__SITE_ORIGIN__').join('https://x.example')); }
      catch (e) { return `JSON-LD 不是合法 JSON（结构化数据会整体失效）：${e.message.slice(0, 60)}`; }
      const types = (ld['@graph'] || []).map((n) => n['@type']);
      if (!types.includes('WebApplication')) return 'JSON-LD 丢了 WebApplication（免费、健康类声明）';
      if (!types.includes('FAQPage')) return 'JSON-LD 丢了 FAQPage';
      const qs = (ld['@graph'] || []).flatMap((n) => n.mainEntity || []);
      if (qs.length < 5) return `FAQ 只剩 ${qs.length} 条问答（应有 6 条）`;
      if (!qs.some((q) => /代替医生|医疗建议/.test((q.acceptedAnswer || {}).text || ''))) return 'FAQ 丢了「不能代替医生」那条（免责必须在场）';
      if (!/<noscript>[\s\S]*长命百岁体检项目指南[\s\S]*国家权威指南[\s\S]*<\/noscript>/.test(idx)) return 'noscript 兜底摘要丢了（不开 JS 的爬虫只能爬到空白）';
      if (!/需要开启 JavaScript/.test(idx)) return 'noscript 里「开启 JavaScript」的提示丢了';
      let llms = '';
      try { llms = readFileSync('./public/llms.txt', 'utf8'); } catch { return 'public/llms.txt 不存在（构建不会凭空生出来）'; }
      if (!/免费/.test(llms) || !/不是医疗建议/.test(llms) || !/\/e\.html/.test(llms)) return 'llms.txt 缺关键事实（免费 / 不是医疗建议 / 依据页路径）';
      return null;
    },
  },
];

/** 跑一遍全部不变量，返回 [{id, ok, msg}] */
export const runInvariants = (files) =>
  INVARIANTS.map((inv) => {
    let msg;
    try { msg = inv.check(files); } catch (e) { msg = `检查自身报错：${e.message}`; }
    return { id: inv.id, why: inv.why, ok: !msg, msg: msg || '' };
  });
