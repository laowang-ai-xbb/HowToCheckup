#!/usr/bin/env node
/**
 * 体型与酒精的界面守卫（R2 / R3 / J10）。
 *
 * 为什么这几条要用断言钉住：错的都不是"报错"，而是"说了一句不该说的话"。
 *   · 65 岁的人被叫「肥胖」—— 页面不报错，但那句话伤人，而且对他没有可操作的意义；
 *   · 方案 1 出现「偏瘦 / 正常 / 偏胖 / 肥胖」—— 老板点名不要，改回去也不报错；
 *   · 「安全饮酒量」—— 一旦出现，等于替酒精背书，这是内容风险，不是笔误。
 * 这三件事都只能靠机器守。
 *
 * 用法：node tests/body-unit.mjs
 */
import { readFileSync } from 'node:fs';
import {
  bmiOf, bodyLevel, cutsFor, waistLevel, weightLossNote, bodyOf, BMI_CUTS, adviceFor, BODY_EVIDENCE,
} from '../src/body.js';
import { SHAPE_OPTIONS, questions } from '../src/questions.js';
import { emptyProfile } from '../src/engine.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name} — ${detail}`); }
};

/* ---- 1. BMI 计算本身 ---- */
check('1.65 米 62 公斤 → BMI 22.8', bmiOf(165, 62) === 22.8, String(bmiOf(165, 62)));
check('1.70 米 80 公斤 → BMI 27.7', bmiOf(170, 80) === 27.7, String(bmiOf(170, 80)));
check('身高 0 不硬算（返回 null 而不是 Infinity）', bmiOf(0, 60) === null);
check('体重 999 不硬算（越界当没填）', bmiOf(170, 999) === null);
check('身高 40cm 不硬算', bmiOf(40, 20) === null);

/* ---- 2. 18–64 岁：三刀四点 ---- */
const at = (bmi, age) => bodyLevel(bmi, age).label;
check('30 岁 18.4 → 偏低', at(18.4, 30) === '偏低', at(18.4, 30));
check('30 岁 18.5 → 正常', at(18.5, 30) === '正常', at(18.5, 30));
check('30 岁 23.9 → 正常', at(23.9, 30) === '正常', at(23.9, 30));
check('30 岁 24.0 → 偏高', at(24.0, 30) === '偏高', at(24.0, 30));
check('30 岁 27.9 → 偏高', at(27.9, 30) === '偏高', at(27.9, 30));
check('30 岁 28.0 → 肥胖', at(28.0, 30) === '肥胖', at(28.0, 30));

/* ---- 3. 65 岁起换一套界值，而且不许出现「肥胖」 ---- */
check('65 岁用的是 senior 那套', cutsFor(65).key === 'senior', cutsFor(65).key);
check('79 岁仍是 senior', cutsFor(79).key === 'senior', cutsFor(79).key);
check('80 岁换 oldest 那套', cutsFor(80).key === 'oldest', cutsFor(80).key);
check('65 岁 19.9 → 偏低（按年轻人标准算正常，这是关键区别）', at(19.9, 65) === '偏低', at(19.9, 65));
check('65 岁 20.0 → 正常', at(20.0, 65) === '正常', at(20.0, 65));
check('65 岁 26.9 → 正常', at(26.9, 65) === '正常', at(26.9, 65));
check('65 岁 27.0 → 偏高', at(27.0, 65) === '偏高', at(27.0, 65));
check('65 岁 BMI 30 也只到「偏高」，不是肥胖', at(30, 65) === '偏高', at(30, 65));
check('80 岁 21.9 → 偏低', at(21.9, 80) === '偏低', at(21.9, 80));
check('80 岁 22.0 → 正常', at(22.0, 80) === '正常', at(22.0, 80));
check('80 岁 26.9 → 正常', at(26.9, 80) === '正常', at(26.9, 80));
check('80 岁 27.0 → 偏高', at(27.0, 80) === '偏高', at(27.0, 80));

/* 65 岁以上任何数值、任何文案里都不许出现「肥胖」二字 */
const seniorText = [];
for (let bmi = 14; bmi <= 40; bmi += 0.1) {
  const lv = bodyLevel(Math.round(bmi * 10) / 10, 72);
  seniorText.push(lv.label, lv.say, lv.range, ...lv.advice.flatMap((x) => [x.t, x.d]));
}
check('65–79 岁全区间文案不含「肥胖」', !seniorText.join('').includes('肥胖'));
const oldestText = [];
for (let bmi = 14; bmi <= 40; bmi += 0.1) {
  const lv = bodyLevel(Math.round(bmi * 10) / 10, 85);
  oldestText.push(lv.label, lv.say, lv.range, ...lv.advice.flatMap((x) => [x.t, x.d]));
}
check('80 岁以上全区间文案不含「肥胖」', !oldestText.join('').includes('肥胖'));

/* ---- 4. 腰围 ---- */
check('男性 90 厘米算超标', waistLevel(90, 'male', 40).over === true);
check('男性 89 厘米不算', waistLevel(89, 'male', 40).over === false);
check('女性 85 厘米算超标', waistLevel(85, 'female', 40).over === true);
check('腰围 0 不出提示（不占版面）', waistLevel(0, 'male', 40) === null);
check('老人腰围文案不写「肥胖」', !(waistLevel(95, 'male', 70).say.includes('肥胖')));

/* ---- 5. 掉秤 ---- */
const loss = weightLossNote('ge5', 60);
check('掉 5% 以上会提示肌少症', loss && loss.sarcopenia === true);
check('把 5% 折算成公斤（60kg → 3kg）', !!loss && loss.say.includes('3 公斤'), loss?.say?.slice(0, 40));
check('掉秤改为先就医，不说清单能替代面诊', /先找医生评估/.test(loss.say) && /替代不了面诊/.test(loss.say), loss?.say);
check('掉秤提示给出可挂的科室', /老年医学科/.test(loss.say) && /全科医学科/.test(loss.say) && /普通内科/.test(loss.say), loss?.say);
check('掉不到 5% 不提示', weightLossNote('lt5', 60) === null);
check('不确定不提示', weightLossNote('unknown', 60) === null);

/* ---- 6. bodyOf 的三种形态 ---- */
const p = (x) => ({ ...emptyProfile(), age: 40, gender: 'male', ...x });
check('填了数 → known 且算出 BMI', bodyOf(p({ bodyHeight: 170, bodyWeight: 80 })).bmi === 27.7);
check('不确定 → known 为 false 且 mode 保留', (() => {
  const b = bodyOf(p({ bodyMode: 'unknown' }));
  return b.known === false && b.mode === 'unknown';
})());
check('降级选尺码 → shape 保留、不算 BMI', (() => {
  const b = bodyOf(p({ bodyMode: 'shape', bodyShape: 'l' }));
  return b.shape === 'l' && b.bmi === null;
})());
check('40 岁不问腰围和掉秤（腰围不占版面）', bodyOf(p({ bodyHeight: 170, bodyWeight: 80, bodyWaist: 95, weightLoss: 'ge5' })).waist === null);
check('70 岁才给腰围与掉秤', (() => {
  const b = bodyOf({ ...emptyProfile(), age: 70, gender: 'male', bodyHeight: 170, bodyWeight: 80, bodyWaist: 95, weightLoss: 'ge5' });
  return b.waist !== null && b.loss !== null;
})());

/* ---- 7. 方案 1 的词表（老板 J10 的硬要求） ---- */
const banned = ['偏瘦', '正常', '偏胖', '肥胖'];
const shapeText = SHAPE_OPTIONS.map((o) => `${o.l}${o.sub || ''}`).join('');
check('方案 1 四个选项不含偏瘦/正常/偏胖/肥胖', !banned.some((w) => shapeText.includes(w)), shapeText);
check('方案 1 有四个档', SHAPE_OPTIONS.length === 4);
check('方案 1 每题都有说明（不能只有选项名）', SHAPE_OPTIONS.every((o) => o.sub && o.sub.length > 3));

/* ---- 8. 体型题不是"选体型"，是"填数字" ---- */
const bodyQ = questions.find((q) => q.key === 'body');
check('体型题存在且是数值题', !!bodyQ && bodyQ.kind === 'body');
check('体型题不再让用户自选档位（没有 options）', !bodyQ.options);
check('体型题列出它填的 5 个字段', (bodyQ.fields || []).length === 5, (bodyQ.fields || []).join(','));
check('体型题的说明里解释了 BMI 是什么', /BMI 就是体重除以身高的平方/.test(bodyQ.hint));

/* ---- 9. 酒精（R2）：老板 2026-11-22 要求提示只留一句"估一下"，数字上限与
       "没有安全饮酒量"那段整段删掉 —— 那些解释留在数据层，不上题面。 ---- */
const alcohol = questions.find((q) => q.key === 'alcohol');
check('酒精题提示只留"估一下"一句', /一周几次/.test(alcohol.hint) && /不用精确/.test(alcohol.hint) && alcohol.hint.length <= 30, alcohol.hint);
check('酒精题不再在题面摆 140/80 克上限', !/140|80 克/.test(alcohol.hint));
check('酒精题不问「算不算经常」（那是让用户下判断）', !/经常/.test(alcohol.options.map((o) => o.l).join('')));

const mainText = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const srcText = readFileSync(new URL('../src/questions.js', import.meta.url), 'utf8')
  + mainText
  + readFileSync(new URL('../src/body.js', import.meta.url), 'utf8');
check('产品文案里不出现「安全饮酒量」', !srcText.includes('安全饮酒量'));
check('产品文案里不出现「适量饮酒」', !srcText.includes('适量饮酒'));

/* 词表禁令只覆盖「方案 1」这条路，不覆盖整个产品：
 * BMI 那条路上，孩子那句「老人偏瘦不是好事」说的是事实，也该说。
 * 所以这里只查降级态的四段说明（SHAPE_SAY）+ 那句兜底文案，别扩大到全站 ——
 * 一条比老板要求更严的检查，会逼着以后的我把对的文案改错。
 *
 * 边界也要划清：机构名里就带「肥胖」三个字（中国营养学会肥胖防控分会）。
 * 所以切到 bodyEvidenceHTML 之前为止，不把依据那句 hint 算进来。 */
const shapeSayBlock = mainText.slice(mainText.indexOf('const SHAPE_SAY'), mainText.indexOf('const bodyEvidenceHTML'))
  + (mainText.match(/[^`'\n]*准不到哪去[^`'\n]*/) || [''])[0];
check('降级态的说明不含偏瘦/正常/偏胖/肥胖', !banned.some((w) => shapeSayBlock.includes(w)), shapeSayBlock.slice(0, 80));
check('方案 1 的四个选项在 main.js 里被引用（不是散落一套新的）', /SHAPE_OPTIONS\.map/.test(mainText));

/* ---- 10. 体型这块要按数值给"该做什么"，而且自己带依据（老板 R8 第 1 条） ---- */
check('偏高给 3 条能做的主张', bodyLevel(27, 40).advice.length === 3, String(bodyLevel(27, 40).advice.length));
check('成人偏低换一套（先找原因）', bodyLevel(17, 40).advice[0].t.includes('找原因'), bodyLevel(17, 40).advice[0].t);
check('老人偏低明确先找医生评估', bodyLevel(18, 70).advice[0].t.includes('先找医生评估') && bodyLevel(18, 70).advice[0].d.includes('替代不了面诊'), bodyLevel(18, 70).advice[0].t);
check('正常也给一条（保持就行）', bodyLevel(21, 40).advice.length === 1, bodyLevel(21, 40).advice[0]?.t);
check('三档的建议内容互不相同', new Set(['low', 'ok', 'high', 'obese'].map((x) => JSON.stringify(adviceFor(x, 40)))).size === 4);
check('老人与成人的减重那句不一样（肌肉/反弹）',
  adviceFor('high', 70)[2].d !== adviceFor('high', 40)[2].d);
check('体型有依据，且指向共识原文', /《中国居民肥胖防治专家共识》/.test(BODY_EVIDENCE.org) && BODY_EVIDENCE.url.startsWith('https://doi.org/'));
check('体型卡把依据画出来', /bodyEvidenceHTML\(\)/.test(mainText) && /BODY_EVIDENCE/.test(mainText));
check('那句"不改变清单"的免责已经删掉', !/体型不参与上面清单的判定/.test(mainText) && !/不改变上面任何一条/.test(mainText));
check('降级态也说明这句提示不准', /准不到哪去/.test(mainText));
check('掉秤提示同时提到肌少症', /肌少症/.test(readFileSync(new URL('../src/body.js', import.meta.url), 'utf8')));

console.log(`\n${pass}/${pass + fail} 通过`);
if (fail) process.exit(1);
