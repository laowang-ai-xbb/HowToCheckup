#!/usr/bin/env node
/**
 * 证据引文核对：每条主张必须能在自己那份原文快照里找到。
 *
 * 为什么要有这个：这些条目在页面上挂了三轮「待证据」，我每次都只写"下轮给表"。
 * 一旦我开始"凭记忆写结论"，就分不清哪句是真从文件里来的、哪句是我觉得应该是对的。
 * 这个脚本把 data/research/r1-r3.json 里每条 quote 拿去对应快照里做连续匹配：
 *   - HTML 快照：先剥标签、去 &nbsp;、把连续空白压成一个空格
 *   - PDF 抽出来的 txt：去掉所有空白再比（PDF 会在词中间断行）
 * 找不到就报错，不许"差不多"。
 *
 * 用法：node scripts/check-research.mjs
 */
import { readFileSync, existsSync } from 'node:fs';

const doc = JSON.parse(readFileSync('data/research/r1-r3.json', 'utf8'));
/**
 * 归一化只做两件事：HTML 快照剥标签、所有空白一律删掉。
 * 删空白是必须的 —— PDF 会在词中间断行（"不超\n过80g"），HTML 里还有 &nbsp;。
 * 剥标签**只能对 HTML 做**：PDF 抽出来的文本里有 "<22.0" 这种比较符号，
 * 按标签切会把后面一大段正文一起吃掉，造成"引文找不到"的假红。
 */
const norm = (s, isHtml) => {
  let t = s;
  if (isHtml) {
    t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;/g, ' ')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }
  return t.replace(/\s+/g, '');
};

let bad = 0;
for (const [id, it] of Object.entries(doc.items)) {
  if (!existsSync(it.snapshot)) { console.log(`FAIL ${id} 快照不存在：${it.snapshot}`); bad++; continue; }
  const raw = readFileSync(it.snapshot, 'utf8');
  const isHtml = /\.html?$/i.test(it.snapshot);
  const hay = norm(raw, isHtml);
  const needle = norm(it.quote, false);
  const hit = hay.includes(needle);
  console.log(`${hit ? 'ok  ' : 'FAIL'} ${id} — ${it.topic}${hit ? '' : '（引文在快照里找不到，可能是记错或改过原文）'}`);
  if (!hit) bad++;
}

const n = Object.keys(doc.items).length;
console.log(`\n${n - bad}/${n} 条引文在原文里逐字可查`);
process.exit(bad ? 1 : 0);
