/**
 * 证据快照：把每条依据指向的原文抓下来，存成纯文本放进仓库。
 *
 * 为什么必须做这件事：
 * 页面上写「依据 USPSTF」+ 一个链接，看起来很像有依据，但链接会烂、页面会改、
 * 也可能一开始就引错了。存一份原文文本，才能做到：
 *   1) 规则里引用的那句话，机器能验证它真的在原文里（防编造/防记错）；
 *   2) 规则里的数字（起始年龄、间隔年数）能在原文里搜到（防改了规则没改证据）；
 *   3) 定期重抓、跟仓库里的旧文本 diff，就知道指南改没改（check-updates.mjs）。
 *
 * 输出：
 *   data/snapshots/<hash>.txt   原文纯文本（PDF / docx 先转文本）
 *   data/snapshots/_index.json  每个 URL 的抓取时间、sha256、字数、失败原因
 *
 * 用法：
 *   node scripts/snapshot-sources.mjs            # 只抓还没抓过的
 *   node scripts/snapshot-sources.mjs --force    # 全部重抓
 *   node scripts/snapshot-sources.mjs --only=uspreventive
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fetchSource, sha, shortHash } from './lib/source-fetch.mjs';

const DIR = 'data/snapshots';
const INDEX = join(DIR, '_index.json');
const force = process.argv.includes('--force');
const onlyArg = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';

const rulesDoc = JSON.parse(readFileSync('data/rules.json', 'utf8'));
const list = rulesDoc.rules || rulesDoc;

/** 去重收集所有来源 URL（顺手记下谁在用它，方便报告） */
const urls = new Map();
for (const rule of list) {
  for (const ev of rule.evidence || []) {
    if (!ev.url) continue;
    if (onlyArg && !ev.url.includes(onlyArg)) continue;
    if (!urls.has(ev.url)) urls.set(ev.url, []);
    urls.get(ev.url).push(rule.id);
  }
}

/* where.json 里的「去哪一栏」出处也要存快照：科室那一栏同样要能逐字核，
 * 否则它就成了全站唯一一句"说了但查不到原文"的话。usedBy 记成 where:* 好认。 */
const whereDoc = (() => {
  try { return JSON.parse(readFileSync('data/where.json', 'utf8')); } catch { return null; }
})();
for (const s of whereDoc?.sources || []) {
  if (!s.url) continue;
  if (onlyArg && !s.url.includes(onlyArg)) continue;
  if (!urls.has(s.url)) urls.set(s.url, []);
  urls.get(s.url).push(`where:${s.org.slice(0, 12)}`);
}

mkdirSync(DIR, { recursive: true });
const index = existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, 'utf8')) : {};

let ok = 0;
let fail = 0;
let skip = 0;

for (const [url, usedBy] of urls) {
  const file = `${DIR}/${shortHash(url)}.txt`;
  if (!force && existsSync(file)) {
    skip += 1;
    console.log('skip  ' + url.slice(0, 90));
    continue;
  }
  try {
    const { text, contentType } = await fetchSource(url);
    writeFileSync(file, text, 'utf8');
    index[url] = {
      file,
      fetchedAt: new Date().toISOString().slice(0, 10),
      sha256: sha(text),
      chars: text.length,
      contentType,
      usedBy: [...new Set(usedBy)],
    };
    ok += 1;
    console.log(`ok    ${String(text.length).padStart(7)} 字  ${url.slice(0, 80)}`);
  } catch (e) {
    index[url] = {
      file: null,
      fetchedAt: new Date().toISOString().slice(0, 10),
      error: String(e.message || e).slice(0, 160),
      usedBy: [...new Set(usedBy)],
    };
    fail += 1;
    console.log(`FAIL  ${e.message}  ${url.slice(0, 80)}`);
  }
}

writeFileSync(INDEX, JSON.stringify(index, null, 2) + '\n', 'utf8');

// 首页级别的快照（只有导航、没有正文）挑出来：这类"依据"等于没有依据
const thin = Object.entries(index).filter(([, v]) => v.chars !== undefined && v.chars < 800);
console.log(`\n抓取 ${ok} 成功 / ${fail} 失败 / ${skip} 跳过`);
if (thin.length) {
  console.log('正文过短（多半只抓到首页，需要换成单篇全文链接）：');
  for (const [u, v] of thin) console.log(`  ${String(v.chars).padStart(5)} 字  ${u}`);
}
