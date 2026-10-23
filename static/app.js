/* All parsing libraries are served locally; model keys never enter the browser. */
const $ = (selector) => document.querySelector(selector);
const input = $('#input');
let storageKey = 'anyi-ai-chats-v1';
const preferencesKey = 'anyi-ai-preferences-v1';
let chats = [], current = null, controller = null, pending = [], editing = null;
let modes = {thinking: false, search: false};
let toastTimer, saveTimer, paintFrame;
let liveView = null, activeSpeech = null, listening = false;
let historyReady = false, contextTimer, contextRequest, displayedChatId, displayLimit = 80;
let speechConfig = {recognition:false,synthesis:false};
let currentAccount = null, accountTransition = Promise.resolve(), legacyChats = [];
let serverSyncTimer = null;
const speechAPI = 'speechSynthesis' in window;
function uuid() {
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
    const value = Math.floor(Math.random() * 16);
    return (char === 'x' ? value : (value & 0x3) | 0x8).toString(16);
  });
}
function activeChatKey(){return currentAccount?'anyi-ai-active-chat-'+currentAccount.scope:'anyi-ai-active-chat';}
async function apiFetch(url,options={}) {
  const response=await fetch(url,{...options,headers:{...options.headers,...(currentAccount?{'X-Anyi-Account':currentAccount.scope}:{})}});
  if(response.status===401)window.anyiAuth.expire();
  if(response.headers.get('X-Anyi-Auth-State')==='changed')window.anyiAuth.recheck();
  return response;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`); svg.append(use); return svg;
}
function button(label, name, action, className = 'action-button') {
  const node = document.createElement('button'); node.type = 'button'; node.className = className;
  node.title = label; node.setAttribute('aria-label', label); if (name) node.append(icon(name));
  node.onclick = action; return node;
}
function node(tag, className, text) {
  const element = document.createElement(tag); if (className) element.className = className;
  if (text !== undefined) element.textContent = text; return element;
}
function notify(text) {
  $('#toast').textContent = text; $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3600);
}
function showError(text) { $('#error-text').textContent = text; $('#error').hidden = false; }
function save() {
  clearTimeout(saveTimer);
  if (!historyReady) return;
  if (window.anyiHistory?.db) {
    anyiHistory.save(chats).catch(() => showError('本机历史保存失败，请导出重要对话并检查磁盘空间。'));
  } else {
    try { localStorage.setItem(storageKey, JSON.stringify(chats)); }
    catch { showError('浏览器存储空间不足，请导出重要对话后清理历史。本次内容暂存于页面。'); }
  }
  syncServer();
}
function soonSave() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 700); }
function flushServerHistory() {
  if (!currentAccount || !historyReady) return;
  const scope = currentAccount.scope;
  const body = JSON.stringify({chats});
  fetch('/api/history', {method:'PUT', headers:{'Content-Type':'application/json','X-Anyi-Account':scope}, body}).catch(() => {});
}
function syncServer() {
  if (!currentAccount || !historyReady) return;
  clearTimeout(serverSyncTimer);
  serverSyncTimer = setTimeout(flushServerHistory, 1500);
}
try {
  const stored = JSON.parse(localStorage.getItem(storageKey) || '[]');
  if (Array.isArray(stored)) chats = stored.filter(c => typeof c?.id === 'string' && Array.isArray(c.messages) && c.messages.every(m => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string'));
  modes = {...modes, ...JSON.parse(localStorage.getItem(preferencesKey) || '{}')};
} catch { showError('部分本地记录无法读取，你仍可以开始新对话。'); }
for (const chat of chats) {
  for (const message of chat.messages) if (message.state === 'streaming') message.state = 'stopped';
}
function chatTitle(chat) { return chat.title || chat.messages.find(m => m.role === 'user')?.content.slice(0, 30) || '新对话'; }
function visibleAnswer(message) {
  return Number.isInteger(message.selectedVersion) && message.versions?.[message.selectedVersion] ? message.versions[message.selectedVersion] : message;
}
function groupName(time) {
  if (!time) return '更早';
  const date = new Date(time), today = new Date(); today.setHours(0, 0, 0, 0);
  if (date >= today) return '今天';
  if (date >= new Date(today.getTime() - 86400000)) return '昨天';
  if (date >= new Date(today.getTime() - 7 * 86400000)) return '最近七天';
  return '更早';
}
function toggleSidebar(force) {
  if (!window.matchMedia('(max-width: 760px)').matches) {
    if (force !== undefined) return;
    document.body.classList.toggle('sidebar-collapsed');
    $('#menu').setAttribute('aria-expanded', String(!document.body.classList.contains('sidebar-collapsed')));
    return;
  }
  const open = force ?? !document.body.classList.contains('sidebar-open');
  document.body.classList.toggle('sidebar-open', open); $('#backdrop').hidden = !open;
  $('#menu').setAttribute('aria-expanded', String(open));
}
function renderHistory() {
  const list = $('#history'); list.replaceChildren(); const query = $('#history-search').value.trim().toLowerCase();
  const filtered = chats.filter(c => !query || [chatTitle(c), ...c.messages.map(m => m.content)].join('\n').toLowerCase().includes(query)).sort((a,b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  if (!filtered.length) { list.append(node('p', 'empty-history', query ? '没有找到相关对话' : '你的新想法，从这里开始')); return; }
  const groups = ['今天', '昨天', '最近七天', '更早'];
  for (const group of groups) {
    const entries = filtered.filter(c => groupName(c.updatedAt || c.createdAt) === group); if (!entries.length) continue;
    list.append(node('div', 'history-label', group));
    for (const chat of entries) {
      const row = node('div', 'history-row' + (chat.id === current?.id ? ' active' : ''));
      const open = button(chatTitle(chat), null, () => { if (controller || pending.some(a => a.state === 'uploading')) return; current = chat; cancelEdit(); pending = []; renderAttachments(); stopVoice(); render(); toggleSidebar(false); scrollDown(); }, 'history-open');
      open.textContent = chatTitle(chat); open.disabled = !!controller; if (chat === current) open.setAttribute('aria-current', 'page');
      const rename = button('重命名对话', 'edit', () => {
        if (controller) return; const field = node('input', 'rename-input'); field.value = chatTitle(chat); field.maxLength = 80; field.setAttribute('aria-label', '对话名称');
        open.replaceWith(field); field.focus(); field.select(); let finished = false;
        const finish = (commit) => { if (finished) return; finished = true; if (commit && field.value.trim()) { chat.title = field.value.trim(); chat.updatedAt=Date.now(); save(); } renderHistory(); };
        field.onkeydown = e => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); }; field.onblur = () => finish(true);
      });
      const remove = button('删除对话', 'trash', () => {
        if (controller) return;
        const location = chats.indexOf(chat); chats.splice(location, 1); if (current === chat) current = null;
        save(); render();
        const banner = $('#toast'); banner.replaceChildren(node('span', '', '对话已删除 '));
        const undo = button('撤销删除', null, () => { chat.updatedAt=Date.now(); chats.splice(Math.min(location, chats.length), 0, chat); save(); render(); notify('已恢复对话'); }); undo.textContent = '撤销'; banner.append(undo); banner.hidden = false;
        clearTimeout(toastTimer); toastTimer = setTimeout(() => { banner.hidden = true; }, 6000);
      });
      rename.disabled = remove.disabled = !!controller;
      row.append(open, rename, remove); list.append(row);
    }
  }
}
function safeURL(value) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; } }
function renderMarkdown(target, text, sources = [], light = false) {
  if (!window.marked || !window.DOMPurify) { target.textContent = text; return; }
  target.innerHTML = DOMPurify.sanitize(marked.parse(text, {gfm: true, breaks: true}), {
    USE_PROFILES: {html: true}, FORBID_TAGS: ['img', 'style', 'form', 'input', 'textarea', 'button', 'video', 'audio', 'svg'], FORBID_ATTR: ['style', 'id'],
  });
  target.querySelectorAll('a').forEach(a => {
    const href = safeURL(a.getAttribute('href')); if (!href) { a.removeAttribute('href'); return; }
    a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
  });
  target.querySelectorAll('pre code').forEach(code => {
    const language = [...code.classList].find(c => c.startsWith('language-'))?.slice(9) || 'text';
    const raw = code.textContent;
    if (!light && window.hljs && hljs.getLanguage(language)) code.innerHTML = hljs.highlight(raw, {language, ignoreIllegals: true}).value;
    const bar = node('div', 'code-toolbar'); bar.append(node('span', '', language));
    const copy = button('复制代码', 'copy', async () => copyText(raw, '代码已复制')); copy.append(node('span', '', '复制代码')); bar.append(copy);
    code.parentNode.prepend(bar);
  });
  target.querySelectorAll('table').forEach(table => { const wrap = node('div', 'table-scroll'); table.replaceWith(wrap); wrap.append(table); });
  if (!light && window.renderMathInElement) renderMathInElement(target, {delimiters: [
    {left: '$$', right: '$$', display: true}, {left: '\\[', right: '\\]', display: true},
    {left: '\\(', right: '\\)', display: false}, {left: '$', right: '$', display: false},
  ], throwOnError: false, trust: false, strict: 'ignore', maxExpand: 500});
  if (sources.length) {
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, {acceptNode: textNode => textNode.parentElement.closest('a,pre,code,.katex') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT});
    const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const textNode of nodes) {
      const parts = textNode.textContent.split(/(\[\d+\])/g); if (parts.length < 2) continue;
      const fragment = document.createDocumentFragment();
      parts.forEach(part => { const source = /^\[\d+\]$/.test(part) && sources.find(s => s.number === Number(part.slice(1,-1))); const href = source && safeURL(source.url);
        if (href) { const a = node('a', 'citation', part); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = source.title; fragment.append(a); }
        else fragment.append(document.createTextNode(part));
      }); textNode.replaceWith(fragment);
    }
  }
}
async function copyText(text, success = '已复制') {
  try { await navigator.clipboard.writeText(text); notify(success); }
  catch { showError('复制失败，请手动选择文字复制。'); }
}
function previewImage(attachment) {
  $('#preview-image').src = `/api/attachments/${encodeURIComponent(attachment.id)}/preview`;
  $('#preview-image').alt = attachment.name; $('#image-dialog').showModal();
}
function attachmentChip(attachment, removable = false) {
  const chip = node('div', 'attachment-chip' + (attachment.state === 'error' ? ' failed' : ''));
  if (attachment.kind === 'image' && attachment.id) {
    const preview = button('预览图片：' + attachment.name, null, () => previewImage(attachment), 'attachment-thumb');
    const image = node('img'); image.src = `/api/attachments/${encodeURIComponent(attachment.id)}/preview`; image.alt = ''; image.onerror = () => { image.hidden = true; }; preview.append(image); chip.append(preview);
  } else chip.append(icon('file'));
  const info = node('div', 'attachment-info'); info.append(node('strong', '', attachment.name));
  const status = attachment.state === 'uploading' ? attachment.progress === 100 ? `${attachment.parseStage || '准备解析'} · ${attachment.parsePercent || 0}%` : `上传中 ${attachment.progress || 0}%` : attachment.state === 'error' ? attachment.error : attachment.truncated ? `已截取前 ${(attachment.text_limit||40000).toLocaleString()} 字符` : `${Math.max(1, Math.round(attachment.size / 1024))} KB · ${attachment.kind === 'image' ? '图片' : attachment.ocr_pages ? '文档 · OCR 已识别' : '文档'}`;
  info.append(node('small', '', status));
  if (attachment.state === 'uploading') {
    const progress = node('progress', 'attachment-progress'); progress.max = 100;
    progress.value = attachment.progress === 100 ? attachment.parsePercent || 0 : attachment.progress || 0;
    progress.setAttribute('aria-label', attachment.progress === 100 ? '文件解析进度' : '文件上传进度'); info.append(progress);
  }
  chip.append(info);
  if (removable) chip.append(button('移除附件：' + attachment.name, 'close', () => { attachment.xhr?.abort(); pending = pending.filter(a => a !== attachment); renderAttachments(); }, 'remove-attachment'));
  return chip;
}
function renderAttachments() { $('#attachments').replaceChildren(...pending.map(a => attachmentChip(a, true))); updateInput(); }
const SUPPORTED_EXTENSIONS = new Set(['png','jpg','jpeg','webp','gif','pdf','docx','txt','md','csv','json','py','js','ts','html','css','log']);
async function uploadFiles(files) {
  if (controller) { notify('请等当前回答完成后再添加附件'); return; }
  for (const file of Array.from(files)) {
    if (pending.length >= 4) { showError('每条消息最多添加 4 个附件'); break; }
    if (file.size > 10 * 1024 * 1024 || !file.size) { showError(`“${file.name}”为空或超过 10 MB，请调整后重试。`); continue; }
    if (!SUPPORTED_EXTENSIONS.has((file.name.split('.').pop() || '').toLowerCase())) { showError(`“${file.name}”格式不支持，可上传图片、PDF、DOCX、TXT、Markdown、CSV 或常见代码文件。`); continue; }
    const item = {name: file.name, size: file.size, state: 'uploading', progress: 0}; pending.push(item); renderAttachments();
    const xhr = new XMLHttpRequest(); item.xhr = xhr; const taskId = uuid(); xhr.open('POST', '/api/attachments?task_id=' + taskId);
    let polling = false;
    const pollTimer = setInterval(async () => {
      if (polling || item.state !== 'uploading') return;
      if (!pending.includes(item)) { clearInterval(pollTimer); return; }
      polling = true;
      try {
        const response = await apiFetch('/api/attachments/progress/' + taskId);
        if (response.ok && pending.includes(item) && item.state === 'uploading') {
          const data = await response.json(); item.progress = 100; item.parsePercent = data.percent; item.parseStage = data.stage; renderAttachments();
        }
      } catch {} finally { polling = false; }
    }, 500);
    xhr.onabort = () => clearInterval(pollTimer); xhr.timeout = 180000;
    if(currentAccount)xhr.setRequestHeader('X-Anyi-Account',currentAccount.scope);
    xhr.upload.onprogress = event => { if (event.lengthComputable) { item.progress = Math.round(event.loaded / event.total * 100); renderAttachments(); } };
    xhr.upload.onload = () => { item.progress = 100; renderAttachments(); };
    xhr.onload = () => {
      clearInterval(pollTimer);
      if(xhr.status===401)window.anyiAuth.expire();
      if(xhr.getResponseHeader('X-Anyi-Auth-State')==='changed')window.anyiAuth.recheck();
      if (!pending.includes(item)) return;
      try { const data = JSON.parse(xhr.responseText); if (xhr.status < 200 || xhr.status >= 300) throw new Error(typeof data.detail === 'string' ? data.detail : '上传失败'); Object.assign(item, data, {state:'ready'}); delete item.xhr; }
      catch (error) { item.state = 'error'; item.error = error.message; showError(`${file.name}：${error.message}`); }
      renderAttachments();
    };
    xhr.onerror = xhr.ontimeout = () => { clearInterval(pollTimer); item.state = 'error'; item.error = '上传连接失败，请移除后重试'; renderAttachments(); };
    const form = new FormData(); form.append('file', file); xhr.send(form);
  }
}
function sourceList(sources) {
  const details = node('details', 'sources'); details.append(node('summary', '', `参考了 ${sources.length} 个网页来源`));
  const list = node('ol');
  sources.forEach(source => { const href = safeURL(source.url); if (!href) return; const li = node('li'), a = node('a', '', source.title); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; li.append(a, node('small', '', new URL(href).hostname)); list.append(li); });
  details.append(list); return details;
}
function messageView(message, index) {
  const article = node('article', `message ${message.role}`);
  if (message.role === 'user') {
    const bubble = node('div', 'user-bubble');
    if (message.attachments?.length) bubble.append(node('div', 'message-attachments'));
    for (const attachment of message.attachments || []) bubble.querySelector('.message-attachments').append(attachmentChip(attachment));
    bubble.append(node('div', 'user-text', message.content)); article.append(bubble);
    const actions = node('div', 'message-actions user-actions');
    const edit = button('编辑提问', 'edit', () => editMessage(index)); edit.disabled = !!controller;
    actions.append(button('复制提问', 'copy', () => copyText(message.content)), edit); article.append(actions); return {article};
  }
  const label = node('div', 'assistant-label');
  const brandLogo = node('img', 'logo brand-image');
  brandLogo.src = '/static/brand/anyi-ai-logo-v1.png'; brandLogo.alt = '';
  label.append(brandLogo, node('span', '', '安逸智能AI')); article.append(label);
  const reasoning = node('details', 'reasoning'); reasoning.hidden = !message.reasoning;
  const summary = node('summary', '', message.state === 'streaming' ? '正在深度思考' : '思考过程');
  const reasoningText = node('div', 'reasoning-text', message.reasoning || ''); reasoning.append(summary, reasoningText); article.append(reasoning);
  const sources = node('div', 'source-container'); if (message.sources?.length) sources.append(sourceList(message.sources)); article.append(sources);
  const body = node('div', 'message-content markdown'); renderMarkdown(body, message.content, message.sources); article.append(body);
  const status = node('div', 'message-status');
  status.setAttribute('role', 'status');
  status.textContent = message.state === 'streaming' ? message.status || '正在连接…' : message.state === 'stopped' ? '已停止生成' : message.state === 'error' ? message.error || '生成失败，请重试' : '';
  if (message.notice) status.textContent = message.notice;
  status.hidden = !status.textContent; article.append(status);
  const actions = node('div', 'message-actions');
  if (message.state !== 'streaming') {
    const copy = button('复制回答', 'copy', () => copyText(message.content)); copy.disabled = !message.content;
    const read = button('朗读回答', 'volume', () => speak(message)); read.disabled = !message.content;
    const retry = button('重新生成回答', 'retry', () => regenerate(index)); retry.disabled = !!controller;
    actions.append(copy, read, retry);
    if (message.versions?.length) {
      const versions = [...message.versions, {content: message.content, reasoning: message.reasoning, sources: message.sources, state: message.state, notice: message.notice, error: message.error}];
      let selected = Number.isInteger(message.selectedVersion) ? Math.min(message.selectedVersion, versions.length - 1) : versions.length - 1;
      const counter = node('span', 'version-counter', `${selected + 1}/${versions.length}`);
      const change = step => { selected = Math.max(0, Math.min(versions.length - 1, selected + step)); message.selectedVersion = selected; const version = versions[selected]; renderMarkdown(body, version.content, version.sources); reasoning.hidden = !version.reasoning; reasoningText.textContent = version.reasoning || ''; sources.replaceChildren(...(version.sources?.length ? [sourceList(version.sources)] : [])); counter.textContent = `${selected + 1}/${versions.length}`; prev.disabled = selected === 0; next.disabled = selected === versions.length - 1; copy.disabled = !version.content; read.disabled = !version.content; copy.onclick = () => copyText(version.content); read.onclick = () => speak(version); status.textContent = version.notice || (version.state === 'stopped' ? '已停止生成' : version.state === 'error' ? version.error || '生成失败' : ''); status.hidden = !status.textContent; save(); };
      const prev = button('查看上一个回答版本', null, () => change(-1)); prev.textContent = '‹';
      const next = button('查看下一个回答版本', null, () => change(1)); next.textContent = '›'; next.disabled = true; actions.append(prev, counter, next);
      change(0);
    }
    article.append(actions);
  }
  return {article, body, reasoning, reasoningText, summary, sources, status};
}
function render() {
  if (displayedChatId !== current?.id) { displayedChatId = current?.id; displayLimit = 80; }
  try { if (current) localStorage.setItem(activeChatKey(), current.id); else localStorage.removeItem(activeChatKey()); } catch {}
  renderHistory(); $('#messages').replaceChildren(); $('#welcome').hidden = !!current?.messages.length;
  $('#export').disabled = !current?.messages.length || !!controller;
  const allMessages = current?.messages || [], start = Math.max(0, allMessages.length - displayLimit);
  if (start) {
    const earlier = button(`显示更早消息（还有 ${start} 条）`, null, () => { displayLimit += 80; const top = $('#scroll').scrollHeight; render(); $('#scroll').scrollTop += $('#scroll').scrollHeight - top; }, 'load-earlier');
    earlier.textContent = `显示更早消息（还有 ${start} 条）`; $('#messages').append(earlier);
  }
  for (let index=start; index<allMessages.length; index++) $('#messages').append(messageView(allMessages[index], index).article);
  updateInput();
}
function scrollDown() { $('#scroll').scrollTop = $('#scroll').scrollHeight; $('#jump-bottom').hidden = true; }
function shouldFollow() { const el = $('#scroll'); return el.scrollHeight - el.scrollTop - el.clientHeight < 140; }
function updateInput() {
  $('#send').disabled = !historyReady || !!controller || listening || voicePending || micStarting || pending.some(a => a.state !== 'ready') || (!input.value.trim() && !pending.length);
  $('#char-count').textContent = input.value.length > 12000 ? `${input.value.length.toLocaleString()} / 16,000` : '';
  input.style.height = 'auto'; input.style.height = `${Math.min(160, Math.max(50,input.scrollHeight))}px`;
  scheduleContext();
}
function contextPayload() {
  const base = editing ? editing.chat.messages.slice(0, editing.index) : current?.messages || [];
  const messages = base.map(m => ({role:m.role, content:visibleAnswer(m).content || '（未完成的回答）', attachments:m.role==='user'?(m.attachments||[]).map(a=>a.id):[]}));
  messages.push({role:'user',content:input.value.trim()||'（待发送）',attachments:pending.filter(a=>a.state==='ready').map(a=>a.id)});
  return {messages};
}
function showContext(data) {
  const value = data.input_tokens, compact = value >= 1000000 ? `${(value/1000000).toFixed(2)}M` : value>=1000?`${(value/1000).toFixed(1)}K`:value;
  $('#context-usage').textContent = `约 ${compact} / 1M Token`;
  $('#context-usage').title = `窗口 1,048,576 Token；本轮输入估算 ${value.toLocaleString()}，预留回答 ${data.reserved_output_tokens.toLocaleString()}。${data.method==='deepseek-v4-tokenizer'?'使用 V4 分词器；协议开销预留，最终以 API 为准。':'分词器未就绪，采用保守估算。'}`;
  $('#context-usage').classList.toggle('context-full', !data.fits);
}
function scheduleContext() {
  clearTimeout(contextTimer); if (!historyReady || controller) return;
  contextTimer = setTimeout(async () => {
    contextRequest?.abort(); contextRequest=new AbortController();
    try { const r=await apiFetch('/api/context',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(contextPayload()),signal:contextRequest.signal}); if(r.ok)showContext(await r.json()); }
    catch {} // Context counting must not interrupt writing or a running answer.
  },650);
}
function setBusy(busy) {
  $('#send').hidden = busy; $('#stop').hidden = !busy;
  input.disabled = busy;
  for (const selector of ['#new','#thinking','#search','#attach','#mic','#export','#cancel-edit','#upload-audio','#logout']) $(selector).disabled = busy;
  if (!busy) $('#export').disabled = !current?.messages.length;
  document.querySelectorAll('.history-row button,.user-actions button').forEach(b => b.disabled = busy);
  updateInput();
}
function cancelEdit() { editing = null; $('#edit-banner').hidden = true; }
function editMessage(index) {
  if (controller) return; stopVoice();
  const message = current.messages[index]; editing = {chat: current, index};
  input.value = message.content; pending = (message.attachments || []).map(a => ({...a, state:'ready'}));
  $('#edit-banner').hidden = false; renderAttachments(); input.focus();
}
function newChat() {
  if (controller || pending.some(a => a.state === 'uploading')) return;
  current = null; pending = []; cancelEdit(); stopVoice(); input.value = ''; $('#error').hidden = true; renderAttachments(); render(); input.focus(); toggleSidebar(false);
}
async function submit() {
  if ($('#send').disabled || controller) return;
  const text = input.value.trim() || '请分析这些附件的内容。';
  const attachments = pending.map(({id,name,kind,size,truncated,text_limit}) => ({id,name,kind,size,truncated,text_limit}));
  if (editing) {
    const original = editing.chat;
    current = {id:uuid(), title: `${chatTitle(original).slice(0,24)} · 编辑分支`, createdAt:Date.now(), messages: structuredClone(original.messages.slice(0,editing.index))}; chats.unshift(current); cancelEdit();
  }
  if (!current) { current = {id:uuid(), createdAt:Date.now(), messages:[]}; chats.unshift(current); }
  current.messages.push({role:'user', content:text, attachments});
  pending = []; input.value = ''; renderAttachments();
  await generate();
}
async function regenerate(index) {
  if (controller) return;
  stopVoice();
  // A retry in the middle starts a branch, preserving all later messages in the original chat.
  if (index !== current.messages.length - 1) {
    const old = current; current = {id:uuid(), title:`${chatTitle(old).slice(0,24)} · 重新生成`, createdAt:Date.now(), messages:structuredClone(old.messages.slice(0,index))}; chats.unshift(current);
    await generate(); return;
  }
  const previous = current.messages.pop();
  const versions = [...(previous.versions || [])];
  if (previous.content || previous.reasoning) versions.push({content:previous.content, reasoning:previous.reasoning, sources:previous.sources, notice:previous.notice, state:previous.state, error:previous.error});
  await generate(versions);
}
function paintLive(message) {
  if (!liveView) return; const follow = shouldFollow();
  renderMarkdown(liveView.body, message.content, message.sources, true);
  liveView.reasoning.hidden = !message.reasoning; liveView.reasoningText.textContent = message.reasoning || '';
  liveView.summary.textContent = message.content ? '思考过程' : '正在深度思考';
  liveView.status.textContent = message.content ? '' : message.status || '正在生成…'; liveView.status.hidden = !!message.content;
  if (follow) scrollDown(); else $('#jump-bottom').hidden = false;
}
async function generate(versions = []) {
  stopVoice(); $('#error').hidden = true;
  const chat = current;
  const payload = chat.messages.map(m => ({role:m.role, content:visibleAnswer(m).content || '（上一条回答未完成）', attachments:m.role === 'user' ? (m.attachments || []).map(a => a.id) : []}));
  const assistant = {role:'assistant', content:'', reasoning:'', sources:[], state:'streaming', status:'正在连接…', versions, modes:{...modes}};
  chat.messages.push(assistant); chat.updatedAt = Date.now(); controller = new AbortController();
  render(); liveView = messageView(assistant, chat.messages.length-1); $('#messages').lastElementChild.replaceWith(liveView.article); setBusy(true); save(); scrollDown();
  let completed = false, reader;
  try {
    const response = await apiFetch('/api/chat', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({messages:payload, thinking:!!modes.thinking, search:!!modes.search}), signal:controller.signal});
    if (!response.ok) { const data = await response.json(); const detail = typeof data.detail === 'string' ? data.detail : data.detail?.[0]?.msg; throw new Error(detail || `请求失败（${response.status}）`); }
    reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const {done,value} = await reader.read(); if (done) break; buffer += decoder.decode(value, {stream:true});
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0,end).replace(/\r/g,''); buffer = buffer.slice(end+2);
        const lines = block.split('\n'), kind = lines.find(l => l.startsWith('event: '))?.slice(7), raw = lines.filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n'); if (!raw) continue;
        const data = JSON.parse(raw);
        if (kind === 'error') throw new Error(data.message);
        if (kind === 'done') completed = true;
        if (kind === 'context') { assistant.context = data; showContext(data); }
        if (kind === 'usage') assistant.usage = data.usage;
        if (kind === 'delta') assistant.content += data.text;
        if (kind === 'thinking') assistant.reasoning += data.text;
        if (kind === 'status') assistant.status = data.text;
        if (kind === 'notice') assistant.notice = data.text;
        if (kind === 'sources') { assistant.sources = data.sources; liveView.sources.replaceChildren(...(data.sources.length ? [sourceList(data.sources)] : [])); }
        if (!paintFrame) paintFrame = requestAnimationFrame(() => { paintFrame = null; paintLive(assistant); });
        soonSave();
      }
    }
    if (!completed) throw new Error('连接意外中断，已保留收到的内容，可重新生成。');
    if (!assistant.content) throw new Error('未收到回答，请重新生成。');
    assistant.state = 'done';
  } catch (error) {
    assistant.state = error.name === 'AbortError' ? 'stopped' : 'error';
    if (assistant.state === 'error') { assistant.error = error.message || '连接失败，请稍后重试'; showError(assistant.error); }
  } finally {
    await reader?.cancel().catch(() => {}); controller?.abort(); controller = null;
    if (paintFrame) { cancelAnimationFrame(paintFrame); paintFrame = null; }
    liveView = null; chat.updatedAt = Date.now(); save(); const follow = shouldFollow(); render(); setBusy(false); if (follow) scrollDown(); input.focus();
  }
}
function exportChat() {
  if (!current) return;
  const lines = [`# ${chatTitle(current)}`, '', `导出时间：${new Date().toLocaleString('zh-CN')}`, ''];
  for (const original of current.messages) {
    const m = {...original, ...visibleAnswer(original)};
    lines.push(`## ${m.role === 'user' ? '你' : '安逸智能AI'}`, '', m.content || '（无回答内容）', '');
    for (const a of m.attachments || []) lines.push(`附件：${a.name}（附件文件保存在本机，导出文件不包含附件）`, '');
    if (m.reasoning) lines.push('### 思考过程', '', m.reasoning, '');
    if (m.sources?.length) lines.push('### 参考来源', '', ...m.sources.map(s => `${s.number}. [${s.title}](${s.url})`), '');
    if (m.state === 'stopped' || m.state === 'error') lines.push(`状态：${m.state === 'stopped' ? '已停止生成' : '生成失败，内容可能不完整'}`, '');
  }
  const url = URL.createObjectURL(new Blob([lines.join('\n')], {type:'text/markdown;charset=utf-8'}));
  const a = node('a'); a.href = url; a.download = `${chatTitle(current).replace(/[<>:"/\\|?*]/g,'_')}.md`; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000); notify('对话已导出为 Markdown');
}
let recorder = null, recordingStream = null, recordingTimer = null, recordingLimit = null;
let recordingSession = 0, voicePending = false, voiceRequest = null, micStarting = false;
const speechConfigPromise = fetch('/api/speech/config').then(r=>r.ok?r.json():speechConfig).then(data=>(speechConfig=data)).catch(()=>speechConfig);
function microphoneState() {
  $('#mic').classList.toggle('recording', listening);
  $('#mic').setAttribute('aria-label',listening?'结束录音并识别':'开始语音输入');
  $('#mic').disabled=!!controller||voicePending||micStarting; updateInput();
}
function releaseRecording() {
  clearInterval(recordingTimer); clearTimeout(recordingLimit);
  recordingStream?.getTracks().forEach(track=>track.stop()); recordingStream=null;
}
function stopVoice() {
  recordingSession++; micStarting=false;
  if (recorder?.state==='recording') recorder.stop();
  recorder=null; releaseRecording(); listening=false;
  voiceRequest?.abort(); voiceRequest=null; voicePending=false;
  const previous=activeSpeech; activeSpeech=null;
  previous?.request?.abort(); previous?.audio?.pause();
  if(previous?.url)URL.revokeObjectURL(previous.url);
  if(speechAPI)speechSynthesis.cancel();
  $('#voice-panel').hidden=true; microphoneState();
}
function speechHelp(text) {
  $('#speech-help-text').textContent=text; $('#speech-help').hidden=false;
}
function plainSpeech(markdown) {
  const temp=node('div');renderMarkdown(temp,markdown);
  temp.querySelectorAll('pre,table,.katex-mathml').forEach(el=>el.remove());
  return temp.textContent.replace(/\s+/g,' ').trim();
}
async function speak(message) {
  stopVoice();const requestSession=recordingSession;await speechConfigPromise;
  if(requestSession!==recordingSession)return;
  const text=plainSpeech(message.content);if(!text){notify('此回答以代码或表格为主，没有适合朗读的正文');return;}
  const engine=speechConfig.synthesis?'server':speechAPI&&speechSynthesis.getVoices().length?'browser':null;
  if(!engine){showError('朗读服务未就绪，浏览器也未提供可用声音，请检查本机中文语音包。');return;}
  const chunks=text.match(/[^。！？.!?]{1,180}[。！？.!?]?/g)||[text];
  activeSpeech={chunks,index:0,engine,paused:false};
  $('#voice-panel').hidden=false;$('#voice-pause').hidden=false;$('#voice-pause').textContent='暂停';$('#voice-rate').disabled=false;$('#voice-end').textContent='停止';
  speakChunk();
}
async function speakChunk() {
  const session=activeSpeech;if(!session)return;
  if(session.index>=session.chunks.length){stopVoice();return;}
  $('#voice-state').textContent=`正在朗读 ${session.index+1}/${session.chunks.length}`;
  if(session.engine==='browser') {
    const utterance=new SpeechSynthesisUtterance(session.chunks[session.index]);utterance.lang='zh-CN';utterance.rate=Number($('#voice-rate').value);
    const voice=speechSynthesis.getVoices().find(v=>v.lang.toLowerCase().startsWith('zh'));if(voice)utterance.voice=voice;
    utterance.onend=()=>{if(activeSpeech===session){session.index++;speakChunk();}};
    utterance.onerror=e=>{if(activeSpeech===session&&!['interrupted','canceled'].includes(e.error)){stopVoice();showError('浏览器朗读失败，请检查设备声音。');}};
    speechSynthesis.speak(utterance);return;
  }
  try {
    session.request=new AbortController();$('#voice-state').textContent=`正在生成本地语音 ${session.index+1}/${session.chunks.length}…`;
    const response=await apiFetch('/api/speech/synthesize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:session.chunks[session.index],rate:1}),signal:session.request.signal});
    if(!response.ok){const result=await response.json();throw new Error(result.detail||'语音生成失败');}
    const blob=await response.blob();if(activeSpeech!==session)return;
    if(session.url)URL.revokeObjectURL(session.url);
    session.url=URL.createObjectURL(blob);session.audio=new Audio(session.url);session.audio.playbackRate=Number($('#voice-rate').value);
    session.audio.onended=()=>{if(activeSpeech===session){session.index++;speakChunk();}};
    session.audio.onerror=()=>{if(activeSpeech===session){stopVoice();showError('语音音频无法播放，请检查浏览器或设备声音。');}};
    $('#voice-state').textContent=`本地朗读 ${session.index+1}/${session.chunks.length}`;
    if(!session.paused){try{await session.audio.play();}catch{if(activeSpeech===session){session.paused=true;$('#voice-pause').textContent='播放';$('#voice-state').textContent='音频已就绪，点击播放';}}}
  }catch(error){if(activeSpeech===session&&error.name!=='AbortError'){stopVoice();showError(error.message||'本地朗读失败，请重试。');}}
}
function finishRecording() { if(recorder?.state==='recording'){recorder.stop();$('#voice-state').textContent='正在完成录音…';} }
async function toggleMic() {
  if(listening){finishRecording();return;}if(micStarting||voicePending)return;
  stopVoice();const session=++recordingSession;micStarting=true;microphoneState();
  try {
    await speechConfigPromise;
    if(session!==recordingSession)return;
    if(!speechConfig.recognition)throw new Error('本地中文识别模型未就绪，请运行 setup_assets.py 后刷新页面。');
    if(!isSecureContext||!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined'){
      speechHelp('当前浏览器无法录音。请上传录音，或在系统浏览器通过 localhost / HTTPS 打开。');return;
    }
    const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,channelCount:1}});
    if(session!==recordingSession){stream.getTracks().forEach(t=>t.stop());return;}
    recordingStream=stream;
    const mime=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(type=>MediaRecorder.isTypeSupported(type));
    recorder=new MediaRecorder(stream,mime?{mimeType:mime}:undefined);
    const chunks=[];let size=0;const started=Date.now();
    recorder.ondataavailable=e=>{if(session!==recordingSession)return;if(e.data.size){chunks.push(e.data);size+=e.data.size;if(size>12*1024*1024){stopVoice();showError('录音过大，请缩短后重试');}}};
    recorder.onstop=()=>{if(session!==recordingSession)return;releaseRecording();listening=false;recorder=null;microphoneState();const blob=new Blob(chunks,{type:mime||'audio/webm'});if(blob.size)transcribeAudio(blob,mime?.includes('mp4')?'recording.m4a':'recording.webm');else{stopVoice();showError('未获得录音数据，请检查麦克风后重试。');}};
    recorder.onerror=()=>{if(session===recordingSession){stopVoice();showError('录音设备发生错误，请检查麦克风连接。');}};
    recorder.start(1000);listening=true;$('#speech-help').hidden=true;
    $('#voice-panel').hidden=false;$('#voice-pause').hidden=true;$('#voice-rate').disabled=true;$('#voice-end').textContent='结束并识别';
    const tick=()=>{$('#voice-state').textContent=`正在录音 ${Math.floor((Date.now()-started)/1000)} / 90 秒 · 本机识别`;};tick();
    recordingTimer=setInterval(tick,500);recordingLimit=setTimeout(finishRecording,90000);
  }catch(error){
    if(session===recordingSession){releaseRecording();listening=false;recorder=null;}
    const errors={NotAllowedError:'麦克风被浏览器或内置页面拒绝。请允许站点麦克风权限，或上传录音识别。',NotFoundError:'未检测到麦克风，请连接设备或上传录音。',NotReadableError:'麦克风被其他程序占用，请关闭占用程序后重试。'};
    speechHelp(errors[error.name]||error.message||'无法启动录音，可改用上传录音识别。');
  }finally{if(session===recordingSession){micStarting=false;microphoneState();}}
}
async function transcribeAudio(blob,name='recording.webm') {
  if(controller){notify('请等回答完成后再识别录音');return;}
  if(blob.size>12*1024*1024){showError('录音文件最大 12 MB、时长最长 90 秒');return;}
  const session=++recordingSession;voicePending=true;voiceRequest=new AbortController();
  $('#voice-panel').hidden=false;$('#voice-state').textContent='正在本机识别普通话…';$('#voice-pause').hidden=true;$('#voice-rate').disabled=true;$('#voice-end').textContent='取消';microphoneState();
  try {
    const body=new FormData();body.append('file',blob,name);
    const response=await apiFetch('/api/speech/transcribe',{method:'POST',body,signal:voiceRequest.signal});const result=await response.json();
    if(!response.ok)throw new Error(result.detail||'录音识别失败');if(session!==recordingSession)return;
    input.value=(input.value+(input.value?' ':'')+result.text).slice(0,16000);notify('语音已转为文字，请检查后发送');$('#speech-help').hidden=true;
  }catch(error){if(error.name!=='AbortError')showError(error.message||'识别连接失败，请重试。');}
  finally{if(session===recordingSession){voicePending=false;voiceRequest=null;$('#voice-panel').hidden=true;microphoneState();input.focus();}}
}
function toggleVoicePause() {
  const session=activeSpeech;if(!session)return;session.paused=!session.paused;
  if(session.engine==='server'){if(session.paused)session.audio?.pause();else session.audio?.play().catch(()=>{session.paused=true;$('#voice-pause').textContent='播放';showError('播放被浏览器阻止，请再次点击播放。');});}
  else if(session.paused)speechSynthesis.pause();else speechSynthesis.resume();
  $('#voice-pause').textContent=session.paused?'继续':'暂停';
}
function changeVoiceRate() {
  if(!activeSpeech)return;
  if(activeSpeech.engine==='server'){if(activeSpeech.audio)activeSpeech.audio.playbackRate=Number($('#voice-rate').value);}
  else{const previous=activeSpeech;activeSpeech=null;speechSynthesis.cancel();activeSpeech=previous;previous.paused=false;speakChunk();}
}

for (const placeholder of document.querySelectorAll('[data-icon]')) placeholder.replaceWith(icon(placeholder.dataset.icon));
function updateModes() { for (const key of ['thinking','search']) $(`#${key}`).setAttribute('aria-pressed', String(!!modes[key])); }
for (const key of ['thinking','search']) $(`#${key}`).onclick = () => { modes[key] = !modes[key]; updateModes(); try { localStorage.setItem(preferencesKey,JSON.stringify(modes)); } catch {} };
$('#new').onclick = newChat; $('#menu').onclick = () => toggleSidebar(); $('#backdrop').onclick = () => toggleSidebar(false);
$('#history-search').oninput = renderHistory;
$('#form').onsubmit = e => { e.preventDefault(); submit(); };
$('#stop').onclick = () => controller?.abort(); $('#dismiss-error').onclick = () => { $('#error').hidden = true; };
$('#cancel-edit').onclick = () => { cancelEdit(); input.value = ''; pending = []; renderAttachments(); };
$('#attach').onclick = () => $('#file-input').click(); $('#file-input').onchange = e => { uploadFiles(e.target.files); e.target.value = ''; };
$('#mic').onclick = toggleMic; $('#export').onclick = exportChat; $('#jump-bottom').onclick = scrollDown;
$('#close-preview').onclick = () => $('#image-dialog').close();
$('#image-dialog').onclick = e => { if (e.target === $('#image-dialog')) $('#image-dialog').close(); };
input.oninput = updateInput;
input.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); } };
input.onpaste = e => { if (e.clipboardData.files.length) { e.preventDefault(); uploadFiles(e.clipboardData.files); } };
for (const b of document.querySelectorAll('[data-prompt]')) b.onclick = () => { input.value = b.dataset.prompt; updateInput(); input.focus(); };
let dragDepth = 0;
document.addEventListener('dragenter', e => { if (Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); } });
document.addEventListener('dragover', e => { if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault(); });
document.addEventListener('dragleave', e => { if (Array.from(e.dataTransfer.types).includes('Files') && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
document.addEventListener('drop', e => { if (e.dataTransfer.files.length) { e.preventDefault(); dragDepth=0; document.body.classList.remove('dragging'); uploadFiles(e.dataTransfer.files); } });
$('#scroll').onscroll = () => { $('#jump-bottom').hidden = shouldFollow() || !current?.messages.length; };
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); newChat(); } if (e.key === 'Escape') toggleSidebar(false); });
$('#voice-end').onclick = () => listening ? finishRecording() : stopVoice();
$('#voice-pause').onclick = toggleVoicePause;
$('#voice-rate').onchange = changeVoiceRate;
$('#upload-audio').onclick = () => $('#audio-input').click();
$('#audio-input').onchange = e => { const file=e.target.files[0];if(file){stopVoice();transcribeAudio(file,file.name);}e.target.value=''; };
$('#close-speech-help').onclick = () => { $('#speech-help').hidden=true; };
window.addEventListener('beforeunload', () => { if (controller) controller.abort(); stopVoice(); save(); });
async function loadHistory(scope) {
  let serverChats = null;
  try {
    const response = await fetch('/api/history', {headers: {'X-Anyi-Account': scope}});
    if (response.ok) { const data = await response.json(); if (Array.isArray(data.chats)) serverChats = data.chats; }
  } catch {}
  if (Array.isArray(serverChats) && serverChats.length) return serverChats;
  let local;
  try { local = await anyiHistory.open(scope); } catch { local = undefined; }
  if (Array.isArray(local) && local.length) return local;
  return serverChats !== null ? serverChats : local;
}
async function initializeHistory(account) {
  if(!account){historyReady=false;return;}
  currentAccount=account;storageKey='anyi-ai-chats-user-'+account.scope;
  chats=[];current=null;
  try {
    const stored = await loadHistory(account.scope);
    if (stored !== undefined) {
      if (!Array.isArray(stored) || !stored.every(c=>typeof c?.id==='string'&&Array.isArray(c.messages))) throw new Error('历史数据异常');
      chats=stored;
    } else {
      try{const fallback=JSON.parse(localStorage.getItem(storageKey)||'[]');if(Array.isArray(fallback))chats=fallback;}catch{}
    }
    for(const chat of chats)for(const message of chat.messages)if(message.state==='streaming')message.state='stopped';
    current=chats.find(c=>c.id===localStorage.getItem(activeChatKey()))||null;
  }catch{showError('大容量本地存储不可用，暂用本账号的旧存储。超长对话请及时导出。');}
  historyReady=true;save();updateModes();render();
  try {
    legacyChats=(await anyiHistory.legacy()).filter(c=>!chats.some(saved=>saved.id===c.id||saved.importedLegacyId===c.id));
    $('#legacy-banner').hidden=!legacyChats.length||sessionStorage.getItem('anyi-ai-skip-import-'+account.scope)==='1';
  }catch{$('#legacy-banner').hidden=true;}
}
function changeAccount(account) {
  accountTransition=accountTransition.then(async()=>{
    if(currentAccount?.scope===account?.scope&&historyReady)return;
    if(controller){controller.abort();while(controller)await new Promise(resolve=>setTimeout(resolve,20));}
    stopVoice();save();flushServerHistory();historyReady=false;
    clearTimeout(contextTimer);clearTimeout(serverSyncTimer);contextRequest?.abort();
    pending.forEach(a=>a.xhr?.abort());pending=[];input.value='';cancelEdit();
    anyiHistory.db?.close();anyiHistory.db=null;
    chats=[];current=null;currentAccount=null;legacyChats=[];$('#legacy-banner').hidden=true;
    $('#history-search').value='';$('#messages').replaceChildren();$('#history').replaceChildren();$('#error').hidden=true;
    if(account)await initializeHistory(account);
  });
  return accountTransition;
}
window.addEventListener('anyi:auth-change',event=>changeAccount(event.detail));
window.addEventListener('anyi:auth-error',event=>showError(event.detail));
$('#skip-legacy').onclick=()=>{if(currentAccount)sessionStorage.setItem('anyi-ai-skip-import-'+currentAccount.scope,'1');$('#legacy-banner').hidden=true;};
$('#import-legacy').onclick=async()=>{
  if(!currentAccount||controller)return;const button=$('#import-legacy');button.disabled=true;
  try {
    const ids=[...new Set(legacyChats.flatMap(c=>c.messages.flatMap(m=>(m.attachments||[]).map(a=>a.id))))];
    const response=await apiFetch('/api/attachments/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({attachments:ids})});
    const result=await response.json();if(!response.ok)throw new Error(result.detail||'导入失败');
    const imported=structuredClone(legacyChats).map(c=>({...c,importedLegacyId:c.id,updatedAt:Date.now()}));
    chats.push(...imported);if(!current&&imported.length)current=imported[0];
    save();render();$('#legacy-banner').hidden=true;notify(`已导入 ${imported.length} 个旧对话，原始记录仍保留`);
  }catch(error){showError(error.message||'导入失败，请稍后重试');}
  finally{button.disabled=false;}
};
anyiAuth.ready.then(account=>changeAccount(account));
const sidebarMedia = window.matchMedia('(max-width: 760px)');
function syncSidebar() {
  document.body.classList.remove('sidebar-open'); $('#backdrop').hidden = true;
  $('#menu').setAttribute('aria-expanded', String(!sidebarMedia.matches && !document.body.classList.contains('sidebar-collapsed')));
}
sidebarMedia.addEventListener('change', syncSidebar); syncSidebar();
