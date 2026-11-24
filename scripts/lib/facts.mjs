/**
 * 临床事实模型（P1.0）
 *
 * 旧画像是一堆平字段：smoking / packYears / secondhand / familyHistory …
 * 每来一条新指南要问"戒了几年""被动吸了几年"，就得改 schema、改问卷、改分享编码、
 * 改校验器 —— 发现一个改一次，就是打地鼠。
 *
 * 这一层把画像投影成"临床事实"：暴露自带剂量和时间，每条事实都有三态
 *   具体值 / 'unknown'（用户说不清）/ null（没答过）
 * 规则读事实，新增指南大多只改规则与一两道题，不再动引擎主干。
 *
 * 纯函数、无 Node 依赖：浏览器和 CLI 校验共用同一份实现。
 */

export const UNKNOWN = 'unknown';

/** 用户主动说不清的取值集合（与 schema 的 unknown 对齐） */
const isUnknown = (v) => v === UNKNOWN || v === '记不清' || v === '不确定';

const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : UNKNOWN);

/** 把旧画像投影成结构化事实。只读，不修改入参。 */
export const toFacts = (p = {}) => {
  const smokingStatus = p.smoking === 'yes' ? 'current'
    : p.smoking === 'quit' ? 'quit'
      : p.smoking === 'no' ? 'never'
        : p.smoking === 'declined' ? 'declined' : UNKNOWN;

  // 老分享链接没有戒烟年限：落 unknown（说不清），绝不落"没戒"或"戒很久"
  const quitYears = smokingStatus === 'quit'
    ? (p.smokingQuitYears || UNKNOWN)
    : smokingStatus === 'current' ? 0 : null;

  const secondhand = {
    kind: 'secondhand',
    status: p.secondhand === 'yes' ? 'yes' : p.secondhand === 'no' ? 'no' : UNKNOWN,
    years: p.secondhand === 'yes' ? (p.secondhandYears || UNKNOWN)
      : p.secondhand === 'no' ? 0 : UNKNOWN,
  };

  const occupational = {
    kind: 'occupational',
    status: p.occupationDust === 'yes' ? 'yes' : p.occupationDust === 'no' ? 'no' : UNKNOWN,
    // 具体致癌物走新题；老链接没有这题时，退回到旧的职业类别做保守提示
    agents: arr(p.occupationAgents).length ? arr(p.occupationAgents) : arr(p.occupationTypes),
    years: p.occupationDust === 'yes' ? (p.occupationYears || UNKNOWN)
      : p.occupationDust === 'no' ? 0 : UNKNOWN,
  };

  const familyHistory = arr(p.familyHistory)
    .filter((x) => typeof x === 'string' && x !== UNKNOWN && x !== 'declined')
    .map((cancer) => ({ cancer, relation: 'first', diagnosisAge: p.familyDiagnosisAge || UNKNOWN }));

  const results = [];
  if (p.hpStatus) {
    results.push({
      item: 'hp',
      outcome: p.hpStatus === 'positive' ? 'positive'
        : p.hpStatus === 'negative' ? 'negative' : UNKNOWN,
      date: null,
    });
  }

  const symptomFlags = arr(p.symptomFlags).filter((x) => x && x !== 'none');
  return {
    exposures: [
      {
        kind: 'smoking',
        status: smokingStatus,
        packYears: typeof p.packYears === 'number' ? p.packYears : UNKNOWN,
        quitYears,
      },
      secondhand,
      occupational,
    ],
    familyHistory,
    results,
    status: {
      age: Number(p.age) || 0,
      gender: p.gender || null,
      pregnant: p.pregnant || null,
      symptomatic: symptomFlags.length > 0,
      symptomFlags,
      frailty: p.frailty || UNKNOWN,
      recentHospital: p.recentHospital || UNKNOWN,
    },
  };
};

/** 按 kind 取暴露事实 */
export const exposure = (facts, kind) =>
  (facts.exposures || []).find((e) => e.kind === kind) || null;

/** 是否存在某癌种家族史 */
export const family = (facts, cancer) =>
  (facts.familyHistory || []).some((f) => f.cancer === cancer);

/** 取某项检查结果 */
export const result = (facts, item) =>
  (facts.results || []).find((r) => r.item === item) || null;

/** 2025 指南点名的职业致癌物；普通"粉尘"不等于致癌物暴露 */
const OCC_CARCINOGENS = ['radon', 'arsenic', 'beryllium', 'chromium', 'asbestos',
  'chloromethyl', 'silica', 'coke', 'soot'];
/** 旧职业类别只在没有新题时兜底；建筑/其他不算明确致癌物 */
const LEGACY_OCC_CARCINOGENS = ['mining', 'welding'];

/**
 * 肺癌 LDCT 准入判定（《中国肺癌低剂量 CT 筛查指南（2025 年版）》）
 *
 * 返回 eligible / indeterminate / fields / reasons / legacyDispute：
 *   indeterminate = 算不出来（信息不足），绝不能被当成"不用做"；
 *   legacyDispute = 按 USPSTF/ACS 等宽松口径可能符合，与 2025 中国指南不一致 → 交给医生。
 */
export const lungLDCT2025 = (facts) => {
  const smoke = exposure(facts, 'smoking');
  const sh = exposure(facts, 'secondhand');
  const occ = exposure(facts, 'occupational');
  const age = facts.status.age;
  const reasons = [];
  const indeterminate = [];
  let eligible = false;
  let legacyDispute = false;

  const pack = smoke?.packYears;
  const pack20 = typeof pack === 'number' && pack >= 20;
  const pack15 = typeof pack === 'number' && pack >= 15;
  const sh20 = sh?.years === 'ge20';
  const sh15 = sh?.years === 'ge20' || sh?.years === 'ge15';

  // ① 吸烟 ≥20 包年（仍在吸或戒烟≤5 年），或被动吸烟 ≥20 年
  const quitOk = smoke?.status === 'current'
    || (smoke?.status === 'quit' && (smoke.quitYears === 'lt5' || smoke.quitYears === 0));
  if (pack20 && quitOk) { eligible = true; reasons.push('吸烟≥20 包年且仍在吸或戒烟≤5 年'); }
  if (sh20) { eligible = true; reasons.push('被动吸烟≥20 年'); }

  // ② 明确职业致癌物：≥5 年，或高强度 ≥1 年
  const agents = arr(occ?.agents);
  const knownAgent = agents.some((a) => OCC_CARCINOGENS.includes(a))
    || (!agents.some((a) => OCC_CARCINOGENS.includes(a))
      && agents.some((a) => LEGACY_OCC_CARCINOGENS.includes(a)));
  const yearsOk = occ?.years === 'ge5' || occ?.years === 'high1';
  if (knownAgent && yearsOk) { eligible = true; reasons.push('明确职业致癌物暴露达指南年限'); }

  // ③ 家族史合并本人吸烟≥15 包年或被动吸烟≥15 年
  const hasLungFH = family(facts, 'lung');
  if (hasLungFH && (pack15 || sh15)) { eligible = true; reasons.push('肺癌家族史合并吸烟暴露'); }

  // 宽松口径：戒烟≤15 年（USPSTF 2021 / ACS 2023）/ 职业≥1 年 / 家属史单独成立
  if (!eligible && ((pack20 && smoke?.quitYears === 'ge5')
    || (knownAgent && occ?.years === 'lt5') || hasLungFH)) legacyDispute = true;

  // 信息不足不能静默按"没有"处理
  if (smoke?.status === 'quit' && isUnknown(smoke.quitYears)) indeterminate.push('戒烟年限');
  if (sh?.status === 'yes' && isUnknown(sh.years)) indeterminate.push('被动吸烟年限');
  if (occ?.status === 'yes' && isUnknown(occ.years)) indeterminate.push('职业暴露年限');

  return {
    eligible: eligible && age >= 50 && age <= 80,
    indeterminate: indeterminate.length > 0,
    fields: indeterminate,
    reasons,
    legacyDispute,
  };
};

/** 筛查前提三闸：症状 / 衰弱与预期寿命 / 年龄超范围 */
export const gates = (facts) => {
  const s = facts.status;
  return {
    symptomStop: s.symptomatic === true,
    frailDowngrade: s.age > 100 || s.frailty === 'yes' || s.recentHospital === 'ge2',
    ageOutOfScope: s.age > 100 || s.age < 18,
  };
};

/** 给规则/字段用的别名，保持外部 API 稳定 */
export const toClinicalFacts = toFacts;
