/**
 * 年份岗哨 + 心跳 的离线单测（不联网，跑得飞快）
 *
 * 为什么要有这个文件：岗哨判错和巡检判错一样危险且隐蔽——
 *   · 判太松 → 官网换版了不响（静默漏报，最危险，看起来一切正常）；
 *   · 判太严 → 每周一条噪声，几周后没人点开（等于没接）。
 * 用法：node tests/year-sentinel-unit.mjs
 */
import {
  abMonthYearToYear, parseAbList, extractDatePublished, maxPatternYear,
  sentinelDecide, heartbeatStale, HEARTBEAT_MAX_DAYS,
} from '../scripts/lib/year-sentinel.mjs';

let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fails.push(name); console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

/* ---------- 1. A&B 清单页解析 ---------- */

{
  // 2026-11-27 实测官网结构：单引号 href + <td>May 2021</td>
  const html = `<tr><td><a href='/uspstf/recommendation/colorectal-cancer-screening'>Colorectal Cancer: Screening</a></td><td>x</td><td>May 2021 <a href='#more'>*</a></td></tr>`;
  const m = parseAbList(html);
  check('A&B：单引号行解析出 slug→年份', m['colorectal-cancer-screening'] === '2021', JSON.stringify(m));
}
{
  const html = `<tr><td><a href="/uspstf/recommendation/breast-cancer-screening">Breast Cancer</a></td><td>April 2024</td></tr>`;
  const m = parseAbList(html);
  check('A&B：双引号行也认', m['breast-cancer-screening'] === '2024', JSON.stringify(m));
}
{
  // 同 slug 两行（A 级 45-49 / B 级 50-75 同年）→ 不报、不重复
  const html = `<tr><td><a href='/uspstf/recommendation/colorectal-cancer-screening'>45-49</a></td><td>May 2021</td></tr>
<tr><td><a href='/uspstf/recommendation/colorectal-cancer-screening'>50-75</a></td><td>May 2021</td></tr>`;
  const m = parseAbList(html);
  check('A&B：同 slug 多行取一个值', Object.keys(m).length === 1 && m['colorectal-cancer-screening'] === '2021', JSON.stringify(m));
}
{
  // 同 slug 不同年（理论上不该出现，出现了取最新）
  const html = `<tr><td><a href='/uspstf/recommendation/x'>a</a></td><td>May 2019</td></tr>
<tr><td><a href='/uspstf/recommendation/x'>b</a></td><td>May 2023</td></tr>`;
  const m = parseAbList(html);
  check('A&B：同 slug 不同年取最大', m['x'] === '2023', JSON.stringify(m));
}
{
  // 行里没有日期（比如分隔行）→ 跳过不崩
  const html = `<tr><td><a href='/uspstf/recommendation/x'>t</a></td><td>(no date)</td></tr><tr><td>plain</td></tr>`;
  check('A&B：无日期行安全跳过', Object.keys(parseAbList(html)).length === 0);
}
{
  // 月份缩写/大小写变形不误判（"May 2021" 合法，"may 2021" 不是官方写法，忽略）
  check('A&B：abMonthYearToYear 合法输入', abMonthYearToYear('January 2025') === '2025');
  check('A&B：abMonthYearToYear 非法输入返回空', abMonthYearToYear('Jan 2025') === '' && abMonthYearToYear('') === '');
}

/* ---------- 2. 主题页 datePublished 提取 ---------- */

{
  const html = `<script type="application/ld+json">{"@type":"Article","datePublished":"2018-05-08","publisher":{}}</script>`;
  check('datePublished：标准 JSON-LD 提取', extractDatePublished(html) === '2018-05-08');
}
{
  // 日期字段间带空格的变体
  const html = `"datePublished" : "2025-01-14"`;
  check('datePublished：冒号带空格也认', extractDatePublished(html) === '2025-01-14');
}
{
  check('datePublished：没有就返回空', extractDatePublished('<html>nothing</html>') === '');
  check('datePublished：坏日期返回空', extractDatePublished('"datePublished":"1999-99-99"') === '');
}

/* ---------- 3. 中文指南 pattern 提取 ---------- */

{
  const txt = '《成人健康体检项目推荐指引（2025年版）》…本指引替代（2019年版）。';
  check('中文：标题年份提取（取最大）', maxPatternYear(txt, '（(20[0-9][0-9])年版）') === '2025');
}
{
  // 全角括号外的半角变体
  const txt = '指南(2022年版)发布';
  check('中文：半角括号变体', maxPatternYear(txt, '\\((20[0-9][0-9])年版\\)') === '2022');
}
{
  check('中文：无命中返回空', maxPatternYear('没有任何年份', '（(20[0-9][0-9])年版）') === '');
  check('中文：坏正则不崩返回空', maxPatternYear('x', '([bad') === '');
  check('中文：pattern 为空返回空', maxPatternYear('（2025年版）', '') === '');
}
{
  // 捕获组不是四位年份（比如 "2025年1月" 误配）→ 不当成年份
  const txt = '2025年1月发布（2025年版）';
  check('中文：非标准捕获不误判', maxPatternYear(txt, '(20[0-9][0-9])年') === '2025');
}

/* ---------- 4. 岗哨裁决 ---------- */

{
  const citations = [
    { ruleId: 'colorectal-screening', key: 'colorectal-cancer-screening', url: 'https://x', year: '2021' },
  ];
  check('裁决：同年安静', sentinelDecide(citations, { 'colorectal-cancer-screening': '2021' }).length === 0);
  check('裁决：官网更新→漂移+方向正确', (() => {
    const d = sentinelDecide(citations, { 'colorectal-cancer-screening': '2024' });
    return d.length === 1 && d[0].direction === '官网有更新版本' && d[0].citedYear === '2021' && d[0].officialYear === '2024';
  })());
  check('裁决：引用比官网新→也报（数据可疑）', (() => {
    const d = sentinelDecide(citations, { 'colorectal-cancer-screening': '2018' });
    return d.length === 1 && d[0].direction.includes('可疑');
  })());
}
{
  // 官方取不到 → 不报（抓取失败走 broken 通道）
  const citations = [{ ruleId: 'r', key: 'k', year: '2021' }];
  check('裁决：官方年份缺失不报', sentinelDecide(citations, {}).length === 0);
  // 官方年份格式坏 → 不报
  check('裁决：官方年份坏格式不报', sentinelDecide(citations, { k: '20x5' }).length === 0);
  // citation 字段缺 → 安全跳过
  check('裁决：缺 ruleId 跳过', sentinelDecide([{ key: 'k', year: '2021' }], { k: '2024' }).length === 0);
  check('裁决：缺 year 跳过', sentinelDecide([{ ruleId: 'r', key: 'k' }], { k: '2024' }).length === 0);
}
{
  // 幂等：同输入跑两遍结果一致；同 (ruleId,key) 去重
  const citations = [
    { ruleId: 'r1', key: 'k', year: '2021' },
    { ruleId: 'r1', key: 'k', year: '2021' },
  ];
  const d1 = sentinelDecide(citations, { k: '2024' });
  const d2 = sentinelDecide(citations, { k: '2024' });
  check('裁决：幂等且去重', d1.length === 1 && JSON.stringify(d1) === JSON.stringify(d2));
}

/* ---------- 5. 心跳 ---------- */

{
  const now = new Date('2026-11-27T09:00:00Z');
  check('心跳：新鲜', heartbeatStale('2026-11-26T09:00:00Z', now).stale === false);
  check('心跳：过期', heartbeatStale('2026-11-01T09:00:00Z', now).stale === true);
  check('心跳：阈值边界（14个自然日内不报，第15天起报）', (() => {
    const base = new Date('2026-11-13T09:00:00Z').getTime();
    const at = (hours) => heartbeatStale('2026-11-13T09:00:00Z', new Date(base + hours * 3600000));
    // 巡检每周跑一次：14 天整差 12 小时内都不该报；第 15 个自然日起必须报
    return at(14 * 24 + 12).stale === false && at(15 * 24).stale === true;
  })());
  check('心跳：无记录=过期（从未成功跑过）', heartbeatStale('', now).stale === true);
  check('心跳：坏时间戳=过期', heartbeatStale('not-a-date', now).stale === true);
  check('心跳：过期时带原因', heartbeatStale('2026-11-01', now).reason.includes('超过'));
}

/* ---------- 汇总 ---------- */

console.log(`\n${pass} 项通过${fails.length ? `，${fails.length} 项失败：${fails.join('；')}` : '，全部绿'}`);
process.exit(fails.length ? 1 : 0);
