/* IndexedDB has room for long conversations; legacy localStorage remains a backup. */
window.anyiHistory = {
  db: null,
  knownIds: new Set(),
  async open(scope = null) {
    this.db?.close(); this.db = null; this.knownIds = new Set();
    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(scope ? 'anyi-ai-history-user-' + scope : 'anyi-ai-history', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('请关闭其他旧版聊天标签页后刷新'));
    });
    this.db.onversionchange = () => this.db.close();
    return new Promise((resolve, reject) => {
      const request = this.db.transaction('state').objectStore('state').get('chats');
      request.onsuccess = () => {
        const data = request.result;
        const chats = Array.isArray(data) ? data : data?.chats;
        this.knownIds = new Set((chats || []).map(c=>c.id));
        resolve(chats);
      };
      request.onerror = () => reject(request.error);
    });
  },
  async legacy() {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('anyi-ai-history',1);
      open.onupgradeneeded=()=>open.result.createObjectStore('state');
      open.onerror=()=>reject(open.error);
      open.onsuccess=()=>{
        const db=open.result, request=db.transaction('state').objectStore('state').get('chats');
        request.onsuccess=()=>{
          const stored=request.result;db.close();
          if(stored!==undefined) resolve(Array.isArray(stored)?stored:stored.chats||[]);
          else {try{resolve(JSON.parse(localStorage.getItem('anyi-ai-chats-v1')||'[]'));}catch{resolve([]);}}
        };
        request.onerror=()=>{db.close();reject(request.error);};
      };
    });
  },
  save(chats) {
    const incoming = structuredClone(chats);
    const ids = new Set(incoming.map(c=>c.id));
    const removed = [...this.knownIds].filter(id=>!ids.has(id));
    this.knownIds = ids;
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction('state', 'readwrite');
      const store = transaction.objectStore('state');
      const read = store.get('chats');
      read.onsuccess = () => {
        const previous = read.result;
        const stored = Array.isArray(previous) ? previous : previous?.chats || [];
        const tombstones = {...(!Array.isArray(previous) && previous?.tombstones || {})};
        const merged = new Map(stored.map(c=>[c.id,c]));
        for (const id of removed) { tombstones[id]=Date.now(); merged.delete(id); }
        for (const chat of incoming) {
          const revision=chat.updatedAt||chat.createdAt||0;
          if(tombstones[chat.id] && revision <= tombstones[chat.id]) continue;
          if(!merged.has(chat.id) || revision >= (merged.get(chat.id).updatedAt||merged.get(chat.id).createdAt||0)) merged.set(chat.id,chat);
        }
        store.put({chats:[...merged.values()],tombstones}, 'chats');
      };
      transaction.oncomplete = resolve;
      transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('保存失败'));
    });
  },
};
