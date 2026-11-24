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
 * 都会冒出一堆"新标题"，几周后没人再看 —— 那等于没接。 */
const WATCH_FILE = 'data/guideline-watch.json';
const BASE_FILE = 'data/snapshots/_watch-baseline.json';
const catalog = { sources: 0, newGuidelines: [], broken: [], baselineCreated: false };
{
  let watch = null;
  try { watch = JSON.parse(readFileSync(WATCH_FILE, 'utf8')); } catch { /* 没有配置文件就只跑老巡检 */ }
  if (watch?.sources?.length) {
    let base = {};
    try { base = JSON.parse(readFileSync(BASE_FILE, 'utf8')); } catch { /* 首次运行 */ }
    const next = {};
    for (const src of watch.sources) {
      catalog.sources++;
      try {
        const { text } = await fetchSource(src.url);
        const snap = snapshotOf(src.id, src.url, text, src.keywords);
        next[src.id] = snap;
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
        catalog.broken.push({ source: src.org, url: src.url, error: errText });
      }
      process.stdout.write('o');
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

if (!changed.length && !broken.length && !quoteBroken.length) {
  const quoteTotal = [...urls.values()].reduce((n, v) => n + v.quotes.length, 0);
  console.log(`\n全部来源的关键数字都没变，${quoteTotal} 句引用全部仍能在原文里找到。`);
}

if (jsonArg) {
  const report = {
    checkedAt: new Date().toISOString(),
    totals: {
      sources: urls.size, same: same.length, changed: changed.length,
      cosmetic: cosmetic.length, broken: broken.length, quoteBroken: quoteBroken.length,
      catalogSources: catalog.sources, newGuidelines: catalog.newGuidelines.length,
    },
    quoteBroken,
    changed,
    cosmetic,
    broken,
    catalogWatch: catalog,
  };
  const out = jsonArg === 'true' ? 'reports/updates.json' : jsonArg;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`\n机器可读报告已写入 ${out}`);
}

// 只有要动手的三种情况才亮红：引用失效、关键数字变了、来源抓不到。
// 单纯版式改版不算 —— 否则每周都亮红，人就不看了。
if (failOnChange && (quoteBroken.length || changed.length || broken.length || catalog.newGuidelines.length)) process.exit(2);
