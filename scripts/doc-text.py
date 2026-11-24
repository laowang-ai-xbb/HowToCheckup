"""
把老式 .doc（Word 97-2003 二进制，OLE2 复合文档）抽成纯文本，给 snapshot-sources.mjs 用。

为什么要有这一支：
卫健委 2009 年前后发布的指南只发 Word 文件、不发 PDF（《中国居民口腔健康指南》就是）。
这份文件的官网网页版对脚本一律回 412（WAF），但同站的 .doc 原件能正常下载 ——
所以拿原件来核引文，比拿某个县政府网站的转载可靠得多：
转载会改字（实测柳城那份把"最好每年一次"漏成了"每年一次"）。

做法：不解析 OLE 目录结构，挑最稳的路 ——
中文正文在 Word 二进制里是按 UTF-16LE 连续存放的，整段解码后按字符白名单过滤，
就能得到顺序正确、可直接做子串比对的正文。够用来验"这句话在不在原文里"。
缺点是少量页眉/批注也会混进来，以及没有段落切分 —— 对引文校验都无影响。
"""
import re
import sys


def main(path: str) -> int:
    try:
        with open(path, "rb") as f:
            raw = f.read()
        if not raw.startswith(b"\xd0\xcf\x11\xe0"):
            sys.stderr.write("不是 doc：文件头不是 OLE2（D0CF11E0）")
            return 2

        text = raw.decode("utf-16-le", "ignore")
        out = []
        for ch in text:
            code = ord(ch)
            if 0x4E00 <= code <= 0x9FFF:      # 汉字
                out.append(ch)
            elif 0x3000 <= code <= 0x303F:    # 中文标点
                out.append(ch)
            elif 0xFF00 <= code <= 0xFF65:    # 全角字符
                out.append(ch)
            elif 32 <= code < 127:            # 半角可打印
                out.append(ch)
            else:
                out.append("\n")
        body = "".join(out)
        body = re.sub(r"\n{2,}", "\n", body)
        if len(body) < 200:
            sys.stderr.write(f"正文过短（{len(body)} 字），可能不是文本型 doc")
            return 2
        sys.stdout.write(body)
        return 0
    except Exception as exc:
        sys.stderr.write(f"{type(exc).__name__}: {exc}")
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
