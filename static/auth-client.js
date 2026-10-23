/* Authentication UI. Upstream tokens remain in the Python server, never JS storage. */
window.anyiAuth = (() => {
  const get = id => document.getElementById(id);
  let user = null, mode = 'sms', captcha = null, captchaRequest = null, busy = false, sending = false;
  let configured = false, cooldowns = {}, challengeAction = null;
  try { cooldowns = JSON.parse(sessionStorage.getItem('anyi-ai-sms-cooldowns') || '{}'); } catch {}
  async function request(path, options = {}) {
    let response;
    try { response = await fetch('/api/auth/' + path, {...options, credentials: 'same-origin', headers: {'Content-Type': 'application/json', ...options.headers}}); }
    catch (error) { if (error.name === 'AbortError') throw error; throw new Error('账号服务连接失败，请稍后重试'); }
    let result;
    try { result=await response.json(); } catch { throw new Error('账号服务返回异常，请稍后重试'); }
    if (!response.ok) { const error = new Error(typeof result.detail === 'string' ? result.detail : result.detail?.[0]?.msg || '账号操作失败，请检查输入'); error.status = response.status; throw error; }
    return result;
  }
  function error(text) { get('auth-error').textContent = text; get('auth-error').hidden = !text; }
  function fieldError(id, text) {
    get(id + '-error').textContent = text; get(id).setAttribute('aria-invalid', String(!!text));
    return !text;
  }
  function checkPhone() { return fieldError('auth-phone', /^1\d{10}$/.test(get('auth-phone').value.trim()) ? '' : '请输入正确的 11 位手机号'); }
  function checkCaptcha() { return fieldError('auth-captcha', captcha && get('auth-captcha').value.trim() ? '' : '请输入右侧图形验证码'); }
  function checkCode() { return fieldError('auth-code', /^\d{4,8}$/.test(get('auth-code').value.trim()) ? '' : '请输入短信验证码'); }
  function checkPassword() {
    const value = get('auth-password').value, minimum = mode === 'register' ? 8 : 6;
    return fieldError('auth-password', value.length >= minimum && value.length <= 64 ? '' : `密码需要 ${minimum}～64 位`);
  }
  function cooldownKey() { return `${get('auth-phone').value.trim()}:${mode === 'register' ? 'register' : 'login'}`; }
  function updateButtons() {
    const remaining = Math.max(0, Math.ceil(((cooldowns[cooldownKey()] || 0) - Date.now()) / 1000));
    get('send-code').textContent = sending ? '发送中…' : remaining ? `${remaining}s 后重试` : '获取验证码';
    get('send-code').disabled = busy || sending || !!remaining || !configured;
    get('auth-submit').disabled = busy || !configured;
    get('auth-submit').textContent = busy ? mode === 'register' ? '注册中…' : '登录中…' : mode === 'register' ? '创建账号' : '登录';
    get('captcha-refresh').disabled = busy || sending || !configured || !!captchaRequest;
    get('captcha-confirm').disabled = busy || sending || !captcha || !!captchaRequest;
    get('captcha-confirm').textContent = busy || sending ? '正在验证…' : challengeAction === 'password' ? '验证并登录' : '验证并发送';
    get('captcha-close').disabled = busy || sending;
    document.querySelectorAll('[data-auth-mode]').forEach(button => button.disabled = busy || sending);
  }
  async function refreshCaptcha() {
    captchaRequest?.abort(); captcha = null; get('auth-captcha').value = ''; get('captcha-image').hidden = true;
    if (!configured) { updateButtons(); return; }
    const active = new AbortController(); captchaRequest = active; get('captcha-loading').textContent = '加载中…'; get('captcha-loading').hidden = false; updateButtons();
    try {
      const data = await request('captcha', {signal: active.signal});
      if (captchaRequest !== active) return;
      if (!/^data:image\/(svg\+xml|png|jpeg);base64,/i.test(data.image)) throw new Error('验证码图片格式无效，请重试');
      captcha = data; get('captcha-image').src = data.image; get('captcha-image').hidden = false;
    } catch (e) { if (e.name !== 'AbortError') captchaError(e.message); }
    finally { if (captchaRequest === active) { captchaRequest = null; get('captcha-loading').hidden = !!captcha; get('captcha-loading').textContent = '点击重试'; updateButtons(); } }
  }
  function setMode(next) {
    if (busy || sending) return;
    mode = next; error('');
    get('auth-notice').hidden=true;
    get('auth-title').textContent = mode === 'register' ? '创建安逸账号' : '欢迎使用安逸智能AI';
    get('auth-subtitle').textContent = mode === 'register' ? '用一个账号，开始更多灵感' : '登录，继续你的思考与探索';
    get('auth-tabs').hidden = mode === 'register';
    get('password-field').hidden = mode === 'sms'; get('code-field').hidden = mode === 'password';
    get('auth-password').value = ''; get('auth-code').value = '';
    get('auth-password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    get('auth-password').placeholder = mode === 'register' ? '设置 8～64 位密码' : '请输入密码';
    get('auth-password').type = 'password'; get('toggle-password').textContent = '显示'; get('toggle-password').setAttribute('aria-label', '显示密码');
    get('registration-link').hidden = mode === 'register'; get('back-login').hidden = mode !== 'register'; get('switch-sms').hidden = mode !== 'password';
    for (const key of ['auth-phone', 'auth-password', 'auth-code', 'auth-captcha']) fieldError(key, '');
    document.querySelectorAll('[role=tab][data-auth-mode]').forEach(button => {const selected=button.dataset.authMode===mode;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;});
    closeChallenge(); updateButtons();
  }
  function showLogin(message = '') {
    user = null; document.body.classList.add('signed-out'); get('chat-app').hidden = true; get('auth-screen').hidden = false;
    get('auth-form').hidden = false; get('auth-boot').hidden = true;
    get('auth-phone').value = ''; get('auth-password').value = ''; get('auth-code').value = '';
    get('auth-error').hidden = true; get('account-menu').hidden = true;
    setMode('sms');
    if (message) error(message);
  }
  function enter(account) {
    user = account; get('auth-screen').hidden = true; get('chat-app').hidden = false; document.body.classList.remove('signed-out');
    get('account-name').textContent = account.nickname; get('account-phone').textContent = account.phone;
    get('account-avatar').textContent = [...account.nickname][0] || '逸';
    get('account-menu-name').textContent = account.nickname; get('account-menu-phone').textContent = account.phone;
    get('auth-password').value = ''; get('auth-code').value = '';
    window.dispatchEvent(new CustomEvent('anyi:auth-change', {detail: account}));
  }
  async function submitAuth(verified = false) { if (busy || !configured) return;
    error(''); const validPhone = checkPhone();
    const validSecret = mode === 'password' ? checkPassword() : checkCode();
    const validExtra = mode === 'register' ? checkPassword() : true;
    if (!validPhone || !validSecret || !validExtra) { document.querySelector('#auth-form [aria-invalid=true]')?.focus(); return; }
    if (mode === 'password' && !verified) { openChallenge('password'); return; }
    busy = true; updateButtons();
    try {
      const phone = get('auth-phone').value.trim(); let path, body;
      if (mode === 'password') { path = 'login'; body = {phone, password:get('auth-password').value, captchaId:captcha.captchaId, captchaCode:get('auth-captcha').value.trim()}; }
      else { path = mode === 'register' ? 'register' : 'sms/login'; body = {phone, code:get('auth-code').value.trim()}; if (mode === 'register') body.password=get('auth-password').value; }
      const data = await request(path, {method:'POST',body:JSON.stringify(body)}); enter(data.user); closeChallenge(true);
    } catch (e) { if (mode === 'password') { captchaError(e.message); await refreshCaptcha(); } else error(e.message); }
    finally { busy = false; updateButtons(); }
  };
  get('auth-form').onsubmit = event => { event.preventDefault(); submitAuth(); };
  async function sendSms() {
    if (sending || busy) return; error('');
    if (!checkPhone() || !checkCaptcha()) return;
    const phone = get('auth-phone').value.trim(), purpose = mode === 'register' ? 'register' : 'login', key = `${phone}:${purpose}`;
    sending = true; updateButtons();
    try {
      const result = await request('sms/code', {method:'POST',body:JSON.stringify({phone,purpose,captchaId:captcha.captchaId,captchaCode:get('auth-captcha').value.trim()})});
      cooldowns[key] = Date.now() + result.cooldownSeconds * 1000;
      try { sessionStorage.setItem('anyi-ai-sms-cooldowns',JSON.stringify(cooldowns)); } catch {}
      get('auth-notice').textContent = result.developmentCode ? `本地联调验证码：${result.developmentCode}（未发送真实短信）` : '验证码已发送，请查看手机短信'; get('auth-notice').hidden = false; closeChallenge(true); get('auth-code').focus();
    } catch (e) { captchaError(e.message); await refreshCaptcha(); }
    finally { sending = false; updateButtons(); }
  };
  function captchaError(text) { get('captcha-error').textContent = text; get('captcha-error').hidden = !text; }
  function closeChallenge(force = false) {
    if (!force && (busy || sending)) return;
    captchaRequest?.abort(); captchaRequest = null; captcha = null; challengeAction = null;
    get('captcha-dialog').close(); get('auth-captcha').value = ''; captchaError('');
  }
  async function openChallenge(action) {
    challengeAction = action; captchaError(''); fieldError('auth-captcha', '');
    get('captcha-description').textContent = action === 'password' ? '输入图中字符，验证通过后登录。' : '输入图中字符，验证通过后发送短信验证码。';
    get('captcha-dialog').showModal(); get('auth-captcha').focus(); await refreshCaptcha();
  }
  get('send-code').onclick = () => {
    if (sending || busy || !configured || (cooldowns[cooldownKey()] || 0) > Date.now()) return;
    error(''); if (!checkPhone()) { get('auth-phone').focus(); return; }
    openChallenge('sms');
  };
  get('captcha-form').onsubmit = event => {
    event.preventDefault();
    if (busy || sending || captchaRequest || !captcha || !checkCaptcha()) return;
    captchaError(''); if (challengeAction === 'password') submitAuth(true); else if (challengeAction === 'sms') sendSms();
  };
  get('captcha-close').onclick = () => closeChallenge();
  get('captcha-dialog').addEventListener('cancel', event => { event.preventDefault(); closeChallenge(); });
  get('captcha-refresh').onclick = () => { captchaError(''); fieldError('auth-captcha',''); refreshCaptcha(); };

  get('auth-phone').oninput = () => { fieldError('auth-phone',''); get('auth-notice').hidden=true; updateButtons(); };
  for (const key of ['auth-password','auth-code','auth-captcha']) get(key).oninput = () => fieldError(key,'');
  document.querySelectorAll('[data-auth-mode]').forEach(button => button.onclick = () => setMode(button.dataset.authMode));
  get('auth-tabs').onkeydown=event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();const next=mode==='sms'?'password':'sms';setMode(next);document.querySelector(`[role=tab][data-auth-mode=${next}]`).focus();}};
  get('toggle-password').onclick = () => { const visible=get('auth-password').type==='text'; get('auth-password').type=visible?'password':'text'; get('toggle-password').textContent=visible?'显示':'隐藏'; get('toggle-password').setAttribute('aria-label',visible?'显示密码':'隐藏密码'); };
  get('account-button').onclick = () => { const open=get('account-menu').hidden;get('account-menu').hidden=!open;get('account-button').setAttribute('aria-expanded',String(open)); };
  get('logout').onclick = async () => {
    get('logout').disabled=true;
    try { await request('logout',{method:'POST'}); showLogin(); window.dispatchEvent(new CustomEvent('anyi:auth-change',{detail:null})); }
    catch(e){window.dispatchEvent(new CustomEvent('anyi:auth-error',{detail:e.message}));}
    finally{get('logout').disabled=false;}
  };
  document.addEventListener('click', event => { if (!get('account-area').contains(event.target)) {get('account-menu').hidden=true;get('account-button').setAttribute('aria-expanded','false');} });
  document.addEventListener('keydown', event => { if(event.key==='Escape')get('account-menu').hidden=true; });
  setInterval(updateButtons, 1000);
  async function recheck() {
    try{const data=await request('me');if(user?.scope!==data.user.scope)enter(data.user);return data.user;}
    catch(e){if(e.status===401&&user){showLogin('登录已过期，请重新登录');window.dispatchEvent(new CustomEvent('anyi:auth-change',{detail:null}));}return null;}
  }
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&user)recheck();});
  const ready = (async () => {
    try {
      const config=await request('config');configured=config.configured;
      get('auth-dev-note').hidden=!config.mockDevelopment;
      if (!configured) { showLogin(); error('正式账号接口待配置，请稍后刷新。'); return null; }
      try { const data=await request('me'); enter(data.user); return data.user; }
      catch(e){showLogin(e.status===401?'':e.message);return null;}
    } catch(e){showLogin();error(e.message);return null;}
  })();
  return {ready,recheck,get user(){return user;},expire(){if(user){showLogin('登录已过期，请重新登录');window.dispatchEvent(new CustomEvent('anyi:auth-change',{detail:null}));}}};
})();
