/**
 * 巡检判定的离线自测（不联网，跑得飞快）
 *
 * 为什么要有这个文件：巡检每周自动跑，它判错人不会立刻发现 ——
 *   · 判太松 → 每周一条噪声，几周后没人点开（等于没接）；
 *   · 判太严 → 指南真改了年龄/间隔也静默跳过（更危险，因为它看起来一切正常）。
 * 这两种错误都不是崩溃，测试是唯一能提前发现它们的地方。
 *
 * 用法：node tests/check-updates-unit.mjs
 */
import { summarize, keyNumbers, toSentences } from '../scripts/lib/diff-text.mjs';

let pass = 0;
const fails = [];

const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fails.push(name);
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

/** 造一段"像指南正文"的文字：句子够多，才不会把所有变化都算成抖动 */
const body = (extra = '') =>
  Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 段说明文字，讲筛查的对象与意义，本身不含关键年龄。`).join('') +
  extra;

/* ---------- 1. 关键数字变了 → 必须亮红 ---------- */

{
  const oldT = body('推荐对 50 to 75 years 的成年人进行年度筛查。');
  const newT = body('推荐对 45 to 75 years 的成年人进行年度筛查。');
  const s = summarize(oldT, newT);
  check('英文年龄区间 50→45 判为关键数字变化', s.numsChanged && !s.jitter, JSON.stringify(s.numsGone));
}

{
  const oldT = body('建议每五年做一次胃镜。');
  const newT = body('建议每三年做一次胃镜。');
  const s = summarize(oldT, newT);
  check('中文数字"每五年→每三年"判为关键数字变化', s.numsChanged, JSON.stringify({ added: s.numsAdded, gone: s.numsGone }));
}

{
  const oldT = body('建议从五十岁开始筛查。');
  const newT = body('建议从四十五岁开始筛查。');
  const s = summarize(oldT, newT);
  check('中文数字"五十岁→四十五岁"判为关键数字变化', s.numsChanged, JSON.stringify({ added: s.numsAdded, gone: s.numsGone }));
}

/* ---------- 2. 同义写法不能当成变化 ---------- */

{
  const s = summarize(body('建议每两年做一次。'), body('建议每 2 年做一次。'));
  check('"每两年"和"每 2 年"视为同一个数字', !s.numsChanged, JSON.stringify({ added: s.numsAdded, gone: s.numsGone }));
}

{
  const s = summarize(body('50 to 75 years'), body('50 to 75 years'));
  check('完全相同的正文判为无变化', !s.numsChanged && s.addedCount === 0);
}

/* ---------- 3. 版式噪声 → 不许吵人 ---------- */

{
  // 真实遇到过的情况：USPSTF 改版，多了一段导航/工具说明
  const oldT = body('推荐 50 to 75 years 每年一次。');
  const newT =
    body('推荐 50 to 75 years 每年一次。') + 'Return to Table of Contents Search and Filter All Recommendations.';
  const s = summarize(oldT, newT);
  check('只多一段导航文字 → 判为抖动，不报警', s.jitter && !s.numsChanged, `新增 ${s.addedCount} 句`);
}

{
  // 大段新增（比如加了"临床考量"整节），但关键数字没动 → 归 cosmetic，不是 changed
  const oldT = body('推荐 50 to 75 years 每年一次。');
  const newT =
    body('推荐 50 to 75 years 每年一次。') +
    Array.from({ length: 10 }, (_, i) => `新增的临床考量段落 ${i}，讨论获益与 harms 的平衡。`).join('');
  const s = summarize(oldT, newT);
  check('大段新增但数字没动 → 不算关键数字变化', !s.numsChanged && !s.jitter, `新增 ${s.addedCount} 句`);
}

/* ---------- 4. 给人看的那几句必须是人话 ---------- */

{
  // 导航残片里也有数字，不能被选中当"变化句"
  const oldT = body('推荐 50 to 75 years 每年一次。');
  const newT = body('推荐 45 to 75 years 每年一次。') + 'X'.repeat(400) + ' 2024 年指南。';
  const s = summarize(oldT, newT);
  check('变化句里不含超长残片', s.pick.every((p) => p.length <= 300), `pick ${s.pick.length} 句`);
  check('变化句优先带年龄/年数', s.pick.some((p) => /岁|年|years?/i.test(p)), JSON.stringify(s.pick[0] || ''));
}

/* ---------- 5. 切句与关键数字抽取的基本功 ---------- */

{
  check('切句不会切出空串', toSentences('甲。乙！丙？').every((s) => s.length > 0));
  const nums = keyNumbers('40 岁起，每 1–2 年一次，持续到 74 岁');
  check('一次抓全中文年龄', nums.has('40岁') && nums.has('74岁'), [...nums].join('/'));
  check('叙述性相对时间不当成间隔', !keyNumbers('本文梳理了近两年国内外研究').has('2年'));
  check('"每两年"这种间隔仍要抓', keyNumbers('建议每两年复查一次').has('2年'));
}

console.log(`\n${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  console.log('失败项：\n' + fails.map((f) => `  · ${f}`).join('\n'));
  process.exit(1);
}
