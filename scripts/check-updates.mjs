/**
 * 指南更新巡检（Phase E）
 *
 * 干什么：把 rules.json 里所有依据的来源重新抓一遍，跟仓库里的快照比。
 *   1. 内容变了 → 打印变了哪些句子（优先带数字的），列出受影响的规则；
 *   2. **引用失效** → 直接拿新抓的正文去核我们引的那几句，找不到就是"我们的依据被改掉了"，
 *      这比"内容有变化"可执行得多，优先级最高；
 *   3. 抓不到 → 也报，链接烂掉本身就是需要处理的事。
 *
 * 默认不覆盖快照。确认改动是真实的指南更新后，跑 `node scripts/snapshot-sources.mjs --force`
 * 才会把新原文写进仓库（然后再跑 validate，看引用是否还命中）。
 *
 * 用法：
 *   node scripts/check-updates.mjs
 *   node scripts/check-updates.mjs --only=uspstf
 *   node scripts/check-updates.mjs --json=reports/updates.json   给定时任务读的机器可读报告
 *   node scripts/check-updates.mjs --fail-on-change              有变化就 exit 2（CI 用来触发提醒）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fetchSource, sha, squash } from './lib/source-fetch.mjs';
import { summarize } from './lib/diff-text.mjs';
import { newTitles, extractTitles, snapshotOf } from './lib/catalog-watch.mjs';
import { nextFailures, bumpFailure, longUnreachable, isTruncated } from './lib/watch-health.mjs';
import {
  parseAbList, extractDatePublished, maxPatternYear, sentinelDecide, heartbeatStale,
} from './lib/year-sentinel.mjs';

const INDEX = 'data/snapshots/_index.json';
const argv = process.argv.slice(2);
const onlyArg = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';
const jsonArg = (argv.find((a) => a.startsWith('--json')) || '').split('=')[1] || '';
const failOnChange = argv.includes('--fail-on-change');
const initWatchBaseline = argv.includes('--init-watch-baseline');

const rulesDoc = JSON.parse(readFileSync('data/rules.json', 'utf8'));
const rules = rulesDoc.rules || rulesDoc;
const index = existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, 'utf8')) : {};

/** url → { rules:Set, quotes:[] } —— 同一个链接常被多条规则共用，引用要一起核 */
const urls = new Map();
for (const rule of rules) {
  for (const ev of rule.evidence || []) {
    if (!ev.url || (onlyArg && !ev.url.includes(onlyArg))) continue;
    if (!urls.has(ev.url)) urls.set(ev.url, { rules: new Set(), quotes: [] });
    const bucket = urls.get(ev.url);
    bucket.rules.add(rule.id);
    for (const q of ev.quotes || []) bucket.quotes.push({ ruleId: rule.id, quote: q });
  }
}

const changed = [];
const broken = [];
const same = [];
const quoteBroken = []; // 最重要的一类：新正文里找不到我们引的那句
const numsTouched = []; // 关键数字变了的来源
const cosmetic = [];    // 只是版式/段落变了、数字没动的来源

/* ---- 第三层：年份岗哨（2026-11-27 任务2 第一步）----
 * 老巡检核"引文还在不在"，目录雷达盯"发没发新文件"，这里补第三只眼：
 * 官方现行版年份 vs 我们 rules.json 里标的年份。官网换版而旧页还挂着时，
 * 内容层看不见，年份层看得见。
 * USPSTF 走 A&B 清单页（A/B 级一行一条带月份）+ 主题页 JSON-LD datePublished（D/I 级）；
 * 中文指南按配置里的 pattern 从原文抓「（2025年版）」这类版本年份，取最大值当现行版。 */
const AB_URL = 'https://www.uspreventiveservicestaskforce.org/uspstf/recommendation-topics/uspstf-a-and-b-recommendations';
const officialYears = {};   // key = slug 或 url → 'YYYY'
const sentinelFails = [];
let abParsed = {};

// 收集"每条依据该用哪个岗哨源"：USPSTF 用 slug，pattern 源用 url 本身
const sentinelCites = [];
const yearPatternOf = new Map(); // url → pattern（由 data/year-watch.json 配置）
const YEAR_WATCH_FILE = 'data/year-watch.json';
let yearWatch = { sources: [] };
try { yearWatch = JSON.parse(readFileSync(YEAR_WATCH_FILE, 'utf8')); } catch { /* 没有配置就只盯 USPSTF */ }
for (const s of yearWatch.sources || []) {
  if (s.pattern) yearPatternOf.set(s.url, s.pattern);
}
for (const rule of rules) {
  for (const ev of rule.evidence || []) {
    if (!ev.url || !ev.year) continue;
    const slug = ev.url.match(/uspreventiveservicestaskforce\.org\/uspstf\/recommendation\/([a-z-]+)/)?.[1];
    if (slug) sentinelCites.push({ ruleId: rule.id, key: slug, url: ev.url, year: ev.year });
    else if (yearPatternOf.has(ev.url)) sentinelCites.push({ ruleId: rule.id, key: ev.url, url: ev.url, year: ev.year });
  }
}
const sentinelNeeded = { ab: sentinelCites.some((c) => !c.key.includes('/')), patterns: [...yearPatternOf.keys()] };

// A&B 清单页：一次抓全，覆盖所有 A/B 级主题
if (sentinelCites.length) {
  try {
    const { text } = await fetchSource(AB_URL);
    abParsed = parseAbList(text);
    Object.assign(officialYears, abParsed);
  } catch (e) {
    sentinelFails.push({ source: 'uspstf-ab-list', url: AB_URL, error: String(e.message || e).slice(0, 120) });
  }
}
// D/I 级主题（A&B 清单里没有的 slug）→ 抓主题页 JSON-LD datePublished。
// 只补 USPSTF 域名的 slug；pattern 源的 key 是完整 URL，有自己的提取循环，别混进来。
const missingSlugs = [...new Set(sentinelCites
  .filter((c) => !c.key.includes('/') && !officialYears[c.key])
  .map((c) => c.key))];
for (const slug of missingSlugs) {
  try {
    const { text } = await fetchSource(`https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/${slug}`);
    const iso = extractDatePublished(text);
    if (iso) officialYears[slug] = iso.slice(0, 4);
  } catch (e) {
    sentinelFails.push({ source: 'uspstf-topic', url: slug, error: String(e.message || e).slice(0, 120) });
  }
}
// 中文/其它 pattern 源：从原文（复用快照或现抓）提取版本年份
for (const [url, pattern] of yearPatternOf) {
  if (!urls.has(url) && !sentinelFails.some((f) => f.url === url)) {
    try {
      const { text } = await fetchSource(url);
      const y = maxPatternYear(text, pattern);
      if (y) officialYears[url] = y;
    } catch (e) {
      sentinelFails.push({ source: 'pattern', url, error: String(e.message || e).slice(0, 120) });
    }
  } else if (urls.has(url)) {
    // 主巡检循环已经抓过这个 URL 了——等它跑完从 same/changed 里拿不到正文，
    // 所以这里单独再抓一次的成本（每源一次 HTTP）换结构简单，值得。
    try {
      const { text } = await fetchSource(url);
      const y = maxPatternYear(text, pattern);
      if (y) officialYears[url] = y;
    } catch (e) {
      sentinelFails.push({ source: 'pattern', url, error: String(e.message || e).slice(0, 120) });
    }
  }
}
const yearDrift = sentinelCites.length ? sentinelDecide(sentinelCites, officialYears) : [];

for (const [url, info] of urls) {
  const rec = index[url];
  try {
    const { text } = await fetchSource(url);
    // 引用还站不站得住 —— 不管内容有没有"变化"，都拿新正文核一遍
    const flat = squash(text);
    for (const { ruleId, quote } of info.quotes) {
      if (!flat.includes(squash(quote))) quoteBroken.push({ url, ruleId, quote });
    }
    const nowHash = sha(text);
    if (!rec || !rec.file || !existsSync(rec.file)) {
      changed.push({ url, usedBy: [...info.rules], kind: '新增来源（没有旧快照）', pick: [] });
      continue;
    }
    const oldText = readFileSync(rec.file, 'utf8');
    if (rec.sha256 === nowHash) {
      same.push(url);
      continue;
    }
    const s = summarize(oldText, text);
    if (s.jitter) { same.push(url); continue; }
    // 分两类：关键数字动了 = 要处理；只是版式/段落变了 = 看一眼就行
    if (s.numsChanged) {
      changed.push({ url, usedBy: [...info.rules], kind: `关键数字变化（新增 ${s.numsAdded.length} / 消失 ${s.numsGone.length}）`, pick: s.pick, numsAdded: s.numsAdded, numsGone: s.numsGone });
      numsTouched.push(url);
    } else {
      cosmetic.push({ url, usedBy: [...info.rules], kind: `仅版式/段落变化（${s.addedCount} 句），关键数字未动`, pick: [] });
    }
  } catch (e) {
    broken.push({ url, usedBy: [...info.rules], error: String(e.message || e).slice(0, 160) });
  }
  process.stdout.write('.');
}

/* ---- 第二层：发布方目录页监控 ----
 * 老巡检只能看到"已引用的那篇变了"；这里补的是"发布方在别处发了一篇新的"。
 * 第一次跑（或显式 --init-watch-baseline）只写基线不报警，否则每家网站的首页
 * 都会冒出一堆"新标题"，几周后没人再看 —— 那等于没接。
 * 2026-11-25 升级（官方源优先三级分级）：tier A 官方直连；tier B 官方有 WAF 不降级，
 * 连续失败 ≥3 周才标"长期抓不到"（failures 持久化），截断检测防把抓坏了当成指南改了。 */
const WATCH_FILE = 'data/guideline-watch.json';
const BASE_FILE = 'data/snapshots/_watch-baseline.json';
const FAIL_FILE = 'data/snapshots/_watch-failures.json';
const catalog = { sources: 0, newGuidelines: [], broken: [], truncated: [], longUnreachable: [], baselineCreated: false };
{
  let watch = null;
  try { watch = JSON.parse(readFileSync(WATCH_FILE, 'utf8')); } catch { /* 没有配置文件就只跑老巡检 */ }
  if (watch?.sources?.length) {
    let base = {};
    try { base = JSON.parse(readFileSync(BASE_FILE, 'utf8')); } catch { /* 首次运行 */ }
    let failures = {};
    try { failures = JSON.parse(readFileSync(FAIL_FILE, 'utf8')); } catch { /* 首次运行 */ }
    const next = {};
    const okIds = [];
    const srcIds = watch.sources.map((s) => s.id);
    for (const src of watch.sources) {
      catalog.sources++;
      try {
        const { text } = await fetchSource(src.url);
        const snap = snapshotOf(src.id, src.url, text, src.keywords);
        // 截断检测：正文比基线短一半以上 → 疑似 WAF 打断/改版，不当成"指南改了"
        const baseChars = base[src.id]?.chars;
        if (!initWatchBaseline && isTruncated(snap.chars, baseChars)) {
          catalog.truncated.push({ source: src.org, url: src.url, baseChars, nowChars: snap.chars });
          // 沿用旧基线：这次结果不可信
          if (base[src.id]) next[src.id] = base[src.id];
          failures = bumpFailure(failures, src.id);
          process.stdout.write('t');
          continue;
        }
        next[src.id] = snap;
        okIds.push(src.id);
        const hadBase = base[src.id] && Array.isArray(base[src.id].titles);
        // 基线文件整体不存在才算"首次"：单个栏目第一次抓到就默默补上，
        // 否则 WAF 常年抓不到的那两家的报错会让每周都误报"首次运行"。
        if (!hadBase && !existsSync(BASE_FILE)) catalog.baselineCreated = true;
        if (!initWatchBaseline && hadBase) {
          for (const title of newTitles(snap.titles, base[src.id].titles) || []) {
            catalog.newGuidelines.push({ source: src.org, id: src.id, title, url: src.url });
          }
        }
      } catch (e) {
        // 2026-11-24 根因修复：失败的源**不写进 next**。
        // 旧写法把空快照也塞进基线，等于把"这次没抓到"冻结成"这个栏目就是没有标题"，
        // 等站点恢复后会一次性冒出几十条"新指南"。现在失败就沿用旧基线，不覆盖。
        if (base[src.id]) next[src.id] = base[src.id];
        const errText = String(e.message || e).slice(0, 160);
        catalog.broken.push({ source: src.org, url: src.url, tier: src.tier || 'A', error: errText });
        failures = bumpFailure(failures, src.id);
      }
      process.stdout.write('o');
    }
    // 连续失败计数：成功的清零；≥3 周的进"长期抓不到"名单（B 级源用 mirrorUrl 雷达补位）
    catalog.longUnreachable = longUnreachable(nextFailures(failures, okIds, srcIds));
    const finalFailures = nextFailures(failures, okIds, srcIds);
    if (Object.keys(finalFailures).length || existsSync(FAIL_FILE)) {
      mkdirSync(dirname(FAIL_FILE), { recursive: true });
      writeFileSync(FAIL_FILE, JSON.stringify(finalFailures, null, 2) + '\n', 'utf8');
    }
    // 只在有成功抓到的源时才写基线；全失败时一个字都不写，避免把空壳固化。
    if (Object.keys(next).length > 0 && (initWatchBaseline || !existsSync(BASE_FILE)
      || catalog.baselineCreated || Object.keys(base).length < watch.sources.length)) {
      mkdirSync(dirname(BASE_FILE), { recursive: true });
      writeFileSync(BASE_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
    }
  }
}

console.log('\n==== 指南更新巡检 ====');
console.log(
  `来源 ${urls.size} 个：无变化 ${same.length}，关键数字变了 ${changed.length}，仅版式变化 ${cosmetic.length}，` +
    `抓取失败 ${broken.length}，引用失效 ${quoteBroken.length}`,
);

if (catalog.truncated.length) {
  console.log('\n【疑似页面被截断 —— 正文比上次短了一半以上，先当抓坏了处理】');
  for (const t of catalog.truncated) {
    console.log(`· ${t.source}: ${t.baseChars} → ${t.nowChars} 字符  ${t.url}`);
  }
  console.log('处理：本轮沿用旧基线、不报警；下次还这样就人工看一眼是不是改版。');
}

if (catalog.longUnreachable.length) {
  console.log('\n【长期抓不到 —— 连续 3 周以上失败，官方源地位不变，但不指望它主动报信了】');
  for (const f of catalog.longUnreachable) {
    console.log(`· ${f.id}：连续 ${f.consecutiveFailures} 周失败`);
  }
  console.log('处理：周报里人工确认这家是否改版；有新指南会由 mirrorUrl（转载雷达）先兜底发现。');
}

if (quoteBroken.length) {
  console.log('\n【最要紧：引用失效 —— 我们引的那句在最新原文里已经找不到】');
  for (const b of quoteBroken) {
    console.log(`· ${b.ruleId}\n  「${b.quote.replace(/\s+/g, ' ').slice(0, 110)}」\n  来源：${b.url}`);
  }
  console.log('\n处理：先确认是正文改写了还是整页换了。改写了 → 更新 quote；换页了 → 换来源。');
}

if (changed.length) {
  console.log('\n【关键数字变了 —— 结论可能要跟着改】');
  for (const c of changed) {
    console.log(`\n· ${c.url}`);
    console.log(`  ${c.kind}`);
    console.log(`  影响规则：${c.usedBy.join('、')}`);
    if (c.numsAdded.length) console.log(`  新增数字：${c.numsAdded.join('、')}`);
    if (c.numsGone.length) console.log(`  消失数字：${c.numsGone.join('、')}`);
    for (const t of c.pick) console.log(`  + ${t.replace(/\s+/g, ' ').slice(0, 150)}`);
  }
  console.log('\n复核步骤：① 确认这几个数字是不是真的改了 ② 对应的 verdict/年龄/间隔要不要跟着改 ③ 改完跑 npm run validate ④ 快照 --force');
}

if (broken.length) {
  console.log('\n【抓不到，链接可能失效】');
  for (const b of broken) console.log(`· ${b.url}\n  ${b.error}\n  影响规则：${b.usedBy.join('、')}`);
}

// 版式变化不打扰人，只在末尾提一句，供需要时翻快照
if (cosmetic.length) {
  console.log(`\n（另有 ${cosmetic.length} 个来源只是版式/段落变了、关键数字没动：${cosmetic.map((c) => new URL(c.url).host).filter((v, i, a) => a.indexOf(v) === i).join('、')}）`);
}

if (catalog.sources) {
  console.log(`\n【发布方目录页】监控 ${catalog.sources} 个栏目：`);
  if (catalog.baselineCreated) console.log('· 首次运行 / 新增栏目：已记录标题基线，本次不报警。');
  if (catalog.newGuidelines.length) {
    console.log(`· 新出现 ${catalog.newGuidelines.length} 条线索（此前未覆盖，需人工确认是不是权威依据）：`);
    for (const g of catalog.newGuidelines.slice(0, 30)) console.log(`  + ${g.source}：${g.title.slice(0, 100)}\n    ${g.url}`);
  }
  if (catalog.broken.length) {
    console.log(`· ${catalog.broken.length} 个栏目没抓到（可能改版或网络问题，不代表依据失效）：`);
    for (const b of catalog.broken) console.log(`  - ${b.source} ${b.url}：${b.error}`);
  }
}

/* 年份岗哨的输出：漂移要亮红，抓取失败只记录（抓取失败走 broken 通道的意思） */
const sentinelOk = officialYears && Object.keys(officialYears).length;
if (sentinelCites.length) {
  console.log(`\n【年份岗哨】盯 ${new Set(sentinelCites.map((c) => c.key)).size} 个来源的现行版年份：`);
  if (yearDrift.length) {
    console.log(`· 年份漂移 ${yearDrift.length} 条（官网现行版 ≠ 我们标注，需要走升级核对）：`);
    for (const d of yearDrift) {
      console.log(`  ! ${d.ruleId}：我们标 ${d.citedYear}，官网现行 ${d.officialYear}（${d.direction}）\n    ${d.url}`);
    }
  } else if (sentinelOk) {
    console.log('· 全部来源的现行版年份与我们的标注一致。');
  }
  if (sentinelFails.length) {
    console.log(`· ${sentinelFails.length} 个年份源没抓到（不影响内容层巡检，下周再试）：`);
    for (const f of sentinelFails) console.log(`  - ${f.source} ${f.url}：${f.error}`);
  }
}

if (!changed.length && !broken.length && !quoteBroken.length && !yearDrift.length) {
  const quoteTotal = [...urls.values()].reduce((n, v) => n + v.quotes.length, 0);
  console.log(`\n全部来源的关键数字都没变，${quoteTotal} 句引用全部仍能在原文里找到，现行版年份全部一致。`);
}

if (jsonArg) {
  const report = {
    checkedAt: new Date().toISOString(),
    totals: {
      sources: urls.size, same: same.length, changed: changed.length,
      cosmetic: cosmetic.length, broken: broken.length, quoteBroken: quoteBroken.length,
      catalogSources: catalog.sources, newGuidelines: catalog.newGuidelines.length,
      yearDrift: yearDrift.length, sentinelFails: sentinelFails.length,
    },
    quoteBroken,
    changed,
    cosmetic,
    broken,
    catalogWatch: catalog,
    yearSentinel: { citations: sentinelCites.length, drift: yearDrift, fails: sentinelFails, officialYears },
  };
  const out = jsonArg === 'true' ? 'reports/updates.json' : jsonArg;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`\n机器可读报告已写入 ${out}`);
}

/* 心跳：巡检跑到这里=主体流程走完了，写时间戳。
 * 写在报告目录旁边，git 忽略（心跳是"最近一次成功"的活数据，不该进版本库）。
 * workflow 里的"心跳检查"步骤读它判断整套自动化是否静默死亡。 */
try {
  mkdirSync('reports', { recursive: true });
  writeFileSync('reports/heartbeat.json', JSON.stringify({
    lastOkAt: new Date().toISOString(),
    sources: urls.size,
    drift: yearDrift.length,
    broken: broken.length + sentinelFails.length,
  }, null, 2) + '\n', 'utf8');
} catch { /* 心跳写不进去不该让巡检本身失败 */ }

// 只有要动手的情况才亮红：引用失效、关键数字变了、来源抓不到、年份漂移。
// 单纯版式改版不算 —— 否则每周都亮红，人就不看了。
if (failOnChange && (quoteBroken.length || changed.length || broken.length || catalog.newGuidelines.length || yearDrift.length)) process.exit(2);
