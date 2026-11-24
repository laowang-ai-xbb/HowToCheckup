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
const KEEP = [
  'age', 'gender', 'pregnant', 'smoking', 'packYears', 'secondhand', 'alcohol',
  'occupationDust', 'familyHistory', 'pastHistory', 'hpStatus',
  // P0/P1.0：年限决定 LDCT 结论，不带过去会让别人看到一份"换了个结论"的清单
  'smokingQuitYears', 'secondhandYears', 'occupationYears', 'occupationAgents',
  'symptomFlags', 'frailty', 'recentHospital',
  'fallHistory', 'gaitDifficulty', 'memoryConcern',
  // 体型（J10 方案 2）：不带过去，收到链接的人看到的清单和原主人不一样 ——
  // 清单本身不受影响，但结果页那张体型卡会缺，看着像坏了一半。
  'bodyMode', 'bodyHeight', 'bodyWeight', 'bodyWaist', 'bodyShape', 'weightLoss',
];

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
