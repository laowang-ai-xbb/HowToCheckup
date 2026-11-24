/**
 * 把 data/evidence-patch.json 合并进 data/rules.json。
 *
 * 关键点：每句 quote 都必须能在对应的原文快照里逐字找到，否则整个脚本失败、不写文件。
 * 这样"引用"就不可能凭空编出来 —— 编了就过不了这一关。
 *
 * 用法：node scripts/apply-evidence.mjs [--dry]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { squash } from './lib/source-fetch.mjs';

const DRY = process.argv.includes('--dry');
const INDEX = 'data/snapshots/_index.json';

const rulesDoc = JSON.parse(readFileSync('data/rules.json', 'utf8'));
const rules = rulesDoc.rules || rulesDoc;
const patch = JSON.parse(readFileSync('data/evidence-patch.json', 'utf8'));
const index = existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, 'utf8')) : {};

const snapText = (url) => {
  const rec = index[url];
  if (!rec || !rec.file || !existsSync(rec.file)) return null;
  return squash(readFileSync(rec.file, 'utf8'));
};

/** 从 grade 文本能直接看出的推荐方向，先自动补上；看不出的留空等人判断 */
const autoStrength = (grade = '') => {
  const g = grade.toUpperCase();
  if (/USPSTF[- ]?D|（不推荐）|USPSTF\s*D/.test(g) || /不推荐/.test(grade)) return 'against';
  if (/USPSTF[- ]?I\b/.test(g) || /证据不足/.test(grade)) return 'insufficient';
  if (/USPSTF[- ]?C|USPSTF-C\/D/.test(g)) return 'conditional';
  if (/USPSTF[- ]?[AB]\b|USPSTF-A|USPSTF-B/.test(g)) return 'strong';
  if (/^IA$/.test(g) || /推荐\s*A/.test(grade) || /强推荐/.test(grade)) return 'strong';
  return null;
};

const errors = [];
const applied = [];

for (const [ruleId, byIndex] of Object.entries(patch)) {
  if (ruleId.startsWith('_')) continue;
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) {
    errors.push(`找不到规则 ${ruleId}`);
    continue;
  }
  for (const [idxStr, fields] of Object.entries(byIndex)) {
    // append：这一批新补的证据条目（整条新写，不是改已有的）
    if (idxStr === 'append') {
      for (const entry of fields) {
        const next = { ...entry };
        if (Array.isArray(entry.urlFrom)) {
          const [fromRuleId, fromIdx] = entry.urlFrom;
          const fromRule = rules.find((r) => r.id === fromRuleId);
          const fromEv = fromRule && (fromRule.evidence || [])[fromIdx];
          if (!fromEv) {
            errors.push(`${ruleId} append urlFrom 指向的证据不存在：${fromRuleId}[${fromIdx}]`);
            continue;
          }
          next.url = fromEv.url;
          delete next.urlFrom;
        }
        const text = snapText(next.url);
        if (!text) {
          errors.push(`${ruleId} append 没有原文快照（url=${next.url}）`);
          continue;
        }
        for (const q of next.quotes || []) {
          if (!text.includes(squash(q))) errors.push(`${ruleId} append 引用在原文里找不到：${q.slice(0, 60)}…`);
        }
        rule.evidence = rule.evidence || [];
        const dup = rule.evidence.findIndex((e) => e.url === next.url && e.org === next.org);
        if (dup >= 0) {
          rule.evidence[dup] = { ...rule.evidence[dup], ...next };
          applied.push(`${ruleId}[${dup}]（append 覆盖）`);
        } else {
          rule.evidence.push(next);
          applied.push(`${ruleId}[${rule.evidence.length - 1}]（append）`);
        }
      }
      continue;
    }
    const i = Number(idxStr);
    const ev = (rule.evidence || [])[i];
    if (!ev) {
      errors.push(`${ruleId} 没有第 ${i} 条证据`);
      continue;
    }
    const next = { ...ev, ...fields };
    // urlFrom："这条证据指的是同一份文件，链接照抄那条"，避免把长 URL 手抄进补丁抄错
    if (Array.isArray(fields.urlFrom)) {
      const [fromRuleId, fromIdx] = fields.urlFrom;
      const fromRule = rules.find((r) => r.id === fromRuleId);
      const fromEv = fromRule && (fromRule.evidence || [])[fromIdx];
      if (!fromEv) {
        errors.push(`${ruleId}[${i}] urlFrom 指向的证据不存在：${fromRuleId}[${fromIdx}]`);
        continue;
      }
      next.url = fromEv.url;
      delete next.urlFrom;
    }
    // 校验引用是否真的在原文里
    const text = snapText(next.url);
    if (Array.isArray(fields.quotes) && fields.quotes.length) {
      if (!text) {
        errors.push(`${ruleId}[${i}] 没有原文快照，无法校验引用（url=${next.url}）`);
      } else {
        for (const q of fields.quotes) {
          if (!text.includes(squash(q))) {
            errors.push(`${ruleId}[${i}] 引用在原文里找不到：${q.slice(0, 60)}…`);
          }
        }
      }
    }
    Object.assign(ev, next);
    applied.push(`${ruleId}[${i}]`);
  }
}

// 补齐所有证据的 strength（能看出来的）
let filled = 0;
for (const rule of rules) {
  for (const ev of rule.evidence || []) {
    if (ev.absence) { delete ev.strength; continue; }   // 反向证明不套四档标签
    if (!ev.strength) {
      const s = autoStrength(ev.grade);
      if (s) {
        ev.strength = s;
        filled += 1;
      }
    }
  }
}

if (errors.length) {
  console.error('合并失败，没有写入任何文件：\n' + errors.map((e) => '  - ' + e).join('\n'));
  process.exit(1);
}

const withQuote = rules.flatMap((r) => (r.evidence || []).filter((e) => (e.quotes || []).length)).length;
const total = rules.flatMap((r) => r.evidence || []).length;

console.log(`已合并 ${applied.length} 条证据补丁，自动补 strength ${filled} 条`);
console.log(`有原文摘录的证据：${withQuote} / ${total}`);
if (DRY) {
  console.log('（--dry：不写文件）');
} else {
  rulesDoc.rules = rules;
  writeFileSync('data/rules.json', JSON.stringify(rulesDoc, null, 2) + '\n', 'utf8');
  console.log('data/rules.json 已更新');
}
