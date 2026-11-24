/**
 * 两次抓取之间的"文字差异判定"
 *
 * 单独放在这里，是因为它决定了每周巡检要不要吵醒人：
 *   - 判太松 → 网页加个导航栏就报警，几周之后没人看了（警示疲劳）；
 *   - 判太严 → 指南真改了年龄区间也当没看见，那这个巡检等于没接。
 *
 * 所以只认一种信号：**关键数字的集合变了**。年龄、年数、月数、包年、剂量 ——
 * 这类数字一变，结论（该不该做、多少岁开始、隔几年）就得跟着改；
 * 其余版式、段落、推荐模块的增删，一律算噪声。
 */

/** 把文本切成句子，用来描述"哪里变了"（太短的碎片不算句子） */
export const toSentences = (t) =>
  t.split(/(?<=[。！？.!?])\s*/).map((s) => s.trim()).filter((s) => s.length > 8);

/**
 * 只抽"会改变结论的那种数字"。
 *
 * 实测过的噪声：USPSTF 页面改版会加 "Evidence Summary (May 09, 2017)"、加 Filter 模块、
 * 加 Return to Table of Contents —— 句子 diff 一片红，结论一个字没变。
 * 而 "50 to 75 years" 改成 "45 to 75 years"，才是真要把 verdict 跟着改的那种。
 */
const KEY_NUM = /\d+\s*(?:岁|年|个月|周|包年|mg|g\/d)|(?:age|aged)\s*\d+|\d+\s*to\s*\d+\s*years?/gi;

/**
 * 中文数字：国内指南大量写"每两年""五十岁""隔五年"，只认阿拉伯数字会整段漏掉。
 * 归一化成 "2年" / "50岁"，与"每 2 年""50 岁"落到同一个 key 上，才不会把同义写法当变化。
 */
const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

const cnToInt = (s) => {
  if (s.length === 1) return CN_DIGIT[s];
  const i = s.indexOf('十');
  if (i < 0) return NaN; // 比如"三五"这种口语连写，不猜
  const high = i === 0 ? 1 : CN_DIGIT[s.slice(0, i)];
  const low = i === s.length - 1 ? 0 : CN_DIGIT[s.slice(i + 1)];
  return high * 10 + low;
};

const KEY_NUM_CN = /[零一二两三四五六七八九十]{1,3}\s*(?:岁|年|个月|周)/g;

/**
 * 叙述性相对时间不是筛查间隔：实测正文里有"近两年国内外研究""前五年数据"这类句子，
 * 把它当关键数字，改个措辞就报一次警。注意不能连"每"一起排除 ——"每两年"正是要抓的那种。
 */
const CN_NOISE_PREFIX = /[近前这那几数]/;

export const keyNumbers = (t) => {
  const out = new Set((t.match(KEY_NUM) || []).map((s) => s.replace(/\s+/g, '').toLowerCase()));
  for (const m of t.matchAll(KEY_NUM_CN)) {
    const prev = m.index > 0 ? t[m.index - 1] : '';
    if (CN_NOISE_PREFIX.test(prev)) continue;
    const compact = m[0].replace(/\s+/g, '');
    const unit = compact.match(/岁|年|个月|周/)[0];
    const n = cnToInt(compact.slice(0, compact.length - unit.length));
    if (Number.isFinite(n)) out.add(`${n}${unit}`);
  }
  return out;
};

/**
 * @param {string} oldText 仓库里快照的正文（上一版）
 * @param {string} newText 刚从线上抓到的正文
 * @returns {{addedCount:number, jitter:boolean, numsAdded:string[], numsGone:string[],
 *            numsChanged:boolean, pick:string[]}}
 *   jitter    — 只是抖了一下，不值得报
 *   numsChanged — 关键数字变了，结论可能要跟着改
 *   pick      — 给人看的三句，优先"带数字且说的是年龄/间隔"的句子
 */
export const summarize = (oldText, newText) => {
  const before = new Set(toSentences(oldText));
  const after = toSentences(newText);
  const added = after.filter((s) => !before.has(s));
  const total = after.length || 1;

  const oldNums = keyNumbers(oldText);
  const newNums = keyNumbers(newText);
  const numsAdded = [...newNums].filter((n) => !oldNums.has(n));
  const numsGone = [...oldNums].filter((n) => !newNums.has(n));
  const numsChanged = numsAdded.length + numsGone.length > 0;

  // 挑给人看的那几句：优先"带数字 + 说的是年龄/年数"。
  // 不能只筛 \d —— 导航栏拼接出来的残片里也有数字，贴在告警里等于没给信息。
  const clean = added.filter((s) => s.length <= 300);
  const withNumber = clean.filter((s) => /\d/.test(s));
  const withNumberAboutTime = withNumber.filter((s) =>
    /岁|年|月|周|年龄|years?|aged?|interval/i.test(s),
  );
  const candidate = withNumberAboutTime.length ? withNumberAboutTime : withNumber.length ? withNumber : clean;

  const jitter = !numsChanged && added.length / total < 0.05;
  return {
    addedCount: added.length,
    jitter,
    numsAdded: numsAdded.slice(0, 8),
    numsGone: numsGone.slice(0, 8),
    numsChanged,
    pick: (numsChanged ? candidate : []).slice(0, 3),
  };
};
