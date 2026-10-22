"""Stage 2: rasterize selected PDF pages and package *provided* text as editable DOCX.

This is NOT OCR, image reconstruction, chemical-structure recognition, or
page-layout preservation. Input must be a UTF-8 JSON array of objects like
{"page": 1, "content": "# Heading\\n\\nH₂O\\n\\n| A | B |\\n|---|---|\\n| x | y |"}.
Only plain Markdown headings, paragraphs, and pipe tables are supported.
Unrecognized figures must be described in the supplied text; no figure is
recreated. Each input page starts a new Word page. No page image is embedded.
Outputs must be outside this source directory and must not already exist.

CLI: python stage2_document.py render --pdf SOURCE --pages 1,3-4 --output-dir DIR
     python stage2_document.py build --input RECOGNIZED.json --output FILE.docx
"""
import argparse
import json
from pathlib import Path
import re
from xml.etree import ElementTree as ET
from zipfile import ZipFile, ZIP_DEFLATED

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
ET.register_namespace("w", W)
ET.register_namespace("", CT)


def _tag(name):
    return "{%s}%s" % (W, name)


def _private_output(path):
    path = Path(path).resolve()
    if path == Path(__file__).resolve().parent or Path(__file__).resolve().parent in path.parents:
        raise ValueError("Private outputs must be outside the public source directory")
    if path.exists():
        raise ValueError("Refusing to overwrite existing output: %s" % path)
    return path


def _validate_text(text):
    if not isinstance(text, str) or not text.strip():
        raise ValueError("Every page needs nonempty recognized text")
    if re.search(r"!\s*\[[^]]*\]\([^)]*\)|<\s*img\b", text, re.I):
        raise ValueError("Image Markdown/HTML is unsupported; a page image cannot substitute for editable content")
    if any(ord(c) < 32 and c not in "\t\n\r" for c in text):
        raise ValueError("Invalid control character in page content")
    # XML 1.0 excludes surrogates and noncharacters.
    if any(0xD800 <= ord(c) <= 0xDFFF or ord(c) in (0xFFFE, 0xFFFF) for c in text):
        raise ValueError("Invalid XML character in page content")


def _validate_pages(pages):
    if not isinstance(pages, list) or not pages:
        raise ValueError("Expected a nonempty JSON array of recognized pages")
    seen = set()
    for item in pages:
        if not isinstance(item, dict) or set(item) != {"page", "content"}:
            raise ValueError("Each page must have only 'page' and 'content' keys; image-only pages are forbidden")
        n = item["page"]
        if type(n) is not int or n < 1 or n in seen:
            raise ValueError("Page numbers must be unique positive integers")
        seen.add(n)
        _validate_text(item["content"])


def _text_paragraph(parent, text, heading=None):
    p = ET.SubElement(parent, _tag("p"))
    if heading:
        props = ET.SubElement(p, _tag("pPr"))
        ET.SubElement(props, _tag("pStyle"), {_tag("val"): "Heading%d" % heading})
    run = ET.SubElement(p, _tag("r"))
    t = ET.SubElement(run, _tag("t"))
    t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    t.text = text
    return p


def _cells(line):
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    return [part.strip() for part in line.split("|")]


def _is_separator(line, columns):
    parts = _cells(line)
    return len(parts) == columns and all(re.fullmatch(r":?-{3,}:?", part) for part in parts)


def _table(parent, rows):
    table = ET.SubElement(parent, _tag("tbl"))
    props = ET.SubElement(table, _tag("tblPr"))
    borders = ET.SubElement(props, _tag("tblBorders"))
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        ET.SubElement(borders, _tag(edge), {_tag("val"): "single", _tag("sz"): "4"})
    cols = len(rows[0])
    grid = ET.SubElement(table, _tag("tblGrid"))
    for _ in range(cols):
        ET.SubElement(grid, _tag("gridCol"), {_tag("w"): str(9000 // cols)})
    for row in rows:
        tr = ET.SubElement(table, _tag("tr"))
        for value in row:
            tc = ET.SubElement(tr, _tag("tc"))
            _text_paragraph(tc, value)


def _append_markdown(body, content):
    lines = content.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            continue
        if "|" in line and i + 1 < len(lines) and _is_separator(lines[i + 1], len(_cells(line))):
            width = len(_cells(line))
            rows = [_cells(line)]
            i += 2
            while i < len(lines) and "|" in lines[i] and len(_cells(lines[i])) == width:
                rows.append(_cells(lines[i]))
                i += 1
            _table(body, rows)
            continue
        heading = re.fullmatch(r"(#{1,6})\s+(.+)", line)
        if heading:
            _text_paragraph(body, heading.group(2), heading=len(heading.group(1)))
        else:
            _text_paragraph(body, line)
        i += 1


def build_docx(pages, output):
    """Build editable paragraphs/native tables from supplied recognized text only."""
    _validate_pages(pages)
    output = _private_output(output)
    if output.suffix.lower() != ".docx":
        raise ValueError("Output must end in .docx")
    body_root = ET.Element(_tag("document"))
    body = ET.SubElement(body_root, _tag("body"))
    for index, page in enumerate(pages):
        if index:
            p = ET.SubElement(body, _tag("p"))
            r = ET.SubElement(p, _tag("r"))
            ET.SubElement(r, _tag("br"), {_tag("type"): "page"})
        _append_markdown(body, page["content"])
    sect = ET.SubElement(body, _tag("sectPr"))
    ET.SubElement(sect, _tag("pgSz"), {_tag("w"): "11906", _tag("h"): "16838"})
    ET.SubElement(sect, _tag("pgMar"), {_tag("top"): "1134", _tag("right"): "1134", _tag("bottom"): "1134", _tag("left"): "1134"})
    content_types = (f'<Types xmlns="{CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                     '<Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" '
                     'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                     '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>')
    relationships = (f'<Relationships xmlns="{R}"><Relationship Id="rId1" '
                     'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
                     'Target="word/document.xml"/></Relationships>')
    document_rels = (f'<Relationships xmlns="{R}"><Relationship Id="rId1" '
                     'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
                     'Target="styles.xml"/></Relationships>')
    styles = ET.Element(_tag("styles"))
    for style_id, size in [("Normal", 22)] + [("Heading%d" % n, 36 - 2 * n) for n in range(1, 7)]:
        style = ET.SubElement(styles, _tag("style"), {_tag("type"): "paragraph", _tag("styleId"): style_id})
        ET.SubElement(style, _tag("name"), {_tag("val"): style_id})
        if style_id == "Normal":
            style.set(_tag("default"), "1")
        else:
            ET.SubElement(style, _tag("basedOn"), {_tag("val"): "Normal"})
        rpr = ET.SubElement(style, _tag("rPr"))
        ET.SubElement(rpr, _tag("rFonts"), {_tag("eastAsia"): "SimSun", _tag("ascii"): "Calibri", _tag("hAnsi"): "Calibri"})
        ET.SubElement(rpr, _tag("sz"), {_tag("val"): str(size)})
        if style_id != "Normal":
            ET.SubElement(rpr, _tag("b"))
    output.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation avoids silently replacing either a prior result or a source.
    with output.open("xb") as handle:
        try:
            with ZipFile(handle, "w", ZIP_DEFLATED) as archive:
                archive.writestr("[Content_Types].xml", content_types)
                archive.writestr("_rels/.rels", relationships)
                archive.writestr("word/document.xml", ET.tostring(body_root, encoding="utf-8", xml_declaration=True))
                archive.writestr("word/_rels/document.xml.rels", document_rels)
                archive.writestr("word/styles.xml", ET.tostring(styles, encoding="utf-8", xml_declaration=True))
        except Exception:
            output.unlink()
            raise
    return output


def render_pages(pdf, pages, output_dir, dpi=200):
    """Render selected 1-based PDF pages to new PNGs; never write to the PDF."""
    import fitz
    pdf = Path(pdf).resolve()
    output_dir = Path(output_dir).resolve()
    if not pdf.is_file() or pdf.suffix.lower() != ".pdf":
        raise ValueError("Input must be an existing PDF")
    if type(dpi) is not int or not 72 <= dpi <= 600:
        raise ValueError("DPI must be an integer from 72 through 600")
    if not isinstance(pages, list) or not pages or any(type(n) is not int or n < 1 for n in pages) or len(set(pages)) != len(pages):
        raise ValueError("Select unique positive 1-based pages")
    # A directory path must also be outside the public tree, even if not created yet.
    if output_dir == Path(__file__).resolve().parent or Path(__file__).resolve().parent in output_dir.parents:
        raise ValueError("Private renders must be outside the public source directory")
    with fitz.open(pdf) as document:
        if document.needs_pass or max(pages) > len(document):
            raise ValueError("PDF is encrypted or a selected page is out of range")
        outputs = [output_dir / ("page-%04d.png" % n) for n in pages]
        if any(p.exists() or p == pdf for p in outputs):
            raise ValueError("Refusing to overwrite an existing render")
        output_dir.mkdir(parents=True, exist_ok=True)
        produced = []
        try:
            for n, path in zip(pages, outputs):
                pix = document[n - 1].get_pixmap(dpi=dpi, alpha=False)
                with path.open("xb") as handle:
                    handle.write(pix.tobytes("png"))
                produced.append(path)
        except Exception:
            for path in produced:
                path.unlink()
            raise
    return outputs


def _page_selection(spec):
    pages = []
    for token in spec.split(","):
        match = re.fullmatch(r"([1-9]\d*)(?:-([1-9]\d*))?", token.strip())
        if not match:
            raise ValueError("Pages must be comma-separated 1-based numbers or closed ranges")
        first, last = int(match.group(1)), int(match.group(2) or match.group(1))
        if last < first:
            raise ValueError("Reversed page range")
        pages.extend(range(first, last + 1))
    return pages


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    render = commands.add_parser("render", help="PDF pages to PNG (no OCR)")
    render.add_argument("--pdf", required=True, type=Path)
    render.add_argument("--pages", required=True)
    render.add_argument("--output-dir", required=True, type=Path)
    render.add_argument("--dpi", type=int, default=200)
    build = commands.add_parser("build", help="recognized text JSON to editable DOCX")
    build.add_argument("--input", required=True, type=Path)
    build.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "render":
            result = render_pages(args.pdf, _page_selection(args.pages), args.output_dir, args.dpi)
            print(json.dumps({"rendered": [str(p) for p in result]}, ensure_ascii=False))
        else:
            pages = json.loads(args.input.read_text(encoding="utf-8"))
            result = build_docx(pages, args.output)
            print(json.dumps({"docx": str(result), "recognized_pages": len(pages), "ocr_performed": False}, ensure_ascii=False))
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
