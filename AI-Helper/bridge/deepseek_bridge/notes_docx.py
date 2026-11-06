"""Lecture notes → Word (.docx).

DeepSeek renders its Markdown reply as HTML; we read that HTML from the page and map it to Word:
headings, paragraphs, bold/italic, bulleted and numbered lists (nested), tables, code and
formulas (KaTeX is replaced by its TeX source). Plain Markdown text is supported as a fallback.
"""

from __future__ import annotations

import re
from html.parser import HTMLParser
from pathlib import Path
from typing import Optional

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Pt, RGBColor

SKIP_TAGS = {"button", "svg", "script", "style", "noscript", "img"}
BLOCK_TAGS = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "pre", "blockquote", "td", "th", "div"}


class _Run:
    __slots__ = ("text", "bold", "italic", "code")

    def __init__(self, text: str, bold: bool, italic: bool, code: bool):
        self.text, self.bold, self.italic, self.code = text, bold, italic, code


class _Block:
    """One paragraph-level item: kind is p / h1..h6 / li / pre / quote."""

    def __init__(self, kind: str, level: int = 0, ordered: bool = False):
        self.kind, self.level, self.ordered = kind, level, ordered
        self.runs: list[_Run] = []

    def text(self) -> str:
        return "".join(r.text for r in self.runs)


class _Table:
    def __init__(self) -> None:
        self.rows: list[list[str]] = []
        self.header_rows = 0


class _Parser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.items: list[object] = []
        self.block: Optional[_Block] = None
        self.lists: list[bool] = []  # stack of "ordered?"
        self.bold = self.italic = self.code = 0
        self.skip = 0
        self.katex = 0  # inside a rendered formula: take only its TeX annotation
        self.tex: Optional[list[str]] = None
        self.pre = 0
        self.table: Optional[_Table] = None
        self.cell: Optional[list[str]] = None
        self.in_thead = False

    # ---- helpers ----

    def _open(self, kind: str, level: int = 0, ordered: bool = False) -> None:
        self._close()
        self.block = _Block(kind, level, ordered)

    def _close(self) -> None:
        if self.block and self.block.text().strip():
            self.items.append(self.block)
        self.block = None

    def _text(self, data: str) -> None:
        if self.cell is not None:
            self.cell.append(data)
            return
        if not self.pre:
            data = re.sub(r"\s+", " ", data)
        if not data:
            return
        if self.block is None:
            if not data.strip():
                return
            self._open("li" if self.lists else "p", len(self.lists), bool(self.lists and self.lists[-1]))
        if not self.block.runs and not self.pre:
            data = data.lstrip()
        self.block.runs.append(_Run(data, self.bold > 0, self.italic > 0, self.code > 0))

    # ---- parser callbacks ----

    def handle_starttag(self, tag: str, attrs: list[tuple[str, Optional[str]]]) -> None:
        a = dict(attrs)
        cls = a.get("class") or ""
        if self.skip:
            if tag not in ("br", "hr", "img"):
                self.skip += 1
            return
        if tag in SKIP_TAGS or "code-info" in cls or "md-code-block-banner" in cls or a.get("role") == "button":
            if tag not in ("img",):
                self.skip = 1
            return
        if self.katex:
            self.katex += 1
            if tag == "annotation" and (a.get("encoding") or "").startswith("application/x-tex"):
                self.tex = []
            return
        if "katex" in cls.split():
            self.katex = 1
            return
        if tag in ("strong", "b"):
            self.bold += 1
        elif tag in ("em", "i"):
            self.italic += 1
        elif tag == "code":
            self.code += 1
        elif re.fullmatch(r"h[1-6]", tag):
            self._open(tag)
        elif tag == "p":
            if self.cell is None:
                self._open("li" if self.lists and self.block and self.block.kind == "li" else "p", len(self.lists), bool(self.lists and self.lists[-1]))
        elif tag in ("ul", "ol"):
            self._close()
            self.lists.append(tag == "ol")
        elif tag == "li":
            self._open("li", len(self.lists), bool(self.lists and self.lists[-1]))
        elif tag == "pre":
            self._open("pre")
            self.pre += 1
        elif tag == "blockquote":
            self._open("quote")
        elif tag == "br":
            if self.cell is not None:
                self.cell.append(" ")
            elif self.block:
                self.block.runs.append(_Run("\n", False, False, False))
        elif tag == "table":
            self._close()
            self.table = _Table()
        elif tag == "thead":
            self.in_thead = True
        elif tag == "tr" and self.table is not None:
            self.table.rows.append([])
            if self.in_thead:
                self.table.header_rows += 1
        elif tag in ("td", "th") and self.table is not None:
            self.cell = []

    def handle_endtag(self, tag: str) -> None:
        if self.skip:
            self.skip -= 1
            return
        if self.katex:
            if tag == "annotation" and self.tex is not None:
                tex = "".join(self.tex).strip()
                self.tex = None
                self.katex -= 1
                if tex:
                    italic, self.italic = self.italic, 1
                    self._text(f" {tex} ")
                    self.italic = italic
                return
            self.katex -= 1
            return
        if tag in ("strong", "b"):
            self.bold = max(0, self.bold - 1)
        elif tag in ("em", "i"):
            self.italic = max(0, self.italic - 1)
        elif tag == "code":
            self.code = max(0, self.code - 1)
        elif re.fullmatch(r"h[1-6]", tag) or tag in ("p", "li", "blockquote"):
            if self.cell is None:
                self._close()
        elif tag == "pre":
            self.pre = max(0, self.pre - 1)
            self._close()
        elif tag in ("ul", "ol"):
            self._close()
            if self.lists:
                self.lists.pop()
        elif tag == "thead":
            self.in_thead = False
        elif tag in ("td", "th") and self.table is not None and self.cell is not None:
            if self.table.rows:
                self.table.rows[-1].append(re.sub(r"\s+", " ", "".join(self.cell)).strip())
            self.cell = None
        elif tag == "table" and self.table is not None:
            if self.table.rows:
                self.items.append(self.table)
            self.table = None

    def handle_data(self, data: str) -> None:
        if self.skip:
            return
        if self.katex:
            if self.tex is not None:
                self.tex.append(data)
            return
        self._text(data)

    def close(self) -> None:
        super().close()
        self._close()


def parse_html(html: str) -> list[object]:
    p = _Parser()
    p.feed(html)
    p.close()
    return p.items


_MD_INLINE = re.compile(r"(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)")


def parse_markdown(text: str) -> list[object]:
    """Fallback when there is no HTML: # headings, - / 1. lists, **bold**, *italic*."""
    items: list[object] = []
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip() or re.fullmatch(r"\s*(-{3,}|\*{3,})\s*", line):
            continue
        indent = (len(line) - len(line.lstrip())) // 2
        s = line.strip()
        m = re.match(r"(#{1,6})\s+(.*)", s)
        if m:
            b = _Block(f"h{len(m.group(1))}")
            s = m.group(2)
        elif re.match(r"[-*•]\s+", s):
            b = _Block("li", indent + 1, False)
            s = re.sub(r"^[-*•]\s+", "", s)
        elif re.match(r"\d+[.)]\s+", s):
            b = _Block("li", indent + 1, True)
            s = re.sub(r"^\d+[.)]\s+", "", s)
        elif s.startswith(">"):
            b = _Block("quote")
            s = s.lstrip("> ")
        else:
            b = _Block("p")
        for part in _MD_INLINE.split(s):
            if not part:
                continue
            if part.startswith("**") and part.endswith("**"):
                b.runs.append(_Run(part[2:-2], True, False, False))
            elif part.startswith("`") and part.endswith("`"):
                b.runs.append(_Run(part[1:-1], False, False, True))
            elif part.startswith("*") and part.endswith("*") and len(part) > 2:
                b.runs.append(_Run(part[1:-1], False, True, False))
            else:
                b.runs.append(_Run(part, False, False, False))
        items.append(b)
    return items


def _add_runs(par, runs: list[_Run]) -> None:
    for r in runs:
        run = par.add_run(r.text)
        run.bold = r.bold or None
        run.italic = r.italic or None
        if r.code:
            run.font.name = "Consolas"


def write_docx(path: Path, title: str, subtitle: str, items: list[object]) -> None:
    doc = Document()
    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(12)
    head = doc.add_heading(title, level=0)
    head.alignment = WD_ALIGN_PARAGRAPH.LEFT
    if subtitle:
        sp = doc.add_paragraph()
        run = sp.add_run(subtitle)
        run.italic = True
        run.font.color.rgb = RGBColor(0x66, 0x66, 0x66)

    for it in items:
        if isinstance(it, _Table):
            cols = max(len(r) for r in it.rows)
            table = doc.add_table(rows=0, cols=cols)
            table.style = "Table Grid"
            for i, row in enumerate(it.rows):
                cells = table.add_row().cells
                for j in range(cols):
                    cells[j].text = row[j] if j < len(row) else ""
                    if i < (it.header_rows or 1):  # Markdown tables always start with a header row
                        for p in cells[j].paragraphs:
                            for r in p.runs:
                                r.bold = True
            doc.add_paragraph()
            continue
        b: _Block = it  # type: ignore[assignment]
        if b.kind.startswith("h"):
            # h1 of the reply is the topic: one level below the document title
            level = min(int(b.kind[1]), 4)
            par = doc.add_heading(level=level)
            _add_runs(par, b.runs)
        elif b.kind == "li":
            level = max(1, min(b.level, 3))
            base = "List Number" if b.ordered else "List Bullet"
            style = base if level == 1 else f"{base} {level}"
            par = doc.add_paragraph(style=style)
            _add_runs(par, b.runs)
        elif b.kind == "pre":
            par = doc.add_paragraph()
            run = par.add_run(b.text().strip("\n"))
            run.font.name = "Consolas"
            run.font.size = Pt(10)
        elif b.kind == "quote":
            par = doc.add_paragraph(style="Intense Quote")
            _add_runs(par, b.runs)
        else:
            par = doc.add_paragraph()
            _add_runs(par, b.runs)
    path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(path))


def notes_to_docx(path: Path, title: str, subtitle: str, html: str = "", markdown: str = "") -> int:
    """Writes the notes; returns how many blocks went into the document."""
    # HTML without any structure (the reply was shown as plain text): the Markdown is better
    structured = bool(re.search(r"<(h[1-6]|p|li|ul|ol|table|pre)\b", html, re.I))
    items = parse_html(html) if structured else []
    if not items and markdown.strip():
        items = parse_markdown(markdown)
    write_docx(path, title, subtitle, items)
    return len(items)
