#!/usr/bin/env node
/**
 * 变异测试：证明不变量清单**真的会红**。
 *
 * 为什么必须有这一层：
 *   一条永远通过的检查，比没有检查更糟 —— 它会让人以为这块已经守住了。
 *   这个项目已经吃过一次亏：巡检脚本的汇总行"逐句核对 98 句全部命中原文"
 *   不管成没成都会打印，删掉一句才发现它根本没报。
 *
 * 做法：对每条不变量，把源码**故意改坏一处**（模拟"有人又把坑踩回去了"），
 * 然后要求对应的 check 返回违规信息。改坏了还不报警 = 这条检查是摆设。
 */
import { loadSources, INVARIANTS } from '../scripts/lib/invariants.mjs';

const base = loadSources('.');

/** 每条变异：改哪个文件、把什么替换成什么、哪条不变量必须因此报警 */
const MUTATIONS = [
  {
    inv: 'share-uses-hash',
    file: 'src/share.js',
    from: "url.hash = 'p=' + encodeProfile(profile);",
    to: "url.search = '?p=' + encodeProfile(profile);",
    desc: '把分享参数改回 ?p=',
  },
  {
    inv: 'no-web-storage',
    file: 'src/main.js',
    from: 'const ENV = detectEnv(readEnv());',
    to: "localStorage.setItem('last', JSON.stringify(state.profile));\nconst ENV = detectEnv(readEnv());",
    desc: '偷偷把答案存进 localStorage',
  },
  {
    inv: 'unknown-vs-declined',
    file: 'src/questions.js',
    from: "{ v: 'declined', l: '不方便说' }",
    to: "{ v: 'unknown', l: '不方便说' }",
    desc: '把"不方便说"并回 unknown',
  },
  {
    inv: 'multi-none-not-merged',
    file: 'src/questions.js',
    from: "noneLabel: '都没有',\n    unknownLabel: '不确定，记不清',",
    to: "noneLabel: '都没有 / 不清楚',",
    desc: '把家族史的"没有"和"不清楚"合并',
  },
  {
    inv: 'b-rules-have-lean',
    file: 'data/rules.json',
    from: '"lean": "against",',
    to: '"lean": "nah",',
    desc: '把某条 B 档的 lean 写成非法值',
  },
  {
    inv: 'evidence-copy-r14',
    file: 'src/evidence.js',
    from: '年龄到了，该打就要打，要相信科学。',
    to: '按年龄给，不按体检套餐给。',
    desc: '把疫苗结论改回上一版文案',
  },
  {
    inv: 'back-fab-and-home-share',
    file: 'src/evidence.js',
    from: "fab?.classList.toggle('show', window.scrollY > 400);",
    to: "fab?.classList.add('show');",
    desc: '让「回到我的清单」一进页面就常驻（页头那颗还在，变成两颗同时喊）',
  },
  {
    inv: 'back-fab-and-home-share',
    file: 'src/main.js',
    from: '该体检啦，体检该做什么项目，去这免费查下（依据国家权威指南），入口>> ${url}  一个想让你长命百岁的人',
    to: '该体检啦，体检该做什么项目，去这免费查下，入口>> ${url}',
    desc: '把首页分享文案里的「依据国家权威指南」和落款删掉',
  },
  {
    inv: 'claimed-from-catalog-not-shown',
    file: 'src/main.js',
    // src/main.js 是 CRLF，锚点里的换行必须写 \r\n，否则永远找不到（踩过一次）
    from: '[...A_REST, ...b.B, ...b.C]\r\n      .flatMap((r) => r.catalogIds || [])',
    to: '[...A_REST, ...b.B, ...b.C]\r\n      .flatMap((r) => r.shownIds || [])',
    desc: '把虚假线的口径改回 shownIds（claimed 会恒空，虚线永远不出现）',
  },
  {
    inv: 'print-expands-details',
    file: 'src/styles.css',
    from: 'details { display: block; }',
    to: 'details { display: none; }',
    desc: '打印时不再展开依据',
  },
  {
    inv: 'print-sheet-final',
    file: 'src/print-sheet.js',
    from: "sign: '一个想你长命百岁的人',",
    to: "sign: '体检项目指南团队',",
    desc: '把打印稿右下角的彩蛋签名改回机构署名',
  },
  {
    inv: 'rule-display-name',
    file: 'data/rules.json',
    from: '"displayName": "基础体检项目",',
    to: '"displayName": "基础体检项目（每年一次的基础套餐）",',
    desc: '把基础套餐短名改回带括号说明的长名',
  },
  {
    inv: 'share-image-no-summary',
    file: 'src/main.js',
    from: "        groups: [\r\n          { title: 'A · 建议做'",
    to: "        summary: ['建议做 5 项'],\r\n        groups: [\r\n          { title: 'A · 建议做'",
    desc: '又把统计摘要传给分享图',
  },
  {
    inv: 'print-auto-paginate',
    file: 'src/print-sheet.js',
    from: "post('wb-print-ready', { pages: pages.length });",
    to: "post('wb-print-done', { pages: pages.length });",
    desc: '把分页完成信号改掉，父页面将永远等不到打印时机',
  },
  {
    inv: 'result-actions-share-img',
    file: 'src/main.js',
    from: '<button class="btn primary" data-act="share-img">存成一张图，发给家人</button>',
    to: '<button class="btn ghost" data-act="print">打印 / 存成 PDF</button>',
    desc: '把底部「存成一张图」换回打印按钮',
  },
  {
    inv: 'vaccine-no-grade-note',
    file: 'src/views13.js',
    from: "hint: '疾控中心的技术指南' })",
    to: "hint: '疾控中心的技术指南', note: '没有 GRADE 推荐强度' })",
    desc: '把 GRADE 内部说明写回疫苗依据',
  },
  {
    inv: 'mobile-toc-sticky',
    file: 'src/v13.css',
    from: "position: sticky;\n      top: 0;",
    to: "position: static;\n      top: 0;",
    desc: '把移动端吸顶目录改回静态',
  },
  {
    inv: 'body-contrast-4.5',
    file: 'src/styles.css',
    from: '--ink-3: #6f6a5f;',
    to: '--ink-3: #8a857a;',
    desc: '把灰字改回不达标的旧颜色',
  },
  {
    inv: 'no-hover-on-touch',
    file: 'src/styles.css',
    from: '@media (hover: hover) and (pointer: fine) {',
    to: '.opt:hover { border-color: #cfc8ba; }\n@media (hover: hover) and (pointer: fine) {',
    desc: '在媒体查询外面加一条裸 :hover',
  },
  {
    /* v13.css 搬进产品之后也必须被这条守卫罩住：它原来只服务 demo，
       里面确实有 5 处裸 hover。只改 styles.css 的话，这条检查对新页面是空转。 */
    inv: 'no-hover-on-touch',
    file: 'src/v13.css',
    from: '  /* ---- hover 只给真指针设备 ----',
    to: '  .evt td a:hover { color: red; }\n  /* ---- hover 只给真指针设备 ----',
    desc: '在结果页/依据页的 v13.css 里加一条裸 :hover',
  },
  {
    inv: 'ua-only-in-env',
    file: 'src/main.js',
    from: 'const ENV = detectEnv(readEnv());',
    to: "const isWeChat = /micromessenger/i.test(navigator.userAgent);\nconst ENV = detectEnv(readEnv());",
    desc: '在 main.js 里另起一个微信判断',
  },
  {
    inv: 'footer-links-sane',
    file: 'src/main.js',
    from: "{ name: '国家癌症中心', url: 'https://www.chinancpcn.org.cn/home' },",
    to: "{ name: '国家癌症中心', url: 'http://www.cicams.ac.cn/' },",
    desc: '把癌症中心链回医院官网、并改回 http',
  },
  {
    inv: 'gap-drawer-inline',
    file: 'src/main.js',
    from: "if (state.view === 'result' && act === 'goto') { insertGapEditor(btn.dataset.key); return; }",
    to: "if (state.view === 'result' && act === 'goto') { state.view = 'quiz'; return; }",
    desc: '把「去补这一题」改回跳问卷页',
  },
  {
    inv: 'no-glossary-on-result',
    file: 'src/main.js',
    from: '    <div class="docbody">\r\n      <section id="must">',
    to: '    <div class="docbody">\r\n      ${glossHTML(b)}\r\n      <section id="must">',
    desc: '把术语说明模块接回结果页',
  },
  {
    inv: 'body-title-placeholder',
    file: 'src/questions.js',
    from: "title: '体型',",
    to: "title: '身高和体重',",
    desc: '把体型题标题改回身高和体重',
  },
  {
    inv: 'where-lead-short',
    file: 'data/where.json',
    from: '"lead": "指南说「该不该查」，医院定「挂哪个号」",',
    to: '"lead": "指南说「该不该查」，医院定「挂哪个号」——这一栏是后者。",',
    desc: '把依据页去哪科说明改回内部解释版',
  },
  {
    inv: 'pregnancy-age-boundary',
    file: 'src/questions.js',
    from: "showIf: (p) => p.gender === 'female' && Number(p.age) <= 49,",
    to: "showIf: (p) => p.gender === 'female',",
    desc: '把备孕题改回所有女性都问',
  },
  {
    inv: 'weight-loss-clinical-evaluation',
    file: 'src/body.js',
    from: '先找医生评估，这份体检清单替代不了面诊。',
    to: '先找原因，体检里顺带看看。',
    desc: '把掉秤提示改回"先找原因"',
  },
  {
    inv: 'risk-notes-and-unlisted',
    file: 'src/main.js',
    from: "if (!hasFH || Number(p.age) < 65) return '';",
    to: "if (!hasFH || Number(p.age) < 60) return '';",
    desc: '把 AD 家族史提示的年龄门槛退回 60',
  },
  {
    inv: 'risk-notes-and-unlisted',
    file: 'src/main.js',
    from: '    <p class="ul-examples">例如：',
    to: '    <p class="ul-examples">这些不等于不能做，也不是指南说你一定不该做；本单只是没有把它们列为常规项。机构套餐里常见，例如：',
    desc: '把 4A 已删除的解释句写回来',
  },
  {
    inv: 'gap-editor-spa-view',
    file: 'src/main.js',
    from: "const renderResult = () => {\r\n  state.view = 'result';",
    to: 'const renderResult = () => {',
    desc: '走完问卷进结果页时不给 view 正名',
  },
  {
    inv: 'waist-placeholder-focus',
    file: 'src/main.js',
    from: 'placeholder="老人肚子大、体重轻，腰围比体重更说明问题。"',
    to: 'placeholder="老人肚子大、体重轻，腰围比体重更说明问题）；不想填就空着。"',
    desc: '把腰围底纹改回多余括号的长句',
  },
  {
    inv: 'share-entry-consistency',
    file: 'src/main.js',
    from: '<button class="btn primary" data-act="share-img">存成一张图，发给家人</button>',
    to: '<button class="btn ghost" data-act="share-img">存成一张图，发给家人</button>',
    desc: '把结果页下方分享图按钮改回描边色',
  },
  {
    inv: 'dashed-tip-only-when-dashed',
    file: 'src/views13.js',
    from: "${dup ? '<p class=\"tip\">带虚线的几项在上面专项里已经说过 —— 同一项只说一次。</p>' : ''}",
    to: "'<p class=\"tip\">带虚线的几项在上面专项里已经说过 —— 同一项只说一次。</p>'",
    desc: '虚线提示改回无条件出现',
  },
  {
    inv: 'unlisted-no-manual-numbers',
    file: 'src/main.js',
    from: '<li>证据不足：没有足够证据证明健康人常规做能获益。</li>',
    to: '<li>① 证据不足：没有足够证据证明健康人常规做能获益。</li>',
    desc: '把 ① 写回套餐常见项的原因',
  },
  {
    inv: 'evidence-return-and-share',
    file: 'src/evidence.js',
    from: '你体检该做什么项目，来这免费查（依据国家权威指南），点击>> ${url}  一个想让你长命百岁的人',
    to: '体检做什么项目，来这查：${url}',
    desc: '把依据页剪贴板文案改回旧句',
  },
  {
    inv: 'soon-has-evidence',
    file: 'src/main.js',
    from: '${soonHTML(soon, ctx)}',
    to: '${soonHTML(soon)}',
    desc: '再过几年模块不带依据页链接',
  },
  {
    inv: 'evidence-toc-sticky',
    file: 'src/v13.css',
    from: 'position: sticky; top: 0; z-index: 30;',
    to: 'position: relative; z-index: 30;',
    desc: '依据页目录取消吸顶',
  },
  {
    inv: 'lean-only-on-evidence',
    file: 'src/views13.js',
    from: "  const soft = rule.frequency.basis && rule.frequency.basis !== 'guideline';",
    to: "  const lean = leanOf(rule);\n  const soft = rule.frequency.basis && rule.frequency.basis !== 'guideline';",
    desc: '把偏向标签塞回结果页卡片',
  },
  {
    inv: 'empty-profile-not-an-answer',
    file: 'src/engine.js',
    from: "  hpStatus: '',",
    to: "  hpStatus: 'unknown',",
    desc: '把幽门螺杆菌的默认值改回「没查过，或不记得」这个选项值',
  },
  {
    inv: 'body-shape-field-align',
    file: 'src/styles.css',
    from: '.field-single { margin: 18px 0 10px; padding: 12px 18px; }',
    to: '.field-single { margin: 18px 0 0; padding: 12px; }',
    desc: '把腰围框改回「左右 12px、底下 0 间距」',
  },
  {
    inv: 'egg-wish-by-person',
    file: 'data/egg.json',
    from: '"wishFamily": "祝你家人早日康复，身体健康。"',
    to: '"wishFamily": "祝你早日康复，身体健康。"',
    desc: '家族史的祝福又说回「祝你早日康复」',
  },
  {
    inv: 'no-fake-assertions',
    file: 'tests/browser-check.mjs',
    from: "check('首屏含免责声明'",
    to: "check('永远为真', true);\n  check('首屏含免责声明'",
    desc: '塞一条永远为真的断言',
  },
  {
    inv: 'author-links-one-place',
    file: 'src/main.js',
    from: "import { signBarHTML, signLineResultHTML } from './author.js';",
    to: "import { signBarHTML, signLineResultHTML } from './author.js';\nconst XHS = 'https://www.xiaohongshu.com/user/profile/56fe2edf4775a72b03563fdc';",
    desc: '把小红书地址复制一份到 main.js 里直接用',
  },
  {
    inv: 'author-name-from-constant',
    file: 'src/main.js',
    from: "  mark: '长命百岁',",
    to: "  mark: '老王AI瞎bb',",
    desc: '把作者名直接写进品牌标题',
  },
  {
    inv: 'author-three-places',
    file: 'src/evidence.js',
    from: '      ${signLineEvidenceHTML()}',
    to: '',
    desc: '把依据页的署名收尾行删掉',
  },
  {
    inv: 'author-avatar-size',
    file: 'src/author.js',
    from: 'width="26" height="26"',
    to: 'width="26" height="32"',
    desc: '头像标签高度改成 32（和 CSS 的 26 对不上，加载时会跳）',
  },
  {
    inv: 'excerpt-note-once',
    file: 'src/evidence.js',
    from: '    <footer class="disc">\n',
    to: '    <footer class="disc">\n      <p class="evnote">以上均为公开文件摘录</p>\n',
    desc: '把页脚顶部那张「以上均为公开文件摘录」卡加回来',
  },
  {
    inv: 'repo-slug-consistent',
    file: 'data/fingerprint.json',
    from: '"repo": "HowToCheckup"',
    to: '"repo": "tijian-zhinan"',
    desc: '指纹里记的仓库名和首页链接用的仓库名对不上',
  },
  {
    inv: 'quiz-back-armed',
    file: 'src/main.js',
    from: 'if (state.exitArmed) {',
    to: 'if (state.exitArmed === "never") {',
    desc: '「再点一次回首页」那段被拆了，第二下只会重复出提示',
  },
  {
    inv: 'hp-negative-no-retest',
    file: 'data/rules.json',
    from: '{ "hpStatus": "negative" }',
    to: '{ "hpStatus": "unknown" }',
    desc: 'hp-test-once 又不排除阴性了，查过阴性的用户被推荐重测',
  },
  {
    inv: 'upcoming-only-new-items',
    file: 'src/engine.js',
    from: 'const fresh = (rule.catalogIds || []).filter((id) => !presentIds.has(canon(id)));',
    to: 'const fresh = (rule.catalogIds || []).slice();',
    desc: '「再过几年」不再滤老面孔，便潜血又挂回预告里',
  },
];

let pass = 0;
for (const m of MUTATIONS) {
  const inv = INVARIANTS.find((i) => i.id === m.inv);
  if (!inv) { console.log(`FAIL 变异指向了不存在的不变量：${m.inv}`); continue; }

  const src = base[m.file];
  if (typeof src !== 'string') { console.log(`FAIL 找不到文件 ${m.file}`); continue; }
  if (!src.includes(m.from)) { console.log(`FAIL ${m.inv}：变异锚点在 ${m.file} 里找不到（${m.from.slice(0, 40)}）`); continue; }

  // 只改这一份副本，不碰磁盘
  const mutated = { ...base, [m.file]: src.replace(m.from, m.to) };
  const msg = inv.check(mutated);

  if (msg) {
    console.log(`ok   ${m.inv} —— ${m.desc}，检查确实报警：${msg.slice(0, 46)}…`);
    pass++;
  } else {
    console.log(`FAIL ${m.inv} —— ${m.desc}，但检查**没有**报警（这条守卫是摆设）`);
  }
}

// 反向确认：没被改坏的源码必须全部通过，否则说明检查本身过严（会天天误报）
const cleanFailed = MUTATIONS.map((m) => m.inv).filter((id) => {
  const inv = INVARIANTS.find((i) => i.id === id);
  return inv.check(base) !== null;
});
if (cleanFailed.length) {
  console.log(`FAIL 未改动的源码就有 ${cleanFailed.length} 条不变量不成立：${cleanFailed.join('、')}`);
}

const total = MUTATIONS.length + 1;
const okAll = pass === MUTATIONS.length && cleanFailed.length === 0;
console.log(`\n${okAll ? total : pass}/${total} 通过（${MUTATIONS.length} 条变异 + 1 条"未改动时应全绿"）`);
if (!okAll) process.exit(1);
