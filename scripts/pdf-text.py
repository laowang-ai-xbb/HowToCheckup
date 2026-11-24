"""
把 PDF 抽成纯文本，给 scripts/snapshot-sources.mjs 用。

为什么用 Python 而不是 Node：PDF 里中文常见的 AES 加密 + 字体子集，
Node 侧要么装 pdf-parse（依赖重），要么自己解 CMap。pypdf 一行就够。
加密 PDF 用空密码尝试解密（政府/期刊 PDF 多是这种"只防编辑不防读"的加密）。
"""
import sys

from pypdf import PdfReader


def main(path: str) -> int:
    try:
        reader = PdfReader(path, strict=False)
        if reader.is_encrypted:
            try:
                reader.decrypt("")
            except Exception:
                pass
        out = []
        for page in reader.pages:
            try:
                out.append(page.extract_text() or "")
            except Exception:
                out.append("")
        text = "\n".join(out)
        sys.stdout.write(text)
        return 0
    except Exception as exc:  # 抽不出来不算致命，上层会记录为失败
        sys.stderr.write(f"{type(exc).__name__}: {exc}")
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
