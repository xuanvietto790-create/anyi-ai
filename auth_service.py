"""Reuse Anyi-node accounts and Aliyun SMS via a server-side session gateway."""
import asyncio
import hashlib
import json
import os
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlparse

import httpx
from cryptography.fernet import Fernet
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

router = APIRouter(prefix='/api/auth')
COOKIE = 'anyi_ai_session'
SESSION_DAYS = 30
refresh_lock = asyncio.Lock()


def api_base():
    value = os.getenv('ANYI_AUTH_BASE_URL', '').strip().rstrip('/')
    if not value:
        raise HTTPException(503, '尚未配置正式账号接口，请在服务端配置 ANYI_AUTH_BASE_URL')
    parsed = urlparse(value)
    if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in {'127.0.0.1', 'localhost'}):
        raise HTTPException(503, '正式账号接口必须使用 HTTPS')
    if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise HTTPException(503, '账号接口地址配置不正确')
    return value if parsed.path.rstrip('/').endswith('/api') else value + '/api'


def mock_development():
    try:
        return urlparse(api_base()).hostname in {'localhost', '127.0.0.1'} and os.getenv('ANYI_AUTH_ALLOW_MOCK', '').lower() == 'true'
    except HTTPException:
        return False


class SessionStore:
    def __init__(self):
        folder = Path(os.getenv('ANYI_DATA_DIR', 'E:/Codex/work/anyi-ai-data')) / 'auth'
        folder.mkdir(parents=True, exist_ok=True)
        self.path = folder / 'sessions.sqlite3'
        key_path = folder / 'session.key'
        try:
            with key_path.open('xb') as file:
                file.write(Fernet.generate_key())
        except FileExistsError:
            pass
        self.cipher = Fernet(key_path.read_bytes())
        with self.connect() as connection:
            connection.execute('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, payload BLOB NOT NULL, expires REAL NOT NULL)')

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.path, timeout=10)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def get(self, token):
        if not token or len(token) > 128:
            return None
        with self.connect() as connection:
            row = connection.execute('SELECT payload, expires FROM sessions WHERE id = ?', (self.digest(token),)).fetchone()
        if not row or row[1] < time.time():
            return None
        try:
            return json.loads(self.cipher.decrypt(row[0]))
        except Exception:
            return None

    def put(self, token, value):
        payload = self.cipher.encrypt(json.dumps(value, ensure_ascii=False).encode())
        with self.connect() as connection:
            connection.execute('INSERT OR REPLACE INTO sessions VALUES (?, ?, ?)', (self.digest(token), payload, value['expires']))
            connection.execute('DELETE FROM sessions WHERE expires < ?', (time.time(),))

    def delete(self, token):
        with self.connect() as connection:
            connection.execute('DELETE FROM sessions WHERE id = ?', (self.digest(token),))

    @staticmethod
    def digest(token):
        return hashlib.sha256(token.encode()).hexdigest()


def check_origin(request: Request):
    origin = request.headers.get('origin')
    if origin and origin != str(request.base_url).rstrip('/'):
        raise HTTPException(403, '请求来源无效，请从当前站点操作')
    if request.headers.get('sec-fetch-site') == 'cross-site':
        raise HTTPException(403, '不支持跨站请求')


async def upstream(endpoint, method='POST', payload=None, session=None, ip=None):
    headers = {}
    if session:
        headers['Authorization'] = 'Bearer ' + session['access']
    if ip:
        headers['X-Forwarded-For'] = ip
    cookies = {'anyi_refresh_token': session['refresh']} if session else None
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=False, cookies=cookies) as client:
            response = await client.request(method, api_base() + '/auth/' + endpoint, json=payload, headers=headers)
        result = response.json()
    except httpx.HTTPError:
        raise HTTPException(503, '账号服务连接失败，请稍后重试') from None
    except ValueError:
        raise HTTPException(502, '账号服务返回异常，请稍后重试') from None
    if response.status_code >= 500:
        raise HTTPException(503, '账号服务暂时不可用，请稍后重试')
    if response.status_code >= 300 or result.get('code', 0) != 0:
        status = response.status_code if 400 <= response.status_code < 500 else 400
        message = result.get('message')
        raise HTTPException(status, message if isinstance(message, str) and len(message) < 180 else '账号操作失败，请重试')
    return result.get('data'), response.cookies.get('anyi_refresh_token')


def public_user(user):
    if not isinstance(user, dict) or not user.get('id'):
        raise HTTPException(502, '账号资料不完整，请重新登录')
    namespace = hashlib.sha256(api_base().encode()).hexdigest()[:12]
    phone = str(user.get('phone', ''))
    return {'id': str(user['id']), 'scope': f'{namespace}-{user["id"]}',
            'nickname': str(user.get('nickname') or '安逸用户')[:80],
            'phone': phone[:3] + '****' + phone[-4:] if len(phone) == 11 else ''}


async def load_session(request):
    token = request.cookies.get(COOKIE, '')
    store = SessionStore()
    value = await asyncio.to_thread(store.get, token)
    if not value or value.get('origin') != api_base():
        raise HTTPException(401, '请先登录安逸智能AI')
    if value['access_expires'] <= time.time():
        async with refresh_lock:
            value = await asyncio.to_thread(store.get, token)
            if not value:
                raise HTTPException(401, '登录已过期，请重新登录')
            if value['access_expires'] <= time.time():
                try:
                    result, refresh = await upstream('refresh', session=value)
                except HTTPException as error:
                    if error.status_code == 401:
                        await asyncio.to_thread(store.delete, token)
                    raise
                if not result or not result.get('accessToken') or not refresh:
                    raise HTTPException(502, '账号刷新失败，请重新登录')
                value.update(access=result['accessToken'], refresh=refresh,
                             access_expires=time.time() + max(1, result.get('expiresIn', 900) - 30))
                await asyncio.to_thread(store.put, token, value)
    request.state.account = public_user(value['user'])
    request.state.session = value
    return value


async def protect_api(request: Request):
    path = request.url.path
    protected = path in {'/api/chat', '/api/context', '/api/history', '/api/speech/transcribe', '/api/speech/synthesize'} or path.startswith('/api/attachments')
    if protected:
        if request.method != 'GET':
            check_origin(request)
        await load_session(request)
        scope = request.headers.get('x-anyi-account')
        if scope and scope != request.state.account['scope']:
            raise HTTPException(409, '账号已在其他页面切换，请刷新后重试', headers={'X-Anyi-Auth-State': 'changed'})


async def authenticated(result, refresh, response, request):
    if not result or not result.get('accessToken') or not refresh:
        raise HTTPException(502, '登录服务返回不完整，请稍后重试')
    user = public_user(result.get('user'))
    token = secrets.token_urlsafe(48)
    value = {'origin': api_base(), 'access': result['accessToken'], 'refresh': refresh,
             'user': result['user'], 'access_expires': time.time() + max(1, result.get('expiresIn', 900) - 30),
             'expires': time.time() + SESSION_DAYS * 86400}
    await asyncio.to_thread(SessionStore().put, token, value)
    response.set_cookie(COOKIE, token, httponly=True, samesite='lax', secure=request.url.scheme == 'https',
                        max_age=SESSION_DAYS * 86400, path='/api')
    return {'user': user}


class PhoneBody(BaseModel):
    phone: str = Field(pattern=r'^1\d{10}$')


class CaptchaFields(PhoneBody):
    captchaId: str = Field(min_length=1, max_length=100)
    captchaCode: str = Field(min_length=1, max_length=8)


class SmsBody(CaptchaFields):
    purpose: str = Field(pattern=r'^(login|register)$')


class PasswordBody(CaptchaFields):
    password: str = Field(min_length=6, max_length=64)


class SmsLoginBody(PhoneBody):
    code: str = Field(pattern=r'^\d{4,8}$')


class RegisterBody(SmsLoginBody):
    password: str = Field(min_length=8, max_length=64)
    nickname: str = Field(default='', max_length=40)


@router.get('/config')
async def config():
    try:
        api_base()
        configured = True
    except HTTPException:
        configured = False
    return {'configured': configured, 'mockDevelopment': mock_development()}


@router.get('/captcha')
async def captcha(request: Request):
    data, _ = await upstream('captcha', method='GET', ip=request.client.host if request.client else None)
    if not data or not str(data.get('image', '')).startswith('data:image/') or not data.get('captchaId'):
        raise HTTPException(502, '图形验证码加载失败，请重试')
    return data


@router.post('/sms/code', dependencies=[Depends(check_origin)])
async def sms(body: SmsBody):
    data, _ = await upstream('sms/code', payload=body.model_dump())
    result = {'cooldownSeconds': min(300, max(1, int(data.get('cooldownSeconds', 60)))), 'expiresInSeconds': data.get('expiresInSeconds', 300)}
    if mock_development() and isinstance(data.get('debugCode'), str):
        result['developmentCode'] = data['debugCode']
    return result


@router.post('/login', dependencies=[Depends(check_origin)])
async def login(body: PasswordBody, request: Request, response: Response):
    data, refresh = await upstream('login', payload=body.model_dump())
    return await authenticated(data, refresh, response, request)


@router.post('/sms/login', dependencies=[Depends(check_origin)])
async def sms_login(body: SmsLoginBody, request: Request, response: Response):
    data, refresh = await upstream('sms/login', payload=body.model_dump())
    return await authenticated(data, refresh, response, request)


@router.post('/register', dependencies=[Depends(check_origin)])
async def register(body: RegisterBody, request: Request, response: Response):
    data, refresh = await upstream('register', payload=body.model_dump())
    return await authenticated(data, refresh, response, request)


@router.get('/me')
async def me(request: Request):
    value = await load_session(request)
    try:
        user, _ = await upstream('me', method='GET', session=value)
    except HTTPException as error:
        if error.status_code == 401:
            await asyncio.to_thread(SessionStore().delete, request.cookies[COOKIE])
        raise
    value['user'] = user
    await asyncio.to_thread(SessionStore().put, request.cookies[COOKIE], value)
    return {'user': public_user(user)}


@router.post('/logout', dependencies=[Depends(check_origin)])
async def logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE, '')
    store = SessionStore()
    value = await asyncio.to_thread(store.get, token)
    try:
        origin = api_base()
    except HTTPException:
        origin = None
    if value and value.get('origin') == origin:
        try:
            await upstream('logout', session=value)
        except HTTPException:
            pass  # Always invalidate this site's session, even if upstream is down.
    await asyncio.to_thread(store.delete, token)
    response.delete_cookie(COOKIE, path='/api')
    return {'success': True}
