/**
 * 年份岗哨（2026-11-27 老板批准的"任务2 第一步"）
 *
 * 盯什么：官方文件的"现行版年份"，不是"最新年份"。
 *   官网说现行版是 2021，我们引 2021 —— 对，不用动；
 *   官网哪天标了 2026，我们还在引 2021 —— 这就是"年份漂移"，要响。
 *
 * 为什么单独一层：老巡检核"我们引的那句话还在不在原文里"（内容层），
 *   但官方"悄悄换版"最常见的形态是——旧版页面还在、引用没断、新版已经挂出来。
 *   内容层看不见这件事，年份层看得见。两层互为备份。
 *
 * 三种源，各配各的提取器（提取规则 2026-11-27 逐条实测过）：
 *   1. USPSTF：A&B 清单页一行一个主题带 "Month YYYY"；D/I 级主题页
 *      JSON-LD 里有 "datePublished": "YYYY-MM-DD"（11 个主题全部验证）。
 *   2. 中文指南：文档标题自带版本年份「（2025年版）」——
 *      NHC docx、防癌指南 PDF 实测命中；取全文命中的最大年份当现行版。
 *   3. 兜底：任何配置了 pattern 的源，都走 maxPatternYear。
 *
 * 纯函数、无 IO：check-updates.mjs 负责抓与写，node 单测直接考这里。
 */

const MONTHS = {
  January: '01', February: '02', March: '03', April: '04',
  May: '05', June: '06', July: '07', August: '08',
  September: '09', October: '10', November: '11', December: '12',
};

const MONTH_RE = '(January|February|March|April|May|June|July|August|September|October|November|December)';

/** "May 2021" → "2021"；解析不了返回 '' */
export const abMonthYearToYear = (s = '') => {
  const m = String(s).match(new RegExp(`^${MONTH_RE} (20[0-9][0-9])$`));
  return m ? m[2] : '';
};

/**
 * USPSTF A&B 清单页 → { slug: 'YYYY' }
 * 官方页面有两副面孔，都得认：
 *   - 原始 HTML：<tr><td><a href='/uspstf/recommendation/SLUG'>…</a></td>…<td>May 2021</td></tr>
 *     （单引号双引号都见过，官网改版换过引号风格）
 *   - 转成纯文本后（fetchSource 统一走 htmlToText，链接会被剥掉）：
 *     "主题标题 \n 描述 \n B \n May 2021 *" —— 没有 slug，按标题行匹配。
 * 纯文本模式用标题关键词映射 slug（11 个在用主题的标题都唯一），拿不到 slug 的行跳过。
 * 同一 slug 出现多行（如结直肠癌 A、B 各一行）取最新年份。
 */
const TOPIC_TITLE_KEYS = [
  ['colorectal-cancer-screening', /colorectal cancer: screening/i],
  ['lung-cancer-screening', /lung cancer: screening/i],
  ['breast-cancer-screening', /breast cancer: screening/i],
  ['cervical-cancer-screening', /cervical cancer: screening/i],
  ['osteoporosis-screening', /osteoporosis to prevent fractures/i],
  ['prostate-cancer-screening', /prostate cancer: screening/i],
  ['brca-related-cancer-risk-assessment-genetic-counseling-and-genetic-testing', /brca-related cancer/i],
  ['abdominal-aortic-aneurysm-screening', /abdominal aortic aneurysm: screening/i],
  ['carotid-artery-stenosis-screening', /carotid artery stenosis: screening/i],
  ['thyroid-cancer-screening', /thyroid cancer: screening/i],
  ['thyroid-dysfunction-screening', /thyroid dysfunction|thyroid disease/i],
];

export const parseAbList = (html = '') => {
  const out = {};
  const src = String(html);
  const hasMarkup = /<tr|href=/.test(src);
  if (hasMarkup) {
    for (const row of src.split(/<tr>/i).slice(1)) {
      const link = row.match(/href=['"][^'"]*\/recommendation\/([a-z-]+)['"]/i);
      // MONTH_RE 自带一个捕获组，所以"月+年"整体在 date[0] 里，别按组号拆
      const date = row.match(new RegExp(`${MONTH_RE}\\s+20[0-9][0-9]`));
      if (!link || !date) continue;
      const year = abMonthYearToYear(date[0].trim());
      if (!year) continue;
      const slug = link[1];
      // 多行同 slug 取较大年份：行序不代表新旧，数字才是事实
      if (!out[slug] || year > out[slug]) out[slug] = year;
    }
    return out;
  }
  // 纯文本模式：按"标题 → 等级 → Month YYYY"的顺序切片。
  // split 步长不赌死：不同正则引擎版本对嵌套捕获组的展开不一样
  // （实测 54 个日期切出 109 段 = 两步一组）。做法是逐段用
  // abMonthYearToYear 严格试解析——它要求整段恰好是 "Month YYYY"，
  // 所以非日期段（描述、等级、正文）必然秒失败，不会误配。
  const parts = src.split(new RegExp(`(${MONTH_RE}\\s+20[0-9][0-9])(?=\\s*\\*?\\s*(?:\\n|$))`));
  for (let i = 1; i < parts.length; i++) {
    const year = abMonthYearToYear(parts[i]);
    if (!year) continue;
    const before = parts[i - 1];
    for (const [slug, re] of TOPIC_TITLE_KEYS) {
      if (re.test(before)) {
        if (!out[slug] || year > out[slug]) out[slug] = year;
        break;
      }
    }
  }
  return out;};

/**
 * 主题页 → ISO 日期 'YYYY-MM-DD'（取不到返回 ''）
 * 两副面孔都得认（与 parseAbList 同理，fetchSource 会把 HTML 转纯文本）：
 *   - 原始 HTML：<script type="application/ld+json"> 里有 "datePublished": "2018-05-08"
 *   - 转纯文本后 script 被剥掉，但页头仍渲染官方日期："May 08, 2018"（反复出现，取首个）
 * 这是官方自己标的现行版日期，比正文散落的年份可靠。
 */
export const extractDatePublished = (html = '') => {
  const src = String(html);
  const m = src.match(/"datePublished"\s*:\s*"(20[0-9][0-9]-[01][0-9]-[0-3][0-9])"/);
  if (m) return m[1];
  const t = src.match(
    new RegExp(`${MONTH_RE} (0?[1-9]|[12][0-9]|3[01]), (20[0-9][0-9])`),
  );
  // 注意：MONTH_RE 自带一个捕获组，所以组号是 1=月名、2=日、3=年（别按"月日年"直觉排）
  return t ? `${t[3]}-${MONTHS[t[1]]}-${String(t[2]).padStart(2, '0')}` : '';
};

/**
 * 按 pattern 提取文本里的版本年份，返回最大值（'YYYY' 或 ''）。
 * pattern 必须带一个捕获组（如 「（(20[0-9][0-9])年版）」）。
 * 取最大而不是第一个：中文指南正文常同时提到旧版（"替代2019年版"），
 * 版本号只增不减，最大值就是现行版。
 */
export const maxPatternYear = (text = '', pattern = '') => {
  if (!pattern) return '';
  let re;
  try { re = new RegExp(pattern, 'g'); } catch { return ''; }
  let max = '';
  for (const m of String(text).matchAll(re)) {
    const y = (m[1] || '').match(/^20[0-9][0-9]$/) ? m[1] : '';
    if (y && (!max || y > max)) max = y;
  }
  return max;
};

/**
 * 岗哨裁决：官方现行年份 vs 我们引用的年份 → 漂移清单。
 *
 * citations: [{ ruleId, url, slug?, year }] —— 从 rules.json 展平而来；
 * official:  { key: 'YYYY' } —— key 用 citation.key（由调用方构造：USPSTF 用 slug，pattern 源用 url）。
 *
 * 规则（写死，别改）：
 *   officialYear > citedYear  → YEAR_DRIFT（官网现行版更新了，该走升级流程）
 *   officialYear < citedYear  → 也报！我们引的年份官网自己都不认了，
 *     多半是把旧版年份标到了新版头上，属于数据错误。
 *   officialYear === citedYear → 安静。
 *   official 取不到（页面改版/抓取失败）→ 不报。抓取失败由 broken 通道管，这里不重复报警。
 */
export const sentinelDecide = (citations = [], official = {}) => {
  const drift = [];
  const seen = new Set();
  for (const c of citations) {
    if (!c || !c.key || !c.year || !c.ruleId) continue;
    const off = official[c.key];
    if (!off || !/^20[0-9][0-9]$/.test(off)) continue;
    const k = `${c.ruleId}\u0000${c.key}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (off !== c.year) {
      drift.push({
        ruleId: c.ruleId,
        key: c.key,
        url: c.url || '',
        citedYear: c.year,
        officialYear: off,
        direction: off > c.year ? '官网有更新版本' : '引用年份比官网现行版还新（数据可疑）',
      });
    }
  }
  return drift;
};

/* ---------------- 心跳：自动化自己的"还活着"信号 ----------------
 * 最隐蔽的故障不是报错，是整套巡检静默死掉（ Actions 配额、依赖失效、
 * 账号欠费），页面看起来一切正常。心跳=巡检成功时写时间戳，
 * 超过阈值没心跳就报警——"没人盯"不许变成"没人知道坏了"。 */

export const HEARTBEAT_MAX_DAYS = 14;

/** ISO 日期字符串 → {y,m,d}；不合法返回 null */
const parseIso = (s) => {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
};

/** 心跳是否过期。lastOk：上次成功的 ISO 时间戳；now 同格式或 Date。
 * 按自然日粒度比较（两边都折到 UTC 日期再相减）：巡检每周跑一次，
 * 差几个小时不该报，14 个自然日没跑才算死。 */
export const heartbeatStale = (lastOk, now = new Date(), maxDays = HEARTBEAT_MAX_DAYS) => {
  const last = parseIso(lastOk);
  if (!last) return { stale: true, reason: '没有心跳记录（从未成功跑过，或记录文件丢失）' };
  const n = now instanceof Date ? now : (parseIso(now) || new Date());
  const dayFloor = (d) => Math.floor(d.getTime() / 86400000);
  const days = dayFloor(n) - dayFloor(last);
  if (days > maxDays) {
    return { stale: true, reason: `上次巡检成功是 ${String(lastOk).slice(0, 10)}，距今 ${days} 天，超过 ${maxDays} 天阈值` };
  }
  return { stale: false, days };
};
