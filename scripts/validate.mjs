#!/usr/bin/env node
/**
 * 体检项目指南 · 规则校验器
 *
 * 解决的根本问题：文档是自然语言，缺失内容不可见；
 * 本脚本把"漏"变成可执行检查——断链、缺字段、漏项、重复、证据不全、年龄断档，全部机器报错。
 *
 * 用法：node scripts/validate.mjs
 * 退出码：0 = 通过（可能有警告）；1 = 有错误必须修
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { match } from './lib/match.mjs';
import { squash } from './lib/source-fetch.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// --rules 支持绝对路径（负例测试传临时文件）；相对路径一律相对仓库根。
const load = (p) => JSON.parse(readFileSync(/^([A-Za-z]:[/\\]|\/)/.test(p) ? p : join(root, p), 'utf8'));

// --rules <path>：用一份临时规则文件跑同样的检查（对抗负例测试靠它：
// 故意填错一个字段，校验器必须报错才算有效——校验器自己也得被测）。
const rulesArgIdx = process.argv.indexOf('--rules');
const RULES_PATH = rulesArgIdx >= 0 ? process.argv[rulesArgIdx + 1] : 'data/rules.json';

const inputs = load('data/inputs.schema.json');
const catalog = load('data/catalog.json');
const rulesFile = load(RULES_PATH);
const rulesSchema = load('data/rules.schema.json');

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);
const notes = [];
const note = (m) => notes.push(m);   // 已经定过案、不算欠账的事，仍然每次念一遍
/** 人工已判断过、并在 rules.json 里写了理由的数字，不再重复告警（避免警示疲劳） */
const acked = [];

const OPERATORS = new Set(['ageMin', 'ageMax', 'gender', 'any', 'all', 'none']);
const inputFields = new Set(Object.keys(inputs.fields));
const catalogIds = new Set(catalog.items.map((i) => i.id));
const TOPICS = new Set(rulesSchema.topics || []);

// 反向断链检测用：记录每条规则真正用到哪些字段、哪些枚举值
const usedFields = new Set();
const usedValues = new Map(); // field -> Set(values)
const collectValues = (field, v) => {
  if (!usedValues.has(field)) usedValues.set(field, new Set());
  const set = usedValues.get(field);
  const push = (x) => { if (typeof x === 'string' || typeof x === 'number') set.add(x); };
  if (Array.isArray(v)) v.forEach(push);
  else if (v && typeof v === 'object') {
    for (const [op, val] of Object.entries(v)) {
      if (!['gte', 'gt', 'lte', 'lt', 'eq', 'in'].includes(op)) continue;
      // gte/gt/lte/lt 针对数字或年龄，不做值域比对
      if (op === 'eq' || op === 'in') (Array.isArray(val) ? val : [val]).forEach(push);
    }
  } else push(v);
};

// 1. 结构必填
const REQUIRED = ['id', 'name', 'category', 'catalogIds', 'topics', 'when', 'verdict', 'reason', 'whatItFinds', 'frequency', 'evidence'];
const EVIDENCE_REQUIRED = ['org', 'year', 'point', 'url', 'status', 'grade'];
const ids = new Set();

const checkWhen = (when, ruleId, path = 'when') => {
  if (typeof when !== 'object' || when === null) return err(`[${ruleId}] ${path} 必须是对象`);
  for (const [k, v] of Object.entries(when)) {
    if (OPERATORS.has(k)) {
      // ageMin/ageMax 直接作用于 age（实岁，不再做档位映射）
      if (k === 'ageMin' || k === 'ageMax') {
        usedFields.add('age');
        if (typeof v !== 'number') err(`[${ruleId}] ${path}.${k} 必须是数字`);
      }
      // gender 是"字段名恰好和操作符同级"的特例：不递归，但值必须收集，
      // 否则 when.gender 打错字（women）不会被 1.55 的值域检查发现。
      if (k === 'gender') { usedFields.add('gender'); collectValues('gender', v); }
      if (['any', 'all', 'none'].includes(k)) {
        if (!Array.isArray(v)) err(`[${ruleId}] ${path}.${k} 必须是数组`);
        else v.forEach((cond, i) => checkWhen(cond, ruleId, `${path}.${k}[${i}]`));
      }
      continue;
    }
    // 字段引用必须存在于 inputs.schema.json —— 防"职业暴露"式断链
    if (!inputFields.has(k)) err(`[${ruleId}] ${path} 引用了未定义的输入字段 "${k}"（inputs.schema.json 中不存在）`);
    else {
      usedFields.add(k);
      collectValues(k, v);
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        const allowed = new Set(['gte', 'gt', 'lte', 'lt', 'eq', 'in']);
        for (const op of Object.keys(v)) if (!allowed.has(op)) err(`[${ruleId}] ${path}.${k} 使用了未知操作符 "${op}"`);
      }
    }
  }
};

for (const r of rulesFile.rules) {
  const tag = r.id || '(无 id)';
  for (const f of REQUIRED) if (r[f] === undefined) err(`[${tag}] 缺少必填字段 ${f}`);
  if (ids.has(r.id)) err(`[${tag}] 规则 id 重复`);
  ids.add(r.id);
  if (!/^[a-z0-9-]+$/.test(r.id || '')) err(`[${tag}] id 只能包含小写字母、数字、连字符`);
  if (!['A', 'B', 'C'].includes(r.category)) err(`[${tag}] category 必须是 A/B/C`);

  // catalog 引用必须存在
  for (const cid of r.catalogIds || []) if (!catalogIds.has(cid)) err(`[${tag}] catalogIds 引用了不存在的项目 "${cid}"`);

  // topics 必须是登记过的枚举（否则页面分组会散架）
  if (!Array.isArray(r.topics) || r.topics.length === 0) err(`[${tag}] topics 必须是非空数组`);
  for (const t of r.topics || []) if (!TOPICS.has(t)) err(`[${tag}] topics 含未登记的标签 "${t}"（请先在 rules.schema.json 的 topics 中登记）`);

  // decisionType（老板 2026-11-25 P1-6）：每张卡都要说清"这是预防/筛查/复查哪类事"。
  // 它和 A/B/C 正交，不参与判定，但漏标卡片就没标签，所以设为必填、枚举锁死。
  if (!['prevent', 'screen', 'follow'].includes(r.decisionType))
    err(`[${tag}] decisionType 必须是 prevent / screen / follow 之一（预防/筛查/复查）`);

  // when 条件字段校验
  checkWhen(r.when, tag);

  // 频率类型
  if (!r.frequency || !['once', 'interval'].includes(r.frequency.type)) err(`[${tag}] frequency.type 必须是 once 或 interval`);
  if (r.frequency && r.frequency.type === 'once' && r.frequency.years && r.frequency.years > 0)
    warn(`[${tag}] 一次性项目却填了 years=${r.frequency.years}，请确认`);

  // 证据完整性与状态
  if (!Array.isArray(r.evidence) || r.evidence.length === 0) err(`[${tag}] 至少需要 1 条证据`);
  for (const [i, e] of (r.evidence || []).entries()) {
    for (const f of EVIDENCE_REQUIRED) if (!e[f]) err(`[${tag}] evidence[${i}] 缺少 ${f}`);
    if (!['verified', 'pending', 'stale'].includes(e.status)) err(`[${tag}] evidence[${i}].status 必须是 verified/pending/stale`);
    if (e.url && !/^https?:\/\//.test(e.url)) err(`[${tag}] evidence[${i}].url 必须以 http(s):// 开头`);
    if (e.status === 'stale') warn(`[${tag}] evidence[${i}] 已标记过期，建议复核`);
    /* 强度标签防漏（2026-11-27 老板走查发现 16 条中文指南依据漏标，页面上全是灰色"见原文"）：
     * verified 的证据必须给出 strength，除非是 absence（"权威清单里没有它"的反向证明，
     * 本来就不套四档标签）或 status=pending（还没核过，标"待核实"）。
     * strength 枚举与 src/evfmt.js 的 ST 词表一致。 */
    if (e.status === 'verified' && !e.strength && !e.absence) {
      err(`[${tag}] evidence[${i}]（${e.org}）verified 但缺 strength —— 结果页会显示兜底"见原文"。可选：strong/conditional/against/insufficient`);
    }
    if (e.strength && !['strong', 'conditional', 'against', 'insufficient', 'guide', 'consensus', 'standard', 'norm'].includes(e.strength)) {
      err(`[${tag}] evidence[${i}].strength "${e.strength}" 不在词表里（strong/conditional/against/insufficient/guide/consensus/standard/norm）`);
    }
  }
  /* 同一份文件只能占一条证据：拆成多条后，结果页四列表（谁/文件/强度/原文）
   * 看起来就是几行一模一样的东西，老板 2026-11-22 走查洁牙时发现的。
   * 不同角度的引文并进同一条的 quotes 里，不要另起一条 —— 报错拦在这里。 */
  const srcKeys = new Map();
  for (const e of (r.evidence || [])) {
    const k = [e.org, e.year || '', e.url || ''].join('|');
    if (srcKeys.has(k)) err(`[${tag}] 证据重复出处：「${e.org}」被拆成多条，应并进同一条的 quotes`);
    srcKeys.set(k, true);
  }

  // C 档必须给 redFlags 或 notes 说明（防"不用做"被误读为"不用管"）
  if (r.category === 'C' && !(r.redFlags?.length) && !r.notes)
    warn(`[${tag}] C 档规则缺少 redFlags/notes 提示`);
}

// 1.5 反向断链检查：用户能选的，必须有人响应
//     字段被选但没有任何规则使用 = 用户白填，属于静默失效
//
//     例外：只用于「转诊卡」的三个字段（跌倒史 / 起身要扶 / 记性）。
//     它们不进 A/B/C 档，因为跌倒不是"检查项目"，是"该看哪个科"的问题。
//     但"白填"的风险一样存在 —— 所以这里不放行它们，而是让 referral.js 显式登记，
//     由下面的 REFERRAL_FIELDS 检查兜住"登记了却没人用"。
const REFERRAL_FIELDS = (() => {
  try {
    // 同步读源码即可：这里只需要那份字符串清单，不需要执行整模块
    const src = readFileSync(new URL('../src/referral.js', import.meta.url), 'utf8');
    const m = src.match(/REFERRAL_FIELDS\s*=\s*\[([^\]]+)\]/);
    return m ? m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean) : [];
  } catch {
    return [];
  }
})();

const deadFields = [];
const deadValues = [];
for (const [name, def] of Object.entries(inputs.fields)) {
  if (def.informationalOnly) continue; // 明确只做页面提示、不改变档位
  if (!usedFields.has(name)) {
    if (REFERRAL_FIELDS.includes(name)) continue; // 由转诊卡消费，见 src/referral.js
    if (def.required) err(`输入字段 "${name}" 是必填项，但没有任何规则使用它`);
    else deadFields.push(name);
    continue;
  }
  // 多选型"风险因素"（家族史、既往病史）：每个勾选项都应有对应规则响应，
  // 否则用户勾了"家族史：结直肠癌"但结论毫无变化 —— 静默失效。
  // 单选型（吸烟=否、饮酒=无）不查：阴性值不触发规则是正确的语义。
  if (def.type !== 'array') continue;
  const used = usedValues.get(name) || new Set();
  /* 有意不响应的值：写在 schema 的 intentionalNoRule 里，必须带一句为什么。
   * 这条口子不是为了把红灯刷绿 —— 它每次都会把理由念一遍，只是不再算"欠账"。
   * 没写理由的不放行。 */
  const exempt = new Set((def.intentionalNoRule && def.intentionalNoRule.values) || []);
  if (def.intentionalNoRule && !def.intentionalNoRule.reason) {
    err(`字段 "${name}" 的 intentionalNoRule 缺 reason —— 说不出理由的不许免检`);
  }
  const untouched = (def.items || []).filter((o) => !used.has(o) && !exempt.has(o));
  if (untouched.length) deadValues.push(`${name}: ${untouched.join(', ')}`);
  const exempted = (def.items || []).filter((o) => !used.has(o) && exempt.has(o));
  if (exempted.length) note(`字段 "${name}" 有意不触发规则：${exempted.join(', ')} —— ${def.intentionalNoRule.reason}`);
}
if (deadFields.length) err(`以下输入字段没有任何规则使用，用户填了不影响结果：${deadFields.join(', ')}`);
if (deadValues.length) warn(`以下勾选项没有任何规则响应，勾了不改变结果：\n      ${deadValues.join('\n      ')}`);

// 1.55 正向可达性：规则里写死的值，必须是用户能选出来的值
//      失败模式：when.gender 写成 "women"（打错一个字母）→ 规则永不触发，
//      而"字段存在性"检查照样通过。这类错在自然语言文档里永远看不出来。
for (const [field, vals] of usedValues) {
  const def = inputs.fields[field];
  if (!def) continue;
  const allowed = def.type === 'enum' ? new Set((def.values || []).map(String))
    : def.type === 'array' ? new Set((def.items || []).map(String))
      : null;
  if (!allowed) continue; // 数值型字段（age/packYears）由阈值检查覆盖
  const bad = [...vals].filter((v) => !allowed.has(String(v)));
  if (bad.length) err(`规则里用了 ${field} = ${bad.join(', ')}，但这不是用户能选出来的值（打错字？该规则永远不会命中）`);
}

// 1.6 年龄连续性检查（替代已废弃的"档位穿越"检查）
//     改用实岁后不存在映射层，但会出现新的失败模式：某个年龄谁都管不到。
//     用"零危险因素"画像逐岁跑一遍，任何一岁没有任何 A 档项目 = 必然漏了规则。
const ageMin = inputs.fields.age?.min ?? 18;
const ageMax = inputs.fields.age?.max ?? 100;
const emptyProfile = {
  gender: 'male', smoking: 'no', packYears: 0, secondhand: 'no', alcohol: 'none',
  occupationDust: 'no', hpStatus: 'negative', familyHistory: [], pastHistory: [], pregnant: 'no',
};
const barrenAges = [];
const aCountByAge = [];
for (let age = ageMin; age <= ageMax; age++) {
  const p = { ...emptyProfile, age };
  const a = rulesFile.rules.filter((r) => r.category === 'A' && match(r.when, p));
  aCountByAge.push([age, a.length]);
  if (a.length === 0) barrenAges.push(age);
}
if (barrenAges.length)
  err(`以下年龄在"零危险因素"情况下没有任何 A 档项目，必然漏规则：${barrenAges[0]}–${barrenAges[barrenAges.length - 1]} 岁（共 ${barrenAges.length} 个年龄）`);

// 1.7 人群页检查：每页的代表画像必须能产出内容，否则就是空页面
let populations = null;
try { populations = load('data/populations.json'); } catch { /* 允许暂不存在 */ }
if (populations) {
  const slugs = new Set();
  for (const p of populations.pages) {
    const tag = p.slug || '(无 slug)';
    if (slugs.has(p.slug)) err(`人群页 slug 重复：${tag}`);
    slugs.add(p.slug);
    if (!/^[a-z0-9-]+$/.test(p.slug || '')) err(`人群页 slug 只能含小写字母、数字、连字符：${tag}`);
    for (const f of ['title', 'keywords', 'audience', 'profile', 'angle']) if (!p[f]) err(`人群页 ${tag} 缺少 ${f}`);
    if (!Array.isArray(p.keywords) || p.keywords.length === 0) err(`人群页 ${tag} 需要至少 1 个目标关键词`);
    const prof = { pregnant: 'no', smoking: 'no', packYears: 0, secondhand: 'no', alcohol: 'none', occupationDust: 'no', hpStatus: 'negative', familyHistory: [], pastHistory: [], ...p.profile };
    if (typeof prof.age !== 'number' || prof.age < ageMin || prof.age > ageMax) err(`人群页 ${tag} 的代表画像年龄不合法：${prof.age}`);
    if (!['male', 'female'].includes(prof.gender)) err(`人群页 ${tag} 的代表画像性别不合法：${prof.gender}`);
    const a = rulesFile.rules.filter((r) => r.category === 'A' && match(r.when, prof));
    const c = rulesFile.rules.filter((r) => r.category === 'C' && match(r.when, prof));
    if (a.length < 3) err(`人群页 ${tag} 的代表画像只产出 ${a.length} 条 A 档，页面会太空`);
    if (c.length === 0) warn(`人群页 ${tag} 没有 C 档内容，「不用做什么」是这类页面最有价值的部分`);
  }
  // 必链页面必须存在
  for (const s of populations.linkPolicy?.mustLink || []) if (!slugs.has(s)) err(`linkPolicy.mustLink 引用了不存在的页面：${s}`);
}

// 1.8 输入可达性检查（三方一致）：界面能选的、schema 允许的、规则写死的
//     新失败模式：规则里写 when.gender = "women"（打错字）→ 规则永不触发，
//     但旧检查只看"字段是否存在"，一声不响。加了 UI 层后必须三方对齐：
//       界面选项集合  ==  inputs.schema.json 的枚举
//       规则里出现的值  ∈  枚举
//       数值阈值能被界面选项跨越（否则那条规则是死的）
let questions = [];
try { ({ questions } = await import('../src/questions.js')); } catch (e) {
  warn(`无法加载 src/questions.js（${e.message}），跳过输入可达性检查`);
}
if (questions.length) {
  const qByKey = new Map(questions.map((q) => [q.key, q]));
  /* 一道题可能填多个字段（体型题＝身高＋体重＋腰围＋走哪条路＋降级档）。
   * 这些字段要登记成"界面上填得了"，否则下面 289 行会把它们当成填不出来的死角。 */
  for (const q of questions) for (const f of q.fields || []) qByKey.set(f, q);
  const setOf = (arr) => new Set(arr.map(String));

  for (const q of questions) {
    /* 数值型多字段题（体型）：没有"选项"，所以不走下面的枚举三方比对。
     * 但字段必须真的在 schema 里登记过 —— 否则用户填的东西没有落点。 */
    if (q.kind === 'body') {
      if (!(q.fields || []).length) err(`问题 "${q.key}" 是数值题，必须用 fields 列出它填的字段`);
      for (const f of q.fields || []) {
        if (!inputs.fields[f]) err(`问题 "${q.key}" 引用的字段 "${f}" 在 inputs.schema.json 中没有登记`);
      }
      continue;
    }
    const def = inputs.fields[q.key];
    if (!def) { err(`问题 "${q.key}" 在 inputs.schema.json 中没有登记`); continue; }
    const opts = setOf((q.options || []).map((o) => o.v));
    if (q.kind === 'age') continue;
    if (!opts.size && q.kind !== 'age') { err(`问题 "${q.key}" 没有任何选项`); continue; }
    const allowed = def.type === 'enum' ? setOf(def.values || []) : def.type === 'array' ? setOf(def.items || []) : null;
    if (!allowed) continue; // 数字型（packYears）下面单独查阈值
    // defaultOnly：引擎默认值（"没答过"），用户选不出来也不该选出来
    const skipDefault = setOf(def.defaultOnly || []);
    const onlyUi = [...opts].filter((v) => !allowed.has(v));
    const onlySchema = [...allowed].filter((v) => !opts.has(v) && !skipDefault.has(v));
    if (onlyUi.length) err(`问题 "${q.key}" 的选项 ${onlyUi.join(', ')} 不在 schema 允许值内（用户选得出、规则里却没有对应值）`);
    if (onlySchema.length) err(`问题 "${q.key}" 少了 schema 里的选项 ${onlySchema.join(', ')}（规则写了这个值，但用户选不出来）`);

    /* 词表守卫：全站只有三种"不知道"，一种说法只对应一个值。
     *
     * 这条是补上踩过的坑 —— 之前同一个概念在六道题里有六种说法
     * （不确定 / 说不清 / 没查过不记得 / 不方便说 / 都没有不清楚 / 都没有），
     * 而底层只有两个值。用户以为自己在说两件事，数据里却是一件事，
     * 结果页也就没法告诉他"哪几项是能补的、哪几项是你不愿说的"。
     */
    const label = (v) => (q.options || []).find((o) => String(o.v) === v)?.l || '';
    const lUnknown = label('unknown');
    if (lUnknown && !/不确定|记不清|说不清|不记得|没查过/.test(lUnknown)) {
      err(`问题 "${q.key}"：unknown 的文案是「${lUnknown}」，必须写成"不确定/记不清/没查过"这类，不能写成"不方便说"`);
    }
    const lDeclined = label('declined');
    if (lDeclined && !/不方便说|不想说|不愿说/.test(lDeclined)) {
      err(`问题 "${q.key}"：declined 的文案是「${lDeclined}」，必须写成"不方便说"，因为它的含义是拒答而不是不知道`);
    }
    if (q.kind === 'multi' && q.unknownLabel && !(def.sentinelValues || []).includes('unknown')) {
      err(`问题 "${q.key}" 有多选型的"不确定"按钮，但 schema 没声明 sentinelValues: ["unknown"]`);
    }
    // 多选的"都没有"只能是"没有"，不能再捎带一个"不清楚"
    if (q.kind === 'multi' && /不清|不确定/.test(q.noneLabel || '')) {
      err(`问题 "${q.key}" 的"${q.noneLabel}"把"没有"和"不知道"混成了一个按钮，用户选了它会被当成没有`);
    }
  }

  // schema 里有、界面上却没有的字段（排除明确只做提示的）
  for (const [name, def] of Object.entries(inputs.fields)) {
    if (def.informationalOnly && name === 'province') continue;
    if (!qByKey.has(name)) warn(`字段 "${name}" 没有对应的界面题目，用户无法填写`);
  }

  // 数值阈值可达性：规则里的 gte/gt/lte/lt 必须能被某两个选项跨越
  const collectThresholds = (when, out = []) => {
    if (!when || typeof when !== 'object') return out;
    for (const [k, v] of Object.entries(when)) {
      if (['any', 'all', 'none'].includes(k)) {
        if (Array.isArray(v)) v.forEach((c) => collectThresholds(c, out));
        continue;
      }
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [op, num] of Object.entries(v)) {
          if (['gte', 'gt', 'lte', 'lt'].includes(op) && typeof num === 'number') out.push({ field: k, op, num });
        }
      }
    }
    return out;
  };
  const unreachable = [];
  for (const r of rulesFile.rules) {
    for (const { field, op, num } of collectThresholds(r.when)) {
      const q = qByKey.get(field);
      if (!q || q.kind === 'age') continue; // age 由 1.6 逐岁检查覆盖
      const marks = (q.options || []).map((o) => Number(o.v)).filter((n) => !Number.isNaN(n));
      if (!marks.length) { unreachable.push(`${r.id}.${field} 用了 ${op} ${num}，但界面没有数值选项`); continue; }
      const pass = marks.some((m) => (op === 'gte' ? m >= num : op === 'gt' ? m > num : op === 'lte' ? m <= num : m < num));
      const fail = marks.some((m) => (op === 'gte' ? m < num : op === 'gt' ? m <= num : op === 'lte' ? m > num : m >= num));
      if (!pass) unreachable.push(`[${r.id}] ${field} ${op} ${num}：界面最高的档位都达不到，这条规则永远不触发`);
      if (!fail) unreachable.push(`[${r.id}] ${field} ${op} ${num}：界面所有档位都满足，这个条件等于没写`);
    }
  }
  for (const m of unreachable) err(m);
}

// —— 探针工具：构造"能命中某条规则"的输入组合，用于冲突与断崖检查 ——
const fieldsOf = (when, acc = new Set()) => {
  for (const [k, v] of Object.entries(when || {})) {
    if (k === 'any' || k === 'all' || k === 'none') { (v || []).forEach((c) => fieldsOf(c, acc)); continue; }
    if (k === 'ageMin' || k === 'ageMax') { acc.add('age'); continue; }
    acc.add(k);
  }
  return acc;
};
const valuesOf = (when, field, acc = new Set()) => {
  for (const [k, v] of Object.entries(when || {})) {
    if (k === 'any' || k === 'all' || k === 'none') { (v || []).forEach((c) => valuesOf(c, field, acc)); continue; }
    if (k !== field) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const op of ['eq', 'in']) if (op in v) (Array.isArray(v[op]) ? v[op] : [v[op]]).forEach((x) => acc.add(x));
    } else if (Array.isArray(v)) v.forEach((x) => acc.add(x));
    else if (v !== undefined) acc.add(v);
  }
  return acc;
};
const ageBounds = (when, acc = []) => {
  for (const [k, v] of Object.entries(when || {})) {
    if (k === 'any' || k === 'all' || k === 'none') { (v || []).forEach((c) => ageBounds(c, acc)); continue; }
    if ((k === 'ageMin' || k === 'ageMax') && typeof v === 'number') acc.push([k, v]);
  }
  return acc;
};
const neutral = (name) => {
  const def = inputs.fields[name];
  if (!def) return undefined;
  if (def.type === 'array') return [];
  if (def.type === 'number') return 0;
  const pref = ['no', 'none', 'normal', 'negative', 'male', 'unknown'];
  return (def.values || []).find((v) => pref.includes(v)) ?? def.values?.[0];
};
const cartesian = (lists) => lists.reduce((acc, list) => acc.flatMap((a) => list.map((x) => [...a, x])), [[]]);
const BASE_PROBE = {
  gender: 'male', pregnant: 'no', smoking: 'no', packYears: 0, secondhand: 'no', alcohol: 'none',
  occupationDust: 'no', occupationTypes: [], hpStatus: 'negative', familyHistory: [], pastHistory: [],
  age: 50, province: '',
};
/**
 * 找一组"在 age 岁能命中 rule"的输入。找不到返回 null。
 * 用途：证明某条规则确实可能被触发，并给它代表的典型用户做后续检查。
 */
const findWitness = (rule, age) => {
  const fields = [...fieldsOf(rule.when)];
  const lists = fields.map((f) => {
    if (f === 'age') return [age];
    const vals = [...valuesOf(rule.when, f)];
    const def = inputs.fields[f];
    const base = def?.type === 'array' ? [[]] : [neutral(f)];
    const extra = def?.type === 'array' ? vals.map((v) => [v]) : vals;
    return [...base, ...extra].filter((v) => v !== undefined);
  });
  if (lists.reduce((n, l) => n * l.length, 1) > 50000) return null;
  for (const combo of cartesian(lists)) {
    const probe = { ...BASE_PROBE };
    fields.forEach((f, idx) => { probe[f] = combo[idx]; });
    probe.age = age;
    if (match(rule.when, probe)) return probe;
  }
  return null;
};

// 1.9 同项目跨档冲突：同一个检查项目不能同时落进两个档位
//     失败模式（已发生）：吸烟者同时命中「上消化道癌高危 = A」和「胃癌一般风险 = B」，
//     结果页对着同一根胃镜说"该做"又说"和医生商量"。旧校验只列"多规则重叠"，不判矛盾。
if (questions.length) {
  const byItem = new Map();
  for (const r of rulesFile.rules) {
    for (const cid of new Set(r.catalogIds || [])) {
      if (!byItem.has(cid)) byItem.set(cid, []);
      byItem.get(cid).push(r);
    }
  }

  const clashes = [];
  for (const [cid, list] of byItem) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [a, b] = [list[i], list[j]];
        if (a.category === b.category) continue;
        const fields = [...new Set([...fieldsOf(a.when), ...fieldsOf(b.when)])];
        const lists = fields.map((f) => {
          if (f === 'age') {
            const ages = new Set([40, 50, 60, 70]);
            for (const r of [a, b]) {
              for (const [, v] of ageBounds(r.when)) { ages.add(v - 1); ages.add(v); ages.add(v + 1); }
            }
            return [...ages].filter((x) => x >= ageMin && x <= ageMax);
          }
          const vals = [...valuesOf(a.when, f), ...valuesOf(b.when, f)];
          const def = inputs.fields[f];
          const base = def?.type === 'array' ? [[]] : [neutral(f)];
          const extra = def?.type === 'array' ? [...new Set(vals)].map((v) => [v]) : [...new Set(vals)];
          return [...base, ...extra].filter((v) => v !== undefined);
        });
        const size = lists.reduce((n, l) => n * l.length, 1);
        if (size > 20000) { warn(`项目 ${cid} 的两条规则冲突检测跳过（组合 ${size} 过大）`); continue; }
        let probe = null;
        for (const combo of cartesian(lists)) {
          const p = { ...BASE_PROBE };
          fields.forEach((f, idx) => { p[f] = combo[idx]; });
          if (match(a.when, p) && match(b.when, p)) { probe = p; break; }
        }
        if (probe) clashes.push(`${cid}：${a.id}(${a.category}) 与 ${b.id}(${b.category}) 会同时命中，用户会看到自相矛盾的建议。例：${JSON.stringify(probe)}`);
      }
    }
  }
  clashes.forEach((c) => err(c));
}

// 1.95 年龄上限断崖：ageMax 之后，这个项目不能"凭空消失"
//      失败模式（已发生）：74 岁的男人被告知做肠镜，75 岁生日一过，结果页上肠癌筛查整条不见了。
//      用户只会理解成"不用做了"——这是静默漏筛，比写错档位更危险。
//      要求：每条有上限的规则，在 ageMax+1 岁必须还有规则承接（继续做 / 与医生商量 / 明确可以停）。
{
  const cliffs = [];
  for (const r of rulesFile.rules) {
    if (r.category === 'C') continue;
    const maxes = ageBounds(r.when).filter(([k]) => k === 'ageMax').map(([, v]) => v);
    for (const max of new Set(maxes)) {
      if (max >= ageMax) continue;
      const witness = findWitness(r, max);
      if (!witness) continue; // 这条规则本身就不可能命中，另有检查负责
      const after = { ...witness, age: max + 1 };
      const orphan = [];
      for (const cid of new Set(r.catalogIds || [])) {
        // 必须"这一个项目"有人承接。用 catalogIds 求交集会漏：base-package 年年管便潜血，
        // 于是"肠镜到 75 岁断崖"会被便潜血挡住，检查不出来。
        const covered = rulesFile.rules.some((x) => x !== r && (x.catalogIds || []).includes(cid) && match(x.when, after));
        if (!covered) orphan.push(cid);
      }
      if (orphan.length) {
        cliffs.push(`[${r.id}] 到 ${max} 岁就断了：${max + 1} 岁及以后没有规则覆盖 ${orphan.join('/')}，用户会以为"不用做了"。请补承接规则（继续做 / 与医生商量 / 明确可以停）。例：${JSON.stringify(after)}`);
      }
    }
  }
  cliffs.forEach((c) => err(c));
}

// 2. catalog 覆盖率（漏项检查）
const covered = new Map();
for (const r of rulesFile.rules) for (const cid of r.catalogIds || []) {
  if (!covered.has(cid)) covered.set(cid, []);
  covered.get(cid).push(r.id);
}
const gaps = catalog.items.filter((i) => !covered.has(i.id) && !i.notIncluded).map((i) => i.id);
const excluded = catalog.items.filter((i) => i.notIncluded);
const duplicated = [...covered.entries()].filter(([, arr]) => arr.length > 1);

// 数据完整性：既被规则覆盖、又标了"不纳入理由" —— 两处口径打架，必错一处
const contradictory = catalog.items.filter((i) => covered.has(i.id) && i.notIncluded).map((i) => i.id);
if (contradictory.length)
  err(`以下项目既被规则覆盖、又标注了不纳入理由，口径矛盾（二选一）：${contradictory.join(', ')}`);

/* ---------------- 10–12. 证据可核性 ----------------
   这三条是"证据权威可信"的机器底线：
   10 引用的那句话必须能在仓库存的原文里逐字找到（防编造、防记错）；
   11 规则里的年龄必须能在引用里找到（防改了规则没改证据）；
   12 档位必须与证据方向一致（A 不能靠"证据不足"撑着，C 不能靠"强推荐"撑着）。 */
const snapshotIndex = (() => {
  try { return load('data/snapshots/_index.json'); } catch { return {}; }
})();
// 归一化只有一份实现（全角折半、中文间空格、空白压缩），否则会出现
// "原文里有、这里说没有"的假失败。
const normalizeText = squash;
const snapshotCache = new Map();
const snapshotOf = (url) => {
  if (snapshotCache.has(url)) return snapshotCache.get(url);
  const rec = snapshotIndex[url];
  let text = null;
  if (rec && rec.file) {
    try { text = normalizeText(readFileSync(join(root, rec.file), 'utf8')); } catch { text = null; }
  }
  snapshotCache.set(url, text);
  return text;
};

const evidenceList = rulesFile.rules.flatMap((r) => (r.evidence || []).map((ev) => ({ rule: r, ev })));

let quoteChecked = 0;
let quoteMissing = 0; // 有多少句其实没找到 —— 汇总行必须说实话，否则"全部命中"会替错误背书
for (const { rule, ev } of evidenceList) {
  const quotes = ev.quotes || (ev.quote ? [ev.quote] : []);
  if (!quotes.length) continue;
  const text = snapshotOf(ev.url);
  if (!text) {
    err(`${rule.id}：有原文摘录，但仓库里没有对应的原文快照（${ev.url}），无法核验`);
    continue;
  }
  for (const q of quotes) {
    quoteChecked += 1;
    if (!text.includes(normalizeText(q))) {
      quoteMissing += 1;
      err(`${rule.id}：摘录在原文里找不到 →「${q.slice(0, 42)}…」`);
    }
  }
}

/* ---------------- 12.5 条款卡语义校验（计划 3 第一/三层）----------------
   字符串逐字命中只保证"没编造"；这一节保证"结论能由原文推出来"：
   ① 条款卡字段必须填齐、枚举合法（防半截数据冒充已核实）；
   ② population 里写的人群数字，必须能在本规则引文里找到（数字回读）；
   ③ version 必须能在证据出处里找到（防"张冠李戴"的版本号）；
   ④ supersedes 必须指向真实存在的规则（防幽灵版本）；
   ⑤ 每条条款卡要有语义复核记录（AI/人工交叉审读闭环，见 scripts/semantic-review.mjs）。 */
const CLAUSE_REQUIRED = ['version', 'population', 'evidenceRole', 'conflictPolicy', 'followup_path'];
const CLAUSE_ENUMS = {
  evidenceRole: ['primary', 'secondary', 'dispute-only'],
  conflictPolicy: ['strict-first-dispute', 'single-guideline', 'guidelines-merged', 'patient-doctor'],
  followup_path: ['复查', '转诊', '观察', '咨询医生'],
};
const semanticReview = (() => {
  try { return load('data/semantic-review.json'); } catch { return {}; }
})();
let clauseCount = 0;
for (const r of rulesFile.rules) {
  const c = r.clause;
  if (!c) continue;
  clauseCount += 1;
  const tag = r.id;
  for (const f of CLAUSE_REQUIRED) if (c[f] === undefined) err(`[${tag}] clause 缺少必填字段 ${f}`);
  for (const [f, vals] of Object.entries(CLAUSE_ENUMS))
    if (c[f] !== undefined && !vals.includes(c[f])) err(`[${tag}] clause.${f} 必须是 ${vals.join('/')}`);
  if (c.population !== undefined && !Array.isArray(c.population?.include))
    err(`[${tag}] clause.population.include 必须是数组`);
  // 人群数字回读：条款卡里写的每个数字，都得能在引文里找到出处。
  // 这是"字段填了但和原文不符"的第一道机器闸。
  if (Array.isArray(c.population?.include)) {
    const quotesText = normalizeText((r.evidence || []).flatMap((e) => e.quotes || (e.quote ? [e.quote] : [])).join(' '));
    for (const inc of c.population.include) {
      for (const num of String(inc).match(/\d+/g) || []) {
        if (!quotesText.includes(num)) err(`[${tag}] clause.population 的数字 ${num}（「${String(inc).slice(0, 24)}…」）在本规则引文里没有出处`);
      }
    }
  }
  // 版本号必须能在证据出处里找到
  if (c.version !== undefined) {
    const hay = normalizeText((r.evidence || []).map((e) => `${e.org} ${e.year} ${e.point || ''}`).join(' '));
    if (!hay.includes(normalizeText(String(c.version)))) err(`[${tag}] clause.version「${c.version}」在证据出处里找不到`);
  }
  if (c.supersedes !== undefined && !ids.has(c.supersedes)) err(`[${tag}] clause.supersedes 指向不存在的规则「${c.supersedes}」`);
  // 分歧文案（可选）：写了就必须是 { key, text } 且都不为空 —— 防"半截分歧"进结果页
  if (c.dispute !== undefined) {
    if (!c.dispute || typeof c.dispute.key !== 'string' || !c.dispute.key.trim()
      || typeof c.dispute.text !== 'string' || !c.dispute.text.trim())
      err(`[${tag}] clause.dispute 必须是非空 { key, text }`);
  }
  // 3.3bis 边界透明化（可选）：boundary 必须是结构化数组，界线数字必须有引文支撑（不发明阈值）
  if (c.boundary !== undefined) {
    if (!Array.isArray(c.boundary) || !c.boundary.length)
      err(`[${tag}] clause.boundary 必须是非空数组`);
    else {
      // hay 含 org/point：文案里的年份（如「2025 版」）出自证据出处名，界线数字出自原文 —— 两处都算有据
      const bQuotes = normalizeText((r.evidence || []).flatMap((e) => [e.org || '', e.point || '', ...(e.quotes || (e.quote ? [e.quote] : []))]).join(' '));
      const SCHEMA_FIELDS = new Set(Object.keys(inputs.fields));
      for (const b of c.boundary) {
        if (!b || !SCHEMA_FIELDS.has(b.field)) { err(`[${tag}] clause.boundary.field「${b?.field}」不是问卷字段`); continue; }
        if (!Number.isFinite(Number(b.near))) err(`[${tag}] clause.boundary.near 必须是数字`);
        if (!['below', 'above'].includes(b.side)) err(`[${tag}] clause.boundary.side 必须是 below/above`);
        if (!b.text || !b.text.trim()) err(`[${tag}] clause.boundary.text 不能为空`);
        for (const num of String(b.text).match(/\d+/g) || []) {
          if (!bQuotes.includes(num)) err(`[${tag}] clause.boundary 文案里的数字 ${num} 在本规则引文里没有出处（界线必须是指南原文写明的）`);
        }
      }
    }
  }
  // 语义复核闭环：没有 supported 记录就提醒（不阻塞——先让闭环跑起来）
  const review = semanticReview[r.id];
  if (!review || review.verdict !== 'supported')
    warn(`[${tag}] 条款卡还没有语义复核记录（data/semantic-review.json），请跑 npm run review:semantic`);
}

/* ---------------- 12.7 人群对账（3.3bis「A 落地收尾」）----------------
   条款卡 population.include 是给人看的人群描述，when 是机器判定条件。
   两者必须说的是同一批人——不一致就是「字段填了但和原文不符」的变体。
   机器只查可机械判定的三件事：性别、年龄边界、关键条件词。
   说不清的（指南原文没给数字、衔接条等）登记进 data/population-audit.json，每条豁免必须写理由；
   豁免失效（对账已自然通过）也会点名，防止登记表变成免检通道。 */
const popAudit = (() => { try { return load('data/population-audit.json'); } catch { return { ack: {} }; } })();
const FIELD_KEYWORD = {
  smoking: ['吸烟'], packYears: ['包年'], smokingQuitYears: ['戒烟'],
  secondhand: ['被动吸烟', '二手烟'], secondhandYears: ['被动吸烟', '二手烟'],
  alcohol: ['饮酒'],
  occupationDust: ['职业', '粉尘'], occupationAgents: ['职业', '致癌物'], occupationTypes: ['职业', '致癌物'], occupationYears: ['职业'],
  familyHistory: ['家族史', '亲属', '家属'], pastHistory: ['病史', '确诊', '既往', '诊断', '感染', '硬化', '结节'],
  hpStatus: ['幽门螺杆菌'], pregnant: ['孕'], frailty: ['衰弱'],
  symptomFlags: ['症状'], recentHospital: ['住院'],
  fallHistory: ['跌倒', '摔倒'], gaitDifficulty: ['步态', '行动'], memoryConcern: ['记忆', '认知'],
};
const whenFieldsOf = (when, acc = []) => {
  for (const [k, v] of Object.entries(when || {})) {
    if (k === 'any' || k === 'all') (v || []).forEach((w) => whenFieldsOf(w, acc));
    else if (k === 'none' || k === 'ageMin' || k === 'ageMax' || k === 'gender') continue;
    else acc.push(k);
  }
  return acc;
};
const ageBoundsOf = (when, acc = []) => {
  for (const [k, v] of Object.entries(when || {})) {
    if (k === 'ageMin' || k === 'ageMax') acc.push([k, v]);
    else if (k === 'any' || k === 'all') (v || []).forEach((w) => ageBoundsOf(w, acc));
  }
  return acc;
};
let popChecked = 0;
for (const r of rulesFile.rules) {
  const c = r.clause;
  if (!c || !Array.isArray(c.population?.include)) continue;
  popChecked += 1;
  const incJoin = c.population.include.join(' ');
  const text = normalizeText(incJoin);
  const missing = [];
  if (r.when.gender === 'female' && !text.includes('女')) missing.push('性别（女）');
  if (r.when.gender === 'male' && !text.includes('男')) missing.push('性别（男）');
  // 18 / 100 是界面年龄下限/上限，不是任何指南给的线（与 1.x 年龄检查同一口径），不参与对账
  const UI_AGE = [inputs.fields.age?.min ?? 18, inputs.fields.age?.max ?? 100];
  for (const [, v] of ageBoundsOf(r.when)) {
    if (UI_AGE.includes(v)) continue;
    if (!new RegExp(`(^|[^0-9])${v}(?![0-9])`).test(incJoin)) missing.push(`年龄边界 ${v}`);
  }
  for (const f of [...new Set(whenFieldsOf(r.when))]) {
    const kws = FIELD_KEYWORD[f];
    if (kws && !kws.some((w) => text.includes(w))) missing.push(`条件「${f}」`);
  }
  const ack = popAudit.ack?.[r.id];
  const unack = missing.filter((m) => !(ack?.missing || []).includes(m));
  if (unack.length) warn(`[${r.id}] 条款卡人群与判定条件对不上：${unack.join('、')} —— 改 population 文字，或在 data/population-audit.json 登记理由`);
  if (ack && missing.length === 0) warn(`[${r.id}] population-audit 里的豁免已不再需要（对账自然通过），请清理登记表`);
}
console.log(`人群对账：${popChecked} 张条款卡核对性别/年龄边界/条件词（豁免登记 ${Object.keys(popAudit.ack || {}).length} 条）`);

/* ---------------- 12.6 依据时效（老板 2026-11-24 定：48 个月 + 仅单条依据）----------------
   行业通行复审周期 2–5 年（WHO 手册 / NICE 3 年），48 个月取其中位偏保守。
   多条依据互相印证时不提示——单条旧不构成风险，不该拿它打扰用户。 */
const STALE_MONTHS = 48;
const monthsSince = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.test(String(iso || '')) ? iso.match(/^(\d{4})-(\d{2})-(\d{2})$/).slice(1).map(Number) : null;
  if (!m) return null;
  return (Date.now() - new Date(Date.UTC(m[0], m[1] - 1, m[2])).getTime()) / (1000 * 60 * 60 * 24 * 30.44) / 1;
};
for (const r of rulesFile.rules) {
  if ((r.evidence || []).length !== 1) continue;
  const e = r.evidence[0];
  const months = Math.floor(monthsSince(e.checkedAt) || 0);
  if (months > STALE_MONTHS) warn(`[${r.id}] 唯一依据已 ${months} 个月未复核（阈值 ${STALE_MONTHS} 个月），建议复核或补充第二条依据`);
}

/* ---------------- 13. 「去哪一栏」（data/where.json） ----------------
   这一栏回答的是"挂哪个号"，不是"该不该查"。它的可信度要求和 evidence 不同（不是推荐强度），
   但有三条一样硬：
     ① 每条规则都要有答案 —— 漏一条，用户翻到那一节就无处可去；
     ② 标了 basis=guide 的，出处文本里必须真能读到那个科室 —— 否则就是给"惯例"穿依据的外衣；
     ③ 出处的引文必须能在快照里逐字找到 —— 和 rules 的证据同一条底线。
   base-package* 由 base.groups 统一回答（19 项挤一条「去哪」会变成字墙），所以不单独要求。 */
const whereFile = (() => { try { return load('data/where.json'); } catch { return null; } })();
if (!whereFile) err('data/where.json 不存在或不是合法 JSON');
else {
  const ws = whereFile.rules || {};
  const we = whereFile.extras || {};
  const known = new Set(rulesFile.rules.map((r) => r.id));
  for (const r of rulesFile.rules) {
    if (/^base-package/.test(r.id)) continue;
    if (!ws[r.id]) err(`[${r.id}] where.json 里没有「去哪做」—— 依据页这一节会缺一行`);
  }
  for (const id of Object.keys(ws)) if (!known.has(id)) err(`where.json 有一条指向不存在的规则 "${id}"`);
  for (const [id, v] of [...Object.entries(ws), ...Object.entries(we)]) {
    if (!v.dept || typeof v.dept !== 'string') err(`where.json ${id} 的 dept 为空`);
    if (!['guide', 'practice'].includes(v.basis)) err(`where.json ${id} 的 basis 必须是 guide 或 practice`);
  }
  const seenBase = new Set();
  for (const g of whereFile.base?.groups || []) {
    if (!g.dept) err('where.json base.groups 有一组没写 dept');
    for (const id of g.ids || []) {
      if (!catalogIds.has(id)) err(`where.json base.groups 引用了不存在的项目 "${id}"`);
      if (seenBase.has(id)) err(`where.json base.groups 里 "${id}" 出现了两次`);
      seenBase.add(id);
    }
  }
  for (const [i, s] of (whereFile.sources || []).entries()) {
    for (const f of ['org', 'year', 'point', 'url']) if (!s[f]) err(`where.json sources[${i}] 缺少 ${f}`);
    const text = snapshotOf(s.url);
    if (!text) { err(`where.json sources[${i}]（${s.org}）没有原文快照，无法核验`); continue; }
    for (const q of s.quotes || []) {
      if (!text.includes(normalizeText(q))) err(`where.json sources[${i}] 摘录在原文里找不到 →「${q.slice(0, 40)}…」`);
    }
  }
  /* 语义抽查（只警告不拦截）：科室名得在出处文本里露过面。
   * 拆成几个词再比（"消化内科 · 内镜中心"命中"内镜"就算过），并且按前缀由长到短退让 ——
   * 出处里写的是"泌尿专科医师"，我们写的是"泌尿外科"，只有退到"泌尿"才对得上。
   * 这一步是烟雾测试，不是证明；目的只是让"给惯例穿依据外衣"这件事没法悄悄发生。 */
  const corpus = normalizeText((whereFile.sources || [])
    .map((s) => `${s.point}${(s.quotes || []).join('')}`).join(''));
  const hit = (t) => {
    for (let n = t.length; n >= 2; n--) if (corpus.includes(t.slice(0, n))) return true;
    return false;
  };
  let guideCnt = 0;
  let guideWarn = 0;
  for (const [id, v] of Object.entries(ws)) {
    if (v.basis !== 'guide') continue;
    guideCnt += 1;
    const toks = v.dept.split(/[·、/（）()或和\s]+/).map((t) => t.replace(/[（）()]/g, '')).filter((t) => t.length >= 2);
    if (!toks.some(hit)) {
      guideWarn += 1;
      warn(`where.json ${id} 标了"原文点名"，但「${v.dept}」在出处里找不到对应字样，请人工确认`);
    }
  }
  note(`「去哪」：${Object.keys(ws).length + Object.keys(we).length} 条，其中 ${guideCnt} 条标"原文点名"（机器抽查命中 ${guideCnt - guideWarn}/${guideCnt}）`);
}

/** 从 when 树里收年龄边界 */
const collectAges = (when, out = new Set()) => {
  if (!when || typeof when !== 'object') return out;
  if (typeof when.ageMin === 'number') out.add(when.ageMin);
  if (typeof when.ageMax === 'number') out.add(when.ageMax);
  for (const k of ['any', 'all', 'none']) if (Array.isArray(when[k])) when[k].forEach((w) => collectAges(w, out));
  return out;
};

for (const rule of rulesFile.rules) {
  const quotes = (rule.evidence || []).flatMap((e) => e.quotes || (e.quote ? [e.quote] : []));
  if (!quotes.length) continue; // 没摘录的规则另在覆盖率里点名
  const corpus = quotes.join('\n');
  const ack = rule.manualCheck || {};
  const missingAge = [...collectAges(rule.when)].filter((a) => !new RegExp(`(^|[^0-9])${a}(?![0-9])`).test(corpus));
  if (missingAge.length) {
    // 只提醒不拦截：很多依据支撑的是"要不要做这个方向"，不重复写具体年龄；
    // 而 18 岁是界面下限（成年人），不是任何指南给出的起点。
    const solid = missingAge.filter((a) => a !== 18);
    if (solid.length && ack.ages) acked.push(`${rule.id}：年龄 ${solid.join('、')}`);
    else if (solid.length) warn(`${rule.id}：年龄 ${solid.join('、')} 在依据原文里找不到，请人工确认边界是否照抄了指南`);
  }
  const years = rule.frequency && typeof rule.frequency.years === 'number' ? rule.frequency.years : null;
  // 半年一次在原文里通常写成"每 6 个月"，不能只按 "0.5" 找；中文数字（"每两年 1 次"）也要认
  const CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  const freqHit = (y) => {
    if (new RegExp(`(^|[^0-9])${y}(?![0-9])`).test(corpus)) return true;
    if (y > 0 && y < 1) return new RegExp(`(^|[^0-9])${Math.round(y * 12)} ?个月`).test(corpus);
    if (Number.isInteger(y) && y >= 1 && y <= 10) {
      const alt = y === 2 ? '(两|二)' : CN[y];
      if (new RegExp(`${alt}\\s*年`).test(corpus)) return true;
      if (y === 1 && /每年/.test(corpus)) return true;
    }
    return false;
  };
  // 界面常显示区间（"每 5–10 年 1 次"），years 只是下界。原文若写的是同一区间，
  // 必须整段区间字样对得上（"5–10"≈"5~10"），不能靠摘录里随便一个数字蒙过去。
  const rangeHit = (() => {
    const t = String(rule.frequency?.text || '');
    const m = t.match(/(\d+)\s*[–\-—~～至]\s*(\d+)/);
    if (!m) return false;
    const [, a, b] = m;
    return new RegExp(`(^|[^0-9])${a}\\s*(?:[–\\-—~～至]|to)\\s*${b}(?![0-9])`).test(corpus);
  })();
  if (years && !freqHit(years) && !rangeHit) {
    if (rule.frequency?.basis && rule.frequency.basis !== 'guideline') acked.push(`${rule.id}：频率（${rule.frequency.basis === 'doctor' ? '由医生定' : '临床通行做法'}，非指南条文）`);
    else if (ack.freq) acked.push(`${rule.id}：频率"每 ${years} 年"`);
    else warn(`${rule.id}：频率"每 ${years} 年"在依据原文里找不到对应数字，请人工确认`);
  }
}

for (const rule of rulesFile.rules) {
  const graded = (rule.evidence || []).filter((e) => e.strength);
  const has = (s) => graded.some((e) => e.strength === s);
  // 频次若不是指南原文写的，必须写清它到底从哪来 —— 否则界面上会假装是权威条文
  const basis = rule.frequency && rule.frequency.basis;
  if (basis && basis !== 'guideline') {
    if (!['practice', 'doctor'].includes(basis)) err(`${rule.id}：frequency.basis 只能是 guideline / practice / doctor`);
    else if ((rule.frequency.basisNote || '').length < 10) err(`${rule.id}：频次来源标为 ${basis}，但没有写 basisNote 说明出处`);
  }
  // 人工已判断的数字边界，理由不能是一句话敷衍
  if (rule.manualCheck) {
    for (const k of Object.keys(rule.manualCheck)) {
      if (!['ages', 'freq'].includes(k)) err(`${rule.id}：manualCheck 只能有 ages / freq 两个键`);
      else if ((rule.manualCheck[k] || '').length < 12) err(`${rule.id}：manualCheck.${k} 理由太短，写清为什么这个数字对得上`);
    }
  }
  // B 档必须写倾向。
  // 「与医生商议」在指南里叫 conditional recommendation —— 它本身是有方向的，
  // 只是方向不足以强推。界面上一旦把方向丢掉，就只剩一句推卸责任的"你去问医生"。
  if (rule.category === 'B') {
    if (!['for', 'against', 'either'].includes(rule.lean)) {
      err(`${rule.id}：B 档必须写 lean（for / against / either），不能只写"与医生商量"`);
    } else if ((rule.leanNote || '').length < 20) {
      err(`${rule.id}：写了 lean 就必须用 leanNote 说清为什么偏向这边（至少 20 字）`);
    } else {
      // 只查一个方向：全是不推荐却写"偏向做"，说明这条要么归错档，要么理由没想清。
      // 反方向（全是强推荐却写"偏向不做"）不查 —— 强推荐常常是给某个年龄区间的，
      // 而这条规则处理的恰好是区间外的人（如宫颈癌：21–65 岁强推荐筛查，
      // 65 岁以上按同一份指南可以停）。二者不矛盾，硬查会天天误报。
      if (rule.lean === 'for' && graded.length && graded.every((e) => e.strength === 'against')) {
        err(`${rule.id}：lean=for，但全部证据都是"明确不推荐"`);
      }
    }
  } else if (rule.lean) {
    err(`${rule.id}：只有 B 档才写 lean`);
  }
  if (rule.category === 'A') {
    if (!has('strong')) err(`${rule.id}：A 档（该做）没有任何"强推荐"证据支撑`);
    if (has('against')) err(`${rule.id}：A 档里混进了"明确不推荐"的证据，需人工裁决`);
    // "该做"的结论必须能一路点到单篇原文，挂个机构首页不算依据
    for (const e of rule.evidence || []) {
      if (e.linkLevel === 'homepage') err(`${rule.id}：A 档依据只到机构首页（${e.org}），必须换成单篇原文`);
    }
  }
  if (rule.category === 'C') {
    for (const e of graded) {
      // absence：该来源是"权威必选清单里没有它"这类反向证明，不套四档标签
      if (e.absence) continue;
      if (!['against', 'insufficient'].includes(e.strength)) {
        err(`${rule.id}：C 档（不用做）里有 ${e.strength} 强度的证据（${e.org}），方向不一致`);
      }
    }
    // absence 的证据不带 strength，所以要在全量证据里找，不能只在 graded 里找
    const hasBacking =
      (rule.evidence || []).some((e) => e.absence) || graded.some((e) => ['against', 'insufficient'].includes(e.strength));
    if (!hasBacking) err(`${rule.id}：C 档（不用做）没有任何反向证据（不推荐 / 证据不足 / 清单未纳入）`);
  }
  if (rule.category === 'B' && graded.length && graded.every((e) => e.strength === 'against')) {
    // 例外：权威之间本身打架的规则（例如胸片），B 档就是"两边都有理，交给医生"
    if (rule.disputed) warn(`${rule.id}：B 档证据全为"不推荐"，已标注 disputed，请在依据里同时列出支持方`);
    else err(`${rule.id}：B 档证据全是"明确不推荐"，应该归 C 档`);
  }
}

// 3. 报告
const byCat = (c) => rulesFile.rules.filter((r) => r.category === c).length;const evidenceAll = rulesFile.rules.flatMap((r) => r.evidence || []);
const pendingCount = evidenceAll.filter((e) => e.status === 'pending').length;
const coverage = (((catalog.items.length - gaps.length - excluded.length) / (catalog.items.length - excluded.length)) * 100).toFixed(1);
const topicCount = new Map();
for (const r of rulesFile.rules) for (const t of r.topics || []) topicCount.set(t, (topicCount.get(t) || 0) + 1);
const unusedTopics = [...TOPICS].filter((t) => !topicCount.has(t));

console.log('==== 体检项目指南 · 规则校验报告 ====');
console.log(`规则：${rulesFile.rules.length} 条（A ${byCat('A')} / B ${byCat('B')} / C ${byCat('C')}）`);
console.log(`证据：${evidenceAll.length} 条，其中待核实 ${pendingCount} 条`);
const quoted = evidenceAll.filter((e) => (e.quotes || []).length);
const bareUrl = evidenceAll.filter((e) => /^https?:\/\/[^/]+\/?$/.test(e.url));
console.log(
  quoteMissing
    ? `原文摘录：${quoted.length}/${evidenceAll.length} 条有摘录，逐句核对 ${quoteChecked} 句，其中 ${quoteMissing} 句在原文里找不到`
    : `原文摘录：${quoted.length}/${evidenceAll.length} 条有摘录，逐句核对 ${quoteChecked} 句全部命中原文`,
);
const noQuoteA = rulesFile.rules.filter((r) => r.category === 'A' && !(r.evidence || []).some((e) => (e.quotes || []).length));
if (noQuoteA.length) console.log(`A 档尚无原文摘录：${noQuoteA.map((r) => r.id).join('、')}`);
if (bareUrl.length) console.log(`只给了机构首页（无法溯源到单篇）：${bareUrl.length} 条`);
console.log(`项目库：${catalog.items.length} 项；已覆盖 ${covered.size} 项，明确不纳入 ${excluded.length} 项`);
console.log(`待覆盖（漏项）：${gaps.length} 项 → ${gaps.join(', ') || '无'}`);
console.log(`覆盖率：${coverage}%`);
console.log(`主题标签：${topicCount.size} 个在用 / 共登记 ${TOPICS.size} 个`);
console.log(`年龄连续性：${ageMin}–${ageMax} 岁逐岁检查，A 档最少 ${Math.min(...aCountByAge.map((x) => x[1]))} 条、最多 ${Math.max(...aCountByAge.map((x) => x[1]))} 条`);

if (unusedTopics.length) console.log(`未使用的标签：${unusedTopics.join(', ')}`);

if (duplicated.length) {
  console.log(`\n多规则重叠（需确认是有意为之）：`);
  for (const [cid, arr] of duplicated) console.log(`  - ${cid}: ${arr.join(' + ')}`);
}

if (acked.length) {
  console.log(`\n已人工判断并写明理由（不再告警）${acked.length} 条：`);
  for (const a of acked) console.log('  · ' + a);
}

if (notes.length) {
  console.log(`\n已定案（设计如此，不算欠账）${notes.length} 条：`);
  notes.forEach((n) => console.log('  · ' + n));
}

if (warnings.length) {
  console.log(`\n警告 ${warnings.length} 条：`);
  warnings.forEach((w) => console.log('  ! ' + w));
}

if (errors.length) {
  console.log(`\n错误 ${errors.length} 条（必须修复）：`);
  errors.forEach((e) => console.log('  x ' + e));
  process.exit(1);
}

console.log('\n校验通过');
