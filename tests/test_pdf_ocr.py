import io
import unittest
from unittest.mock import Mock, patch

from fastapi import HTTPException
from pypdf import PdfWriter

from attachments import parse_file
from pdf_ocr import MAX_OCR_PAGES, recognize_pages


class PdfOcrTests(unittest.TestCase):
    def pdf(self):
        writer = PdfWriter()
        writer.add_blank_page(width=595, height=842)
        output = io.BytesIO()
        writer.write(output)
        return output.getvalue()

    def test_scanned_pdf_falls_back_and_labels_ocr(self):
        with patch('pdf_ocr.recognize_pages', return_value={0: '高级前端工程师，React、TypeScript，五年开发经验。'}) as recognize:
            data = self.pdf()
            result = parse_file(data, 'resume.pdf')
        recognize.assert_called_once_with(data, [0])
        self.assertIn('高级前端工程师', result['text'])
        self.assertIn('OCR 识别', result['text'])
        self.assertEqual(result['ocr_pages'], 1)

    def test_blank_pdf_still_reports_no_text(self):
        with patch('pdf_ocr.recognize_pages', return_value={0: ''}):
            with self.assertRaises(HTTPException) as error:
                parse_file(self.pdf(), 'blank.pdf')
        self.assertEqual(error.exception.status_code, 400)

    def test_mixed_pdf_keeps_text_pages_and_only_recognizes_scan(self):
        text = 'Readable original text is preserved without OCR substitutions. '
        reader = Mock(is_encrypted=False)
        reader.pages = [Mock(extract_text=Mock(return_value=text)), Mock(extract_text=Mock(return_value=''))]
        with patch('attachments.PdfReader', return_value=reader), patch('pdf_ocr.recognize_pages', return_value={1: '扫描页内容'}) as recognize:
            result = parse_file(b'fixture', 'mixed.pdf')
        recognize.assert_called_once_with(b'fixture', [1])
        self.assertIn(text, result['text'])
        self.assertIn('第 2 页，OCR', result['text'])

    def test_text_pdf_does_not_invoke_ocr(self):
        reader = Mock(is_encrypted=False)
        reader.pages = [Mock(extract_text=Mock(return_value='Original document content, long enough to need no OCR.'))]
        with patch('attachments.PdfReader', return_value=reader), patch('pdf_ocr.recognize_pages') as recognize:
            result = parse_file(b'fixture', 'text.pdf')
        recognize.assert_not_called()
        self.assertEqual(result['ocr_pages'], 0)

    def test_ocr_limit_never_silently_omits_pages(self):
        with self.assertRaises(HTTPException) as error:
            recognize_pages(b'', list(range(MAX_OCR_PAGES + 1)))
        self.assertEqual(error.exception.status_code, 400)

    def test_encrypted_pdf_is_not_sent_to_ocr(self):
        writer = PdfWriter()
        writer.add_blank_page(width=100, height=100)
        writer.encrypt('secret')
        output = io.BytesIO(); writer.write(output)
        with patch('pdf_ocr.recognize_pages') as recognize:
            with self.assertRaises(HTTPException):
                parse_file(output.getvalue(), 'encrypted.pdf')
        recognize.assert_not_called()
