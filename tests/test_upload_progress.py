import unittest
import uuid
from fastapi import HTTPException
from upload_progress import begin, update, read


class ProgressTests(unittest.TestCase):
    def test_account_isolation_and_monotonic_progress(self):
        identifier = str(uuid.uuid4())
        begin(identifier, 'a')
        update(identifier, 40, '读取完成')
        update(identifier, 20, '识别中')
        self.assertEqual(read(identifier, 'a')['percent'], 40)
        with self.assertRaises(HTTPException) as error:
            read(identifier, 'b')
        self.assertEqual(error.exception.status_code, 404)
        update(identifier, 100, '解析完成')
        self.assertEqual(read(identifier, 'a')['percent'], 100)

    def test_reused_and_invalid_tasks_are_rejected(self):
        identifier = str(uuid.uuid4())
        begin(identifier, 'a')
        with self.assertRaises(HTTPException):
            begin(identifier, 'b')
        with self.assertRaises(HTTPException):
            begin('bad-id', 'a')
