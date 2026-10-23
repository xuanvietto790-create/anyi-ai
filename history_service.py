"""Server-side chat history persisted to SQLite, keyed by account scope."""
import asyncio
import json
import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

router = APIRouter(prefix='/api')


class HistoryBody(BaseModel):
    chats: list[dict] = Field(default_factory=list)


class HistoryStore:
    def __init__(self):
        folder = Path(os.getenv('ANYI_DATA_DIR', 'E:/Codex/work/anyi-ai-data')) / 'history'
        folder.mkdir(parents=True, exist_ok=True)
        self.path = folder / 'history.sqlite3'
        with self.connect() as connection:
            connection.execute(
                'CREATE TABLE IF NOT EXISTS chats ('
                'scope TEXT NOT NULL, chat_id TEXT NOT NULL, '
                'payload TEXT NOT NULL, updated_at REAL NOT NULL, '
                'PRIMARY KEY (scope, chat_id))'
            )

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.path, timeout=10)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def load(self, scope):
        with self.connect() as connection:
            rows = connection.execute(
                'SELECT payload FROM chats WHERE scope = ? ORDER BY updated_at DESC', (scope,)
            ).fetchall()
        chats = []
        for (payload,) in rows:
            try:
                chat = json.loads(payload)
                if isinstance(chat, dict):
                    chats.append(chat)
            except ValueError:
                continue
        return chats

    def replace(self, scope, chats):
        with self.connect() as connection:
            connection.execute('DELETE FROM chats WHERE scope = ?', (scope,))
            rows = []
            for chat in chats:
                if not isinstance(chat, dict) or not chat.get('id'):
                    continue
                updated = chat.get('updatedAt') or chat.get('createdAt') or time.time() * 1000
                rows.append((scope, str(chat['id']), json.dumps(chat, ensure_ascii=False), float(updated)))
            connection.executemany(
                'INSERT OR REPLACE INTO chats (scope, chat_id, payload, updated_at) VALUES (?, ?, ?, ?)', rows
            )


@router.get('/history')
async def get_history(request: Request):
    return {'chats': await asyncio.to_thread(HistoryStore().load, request.state.account['scope'])}


@router.put('/history')
async def put_history(request: Request, body: HistoryBody):
    scope = request.state.account['scope']
    await asyncio.to_thread(HistoryStore().replace, scope, body.chats)
    return {'saved': len(body.chats)}
