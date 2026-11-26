// SPDX-License-Identifier: MIT
// Copyright (c) 2026 老王AI瞎bb
// See LICENSE at the repository root.

/**
 * 文案守卫：验"这句话人能不能读懂"，补上 validate 只验字段的缺口。
 *
 * 为什么需要这一层（2026-11-25 老板指出两处读不通的文案后加的）：
 *   之前所有测试只检查"字段有没有登记、枚举对不对、链接打不打得开"。
 *   于是下面这些话一路混到用户眼前，测试全绿：
 *     · 「最近按间隔做过了吗」—— 把内部字段 skipIfDoneWithin 的说法端上了界面；
 *     · 「内镜无异常者…累及全胃或低级别上皮内瘤变」—— 把指南病理分层原文塞进"我该多久做一次"；
 *     · 「它会让清单提醒你…」—— 答题时用户还没见到清单，这句话在解释产品机制；
 *     · 多选题写了 sub 时间窗口，但渲染层只认 l —— 写了等于没写。
 *   这些都不是错别字，是**视角错误**：站在数据和指南那边说话，而不是站在用户这边。
 *   人眼走查抓得到，但会漏；所以把已发现的教训钉成机器规则。
 *
 * 覆盖范围：所有会显示给用户看的文案字段。代码注释不进范围（那是写给维护者看的）。
 */

import { readFileSync } from 'node:fs';
import { questions } from '../src/questions.js';
import { mindCopies } from '../src/mind.js';

const rules = JSON.parse(readFileSync('data/rules.json', 'utf8')).rules;

let bad = 0;
const flag = (where, text, why) => {
  bad += 1;
  console.log(`FAIL ${where}：${why}\n      「${String(text).slice(0, 90)}」`);
};
const check = (name, ok, detail = '') => {
  if (ok) console.log(`ok  ${name}`);
  else flag(name, detail || '(无)', '断言未通过');
};

/* ---- 收集用户可见文案 ----
 * audit=true 的是依据页：那里本来就在讲指南原文和我们的取口径理由，
 * 允许「本工具」「病理分层」这类审计语；结果页和问卷不允许。
 * 两层混在一起查会误伤依据页，所以分开标。 */
const copies = [];
const add = (where, text, audit = false) => {
  if (typeof text === 'string' && text.trim()) copies.push({ where, text, audit });
};

// 心情小问卷（P3）：敏感模块的文案更要过守卫
for (const c of mindCopies()) add('心情小问卷', c);

for (const q of questions) {
  add(`题「${q.key}」题干`, q.title);
  add(`题「${q.key}」提示`, q.hint);
  add(`题「${q.key}」都没有按钮`, q.noneLabel);
  add(`题「${q.key}」记不清按钮`, q.unknownLabel);
  for (const o of q.options || []) add(`题「${q.key}」选项 ${o.v}`, o.l);
}
for (const r of rules) {
  add(`规则「${r.id}」结论`, r.verdict);
  add(`规则「${r.id}」理由`, r.reason);
  if (r.whyYou) add(`规则「${r.id}」为什么列给你`, r.whyYou);
  add(`规则「${r.id}」能查出什么`, r.whatItFinds);
  if (r.askDoctor) add(`规则「${r.id}」问医生`, r.askDoctor);
  add(`规则「${r.id}」频率`, r.frequency?.text);
  (r.redFlags || []).forEach((x, i) => add(`规则「${r.id}」红旗${i + 1}`, x));
  (r.tellDoctor || []).forEach((x, i) => add(`规则「${r.id}」先说一声${i + 1}`, x));
  (r.evidence || []).forEach((e, i) => add(`规则「${r.id}」依据${i + 1}要点`, e.point, true));
}

/* ---- 规则一：内部词不许出现在用户文案里 ----
 * 这些都是我们脑子里的词（数据字段、判定口径、写作口吻），用户从没听过。
 * 出现即说明写文案时站在系统那边了。 */
const BANNED = [
  [/按间隔/, '内部词「按间隔」——用户不知道间隔是什么，应该说清多久'],
  [/skipIfDoneWithin|informationalOnly|intentionalNoRule/, '内部字段名漏到界面'],
  [/本工具/, '内部视角——应直接说"这份清单"或不提'],
  [/口径差异|有意的偏保守/, '内部写作口吻——用户不关心我们怎么取舍'],
  [/A\s*档|B\s*档|C\s*档/, '内部分档名——界面上是「必做/看你的情况/不用做」'],
  [/它会让清单|它会在清单/, '解释产品机制——用户此时还没看到清单'],
];
for (const { where, text, audit } of copies.filter((c) => !c.audit)) {
  for (const [re, why] of BANNED) if (re.test(text)) flag(where, text, why);
}

/* ---- 规则二：指南原文里的病理术语不许直接当频率建议 ----
 * 「内镜无异常 / 累及全胃 / 上皮内瘤变」是病理报告的话。
 * 用户要的是"我多久做一次"，分层细节属于依据页，不属于结果页卡片。 */
const PATHOLOGY = [
  [/内镜无异常/, '病理术语「内镜无异常」——应写「这次检查没发现问题」'],
  [/累及全胃/, '病理术语「累及全胃」——应写「范围较大」'],
  [/上皮内瘤变/, '病理术语「上皮内瘤变」——报告上怎么写就照抄，别替医生归类'],
  [/预期不能耐受/, '指南术语「预期不能耐受根治治疗」——应写「身体情况扛不住手术」'],
  [/首选筛查者/, '读不通——应写「不愿意或没能做肠镜的人」'],
];
for (const { where, text, audit } of copies.filter((c) => !c.audit)) {
  for (const [re, why] of PATHOLOGY) if (re.test(text)) flag(where, text, why);
}

/* ---- 规则三：术语第一次出现必须带解释 ----
 * 这是 questions.js 文件头写了很久的规矩，但一直只靠自觉。这里落地。
 * 判定：某术语只要出现在任一用户文案里，全部文案中就必须能找到它的解释词。 */
const TERMS = [
  /* 问卷里已经换成大白话（乳腺 X 光 / 宫颈刮片 / 抽血），但规则页和依据页还有旧词，
   * 所以守卫继续认这些词：只要出现就得带解释，不许裸奔。 */
  { term: /钼靶/, explain: /X\s*光|乳腺\s*X/, name: '钼靶' },
  { term: /TCT/, explain: /刮片/, name: 'TCT' },
  { term: /HPV/, explain: /人乳头瘤病毒|刮片/, name: 'HPV' },
  { term: /HbA1c/, explain: /糖化血红蛋白/, name: 'HbA1c' },
  { term: /PSA/, explain: /前列腺/, name: 'PSA' },
  { term: /BRCA/, explain: /基因检测|突变/, name: 'BRCA' },
  { term: /甲胎蛋白/, explain: /抽血/, name: '甲胎蛋白' },
  { term: /假阴性/, explain: /查不出来|测不出/, name: '假阴性' },
];
const all = copies.map((c) => c.text).join('\n');
for (const { term, explain, name } of TERMS) {
  if (!term.test(all)) continue;
  if (!explain.test(all)) flag('全站文案', name, `术语「${name}」出现但没有解释——第一次出现要顺手解释`);
}

/* ---- 规则四：结果页频率必须自解释 ----
 * 上一条是"全站有解释就行"，但用户可能只看那一张卡，不翻别处。
 * 所以频率这一栏单独从严：卡里出现术语，卡里就得有解释。 */
for (const { where, text } of copies.filter((c) => c.where.endsWith('频率'))) {
  for (const { term, explain, name } of TERMS) {
    if (term.test(text) && !explain.test(text)) {
      flag(where, text, `结果页频率里的「${name}」在本条内没有解释，用户可能只看到这一句`);
    }
  }
}

/* ---- 规则五：多选题的 sub 是死数据 ----
 * main.js 的 multi 分支只渲染 o.l，不渲染 o.sub。
 * 给多选题写 sub 会让作者以为"我写清楚时间窗口了"，实际用户啥也没看到。 */
for (const q of questions) {
  if (q.kind !== 'multi') continue;
  for (const o of q.options || []) {
    if (o.sub) flag(`题「${q.key}」选项 ${o.v}`, o.sub, '多选题不渲染 sub——请把说明写进 l，或改渲染层');
  }
  /* 同理：用户还没勾选时，"这项/该检查"没有先行词，读起来不知指什么 */
  for (const field of ['title', 'hint']) {
    if (/这项|该检查|这一项/.test(q[field] || '')) {
      flag(`题「${q.key}」${field}`, q[field], '多选未勾选时「这项」没有先行词');
    }
  }
}

/* ---- 规则六：常见错别字（只放高置信度的，宁可少拦不可误伤） ---- */
const TYPOS = [
  [/症壮/, '应为「症状」'],
  [/捡查/, '应为「检查」'],
  [/复察/, '应为「复查」'],
  [/推存/, '应为「推荐」'],
  [/以经/, '应为「已经」'],
  [/既使/, '应为「即使」'],
];
for (const { where, text } of copies) {
  for (const [re, why] of TYPOS) if (re.test(text)) flag(where, text, `错别字：${why}`);
}

/* ---- 自检：拿老板真实指出过的坏文案喂一遍 ----
 * 守卫自己也得被守着：哪天有人把规则删了、改宽了，这里会先红。 */
const SELFTEST = [
  ['下面这些检查，最近按间隔做过了吗？', BANNED],
  ['它会让清单提醒你「这项刚做过」', BANNED],
  ['内镜无异常者每 5 年 1 次；累及全胃或低级别上皮内瘤变 1 年', PATHOLOGY],
  ['明确不推荐预期不能耐受根治治疗者参加筛查', PATHOLOGY],
];
for (const [text, rules] of SELFTEST) {
  check(`自检能拦住「${text.slice(0, 12)}…」`, rules.some(([re]) => re.test(text)));
}

/* ---- 收尾 ---- */
check('用户文案已扫描', copies.length > 100, `${copies.length} 条`);
if (bad) {
  console.log(`\n文案守卫：${bad} 处需要修`);
  process.exit(1);
}
console.log(`\n文案守卫：${copies.length} 条用户文案全部通过`);
