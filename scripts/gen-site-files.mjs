/**
 * 生成 robots.txt / sitemap.xml，并把 og:image 补成绝对地址。
 *
 * 为什么放在 build 之后跑：
 * 1) sitemap 里必须是绝对 URL，相对地址搜索引擎不认；
 * 2) 域名是部署时才确定的（SITE_ORIGIN 环境变量），写死在源码里一定会忘改；
 * 3) 放 public/ 里会让生成物进仓库，改个域名就出一堆 diff。
 *
 * 用法：
 *   SITE_ORIGIN=https://tijianzhinan.cn npm run build
 * 没设 SITE_ORIGIN 时用占位域名并大声提示，产物仍可用（本地预览、内网测试）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';
const PLACEHOLDER = 'https://tijian.example.com';

/** 要被收录的页面。以后加人群页（/p/xxx.html）在这里补，别指望自动扫 dist。 */
const PAGES = [{ path: '/', priority: '1.0' }];

let origin = (process.env.SITE_ORIGIN || '').trim();
const usingPlaceholder = !origin;
if (usingPlaceholder) {
  origin = PLACEHOLDER;
  console.warn(
    '\n[site] 没有设置 SITE_ORIGIN，sitemap/og:url 里先用占位域名 ' + PLACEHOLDER +
      '\n[site] 正式上线前务必：SITE_ORIGIN=https://你的域名 npm run build\n',
  );
} else {
  origin = origin.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(origin)) {
    console.error('[site] SITE_ORIGIN 必须以 http:// 或 https:// 开头，当前：' + origin);
    process.exit(1);
  }
}

if (!existsSync(DIST)) {
  console.error('[site] 找不到 dist/，请先跑 vite build（npm run build 会自动按顺序执行）');
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);

/* ---------------- robots.txt ---------------- */
// 注意：结果页 r.html 用 meta noindex 处理，这里故意不 Disallow。
// 被 robots 挡住的 URL，爬虫看不到页面上的 noindex，反而可能一直留在索引里（带着别人的分享链接）。
// 这条规则很多人写反，写反了等于没做 noindex。
const robots = `# 体检项目指南
User-agent: *
Allow: /

# 结果页 /r.html 靠页面里的 <meta name="robots" content="noindex"> 处理，不要在这里 Disallow。

Sitemap: ${origin}/sitemap.xml
`;

writeFileSync(join(DIST, 'robots.txt'), robots, 'utf8');

/* ---------------- sitemap.xml ---------------- */
const urls = PAGES.map(
  (p) =>
    `  <url>\n    <loc>${origin}${p.path}</loc>\n    <lastmod>${today}</lastmod>\n    <priority>${p.priority}</priority>\n  </url>`,
).join('\n');

writeFileSync(
  join(DIST, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
  'utf8',
);

/* ---------------- og:image 换成绝对地址 ---------------- */
// Open Graph 规范要求 og:image 是绝对 URL；相对地址在微博/QQ/钉钉的卡片里经常取不到图。
const indexPath = join(DIST, 'index.html');
if (existsSync(indexPath)) {
  let html = readFileSync(indexPath, 'utf8');
  const before = html;
  html = html.replace(
    /(<meta property="og:image" content=")([^"]*)(")/,
    (m, a, v, c) => a + (/^https?:/.test(v) ? v : origin + '/' + v.replace(/^\.?\//, '')) + c,
  );
  // og:url 一起补上，转发卡片才知道指向谁
  if (!/property="og:url"/.test(html)) {
    html = html.replace(
      '</head>',
      `  <meta property="og:url" content="${origin}/" />\n  </head>`,
    );
  }
  // canonical / JSON-LD 里的 __SITE_ORIGIN__ 占位符按真实域名替换。
  // 首页源码里不能写死域名：域名变了这里不改，canonical 就指向旧域名，权重全喂给幽灵页。
  html = html.split('__SITE_ORIGIN__').join(origin);
  if (html !== before) writeFileSync(indexPath, html, 'utf8');
}

console.log('[site] robots.txt / sitemap.xml 已生成，域名：' + origin + (usingPlaceholder ? '（占位）' : ''));
