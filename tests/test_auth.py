import base64
import io
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
import auth_service as auth
import main

REAL_CLIENT = httpx.AsyncClient


class AuthTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='anyi-auth-test-', dir='E:/Codex/tmp')
        self.env = patch.dict(os.environ, {'ANYI_DATA_DIR': self.directory.name, 'ANYI_AUTH_BASE_URL': 'https://accounts.example.test/api', 'ANYI_AUTH_ALLOW_MOCK': 'false'})
        self.env.start()
        self.calls = []
        self.fail_refresh = False
        self.client = REAL_CLIENT(transport=httpx.ASGITransport(app=main.app), base_url='http://test')
        self.proxy = patch.object(auth.httpx, 'AsyncClient', lambda **kwargs: REAL_CLIENT(transport=httpx.MockTransport(self.handle), **kwargs))
        self.proxy.start()

    async def asyncTearDown(self):
        self.proxy.stop()
        await self.client.aclose()
        self.env.stop()
        self.directory.cleanup()

    def handle(self, request):
        self.calls.append(request)
        endpoint = request.url.path.removeprefix('/api/auth/')
        data = json.loads(request.content or '{}')
        if endpoint == 'captcha':
            image = 'data:image/svg+xml;base64,' + base64.b64encode(b'<svg xmlns="http://www.w3.org/2000/svg"><text>ABCD</text></svg>').decode()
            return httpx.Response(200, json={'code': 0, 'data': {'captchaId': 'captcha-id', 'image': image, 'expiresInSeconds': 300}})
        if endpoint == 'sms/code':
            return httpx.Response(200, json={'code': 0, 'data': {'cooldownSeconds': 60, 'debugCode': '123456'}})
        if endpoint in {'login', 'register', 'sms/login'}:
            if data.get('password') == 'wrong-password':
                return httpx.Response(401, json={'code': 401, 'message': '手机号或密码错误'})
            identity = '2' if data.get('phone', '').endswith('2') else '1'
            user = {'id': identity, 'phone': data.get('phone'), 'nickname': '测试用户' + identity}
            return httpx.Response(200, json={'code': 0, 'data': {'accessToken': 'secret-access-' + identity, 'expiresIn': 900, 'user': user}}, headers={'Set-Cookie': 'anyi_refresh_token=secret-refresh-' + identity + '; Path=/api/auth; HttpOnly'})
        if endpoint == 'refresh':
            if self.fail_refresh:
                return httpx.Response(401, json={'code': 401, 'message': '登录已失效'})
            return httpx.Response(200, json={'code': 0, 'data': {'accessToken': 'rotated-secret-access-1', 'expiresIn': 900}}, headers={'Set-Cookie': 'anyi_refresh_token=rotated-secret-refresh-1; Path=/api/auth; HttpOnly'})
        if endpoint == 'me':
            identity = '2' if request.headers.get('authorization', '').endswith('2') else '1'
            return httpx.Response(200, json={'code': 0, 'data': {'id': identity, 'phone': '1380000000' + identity, 'nickname': '测试用户' + identity}})
        return httpx.Response(200, json={'code': 0, 'data': {'success': True}})

    async def login(self, phone='13800000001'):
        return await self.client.post('/api/auth/login', json={'phone': phone, 'password': 'valid-password', 'captchaId': 'captcha-id', 'captchaCode': 'ABCD'})

    async def test_anonymous_api_access_blocked(self):
        self.assertEqual((await self.client.post('/api/chat', json={'messages': [{'role': 'user', 'content': 'hello'}]})).status_code, 401)
        self.assertEqual((await self.client.post('/api/speech/synthesize', json={'text': 'hello'})).status_code, 401)

    async def test_captcha_and_sms_proxy(self):
        result = await self.client.get('/api/auth/captcha')
        self.assertEqual(result.status_code, 200)
        self.assertTrue(result.json()['image'].startswith('data:image/'))
        result = await self.client.post('/api/auth/sms/code', json={'phone': '13800000001', 'purpose': 'register', 'captchaId': 'id', 'captchaCode': 'ABCD'})
        self.assertEqual(result.status_code, 200)
        self.assertNotIn('123456', result.text)
        self.assertEqual(json.loads(self.calls[-1].content)['purpose'], 'register')

    async def test_mock_code_never_exposed_for_remote_service(self):
        with patch.dict(os.environ, {'ANYI_AUTH_ALLOW_MOCK': 'true'}):
            result = await self.client.post('/api/auth/sms/code', json={'phone': '13800000001', 'purpose': 'login', 'captchaId': 'id', 'captchaCode': 'ABCD'})
        self.assertNotIn('developmentCode', result.json())

    async def test_login_http_only_encrypted_session(self):
        response = await self.login()
        self.assertEqual(response.status_code, 200)
        self.assertNotIn('secret-access', response.text)
        self.assertIn('httponly', response.headers['set-cookie'].lower())
        self.assertEqual(response.json()['user']['phone'], '138****0001')
        store = auth.SessionStore()
        raw = store.path.read_bytes()
        self.assertNotIn(b'secret-access', raw)
        self.assertNotIn(b'secret-refresh', raw)
        self.assertEqual((await self.client.get('/api/auth/me')).status_code, 200)

    async def test_register_and_sms_login(self):
        result = await self.client.post('/api/auth/register', json={'phone': '13800000001', 'password': 'valid-password', 'code': '123456'})
        self.assertEqual(result.status_code, 200)
        await self.client.post('/api/auth/logout')
        result = await self.client.post('/api/auth/sms/login', json={'phone': '13800000001', 'code': '123456'})
        self.assertEqual(result.status_code, 200)

    async def test_refresh_and_logout(self):
        await self.login()
        token = self.client.cookies.get(auth.COOKIE)
        store = auth.SessionStore(); value = store.get(token); value['access_expires'] = 0; store.put(token, value)
        self.assertEqual((await self.client.get('/api/auth/me')).status_code, 200)
        self.assertTrue(any(request.url.path.endswith('/refresh') for request in self.calls))
        self.assertEqual(store.get(token)['refresh'], 'rotated-secret-refresh-1')
        self.assertEqual((await self.client.post('/api/auth/logout')).status_code, 200)
        self.assertIsNone(store.get(token))
        self.assertEqual((await self.client.get('/api/auth/me')).status_code, 401)

    async def test_failed_refresh_invalidates_session(self):
        await self.login(); token = self.client.cookies.get(auth.COOKIE)
        store = auth.SessionStore(); value = store.get(token); value['access_expires'] = 0; store.put(token, value)
        self.fail_refresh = True
        self.assertEqual((await self.client.get('/api/auth/me')).status_code, 401)
        self.assertIsNone(store.get(token))

    async def test_attachment_isolation(self):
        await self.login(); first_scope = (await self.client.get('/api/auth/me')).json()['user']['scope']
        image = io.BytesIO()
        from PIL import Image
        Image.new('RGB', (10, 10), 'red').save(image, format='PNG')
        result = await self.client.post('/api/attachments', files={'file': ('sample.png', image.getvalue(), 'image/png')})
        identifier = result.json()['id']
        await self.client.post('/api/auth/logout')
        await self.login('13800000002')
        self.assertEqual((await self.client.get(f'/api/attachments/{identifier}/preview')).status_code, 404)
        self.assertEqual((await self.client.post('/api/attachments/import', json={'attachments': [identifier]})).status_code, 409)
        result = await self.client.post('/api/context', json={'messages': [{'role': 'user', 'content': 'test'}]}, headers={'X-Anyi-Account': first_scope})
        self.assertEqual(result.status_code, 409)
        self.assertEqual(result.headers.get('x-anyi-auth-state'), 'changed')

    async def test_cross_site_posts_blocked(self):
        result = await self.client.post('/api/auth/login', json={'phone': '13800000001', 'password': 'valid-password', 'captchaId': 'id', 'captchaCode': 'ABCD'}, headers={'Origin': 'https://evil.example'})
        self.assertEqual(result.status_code, 403)
        self.assertFalse(self.calls)

    async def test_missing_config_and_plain_http_remote_rejected(self):
        with patch.dict(os.environ, {'ANYI_AUTH_BASE_URL': ''}):
            self.assertFalse((await self.client.get('/api/auth/config')).json()['configured'])
            self.assertEqual((await self.client.get('/api/auth/captcha')).status_code, 503)
        with patch.dict(os.environ, {'ANYI_AUTH_BASE_URL': 'http://remote.example'}):
            self.assertFalse((await self.client.get('/api/auth/config')).json()['configured'])


if __name__ == '__main__':
    unittest.main()
