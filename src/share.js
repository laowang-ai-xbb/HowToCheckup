// SPDX-License-Identifier: MIT
// Copyright (c) 2026 老王AI瞎bb
// See LICENSE at the repository root.

/**
 * 分享链接的编码 / 解码。
 *
 * 静态站点没有后端，所以"短码"实际是把画像压进 URL：
 *   r.html#p=<base64url(JSON)>
 *
 * 为什么是 # 而不是 ?p=：
 *   # 之后的内容**不会发给服务器**，不会进 CDN / Nginx 的 access log。
 *   query 会。而这份数据里有年龄、性别、是否怀孕、家族癌症史 ——
 *   健康数据落进任何一台服务器的日志，都和"我们不收集"这句话矛盾。
 *   旧链接（?p=xxx）仍然能读，只是新生成的链接一律用 #。
 */
import { emptyProfile } from './engine.js';

const b64url = (str) =>
  btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const unb64url = (str) => {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(escape(atob(s)));
};

/** 只编码会影响结论的字段，链接更短 */
/* 链接要带哪些字段 —— 语义已翻转（老板 2026-11-25 定）：
 *   默认把问卷的每个字段都带上，只有登记进 EXCLUDE_FROM_LINK 且写明理由的才不带。
 * 为什么翻转：KEEP 手工白名单曾经漏掉 cookingOilFume —— 结果页油烟提醒"有时出现有时消失"，
 * 走查两天才定位到是链接路径丢字段。白名单靠人记，会一直漏；黑名单靠登记，漏了会被
 * 下面的守护测试（questions-unit）直接点名。 */
const EXCLUDE_FROM_LINK = {
  // 红旗症状（P0-1）：这是"现在就要去就医"的安全提示，不是画像。
  // 它不参与任何 A/B/C 判定，带过去也不会改变清单，只会白白暴露健康隐私。
  redFlags: '症状属安全分流与隐私，不影响清单，不进链接',
};
const KEEP = [
  'age', 'gender', 'pregnant', 'smoking', 'packYears', 'secondhand', 'alcohol',
  'occupationDust', 'familyHistory', 'pastHistory', 'hpStatus',
  // P0/P1.0：年限决定 LDCT 结论，不带过去会让别人看到一份"换了个结论"的清单
  'smokingQuitYears', 'secondhandYears', 'occupationYears', 'occupationAgents',
  'occupationTypes',
  'symptomFlags', 'frailty', 'recentHospital',
  // 既往检查史（P0-2 路A）：决定卡片上的「最近做过」提示，丢了会显示错
  'recentChecks',
  // 油烟决定结果页那张"长期接触油烟"提醒卡：链接路径丢了它，卡就凭空消失 —— 2026-11-25 根因修复
  'cookingOilFume',
  'fallHistory', 'gaitDifficulty', 'memoryConcern',
  // 体型（J10 方案 2）：不带过去，收到链接的人看到的清单和原主人不一样 ——
  // 清单本身不受影响，但结果页那张体型卡会缺，看着像坏了一半。
  'bodyMode', 'bodyHeight', 'bodyWeight', 'bodyWaist', 'bodyShape', 'weightLoss',
];

/* 导出给守护测试（questions-unit）：核对问卷每个 key 都落在 KEEP ∪ EXCLUDE 里 */
export const LINK_EXCLUDE = EXCLUDE_FROM_LINK;
export const LINK_KEEP = KEEP;

export const encodeProfile = (profile) => {
  const slim = {};
  for (const k of KEEP) {
    const v = profile[k];
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (k === 'pregnant' && v === 'no') continue;
    slim[k] = v;
  }
  return b64url(JSON.stringify(slim));
};

/* ---------------- 解码：不信任链接里的任何东西 ----------------
 *
 * 链接是可以被手工改的。如果不校验，一个改过的链接能生成一份"看起来像指南结论"
 * 的清单 —— 对一个以"每条都有出处"立身的产品，这是内容风险，不只是安全问题。
 * 所以按白名单逐字段验类型，非法值直接丢弃（不是整条链接作废，能救的救）。
 *
 * 白名单**从 questions.js 直接生成**，不再手抄一份。
 * 这不是洁癖：手抄的那份已经漂移过两次 —— 加了家族史的「糖尿病 / 早发心梗」、
 * 加了既往史的「阿尔茨海默病」，白名单里都没跟上，结果是"能选、能看到结果、
 * 一分享出去就没了"。彩蛋那条最严重：它只认 pastHistory 里的阿尔茨海默病，
 * 而被洗掉之后，别人发来的链接永远不可能触发彩蛋 —— 页面上一点错都不报。
 * 一份数据两处维护，迟早对不上；所以现在只有 questions.js 一处。
 */
import { questions } from './questions.js';

const ENUM = {};   // 单选：字段 → 允许的值
const LIST = {};   // 多选：字段 → 允许的勾选项
for (const q of questions) {
  if (q.kind === 'single') ENUM[q.key] = (q.options || []).map((o) => o.v);
  if (q.kind === 'multi') LIST[q.key] = (q.options || []).map((o) => o.v);
}

/** 把不可信的 JSON 洗成合法画像；age/gender 缺失或越界则视为无效链接 */
export const sanitizeProfile = (obj) => {
  if (!obj || typeof obj !== 'object') return null;
  const age = Number(obj.age);
  // 上限 149，和年龄输入框的分段一致（120–149 是"仙人"段，提示但不拦截）。
  // 两边不一致会造成最尴尬的一种 bug：能填、能看到结果，但一分享链接就打不开。
  if (!Number.isInteger(age) || age < 18 || age > 149) return null;
  const gender = ENUM.gender.includes(obj.gender) ? obj.gender : null;
  if (!gender) return null;

  const out = emptyProfile();
  out.age = age;
  out.gender = gender;
  for (const [k, allowed] of Object.entries(ENUM)) {
    if (k === 'gender') continue;
    if (allowed.includes(obj[k])) out[k] = obj[k];
  }
  /* 包年不用单独处理：它在 questions.js 里是单选，选项就是 20 / 10 / 0
   * 三个档位标记（见那边的注释），所以已经由上面的 ENUM 覆盖。 */
  for (const [k, allowed] of Object.entries(LIST)) {
    if (!Array.isArray(obj[k])) continue;
    out[k] = obj[k].filter((v) => allowed.includes(v));
  }
  // 家族史/既往史允许"不确定"这个标量值（选项体系里的第三态）
  if (obj.familyHistory === 'unknown') out.familyHistory = 'unknown';
  if (obj.pastHistory === 'unknown') out.pastHistory = 'unknown';

  /* 体型：数字全部限幅。链接可以被手改，一个 999 公斤的体重会算出荒唐的 BMI，
   * 而页面上那个数字是要给医生看的。越界就当没填（0），落进缺口回补。 */
  const num = (v, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : 0;
  };
  if (['bmi', 'shape', 'unknown', 'declined'].includes(obj.bodyMode)) out.bodyMode = obj.bodyMode;
  out.bodyHeight = num(obj.bodyHeight, 80, 230);
  out.bodyWeight = num(obj.bodyWeight, 20, 250);
  out.bodyWaist = num(obj.bodyWaist, 40, 200);
  if (['s', 'm', 'l', 'xl'].includes(obj.bodyShape)) out.bodyShape = obj.bodyShape;
  if (['none', 'lt5', 'ge5', 'unknown'].includes(obj.weightLoss)) out.weightLoss = obj.weightLoss;
  return out;
};

/** 从 '#p=xxx' 或 '?p=xxx' 里解出画像；两种都支持是为了旧链接不失效 */
export const decodeProfile = (input = '') => {
  const raw = String(input).replace(/^[?#]/, '');
  if (!raw) return null;
  const code = new URLSearchParams(raw).get('p');
  if (!code) return null;
  try {
    return sanitizeProfile(JSON.parse(unb64url(code)));
  } catch {
    return null;
  }
};

export const buildShareUrl = (profile) => {
  // 分享链接一律指向结果页入口：那里写死了 noindex，不会被搜索引擎当成正文收录。
  // 用相对路径构造，部署在子目录或本地都成立。
  const url = new URL('r.html', location.href);
  url.search = '';
  url.hash = 'p=' + encodeProfile(profile);
  return url.toString();
};

/* ---------------- 结果快照（v=2&s=，默认分享方式）----------------
 * 老板 2026-11-24 定的方向：默认分享"结果快照"，不再把原始病史答案塞进链接。
 *
 * 为什么不是简单地删掉 familyHistory / pastHistory / hpStatus 再分享：
 *   那几个字段直接决定清单里有没有「肠镜提前」「乳腺提前」「胃镜从几岁开始」。
 *   删掉再让对方重算，他看到的是一份"少了好几项"的清单 —— 和原主人的不一样，
 *   对一个"分享我算出来的清单"的功能，这是硬伤。
 *
 * 所以快照存的是**已经算好的清单本身**：可见规则 ID + 年龄/性别 + 生成日期。
 *   ① 不含任何原始问卷答案（家族史、既往史、幽门螺杆菌、吸烟年限……一概不带）；
 *   ② 接收方直接按规则 ID 渲染这份清单，不重跑引擎 —— 看到的和原主人一致；
 *   ③ 带生成日期，页面提示"规则更新后以原页为准"，避免旧快照和最新指南打架；
 *   ④ 老 '#p=' 链接一字不改继续兼容，历史分享不会失效。
 *
 * 快照只存 ID 不存规则内容：规则正文（verdict/依据/频次）永远从 rules.json 现取，
 * 这样某条依据被修正后，老快照点开看到的是更正后的原文，而不是当初的错字。
 */
export const SNAPSHOT_VERSION = 2;

/** 把当前展示的清单压成快照串。ids 是 {A:[],B:[],C:[]} 的可见规则 ID */
export const encodeSnapshot = ({ age, gender }, ids, date = new Date().toISOString().slice(0, 10)) => {
  const slim = {
    v: SNAPSHOT_VERSION,
    age: Number(age),
    gender: gender === 'female' ? 'female' : 'male',
    date: String(date).slice(0, 10),
    A: (ids?.A || []).map(String),
    B: (ids?.B || []).map(String),
    C: (ids?.C || []).map(String),
  };
  return b64url(JSON.stringify(slim));
};

/** 从 hash/search 里解出快照；不是 v=2 或字段不合法一律返回 null（当坏链接处理） */
export const decodeSnapshot = (input = '') => {
  const raw = String(input).replace(/^[?#]/, '');
  if (!raw) return null;
  const q = new URLSearchParams(raw);
  // 支持两种写法：#v=2&s=<code>  和  #s=<code>&v=2
  if (q.get('v') !== String(SNAPSHOT_VERSION)) return null;
  const code = q.get('s');
  if (!code) return null;
  try {
    const o = JSON.parse(unb64url(code));
    if (o.v !== SNAPSHOT_VERSION) return null;
    const age = Number(o.age);
    if (!Number.isInteger(age) || age < 18 || age > 149) return null;
    if (!['male', 'female'].includes(o.gender)) return null;
    const arr = (x) => Array.isArray(x) ? x.filter((i) => typeof i === 'string' && i.length < 80).slice(0, 120) : [];
    return {
      v: SNAPSHOT_VERSION, age, gender: o.gender,
      date: /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : '',
      A: arr(o.A), B: arr(o.B), C: arr(o.C),
    };
  } catch {
    return null;
  }
};

/** 默认分享链接：指向结果页的结果快照，不含原始病史 */
export const buildSnapshotUrl = (snapCode, base = (typeof location !== 'undefined' ? location.href : 'http://localhost/')) => {
  const url = new URL('r.html', base);
  url.search = '';
  url.hash = `v=${SNAPSHOT_VERSION}&s=${snapCode}`;
  return url.toString();
};

/** 依据页链接的快照版：把同一份快照带过去，并按规则 ID 定位锚点 */
export const buildSnapshotEvidenceUrl = (snapCode, anchor = '', base = (typeof location !== 'undefined' ? location.href : 'http://localhost/')) => {
  const url = new URL('e.html', base);
  url.search = '';
  url.hash = `v=${SNAPSHOT_VERSION}&s=${snapCode}` + (anchor ? `&a=${anchor}` : '');
  return url.toString();
};

/** 复制：优先 Clipboard API，失败回退到 execCommand */
export const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
};
