"""Focused offline tests for the small Stage 2 preprocessor (no OCR)."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from xml.etree import ElementTree as ET
from zipfile import ZipFile

import fitz
from PIL import Image

import stage2_document as stage2

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


class Stage2DocumentTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_markdown_becomes_editable_paragraphs_and_native_table(self):
        target = self.root / "editable.docx"
        stage2.build_docx([{"page": 1, "content": "# Chemistry\n\nNaHCO₃ and C₆H₇O₈\n\n| 元素 | 名称 |\n|---|---|\n| Cl | 氯 |"}, {"page": 2, "content": "Second page"}], target)
        with ZipFile(target) as z:
            self.assertEqual(z.testzip(), None)
            self.assertFalse(any(name.startswith("word/media/") for name in z.namelist()))
            self.assertIn("word/styles.xml", z.namelist())
            root = ET.fromstring(z.read("word/document.xml"))
            texts = [e.text for e in root.findall(".//{%s}t" % W)]
            self.assertIn("NaHCO₃ and C₆H₇O₈", texts)
            self.assertIn("Cl", texts)
            self.assertEqual(len(root.findall(".//{%s}tbl" % W)), 1)
            self.assertEqual(len(root.findall(".//{%s}tr" % W)), 2)
            self.assertEqual(len(root.findall(".//{%s}br[@{%s}type='page']" % (W, W))), 1)
            self.assertNotIn(b"drawing", z.read("word/document.xml"))

    def test_rejects_image_only_and_unrecognized_pages(self):
        for pages in ([], [{"page": 1, "image": "scan.png"}], [{"page": 1, "content": "![scan](scan.png)"}], [{"page": 1, "content": "  "}], [{"page": 1, "content": "text"}, {"page": 1, "content": "more"}]):
            with self.subTest(pages=pages), self.assertRaises(ValueError):
                stage2.build_docx(pages, self.root / "bad.docx")
        self.assertFalse((self.root / "bad.docx").exists())

    def test_renders_selected_pdf_pages_without_modifying_source(self):
        pdf = self.root / "source.pdf"
        doc = fitz.open()
        doc.new_page()
        doc.new_page()
        doc.save(pdf)
        doc.close()
        original = hashlib.sha256(pdf.read_bytes()).digest()
        files = stage2.render_pages(pdf, [2], self.root / "renders", dpi=72)
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].suffix, ".png")
        with Image.open(files[0]) as rendered:
            self.assertGreater(rendered.width, 0)
        self.assertEqual(hashlib.sha256(pdf.read_bytes()).digest(), original)
        with self.assertRaises(ValueError):
            stage2.render_pages(pdf, [3], self.root / "renders")

    def test_cli_build_and_render_and_protect_source_path(self):
        import subprocess
        import sys
        pdf = self.root / "original.pdf"
        doc = fitz.open()
        doc.new_page()
        doc.save(pdf)
        doc.close()
        pages = self.root / "pages.json"
        pages.write_text(json.dumps([{"page": 1, "content": "H₂O"}], ensure_ascii=False), encoding="utf-8")
        script = Path(stage2.__file__)
        subprocess.run([sys.executable, str(script), "render", "--pdf", str(pdf), "--pages", "1", "--output-dir", str(self.root / "png")], check=True, capture_output=True)
        out = self.root / "text.docx"
        subprocess.run([sys.executable, str(script), "build", "--input", str(pages), "--output", str(out)], check=True, capture_output=True)
        with ZipFile(out) as z:
            self.assertIn("H₂O", z.read("word/document.xml").decode())
        with self.assertRaises(ValueError):
            stage2.build_docx([{"page": 1, "content": "x"}], pdf)
        self.assertTrue(pdf.exists())


if __name__ == "__main__":
    unittest.main()
