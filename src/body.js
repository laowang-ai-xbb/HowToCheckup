// SPDX-License-Identifier: MIT
// Copyright (c) 2026 老王AI瞎bb
// See LICENSE at the repository root.

/**
 * 体型（BMI / 腰围 / 掉秤）的判定，全部收在这一个文件里。
 *
 * 为什么单独拆出来：这套界值要同时被问卷页、结果页、三个结果页 demo 和测试脚本用。
 * 以前 BMI 那题是"用户自己选四档"，界值只写在折叠说明里，改一处不影响别处 ——
 * 现在界值真的参与文案判定，复制到第四处就一定会漂移，所以只留一份。
 *
 * R3 的结论（老板 2026-11-21 已确认）：
 *   · 18–64 岁：用中国成人标准 18.5 / 24.0 / 28.0（WS/T 428—2013）。
 *   · 65–79 岁：适宜范围 20.0–26.9，低于 20.0 偏低、高于 26.9 偏高。
 *   · 80 岁及以上：适宜范围 22.0–26.9（老人太瘦的风险比微胖更大）。
 *   · 65 岁起不出现「肥胖」这个词 —— 这一档在老人身上没有可操作的行动，
 *     只会变成一句难听的话。只判偏低 / 正常 / 偏高。
 */

/** 三套界值。adult 多一个 obese 切点，老人那两套刻意没有。
 *
 * highAt 说明 high 这个数算哪一边 —— 这不是洁癖，是两套标准写法本来就不一样：
 *   成人：18.5 / 24.0 / 28.0 都是「下一段的起点」，24.0 就已经是偏高；
 *   老人：20.0–26.9 是适宜范围，26.9 本身还在范围内，27.0 才算偏高。
 * 用法上一律靠这个字段判断，别在调用处各自 +0.1 糊过去。
 */
export const BMI_CUTS = {
  adult: { low: 18.5, high: 24.0, obese: 28.0, highAt: 'inclusive' },
  senior: { low: 20.0, high: 26.9, highAt: 'above' },   // 65–79
  oldest: { low: 22.0, high: 26.9, highAt: 'above' },   // 80+
};

/** 腰围切点（厘米）：中国标准，男 ≥90、女 ≥85 算中心性肥胖 */
export const WAIST_CUT = { male: 90, female: 85 };

/**
 * 按档位给的「该做什么」，只写共识里真写了的事，不写"注意饮食多运动"这种放之四海皆准的空话。
 * 老板 R8 第 1 条：体型这块不要一句总结，要按 BMI 档位给能照着做的事。
 */
const ADVICE = {
  high: (old) => [
    { t: '把体重和腰围记下来', d: '每 3 个月量一次。腰围比体重更能说明肚子里的脂肪。' },
    { t: '每年查血压、血糖、血脂', d: '这三项已经在「每年都做」里，别漏。' },
    { t: '真要减重，去营养科或内分泌门诊定方案', d: old ? '别自己饿 —— 掉的多是肌肉，老人的肌肉掉下去很难长回来。' : '别自己饿 —— 掉的多是肌肉和水，很快反弹。' },
  ],
  obese: (old) => [
    { t: '把体重和腰围记下来', d: '每 3 个月量一次。腰围比体重更能说明肚子里的脂肪。' },
    { t: '每年查血压、血糖、血脂，加做腹部超声', d: '这一档和脂肪肝、糖尿病、睡眠呼吸暂停的关系最紧。' },
    { t: '去营养科或内分泌门诊定减重方案', d: old ? '别自己饿 —— 掉的多是肌肉，老人的肌肉掉下去很难长回来。' : '别自己饿 —— 掉的多是肌肉和水，很快反弹。' },
  ],
  low: (old) => [{
    t: old ? '体重偏低，先找医生评估' : '体重偏低，先找原因',
    d: old
      ? '这份体检清单替代不了面诊。先挂老年医学科、全科医学科或普通内科；医生会判断是吃得不够、慢性病消耗，还是药物影响。'
      : '甲亢、吸收不良、情绪问题都会让人掉秤，比"多吃点"更要紧。',
  }],
  ok: () => [{ t: '保持就行', d: '每年体检量一次体重和腰围，不用额外做什么。' }],
};

/** 档位 → 建议清单（未知档位给空数组，卡片上就不摆这块） */
export const adviceFor = (level, age) => {
  const f = ADVICE[level];
  return f ? f(Number(age) >= 65) : [];
};

/** 依据：体型这块只有一条，但它同时管着界值、"查血压血糖血脂"和腰围三件事。
 *  形状与 rules.json 里的 evidence 一致，好让结果页的折叠表和依据页的卡片共用一套排版。
 *  quotes 特意留空：这份共识我们手上没有可逐字摘的原文，宁可只给结论 + 出处，
 *  也不编一句"原文"——依据页那句"逐字可核"是产品立身的地方。 */
export const BODY_EVIDENCE = {
  org: '中国营养学会肥胖防控分会、临床营养分会等《中国居民肥胖防治专家共识》',
  year: '2022',
  strength: 'consensus',
  cite: '中华流行病学杂志, 2022, 43(5): 609-626',
  url: 'https://doi.org/10.3760/cma.j.cn112338-20220402-00253',
  point: '中国目前以 BMI ≥ 24.0 为成人超重、≥ 28.0 为成人肥胖；以腰围男性 ≥ 90.0 cm、女性 ≥ 85.0 cm 判定成人中心性肥胖。共识把「血压、血糖、血脂检测」列为超重/肥胖者的健康风险评估内容。',
  quotes: [],
  note: 'BMI 界值、腰围界值、以及"超重/肥胖者应查血压血糖血脂"，都出自这份共识。',
};

/** 身高体重的合法区间：超出就当没填，不硬算（182cm/9kg 这种一定会算出荒唐的数） */
export const inRange = (h, w) => h >= 80 && h <= 230 && w >= 20 && w <= 250;

/** 算 BMI，保留一位小数；两个数不合法返回 null */
export const bmiOf = (hCm, wKg) => {
  const h = Number(hCm);
  const w = Number(wKg);
  if (!inRange(h, w)) return null;
  return Math.round((w / (h / 100) ** 2) * 10) / 10;
};

/** 该用哪套界值 */
export const cutsFor = (age) => {
  const a = Number(age) || 0;
  if (a >= 80) return { key: 'oldest', ...BMI_CUTS.oldest };
  if (a >= 65) return { key: 'senior', ...BMI_CUTS.senior };
  return { key: 'adult', ...BMI_CUTS.adult };
};

/**
 * BMI → 档位 + 一句人话。
 * level: low / ok / high / obese / unknown
 * 「肥胖」只在 65 岁以下出现，见文件头。
 */
export const bodyLevel = (bmi, age) => {
  if (bmi === null || bmi === undefined || Number.isNaN(Number(bmi))) {
    return { level: 'unknown', label: '', say: '', range: '', advice: [] };
  }
  const v = Number(bmi);
  const c = cutsFor(age);
  const ageN = Number(age) || 0;
  const range = c.key === 'adult'
    ? '18.5–23.9 是正常，24.0–27.9 偏高，28.0 起是肥胖'
    : `${c.low.toFixed(1)}–${c.high.toFixed(1)} 是适宜范围`;

  if (v < c.low) {
    return {
      level: 'low',
      label: '偏低',
      range,
      advice: adviceFor('low', ageN),
      say: ageN >= 65
        ? '老人偏瘦不是好事：体重和肌肉一起掉，跌倒、骨折、住院的风险都会上去。这一档值得在体检时跟医生提一句，别只当"有钱难买老来瘦"。'
        : '体重偏低本身也是个信号，值得查一次原因（甲亢、吸收不良、情绪问题都会这样），别只当"瘦点好"。',
    };
  }
  if (c.obese && v >= c.obese) {
    return {
      level: 'obese',
      label: '肥胖',
      range,
      advice: adviceFor('obese', ageN),
      say: '这一档和脂肪肝、糖尿病、睡眠呼吸暂停的关系最紧。基础套餐里的腹部超声、空腹血糖、血脂别省，也别只盯体重一个数。',
    };
  }
  const overHigh = c.highAt === 'inclusive' ? v >= c.high : v > c.high;
  if (overHigh && !(c.obese && v >= c.obese)) {
    return {
      level: 'high',
      label: '偏高',
      range,
      advice: adviceFor('high', ageN),
      say: '要管的不是体重一个数：血压、血糖、血脂这三项也得一起看。',
    };
  }
  return {
    level: 'ok',
    label: '正常',
    range,
    advice: adviceFor('ok', ageN),
    say: ageN >= 65
      ? '这个范围对老人是合适的。不用为体重额外做什么，倒是要留意别在半年里悄悄掉下去。'
      : '这一档不用为体重额外做什么。',
  };
};

/** 腰围判定。低于切点返回 null（不占版面，也不说一句"你腰围很好"来凑字）。 */
export const waistLevel = (cm, gender, age) => {
  const v = Number(cm);
  if (!(v >= 40 && v <= 200)) return null;
  const cut = WAIST_CUT[gender] || WAIST_CUT.male;
  const over = v >= cut;
  if (!over) return { over: false, cut, say: '' };
  return {
    over: true,
    cut,
    say: Number(age) >= 65
      ? `腰围 ${v} 厘米，超过了 ${cut} 厘米这条线。老人肚子大、体重却不高，是最容易被漏掉的一种 —— 肌肉少、内脏脂肪多。`
      : `腰围 ${v} 厘米，超过了 ${cut} 厘米这条线。这叫中心性肥胖：体重可能还正常，但脂肪长在肚子里，和血糖、血脂的关系更紧。`,
  };
};

/**
 * 掉秤。
 * 只认「近一年掉了 5% 以上」这一个切点：非计划性体重下降超过 5%，
 * 是老年肌少症和消耗性疾病共同的红旗，也是体检时最容易被漏问的一句。
 */
export const WEIGHT_LOSS = {
  none: '基本没变',
  lt5: '掉了一点，不到 5%',
  ge5: '掉了 5% 以上',
  unknown: '不确定',
};

export const weightLossNote = (value, weightKg) => {
  if (value !== 'ge5') return null;
  const w = Number(weightKg);
  const kg = w > 0 ? Math.round(w * 0.05 * 10) / 10 : null;
  return {
    sarcopenia: true,
    say: `一年内非计划地掉了 5% 以上${kg ? `（按你 ${w} 公斤算，就是 ${kg} 公斤以上）` : ''}。可能是肌少症（肌肉流失，握力、走路速度都会掉），也可能是别的病在消耗。先找医生评估，这份体检清单替代不了面诊。先挂老年医学科 / 全科医学科 / 普通内科；医生会按情况决定要不要转营养科、内分泌科或消化内科。把"不是主动减肥"这句话当面告诉医生。`,
  };
};

/** 把画像里的体型字段收成一个对象，页面和 demo 都只用这一个入口 */
export const bodyOf = (profile) => {
  const age = Number(profile?.age) || 0;
  const mode = profile?.bodyMode || 'bmi';
  const bmi = mode === 'bmi' ? bmiOf(profile?.bodyHeight, profile?.bodyWeight) : null;
  const level = mode === 'bmi' ? bodyLevel(bmi, age) : { level: 'unknown', label: '', say: '', range: '', advice: [] };
  return {
    mode,
    known: bmi !== null,
    bmi,
    ...level,
    waist: age >= 65 ? waistLevel(profile?.bodyWaist, profile?.gender, age) : null,
    loss: age >= 65 ? weightLossNote(profile?.weightLoss, profile?.bodyWeight) : null,
    shape: mode === 'shape' ? (profile?.bodyShape || '') : '',
  };
};
