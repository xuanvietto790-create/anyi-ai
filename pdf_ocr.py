"""Bounded, local Chinese/English OCR for PDF pages without usable text."""
import threading
import hashlib
from collections import OrderedDict

from fastapi import HTTPException

MAX_OCR_PAGES = 20
_lock = threading.Lock()  # PDFium and the shared inference engine are serialized.
_engine = None
_cache = OrderedDict()


def recognize_pages(data, indices, progress=None):
    global _engine
    if len(indices) > MAX_OCR_PAGES:
        raise HTTPException(400, '扫描页较多，单次最多识别 20 页，请拆分 PDF 后上传')
    key = (hashlib.sha256(data).digest(), tuple(indices))
    import pypdfium2 as pdfium
    import numpy as np
    from rapidocr_onnxruntime import RapidOCR

    with _lock:
        if key in _cache:
            _cache.move_to_end(key)
            if progress:
                progress(95, '已复用识别结果')
            return dict(_cache[key])
        if _engine is None:
            _engine = RapidOCR(intra_op_num_threads=2, inter_op_num_threads=1)
        texts = {}
        with pdfium.PdfDocument(data) as document:
            for done, index in enumerate(indices, 1):
                page = document[index]
                try:
                    width, height = page.get_size()
                    if min(width, height) <= 0:
                        raise ValueError('Invalid page size')
                    bitmap = page.render(scale=min(2.5, 2400 / max(width, height)))
                    try:
                        picture = bitmap.to_pil().convert('RGB')
                        try:
                            result, _ = _engine(np.asarray(picture))
                            texts[index] = '\n'.join(row[1] for row in (result or []) if row[2] >= .5)
                        finally:
                            picture.close()
                    finally:
                        bitmap.close()
                finally:
                    page.close()
                if progress:
                    progress(40 + int(55 * done / len(indices)), f'文字识别 {done}/{len(indices)} 页')
        # Cache only recognized text, never PDF bytes; bounded to eight documents.
        _cache[key] = dict(texts)
        while len(_cache) > 8:
            _cache.popitem(last=False)
        return texts
