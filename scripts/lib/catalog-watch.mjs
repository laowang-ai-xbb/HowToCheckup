/**
 * 发布方目录页监控（P0/P1 巡检扩容）
 *
 * 老巡检的输入是 rules.json 里已引用的 URL：只有当"我们引的那篇"被改了，
 * 它才会响。如果某机构在**新地址**发布了一版新指南，老巡检一无所知。
 * 这里改成再看一层：盯发布方的栏目/列表页，把含关键词的标题记下来，
 * 和上次基线一比，多出来的就是"此前没覆盖的新依据线索"。
 *
 * 纯函数部分（抽取/对比）不联网，单测可以离线跑。
 */

/** 从纯文本里抽候选标题：出现关键词、长度像标题、不是导航碎片 */
export const extractTitles = (text = '', keywords = []) => {
  const kws = (keywords || []).map((k) => String(k).toLowerCase()).filter(Boolean);
  const out = new Set();
  for (const rawLine of String(text).split(/\n+/)) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (line.length < 8 || line.length > 120) continue;
    if (!kws.some((k) => line.toLowerCase().includes(k))) continue;
    // 一排导航链接拼成的一行，不是标题
    if ((line.match(/\s{2,}/g) || []).length >= 3) continue;
    if (/^(home|首页|返回|上一页|下一页|更多|more|search|登录)/i.test(line)) continue;
    out.add(line);
  }
  return [...out].sort();
};

/** 对比两次快照：返回新出现的标题。基线为空时返回 null（表示"先建基线，别报警"） */
export const newTitles = (current = [], baseline = null) => {
  if (baseline === null || baseline === undefined) return null;
  const old = new Set(baseline || []);
  return (current || []).filter((t) => !old.has(t));
};

/** 把一份目录快照压成可入库的最小结构 */
export const snapshotOf = (id, url, text, keywords) => ({
  id,
  url,
  checkedAt: new Date().toISOString(),
  titles: extractTitles(text, keywords),
});
