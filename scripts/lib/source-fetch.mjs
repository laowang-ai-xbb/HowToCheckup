/**
 * 抓一个来源 URL，转成纯文本。快照脚本和"更新巡检"脚本共用。
 *
 * 三种格式都要处理，踩过的坑都在这里：
 * - PDF：中文期刊 PDF 常见 AES 加密（空密码可解），走 python pypdf；
 * - docx：指南登记平台把 docx 当 PDF 发（文件头 PK），按 PDF 解析会得到乱码；
 * - HTML：去掉脚本样式，块级标签换行；
 * - 反爬：PMC 对脚本返回 reCAPTCHA，换个接口拿同一篇全文。
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export const sha = (s) => createHash('sha256').update(s).digest('hex');
export const shortHash = (url) => sha(url).slice(0, 10);

/**
 * 归一化：让"引用是否在原文里"的比较不受排版噪音影响。
 *
 * 全角转半角是必须的——中文期刊 PDF 里的数字和拉丁字母常是全角
 * （`２０２２`、`ＨＢｓＡｇ`），不折半角就永远搜不到 "HBsAg"。
 */
const foldWidth = (s) =>
  s.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\u3000/g, ' ');

/**
 * 中文 PDF 抽出来的文字常把词拆开（"抗HBs检 测"、"清 除"），
 * 这些空格是排版换行留下的，不是语言的一部分。紧邻中文的空格一律去掉，
 * 否则同一句话在原文里和引用里差一个空格就判不过。
 */
const collapseCjkSpace = (s) =>
  s
    .replace(/(?<=[\u4e00-\u9fa5])[ ]+(?=[\u4e00-\u9fa5])/g, '')
    .replace(/(?<=[\u4e00-\u9fa5])[ ]+(?=[0-9A-Za-z])/g, '')
    .replace(/(?<=[0-9A-Za-z])[ ]+(?=[\u4e00-\u9fa5])/g, '');

export const normalize = (text) =>
  collapseCjkSpace(
    foldWidth(
      text
        .replace(/\r\n?/g, '\n')
        .replace(/[\u00a0\u3000]/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim(),
    ),
  );

/**
 * 比对用：去掉所有空白（含换行）再比。
 *
 * 中文 PDF 的一句话常被排版断成七八行，引用不可能连换行一起抄。
 * 抹掉空白后只比文字序列，既准确又不用迁就排版。
 */
export const squash = (s) => normalize(s).replace(/\s+/g, '');

export const htmlToText = (html) => {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return normalize(
    body
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d))),
  );
};

const runPy = (script, file, label) => {
  const r = spawnSync('python', [script, file], { encoding: 'utf8', timeout: 180000, maxBuffer: 96 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${label} 提取失败：${(r.stderr || '').slice(0, 200)}`);
  return normalize(r.stdout);
};

/**
 * 人类点开的地址 ≠ 能抓的地址：PMC 对脚本返回验证页，Europe PMC 的全文接口能拿到同一篇文章。
 * 展示给用户的链接保持原样，抓取走这里。
 */
const FETCH_AS = {
  'https://pmc.ncbi.nlm.nih.gov/articles/PMC12972581/':
    'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC12972581/fullTextXML',
};

const fetchOnce = async (url) => {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': UA, accept: '*/*', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(45000),
  });
  const ct = res.headers.get('content-type') || '';
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const magic = buf.subarray(0, 4).toString('latin1');
  const isPdf = /pdf/i.test(ct) || magic === '%PDF-';
  const isZip = magic === 'PK\u0003\u0004';
  /* 老式 .doc（OLE2 复合文档，D0CF11E0）—— 卫健委那批 2009 年前后的指南
   * 只发 Word 文件、不发 PDF。不认这一支就会把整份文档当 HTML 解成乱码，
   * 引文核对永远失败，最后只能人工"看着像"放行。 */
  const isDoc = magic.startsWith('\u00D0\u00CF\u0011\u00E0');
  if (isPdf || isZip || isDoc) {
    mkdirSync('.tmp-src', { recursive: true });
    const ext = isPdf ? '.pdf' : isZip ? '.docx' : '.doc';
    const tmp = join('.tmp-src', shortHash(url) + ext);
    writeFileSync(tmp, buf);
    try {
      return {
        text: isPdf
          ? runPy('scripts/pdf-text.py', tmp, 'PDF')
          : isZip
            ? runPy('scripts/docx-text.py', tmp, 'docx')
            : runPy('scripts/doc-text.py', tmp, 'doc'),
        contentType: isPdf ? 'application/pdf'
          : isZip ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : 'application/msword',
      };
    } finally {
      try { rmSync(tmp); } catch { /* ignore */ }
    }
  }
  const text = htmlToText(buf.toString('utf8'));
  /* 坏页识别（2026-11-24）：HTTP 200 不等于"抓到了正文"。
   * 踩过的坑：CDC/ACIP 旧地址返回 200 + "Page Not Found | CDC"，被当成正常页写进基线，
   * 于是"引用失效"和"目录新标题"全部失真。这里统一在抓取层拦下三类伪成功：
   *   ① 验证页 / 反爬壳；② 明确的 404/Not Found 标题；③ 正文过短（多半是空壳或下载页）。
   * 拦下来的源进 broken，不写基线 —— 否则恢复后会误报一大堆"新标题"。 */
  if (text.length < 400 && /recaptcha|checking your browser|访问验证|人机验证/i.test(text)) {
    throw new Error('被反爬拦截（返回验证页，非正文）');
  }
  if (isBadPage(text)) {
    throw new Error('抓到的是坏页（404/访问验证/正文过短），不是正文');
  }
  return { text, contentType: ct || 'text/html' };
};

/**
 * 判断一段 HTML 正文是不是"伪成功"的坏页。
 * 只认明确的失败信号，不误杀短但有效的页面（如一个只有一句的公告）：
 * 标题里出现 Page Not Found / 404 / 访问验证，或正文极短且带失败关键词。
 */
export const isBadPage = (text = '') => {
  const t = String(text).trim();
  // 只看开头一小段（标题通常在最前），避免正文里讨论"404"被误判
  const head = t.slice(0, 400);
  if (/^\s*(page\s*not\s*found|404\b|error\s*404|not\s*found\b)/i.test(head)) return true;
  if (/\b(page not found|404 error|access denied|forbidden)\b/i.test(head)) return true;
  if (/访问验证|人机验证|请输入验证码|验证后方可访问/.test(head)) return true;
  if (t.length < 120 && /(not found|404|验证|访问受限|禁止访问)/i.test(t)) return true;
  return false;
};

/**
 * 抓取策略：直连 fetch → 抖着重试一次 → 用无头 Chrome 渲染再取。
 *
 * 最后一步是必须的：有站点对脚本一律 403/412 或只回空壳页，对真浏览器却正常
 * （Choosing Wisely 全站回同一份首页、卫健委 412、PMC 弹验证码）。
 * 动态 import 是为了避免与 render-page.mjs 形成循环依赖。
 */
const tryRender = async (url) => {
  const { renderWithChrome, chromeAvailable } = await import('./render-page.mjs');
  if (!chromeAvailable()) throw new Error('没有可用的 Chrome 兜底渲染');
  return renderWithChrome(url);
};

export const fetchSource = async (url) => {
  const target = FETCH_AS[url] || url;
  try {
    return await fetchOnce(target);
  } catch (e) {
    // 4xx 是"对方明确不欢迎脚本"，直接换浏览器渲染；其它错误先重试一次
    if (!/HTTP 4\d\d/.test(e.message) || /HTTP 5|HTTP 429/.test(e.message)) {
      try {
        await new Promise((r) => setTimeout(r, 1200));
        return await fetchOnce(target);
      } catch { /* 落到渲染兜底 */ }
    }
    return tryRender(target);
  }
};
