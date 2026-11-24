// SPDX-License-Identifier: MIT
// Copyright (c) 2026 老王AI瞎bb
// See LICENSE at the repository root.

/**
 * 署名三件套：首页页脚签名条、结果页收尾一行、依据页收尾一行。
 *
 * 为什么要单独一个模块：
 *   三处的链接口径并不一样 —— 首页的头像点去小红书、GitHub 图标点去**仓库**；
 *   结果页的「老王AI瞎bb」点去小红书、GitHub 点去**个人主页**；
 *   依据页只认 GitHub。四个网址散在三个文件里手写，改一个忘一个，
 *   最后会出现"首页点得到、结果页 404"这种只有用户才发现的错。
 *   所以这里只放**事实**（名字、四个网址），HTML 由下面三个函数生成，
 *   文案里的名字全部来自 AUTHOR，不写第二遍。
 *
 * 仓库名（REPO_SLUG）同时被首页链接和 data/fingerprint.json 使用，改名要两处一起改；
 *   万一 REPO_SLUG 被清空，repoURL() 会退回个人主页，不会挂一个 404 的空链接。
 */
import { readEnv, detectEnv } from './env.js';

export const AUTHOR = '老王AI瞎bb';
export const XHS_URL = 'https://www.xiaohongshu.com/user/profile/56fe2edf4775a72b03563fdc';
export const GH_USER = 'https://github.com/laowang-ai-xbb';
/** 开源仓库的路径名（不含前缀）。2026-11-24 老板定名 HowToCheckup，与仓库一致 */
export const REPO_SLUG = 'HowToCheckup';
export const repoURL = () => (REPO_SLUG ? `${GH_USER}/${REPO_SLUG}` : GH_USER);

const esc = (s = '') => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* 微信内置浏览器里 target="_blank" 不生效，只会让点击无声无息地失败；
   和 main.js 的 sourceLink 同一套判断。 */
const BLANK = detectEnv(readEnv()).isWeChat ? '' : ' target="_blank" rel="noopener noreferrer"';

const link = (href, cls, label, inner) =>
  `<a class="${cls}" href="${esc(href)}"${BLANK}${label ? ` aria-label="${esc(label)}"` : ''}>${inner}</a>`;

/* GitHub 官方 mark（octicons 16×16）。内联而不是引图片：
   一个 700 字节的图标不值得多一次请求，也不该在离线缓存里留个洞。 */
const GH_MARK = `<svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>`;

/**
 * 首页页脚签名条：头像 + 名字（→ 小红书）｜ GitHub 图标（→ 仓库）
 *
 * 排版上的两个选择：
 *   · 人和代码不是一回事，所以中间立一根 1px 细竖线分隔；
 *     图标比名字轻一档（灰一档、小一档），读起来是"作者，以及他的代码"，
 *     而不是两条并列的按钮。
 *   · 整条不与上面的「致敬」共用虚线：致敬已经有一条虚线分隔，
 *     紧跟着再来一条会把页脚切得太碎。这里只留间距。
 */
export const signBarHTML = () => `
      <div class="sign">
        ${link(XHS_URL, 'sign-me', `在小红书找到我：${AUTHOR}`, `
          <img class="sign-pic" src="./avatar.png" alt="" width="26" height="26" loading="lazy" decoding="async" />
          <span class="sign-name">${esc(AUTHOR)}</span>`)}
        <span class="sign-sep" aria-hidden="true"></span>
        ${link(repoURL(), 'sign-gh', '这个项目的源码，在 GitHub', GH_MARK)}
      </div>`;

/**
 * 结果页收尾一行：由 老王AI瞎bb 构建 · 开源在 GitHub
 * 名字去小红书（刚看完结果想找人说话），GitHub 去个人主页（想看更多项目）。
 */
export const signLineResultHTML = () => `
      <p class="signline">由 ${link(XHS_URL, 'foot-link', `小红书上的${AUTHOR}`, esc(AUTHOR))} 构建 · 开源在 ${link(GH_USER, 'foot-link', 'GitHub 个人主页', 'GitHub')}</p>`;

/**
 * 依据页收尾一行：以上均为公开文件摘录 · 由 老王AI瞎bb 整理
 * 这一页全是别人写的东西，署名的意思正好相反 —— 我不是作者，我是整理的人。
 * 所以这里只给 GitHub：想核对原文的人，不关心我在小红书发什么。
 */
export const signLineEvidenceHTML = () => `
      <p class="signline">以上均为公开文件摘录 · 由 ${link(GH_USER, 'foot-link', `GitHub 上的${AUTHOR}`, esc(AUTHOR))} 整理</p>`;
