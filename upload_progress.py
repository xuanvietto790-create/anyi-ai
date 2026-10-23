"""Short-lived account-scoped upload progress, safe for parser worker threads."""
import threading
import time
import uuid
from fastapi import HTTPException

_items = {}
_lock = threading.Lock()


def begin(identifier, owner):
    try:
        if str(uuid.UUID(identifier)) != identifier:
            raise ValueError()
    except ValueError:
        raise HTTPException(400, '解析任务编号无效') from None
    with _lock:
        now = time.monotonic()
        for key in list(_items):
            if _items[key]['expires'] < now:
                del _items[key]
        if identifier in _items:
            raise HTTPException(409, '解析任务编号已使用')
        if len(_items) >= 256:
            raise HTTPException(429, '解析任务较多，请稍后重试')
        _items[identifier] = {'owner': owner, 'expires': now + 900, 'percent': 0, 'stage': '准备解析'}


def update(identifier, percent, stage):
    with _lock:
        if identifier in _items:
            _items[identifier].update(percent=max(_items[identifier]['percent'], min(100, percent)), stage=stage)


def read(identifier, owner):
    with _lock:
        value = _items.get(identifier)
        if not value or value['owner'] != owner or value['expires'] < time.monotonic():
            raise HTTPException(404, '解析任务不存在')
        return {k: value[k] for k in ('percent', 'stage')}
