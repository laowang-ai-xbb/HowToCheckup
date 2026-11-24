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

/* ---------- 6. 发布方目录监控：新增标题要报，导航碎片不报 ---------- */
{
  const { extractTitles, newTitles } = await import('../scripts/lib/catalog-watch.mjs');
  const page = [
    '首页',
    '中国肺癌低剂量CT筛查指南（2025年版）发布',
    '    ',
    '关于2024年度工作总结的公告',
    'Recommendation: Lung Cancer Screening in Adults',
    'Home  Search  Login  Contact  About  More',
    '中华医学会糖尿病学分会 中国2型糖尿病防治指南（2025年版）',
  ].join('\n');
  const titles = extractTitles(page, ['指南', 'screening']);
  check('目录抽取能抓到中文新指南', titles.some((t) => t.includes('肺癌低剂量CT筛查指南')), titles.join(' / '));
  check('目录抽取能抓到英文新推荐', titles.some((t) => /Lung Cancer Screening/.test(t)));
  check('目录抽取不把导航当标题', !titles.some((t) => /Home\s+Search/.test(t)));
  check('首次没有基线时不报警（只建基线）', newTitles(titles, null) === null);
  check('新增标题能被识别', newTitles(titles, [titles[0]]).length === titles.length - 1);
  check('没有新标题时安静', newTitles(titles, titles).length === 0);
}

/* ---------- 7. 坏页识别：HTTP 200 也可能是 Page Not Found（2026-11-24） ---------- */
{
  const { isBadPage } = await import('../scripts/lib/source-fetch.mjs');
  check('CDC 那种 200 + Page Not Found 被判坏页', isBadPage('Page Not Found | CDC\nWe could not find the page you requested.'));
  check('404 标题被判坏页', isBadPage('404 Not Found\nThe requested URL was not found.'));
  check('访问验证页被判坏页', isBadPage('访问验证\n请完成验证后继续访问本站内容。'));
  check('正常短公告不被误杀', !isBadPage('关于发布2025年版体检指引的通知'));
  check('正文里提到 404 的正常指南不被误杀',
    !isBadPage('筛查指南（2025年版）\n本章节讨论罕见病的检出率，正文很长很长，其中一句提到 404 这个编号并不代表错误页面。'.repeat(3)));
}

/* ---------- 8. 自动运营决策层：机器只降不升、不碰判定（2026-11-24） ---------- */
{
  const { decide, SAFE_STATUS } = await import('../scripts/lib/auto-decide.mjs');

  // 引用失效 + 数字变化 → 都要降级，且只写白名单字段
  const r1 = {
    checkedAt: '2026-11-24T10:00:00Z',
    quoteBroken: [{ ruleId: 'r-a', url: 'http://x', quote: '旧句' }],
    changed: [{ url: 'http://y', usedBy: ['r-b'], numsAdded: ['50'] }],
    broken: [{ url: 'http://z', usedBy: ['r-c'], error: 'WAF' }],
    catalogWatch: { newGuidelines: [{ source: '卫健委', title: '新指南', url: 'http://w' }], broken: [] },
  };
  const { actions, summary } = decide(r1);
  check('决策产出降级/坏源/线索三类动作',
    summary.downgrade === 2 && summary.broken === 1 && summary.radar === 1, JSON.stringify(summary));
  const dg = actions.find((a) => a.type === 'DOWNGRADE_EVIDENCE');
  check('降级目标状态只能是 stale（绝不升级）',
    dg.fields.status === 'stale' && SAFE_STATUS.includes(dg.fields.status), dg.fields.status);
  check('降级不写判定字段',
    !('verdict' in dg.fields) && !('when' in dg.fields) && !('quotes' in dg.fields) && !('frequency' in dg.fields),
    Object.keys(dg.fields).join(','));
  check('降级 stamp 用报告日期', dg.fields.checkedAt === '2026-11-24', dg.fields.checkedAt);

  // 幂等：同一报告跑两遍，动作完全一致
  const again = decide(r1).actions;
  check('决策幂等（同报告两次结果相同）', JSON.stringify(actions) === JSON.stringify(again));

  // 空报告 / 无变化 → no-op，不产生动作
  const noop = decide({ quoteBroken: [], changed: [], broken: [], catalogWatch: { newGuidelines: [] } });
  check('无变化时 no-op', noop.summary.noop && noop.actions.length === 0, JSON.stringify(noop.summary));
  check('坏报告不崩、安全 no-op', decide(null).actions.length === 0);

  // 目录坏页也算坏源，但只记不删依据
  const r2 = { quoteBroken: [], changed: [], broken: [], catalogWatch: { broken: [{ source: 'CDC', url: 'http://c', error: '404' }] } };
  const d2 = decide(r2);
  check('目录坏页被记为坏源', d2.actions.some((a) => a.type === 'MARK_BROKEN' && a.source === 'CDC'));
  check('坏源动作不含删除依据字段',
    d2.actions.every((a) => !('remove' in a) && !('delete' in a)));
}

console.log(`\n${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  console.log('失败项：\n' + fails.map((f) => `  · ${f}`).join('\n'));
  process.exit(1);
}
