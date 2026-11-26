// SPDX-License-Identifier: MIT
// Copyright (c) 2026 老王AI瞎bb
// See LICENSE at the repository root.

/**
 * 心情小问卷（P3，老板 2026-11-25 定稿）：结果页末尾的一张可选卡。
 *
 * 安全边界（写死，谁都别改）：
 *   · 只用来"发现需要帮助的人并递上热线"，不打分、不贴抑郁/焦虑标签、不给诊断；
 *   · 全程不进画像、不进分享链接、不留任何记录；
 *   · 第 2 题碰到"想伤害自己（比较具体）"→ 立刻全屏求助层，不等答完，不给人单独停留；
 *   · 全部"不方便说"或"几乎没有"→ 页面和没答一模一样，不因沉默多给一层提示。
 *
 * 为什么独立成模块、不并进主问卷：它不是体检项目，不参与 A/B/C，也不该在主流程里
 * 强制每个人面对。放结果页末尾、由用户主动点开，是对"愿意说就说"这件事的尊重。
 *
 * 为什么不做完整量表（如 PHQ-9）：那需要专业审校 + 转诊闭环兜底。这是个纯静态、
 * 无后端、没有医生的项目——筛出来接不住，比不筛更危险。所以这版克制到只有 3 题。
 */

const esc = (s = '') => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* 三题。选项第三项是分值语义（none/flash/crisis/skip），只用于决定出口，从不展示、不累计。 */
const QUESTIONS = [
  {
    key: 'mood',
    title: '最近两周，做事情提不起劲、或情绪低落，有多经常？',
    hint: '按这两周最真实的感觉说，没有对错。',
    options: [
      { l: '几乎没有', v: 'none' },
      { l: '有几天', v: 'none' },
      { l: '一半以上的日子', v: 'mild' },
      { l: '几乎每天', v: 'mild' },
      { l: '不方便说', v: 'skip' },
    ],
  },
  {
    key: 'selfHarm',
    title: '有没有出现过"不想活了"，或想伤害自己？',
    /* 老板 2026-11-25 定稿：这一题的提示行统一成这一句，别写别的。 */
    hint: '怎么答都不会被记录、不会影响你的体检清单。',
    critical: true,
    options: [
      { l: '没有', v: 'none' },
      { l: '有过，但只是一闪而过', v: 'flash' },
      { l: '有过，而且比较具体', v: 'crisis' },
      { l: '不方便说', v: 'skip' },
    ],
  },
  {
    key: 'impact',
    title: '这些感受，有没有影响到睡觉、吃饭、上班或和人相处？',
    hint: '按影响最大的那方面说就行。',
    options: [
      { l: '没有影响', v: 'none' },
      { l: '有一点', v: 'none' },
      { l: '影响明显', v: 'mild' },
      { l: '不方便说', v: 'skip' },
    ],
  },
];

/**
 * 用户可见文案清单——给 tests/copy-lint.mjs 扫描用。
 * 敏感模块的文案更要过守卫：错一个字、冒出一个内部词，都是信任事故。
 */
export const mindCopies = () => {
  const out = [];
  out.push('身体之外 · 还要多关心自己心情', '这不是体检项目，答不答都不影响上面的清单。',
    '三道题，你要不要试试 ›', '收起 ⌃');
  for (const q of QUESTIONS) {
    out.push(q.title, q.hint);
    for (const o of q.options) out.push(o.l);
  }
  out.push('宝，请一定要告诉你信任的人，别一个人待着。', '或立即拨打24小时免费心理援助热线',
    '12356', '010-82951332', '962525', '一个想你开心快乐的人',
    '第 3 题 · 共 3 题');
  out.push('你刚才说到想过伤害自己——这件事值得当回事。',
    '现在就拨打 12356，或者告诉身边一个你信得过的人。免费、保密，不用一个人扛。',
    '如果这些感受还在，找专业的人聊聊会有帮助。',
    '可以拨打 12356 — 免费、保密、全国心理援助热线。它不会给你贴标签，只是陪你聊聊。',
    '这里没有给你任何判断，也不影响你的体检清单。',
    '好了，这就是全部。', '无论你刚才答了什么，都不会被记下来，也不影响上面的清单。',
    '以后想找人聊聊，全国心理援助热线 12356 随时免费、保密。');
  return out;
};

/** 入口卡：放在结果页末尾，明确"这不是体检项目，答不答都不影响清单"。
 *  按钮是开关：展开后变成「收起」，答到一半也能合上，不留一个关不掉的洞。 */
export const mindCardHTML = () => `
  <section class="mind" id="mind">
    <div class="mind-card">
      <p class="mind-k">身体之外 · 还要多关心自己心情</p>
      <p class="mind-lead">这不是体检项目，答不答都不影响上面的清单。</p>
      <button class="mind-open" type="button" data-mind="toggle" aria-expanded="false">三道题，你要不要试试 ›</button>
      <div class="mind-body" hidden></div>
    </div>
  </section>`;

/** 全屏求助层：老板 2026-11-26 定稿文案。
 *  电话按钮只留号码本身——"全国免费/北京/24h"那些副标是给运营看的，不是给此刻的人看的。 */
const crisisSheet = () => `
  <div class="mind-crisis" role="alertdialog" aria-modal="true" aria-label="寻求帮助">
    <div class="mind-crisis-card">
      <button class="mind-close" type="button" data-mind="close" aria-label="关闭">×</button>
      <p class="mind-crisis-main">宝，请一定要告诉你信任的人，别一个人待着。</p>
      <p class="mind-crisis-sub">或立即拨打24小时免费心理援助热线</p>
      <div class="mind-tels">
        <a href="tel:12356" class="mind-tel primary">12356</a>
        <a href="tel:01082951332" class="mind-tel">010-82951332</a>
        <a href="tel:962525" class="mind-tel">962525</a>
      </div>
      <p class="mind-sign">一个想你开心快乐的人</p>
    </div>
  </div>`;

/* 关掉全屏层后，模块里留下的就是同样的求助内容——不是一行"先看看上面那条"的弱提示。
   老板 2026-11-26：用户不该为了再看一遍号码还得重新触发全屏。 */
const inlineCrisis = () => `
    <div class="mind-out crisis-inline">
      <p class="mind-crisis-main">宝，请一定要告诉你信任的人，别一个人待着。</p>
      <p class="mind-crisis-sub">或立即拨打24小时免费心理援助热线</p>
      <div class="mind-tels">
        <a href="tel:12356" class="mind-tel primary">12356</a>
        <a href="tel:01082951332" class="mind-tel">010-82951332</a>
        <a href="tel:962525" class="mind-tel">962525</a>
      </div>
      <p class="mind-sign">一个想你开心快乐的人</p>
    </div>`;

/**
 * 把交互挂到结果页那张卡上。每次 renderResult 重绘后会重新调用一次，
 * 所以内部状态用闭包局部保存，不依赖跨 render 的 DOM。
 */
export const mountMind = (root) => {
  const card = root.querySelector('#mind .mind-card');
  if (!card) return;
  const body = card.querySelector('.mind-body');
  const openBtn = card.querySelector('.mind-open');
  // 状态挂在 DOM 上：结果页每次重绘会重建卡片，旧状态自然作废；
  // 也避免用模块级变量时"两个页面实例串味"。
  const st = { answers: {}, step: 0 };

  const closeCrisis = () => {
    const s = document.querySelector('.mind-crisis');
    if (s) s.remove();
    document.body.style.overflow = '';
  };

  const showCrisis = () => {
    if (document.querySelector('.mind-crisis')) return;
    document.body.insertAdjacentHTML('beforeend', crisisSheet());
    document.body.style.overflow = 'hidden';
    const close = document.querySelector('.mind-close');
    close && close.focus({ preventScroll: true });
  };

  /* 老板 2026-11-26 要的专业审视结论落地：
   * "一闪而过想伤害自己"和"心情低落"紧急程度不同，不能共用一张温和卡片——
   * 前者是安全信号，要给更直接、可立刻执行的求助动作；但仍不弹全屏、不诊断、不留痕，
   * 守住文件头写死的安全边界。 */
  const flashResult = () => `
    <div class="mind-out flash">
      <p class="mind-out-lead">你刚才说到想过伤害自己——这件事值得当回事。</p>
      <p>现在就拨打 <a href="tel:12356">12356</a>，或者告诉身边一个你信得过的人。免费、保密，不用一个人扛。</p>
      <p class="mind-fine">这里没有给你任何判断，也不影响你的体检清单。</p>
    </div>`;
  const mildResult = () => `
    <div class="mind-out mild">
      <p class="mind-out-lead">如果这些感受还在，找专业的人聊聊会有帮助。</p>
      <p>可以拨打 <a href="tel:12356">12356</a> — 免费、保密、全国心理援助热线。它不会给你贴标签，只是陪你聊聊。</p>
      <p class="mind-fine">这里没有给你任何判断，也不影响你的体检清单。</p>
    </div>`;
  const quietResult = () => `
    <div class="mind-out quiet">
      <p class="mind-out-lead">好了，这就是全部。</p>
      <p>无论你刚才答了什么，都不会被记下来，也不影响上面的清单。</p>
      <p>以后想找人聊聊，全国心理援助热线 <a href="tel:12356">12356</a> 随时免费、保密。</p>
    </div>`;

  const renderStep = () => {
    if (st.step >= QUESTIONS.length) {
      // 出口判定：第 2 题"比较具体"已在答题时立即弹全屏，这里不会到这里。
      // "一闪而过"→ 安全信号单独一张卡；"一半以上日子/影响明显"→ 温和卡片；
      // 其余（含全不方便说）→ 静默。三条出口互不混用，紧急程度逐级递减。
      if (st.answers.selfHarm === 'flash') {
        body.innerHTML = flashResult();
      } else {
        const needsTalk = st.answers.mood === 'mild' || st.answers.impact === 'mild';
        body.innerHTML = needsTalk ? mildResult() : quietResult();
      }
      return;
    }
    const q = QUESTIONS[st.step];
    body.innerHTML = `
      <div class="mind-q">
        <p class="mind-qn">第 ${st.step + 1} 题 · 共 3 题</p>
        <h3 class="mind-qt">${esc(q.title)}</h3>
        <p class="mind-qh">${esc(q.hint)}</p>
        <div class="mind-opts">
          ${q.options.map((o, i) => `<button class="mind-opt" type="button" data-mind="pick" data-i="${i}">${esc(o.l)}</button>`).join('')}
        </div>
      </div>`;
  };

  // 每个问答按钮就地绑定，卡片重绘后自动随新 DOM 一起生效，不会叠加。
  card.addEventListener('click', (e) => {
    const t = e.target.closest('[data-mind]');
    if (!t) return;
    const act = t.dataset.mind;
    /* 开关（老板 2026-11-26：模块展开后无法折叠）。
       答到一半收起不丢答案——st 保留，重新展开接着答。 */
    if (act === 'toggle') {
      const open = !body.hidden;
      body.hidden = open;
      openBtn.setAttribute('aria-expanded', String(!open));
      openBtn.textContent = open ? '三道题，你要不要试试 ›' : '收起 ⌃';
      if (!open && st.step === 0 && !Object.keys(st.answers).length) renderStep();
      return;
    }
    if (act !== 'pick') return;
    const q = QUESTIONS[st.step];
    const opt = q.options[Number(t.dataset.i)];
    st.answers[q.key] = opt.v;
    // 关键：第 2 题的"比较具体"立刻弹全屏求助，不等答完，不给单独停留。
    // 全屏层关掉后，模块里留下的就是同样的求助内容（inlineCrisis）——
    // 不用"先看看上面那条 ›"让用户重新点一遍才能再看到号码。
    if (q.critical && opt.v === 'crisis') {
      body.innerHTML = inlineCrisis();
      showCrisis();
      return;
    }
    st.step += 1;
    renderStep();
  });
  // 全屏层挂在 body 上，关闭按钮和背景点击用 document 委托，且全局只绑一次
  // （结果页每次重绘都会 mountMind，重复绑会导致 closeCrisis 执行多次）。
  if (!document.__mindCloseBound) {
    document.__mindCloseBound = true;
    document.addEventListener('click', (e) => {
      if (e.target.closest('[data-mind="close"]') || e.target.classList.contains('mind-crisis')) {
        document.querySelector('.mind-crisis') && document.querySelector('.mind-crisis').remove();
        document.body.style.overflow = '';
      }
    });
  }
};
