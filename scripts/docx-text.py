"""
把 docx 抽成纯文本，给 scripts/snapshot-sources.mjs 用。

踩过的坑：指南登记平台上的"下载 PDF"实际返回的是 docx（文件头 PK），
按 PDF 解析会得到一堆乱码，引用校验就会全部失败。
docx 就是 zip，正文在 word/document.xml，去标签即可，不需要额外依赖。
"""
import re
import sys
import zipfile


def main(path: str) -> int:
    try:
        with zipfile.ZipFile(path) as z:
            names = [n for n in z.namelist() if n in ("word/document.xml",)]
            if not names:
                sys.stderr.write("不是 docx：找不到 word/document.xml")
                return 2
            xml = z.read("word/document.xml").decode("utf-8", "ignore")
        # 段落/换行标签先换成真换行，其余标签删掉
        xml = re.sub(r"</w:p>", "\n", xml)
        xml = re.sub(r"<w:br[^>]*/>", "\n", xml)
        xml = re.sub(r"<[^>]+>", "", xml)
        sys.stdout.write(xml)
        return 0
    except Exception as exc:
        sys.stderr.write(f"{type(exc).__name__}: {exc}")
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
