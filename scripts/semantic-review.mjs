/* 语义复核（计划 3 第二层兜底之一）：把条款卡字段和原文引文交给"第二双眼睛"。
 *
 * 它回答的是校验器答不了的问题："population 写的人群，是不是真的能从原文推出来？"
 * 校验器查数字回读（数字在不在引文里），这里查语义方向（意思对不对）。
 *
 * 用法：
 *   node scripts/semantic-review.mjs            # 生成待复核清单 reports/semantic-review-pending.md
 *   SEMANTIC_LLM_URL=... SEMANTIC_LLM_KEY=... node scripts/semantic-review.mjs
 *                                               # 有 OpenAI 兼容端点时自动调用并写回结果
 *
 * 结果落盘 data/semantic-review.json：
 *   { "<ruleId>": { "verdict": "supported" | "unsupported" | "pending",
 *                   "reviewedAt": "YYYY-MM-DD", "by": "llm|human", "note": "..." } }
 *
 * 铁律（和 auto-apply 一致）：
 *   - 本脚本只写 data/semantic-review.json 和 reports/，绝不改 rules.json；
 *   - verdict=unsupported 不改规则，只在 validate 里以警告浮出，等人工定夺；
 *   - LLM 不可用就退化为"待复核清单"，闭环不中断。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const today = () => new Date().toISOString().slice(0, 10);

const rules = load('data/rules.json').rules.filter((r) => r.clause);
const reviewPath = join(root, 'data/semantic-review.json');
const review = existsSync(reviewPath) ? load('data/semantic-review.json') : {};

const buildPrompt = (r) => {
  const c = r.clause;
  const quotes = (r.evidence || []).flatMap((e) => (e.quotes || []).map((q) => `- [${e.org}] ${q}`));
  return [
    `规则 ${r.id}（${r.name}，${r.category} 档）的条款卡如下，请对照引文逐项判断。`,
    ``,
    `version: ${c.version}`,
    `population.include: ${JSON.stringify(c.population?.include || [], null, 2)}`,
    c.population?.exclude ? `population.exclude: ${JSON.stringify(c.population.exclude, null, 2)}` : '',
    `evidenceRole: ${c.evidenceRole}`,
    `conflictPolicy: ${c.conflictPolicy}`,
    `followup_path: ${c.followup_path}`,
    c.terminationCriteria ? `terminationCriteria: ${c.terminationCriteria}` : '',
    ``,
    `引文（全部来自已核对快照）：`,
    ...quotes,
    ``,
    `判断标准：`,
    `1. population 里每个人群/数字条件，是否能从引文直接推出（不能扩大也不能缩小）？`,
    `2. exclude 是否与引文一致？`,
    `3. followup_path 是否与引文中的随访/处理方向一致？`,
    ``,
    `只输出 JSON：{"verdict":"supported"|"unsupported","note":"一句话理由（中文）"}`,
  ].filter(Boolean).join('\n');
};

let changed = 0;
const API = process.env.SEMANTIC_LLM_URL;
const KEY = process.env.SEMANTIC_LLM_KEY;

if (API && KEY) {
  for (const r of rules) {
    const prev = review[r.id];
    if (prev && prev.verdict === 'supported' && prev.reviewedAt === today()) continue;
    try {
      const res = await fetch(`${API.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          messages: [{ role: 'user', content: buildPrompt(r) }],
          temperature: 0,
        }),
      });
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content || '';
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('LLM 未返回 JSON');
      const verdict = JSON.parse(m[0]);
      review[r.id] = {
        verdict: verdict.verdict === 'supported' ? 'supported' : 'unsupported',
        reviewedAt: today(),
        by: 'llm',
        note: String(verdict.note || '').slice(0, 300),
      };
      changed += 1;
      console.log(`  ${r.id}: ${review[r.id].verdict}`);
    } catch (e) {
      console.error(`  ${r.id}: LLM 复核失败（${String(e.message || e).slice(0, 80)}），保持待复核`);
    }
  }
} else {
  console.log('未配置 SEMANTIC_LLM_URL / SEMANTIC_LLM_KEY，生成本轮待复核清单。');
}

writeFileSync(reviewPath, JSON.stringify(review, null, 2) + '\n', 'utf8');

// 待复核清单：给"第二双眼睛"看的工单。没有 LLM 也能人肉/AI 会话补。
const pending = rules.filter((r) => !review[r.id] || review[r.id].verdict !== 'supported');
mkdirSync(join(root, 'reports'), { recursive: true });
writeFileSync(
  join(root, 'reports/semantic-review-pending.md'),
  ['# 条款卡语义复核工单', '', `生成时间：${today()}`, pending.length ? '' : '（当前没有待复核项）',
    ...pending.map((r) => `\n---\n\n${buildPrompt(r)}`),
  ].join('\n'),
  'utf8',
);
console.log(`条款卡 ${rules.length} 条；本轮更新 ${changed} 条；待复核 ${pending.length} 条`);
console.log('工单：reports/semantic-review-pending.md；结果：data/semantic-review.json');
