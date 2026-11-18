'use strict';

// Opt-in acceptance test. Usage: node scripts/backup-browser-acceptance.cjs
// Chrome runs headless in two brand-new temporary profiles. No dependencies installed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { fork, spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const stamp = '2026-01-01T00:00:00.000Z';
const journal = 'zily.backup.v1.restore';
const fixtures = {
  chats: ['验收聊天甲：你好 <&> “引号”', '验收聊天乙：反斜杠 \\ 和 emoji 🌙'],
  favorites: [{ id: 11, name: '虚构歌曲甲', artist: '歌手甲' },
    { id: 22, name: '虚构歌曲乙', artist: '歌手乙' }, { id: 33, name: '虚构歌曲丙', artist: '歌手丙' }],
  memory: ['我一直喜欢虚构的爵士电台。', '我通常晚上整理测试歌单。'],
  candidate: ['我长期喜欢虚构的钢琴曲。', '我一直偏爱虚构的低音提琴。'],
};
const info = (label, data) => console.log(JSON.stringify({ label, ...data }));
function checkInside(root, target) {
  const relative = path.relative(root, target);
  assert.ok(relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
async function until(test, label, timeout = 14000) {
  const end = Date.now() + timeout;
  let error;
  while (Date.now() < end) {
    try { const result = await test(); if (result) return result; } catch (cause) { error = cause; }
    await delay(45);
  }
  throw new Error('Timeout: ' + label + (error ? ' · ' + error.message : ''));
}

function blockEnvironmentFiles() {
  const original = fs.readFileSync;
  fs.readFileSync = function (file, ...args) {
    if (typeof file === 'string' && /^\.env(?:\.|$)/i.test(path.basename(file))) throw new Error('Environment file blocked');
    return original.call(this, file, ...args);
  };
}

async function worker(project, root, requestedPort) {
  const memoryDir = await fsp.realpath(path.join(root, 'memory'));
  const backupDir = await fsp.realpath(path.join(root, 'backups'));
  for (const dir of [memoryDir, backupDir]) checkInside(root, dir);
  blockEnvironmentFiles();
  const listen = (server, port = 0) => new Promise((resolve, reject) => {
    server.once('error', reject).listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
  let mockHits = 0;
  const mock = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/chat/completions') {
      mockHits++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '虚构回答：测试 <&> 🌙' } }] }) +
        '\n\ndata: [DONE]\n\n');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  const mockPort = await listen(mock);
  const allowed = 'http://127.0.0.1:' + mockPort;
  Object.assign(process.env, { DEEPSEEK_API_KEY: 'synthetic-browser-test', DEEPSEEK_MODEL: 'mock',
    DEEPSEEK_BASE_URL: allowed, NCM_API_URL: allowed });
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const url = new URL(String(input));
    if (url.origin !== allowed) throw new Error('Test upstream rejected');
    return nativeFetch(url, { ...options, redirect: 'error' });
  };

  const { createMemoryStore } = require(path.join(project, 'server/memory-store'));
  const { createServer } = require(path.join(project, 'server/server'));
  let failBackup = false;
  let blockMemory = false;
  const disk = { ...fsp, async rename(from, to) {
    if (failBackup && to.startsWith(backupDir + path.sep)) throw new Error('simulated backup write failure');
    if (blockMemory && to.startsWith(memoryDir + path.sep)) {
      process.send({ event: 'memory-rename-blocked' });
      return new Promise(() => {});
    }
    return fsp.rename(from, to);
  } };
  const store = createMemoryStore(memoryDir, disk);
  assert.equal(await fsp.realpath(store.directory), memoryDir);
  const app = createServer({ memoryStore: store,
    backupOptions: { directory: backupDir, intervalMs: 450, retention: 5, disk } });
  const port = await listen(app, Number(requestedPort));
  process.send({ event: 'ready', port, memoryDir, backupDir, profileCount: (await store.listProfiles()).length, mockPort });
  process.on('disconnect', () => process.exit(0));
  process.on('message', async ({ id, command, target, count, value }) => {
    try {
      let result;
      if (command === 'seed-candidates') {
        const candidates = fixtures.candidate.map(content => ({
          id: randomUUID(), category: 'music', kind: 'user_preference', content, status: 'pending',
          sourceType: 'conversation_candidate', sourceRole: 'user', createdAt: stamp, updatedAt: stamp,
          evidence: [{ sessionId: randomUUID(), messageId: randomUUID(), role: 'user', quote: content }],
          reason: '验收虚构理由',
        }));
        await store.mutate(target, () => ({ discovery: { candidates, processed: [], rejected: [], skipped: [], lastExtractedAt: 0 } }));
      } else if (command === 'revision') {
        await store.update(target, entries => entries.map((item, index) => index ? item :
          { ...item, revision: item.revision + 1, content: '轮转合成资料 ' + count }));
      } else if (command === 'read') {
        const current = await store.read(target);
        result = current && { memory: current.memories.length, candidates: current.discovery?.candidates.length || 0,
          committed: (current.backupReceipts || []).filter(item => item.committed).length };
      } else if (command === 'fail-backup') {
        failBackup = value;
      } else if (command === 'block-memory') {
        blockMemory = true;
      } else if (command === 'profile-count') {
        result = (await store.listProfiles()).length;
      } else if (command === 'mock-hits') {
        result = mockHits;
      } else throw new Error('Unknown fixture command');
      process.send({ id, result });
    } catch (error) { process.send({ id, error: error.code || error.message }); }
  });
}

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.pending = new Map();
    this.handlers = new Map();
    this.sequence = 0;
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
      } else {
        for (const callback of this.handlers.get(message.method) || []) callback(message.params);
      }
    });
    socket.addEventListener('close', () => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('CDP closed'));
      }
      this.pending.clear();
    });
  }
  on(event, callback) {
    const listeners = this.handlers.get(event) || new Set();
    this.handlers.set(event, listeners);
    listeners.add(callback);
    return () => listeners.delete(callback);
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP timeout: ' + method));
      }, 12000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'Browser evaluation failed');
    return result.result.value;
  }
}
async function connect(url) {
  const address = new URL(url);
  assert.equal(address.hostname, '127.0.0.1');
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('DevTools connection failed')), { once: true });
  });
  return new CDP(socket);
}

async function launch(executable, root, name, getOrigin, traffic, localFetch = fetch) {
  const profile = path.join(root, 'browser-' + name);
  const downloads = path.join(root, 'downloads-' + name);
  await fsp.mkdir(profile);
  await fsp.mkdir(downloads);
  assert.equal(await fsp.realpath(profile), profile);
  checkInside(root, profile);
  assert.deepEqual(await fsp.readdir(profile), []);
  const proc = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-extensions', '--disable-background-networking', '--disable-component-update',
    '--disable-quic', '--disable-gpu', '--proxy-server=http://127.0.0.1:1', '--proxy-bypass-list=127.0.0.1',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--user-data-dir=' + profile, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    'about:blank'], { windowsHide: true, stdio: 'ignore' });
  try {
    const debug = await until(async () => {
      const data = (await fsp.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
      return data.length === 2 && /^\d+$/.test(data[0]) && data;
    }, 'isolated Chrome debugger');
    const endpoint = 'http://127.0.0.1:' + debug[0];
    const rootCDP = await connect('ws://127.0.0.1:' + debug[0] + debug[1]);
    const { product } = await rootCDP.send('Browser.getVersion');
    await rootCDP.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    async function open() {
      const target = await rootCDP.send('Target.createTarget', { url: 'about:blank' });
      const entry = await until(async () => (await (await localFetch(endpoint + '/json/list')).json()).find(item => item.id === target.targetId), 'Chrome target');
      const cdp = await connect(entry.webSocketDebuggerUrl);
      await cdp.send('Page.enable');
      await cdp.send('Network.enable');
      await cdp.send('Network.setBlockedURLs', { urls: ['https://*', 'http://localhost/*'] });
      cdp.on('Network.responseReceived', ({ response }) => {
        const url = new URL(response.url);
        if (url.origin === getOrigin() && url.pathname.startsWith('/api/')) {
          traffic.push({ browser: name, route: url.pathname, status: response.status });
        }
      });
      let decision = true;
      cdp.on('Page.javascriptDialogOpening', () => {
        void cdp.send('Page.handleJavaScriptDialog', { accept: decision }).catch(() => {});
      });
      const dom = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
      const tab = {
        cdp,
        eval: expression => cdp.evaluate(expression),
        decision: value => { decision = value; },
        async click(selector) {
          await cdp.evaluate('void ' + dom(selector) + '.click()');
        },
        async input(selector, value) {
          await cdp.evaluate(dom(selector) + '.value = ' + JSON.stringify(value));
        },
        text: selector => cdp.evaluate(dom(selector) + '.textContent'),
        wait: (predicate, label) => until(() => cdp.evaluate(predicate), label),
        async file(file) {
          const { root: document } = await cdp.send('DOM.getDocument');
          const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: document.nodeId, selector: '#backupFile' });
          await cdp.send('DOM.setFileInputFiles', { nodeId, files: [file] });
        },
        async navigate() {
          const url = getOrigin() + '/';
          let loaded = false;
          const off = cdp.on('Page.loadEventFired', () => { loaded = true; });
          const result = await cdp.send('Page.navigate', { url });
          try { await until(() => loaded, 'page load event'); } finally { off(); }
          if (result.errorText) throw new Error(result.errorText);
          await this.wait('location.href === ' + JSON.stringify(url) +
            ' && document.readyState === "complete" && typeof ZilyBackupBrowser !== "undefined" && !!navigator.locks', 'Music Companion UI ready');
        },
        async close() { await rootCDP.send('Target.closeTarget', { targetId: target.targetId }); },
      };
      await tab.navigate();
      return tab;
    }
    return { open, downloads, product, async close() {
      rootCDP.socket.addEventListener('error', () => {});
      await rootCDP.send('Browser.close').catch(() => {});
      rootCDP.socket.close();
      await Promise.race([proc.exitCode === null ? once(proc, 'exit') : Promise.resolve(), delay(3500)]);
      if (proc.exitCode === null) proc.kill();
    } };
  } catch (error) {
    proc.kill();
    throw error;
  }
}

async function acceptance() {
  assert.equal(process.platform, 'win32', 'This harness targets Windows Chrome');
  assert.equal(typeof WebSocket, 'function', 'Use Node 22+ for DevTools WebSocket');
  const project = path.resolve(process.argv[2] || path.join(__dirname, '..'));
  const chrome = process.argv[3] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  assert.ok(fs.statSync(chrome).isFile());
  const base = await fsp.realpath(os.tmpdir());
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(base, 'zily-browser-qa-')));
  checkInside(base, root);
  const marker = path.join(root, '.zily-test-directory');
  await fsp.writeFile(marker, 'synthetic acceptance only', { flag: 'wx' });
  const traffic = [];
  const outcomes = [];
  let server, aBrowser, bBrowser, a, b, origin, port;
  let exportAll, exportMemory, baselineMemory, aTarget, allData;
  const { pack, verify } = require(path.join(project, 'server/backup-store'));
  const format = require(path.join(project, 'web/js/22-backup-format'));

  async function step(label, task, dependency = true) {
    if (!dependency) {
      outcomes.push({ label, status: 'NOT RUN' });
      return false;
    }
    try {
      const evidence = await task();
      const row = { label, status: 'PASS', evidence };
      outcomes.push(row);
      info('case', row);
      return true;
    } catch (error) {
      const row = { label, status: 'FAIL', error: error.message };
      outcomes.push(row);
      info('case', row);
      return false;
    }
  }

  async function startServer() {
    const proc = fork(__filename, ['--worker', project, root, String(port || 0)],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    const messages = [];
    let warningCount = 0;
    proc.stderr.on('data', value => {
      if (value.toString().includes('自动备份检查发现异常')) warningCount++;
    });
    proc.on('message', message => messages.push(message));
    const ready = await until(() => {
      if (proc.exitCode !== null) throw new Error('Test server exited before isolation checks');
      return messages.find(message => message.event === 'ready');
    }, 'temporary server ready', 7000).catch(error => { proc.kill(); throw error; });
    assert.equal(ready.memoryDir, path.join(root, 'memory'));
    assert.equal(ready.backupDir, path.join(root, 'backups'));
    assert.notEqual(ready.port, ready.mockPort);
    port = ready.port;
    origin = 'http://127.0.0.1:' + port;
    let sequence = 0;
    const processHandle = {
      ready, messages, warningCount: () => warningCount,
      async command(command, params = {}) {
        const id = ++sequence;
        proc.send({ id, command, ...params });
        const reply = await until(() => messages.find(message => message.id === id), 'worker command ' + command, 5000);
        if (reply.error) throw new Error(reply.error);
        return reply.result;
      },
      async stop() {
        if (proc.exitCode !== null || proc.signalCode !== null) return;
        const done = once(proc, 'exit');
        proc.kill();
        await done;
      },
    };
    return processHandle;
  }

  function api(tab, route, body) {
    const expression = '(async()=>{const response=await fetch(' + JSON.stringify('/api/memory/' + route) + ',' +
      JSON.stringify(route === 'activate' ? { method: 'POST' } : body === undefined ? { cache: 'no-store' } : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }) + ');return {status:response.status,body:await response.json()};})()';
    return tab.eval(expression);
  }
  const openSettings = async tab => {
    if (!await tab.eval('document.querySelector("#preferencesPanel").matches(":popover-open")')) {
      await tab.click('button[popovertarget="preferencesPanel"]');
    }
  };
  const openBackup = async tab => {
    if (!await tab.eval('document.querySelector("#backupPanel").matches(":popover-open")')) {
      await openSettings(tab);
      await tab.click('#openBackup');
    }
    await tab.wait('document.querySelector("#backupPanel").matches(":popover-open")', 'backup panel');
  };
  const statusWait = (tab, text) => tab.wait('document.querySelector("#backupStatus").textContent.includes(' + JSON.stringify(text) + ')', text);
  const statusText = tab => tab.text('#backupStatus');
  const selectFile = async (tab, file, expected) => {
    await openBackup(tab);
    await tab.eval('document.querySelector("#backupFile").value=""');
    await tab.file(file);
    await tab.wait('(document.querySelector("#backupPreview").textContent+" "+document.querySelector("#backupStatus").textContent).includes(' +
      JSON.stringify(expected) + ') && !document.querySelector("#backupPanel").hasAttribute("aria-busy")', 'preview: ' + expected);
  };
  const browserState = tab => tab.eval('(()=>{const c=readConversationControl();const s=savedConversationList(c).sessions;' +
    'return {chat:s.map(x=>x.messages.map(y=>y.content)).sort(),favorite:favSongs.map(x=>x.name),' +
    'playlists:playlistLibrary.read().playlists.map(x=>x.name).sort(),categories:playlistLibrary.read().categories.map(x=>x.name),' +
    'prefs:JSON.parse(localStorage.getItem("zily.companionPreferences")),navigation:localStorage.getItem("zily.navigationCollapsed"),' +
    'enabled:c.enabled,journal:localStorage.getItem("zily.backup.v1.restore")!==null};})()');
  const localBytes = tab => tab.eval('Object.fromEntries(Object.keys(localStorage).filter(k=>!k.includes("cookie")).sort().map(k=>[k,localStorage.getItem(k)]))');
  async function clearB() {
    await b.cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'local_storage,cache_storage,indexeddb,service_workers' });
    await b.cdp.send('Network.clearBrowserCookies');
    await b.navigate();
    assert.equal((await api(b, 'status')).body.enabled, false);
    assert.equal((await browserState(b)).chat.length, 0);
    assert.equal((await browserState(b)).favorite.length, 0);
  }
  async function download(tab, directory, button, scope) {
    await openBackup(tab);
    const before = new Set(await fsp.readdir(directory));
    await tab.click(button);
    const file = await until(async () => (await fsp.readdir(directory)).find(name =>
      !before.has(name) && name.startsWith('music-companion-' + scope + '-') && name.endsWith('.json')), 'download ' + scope);
    const filename = path.join(directory, file);
    const raw = await fsp.readFile(filename, 'utf8');
    const parsed = JSON.parse(raw);
    const verified = verify(parsed);
    return { filename, bytes: Buffer.byteLength(raw), data: verified };
  }
  async function recovery(tab, id, password) {
    await openBackup(tab);
    await tab.eval('document.querySelector("#backupPanel details").open=true');
    await tab.input('#recoverId', id);
    await tab.input('#recoverPassword', password);
    await tab.click('#recoverBackupIdentity');
  }
  async function ensureBlankMemory(tab) {
    const response = await api(tab, 'activate', {});
    assert.equal(response.status, 201);
    const state = await api(tab, 'backup/state');
    assert.equal(state.body.occupied, false);
    return state.body.target;
  }
  function interceptRestore(tab, stage) {
    const method = 'Fetch.requestPaused';
    let paused;
    const detach = tab.cdp.on(method, ({ requestId, responseStatusCode }) => { paused = { requestId, responseStatusCode }; });
    return {
      enable: () => tab.cdp.send('Fetch.enable', { patterns: [{ urlPattern: origin + '/api/memory/backup/restore', requestStage: stage }] }),
      wait: () => until(() => paused, 'paused restore'),
      async continue() {
        const { requestId } = await this.wait();
        await tab.cdp.send('Fetch.continueRequest', { requestId });
        detach();
        await tab.cdp.send('Fetch.disable');
      },
      async fail() {
        const { requestId } = await this.wait();
        await tab.cdp.send('Fetch.failRequest', { requestId, errorReason: 'InternetDisconnected' });
        detach();
        await tab.cdp.send('Fetch.disable');
      },
      detach,
    };
  }
  async function counts(directory) {
    const files = (await fsp.readdir(directory)).filter(name => name.endsWith('.json'));
    let damaged = 0;
    const valid = new Map();
    for (const name of files) {
      const raw = await fsp.readFile(path.join(directory, name), 'utf8');
      try {
        verify(JSON.parse(raw));
        valid.set(name, createHash('sha256').update(raw).digest('hex'));
      } catch { damaged++; }
    }
    return { valid, damaged };
  }

  try {
    await fsp.mkdir(path.join(root, 'memory'));
    await fsp.mkdir(path.join(root, 'backups'));
    server = await startServer();
    assert.equal(server.ready.profileCount, 0);
    aBrowser = await launch(chrome, root, 'A', () => origin, traffic);
    bBrowser = await launch(chrome, root, 'B', () => origin, traffic);
    a = await aBrowser.open();
    b = await bBrowser.open();
    info('isolation', { verified: true, browserA: aBrowser.product, browserB: bBrowser.product, temporaryProfileCount: 2,
      emptyMemoryDirectoryBeforeTests: true, loopback: origin });

    const seeded = await step('A synthetic fixtures through UI and controlled interfaces', async () => {
      await openSettings(a);
      await a.click('#saveConversation');
      await a.wait('document.querySelector("#saveConversation").checked', 'save enabled');
      await a.click('button[popovertarget="preferencesPanel"][popovertargetaction="hide"]');
      for (const [index, text] of fixtures.chats.entries()) {
        if (index) await a.click('#newConversation');
        await a.input('#chatInput', text);
        await a.click('#chatSend');
        await a.wait('!chatPending && chatContext.at(-1)?.content.includes("虚构回答")', 'mock streamed reply');
        await a.wait('savedConversationList(readConversationControl()).sessions.length === ' + (index + 1), 'session durable');
      }
      await a.eval('(async()=>{localStorage.setItem("healed_songs",' + JSON.stringify(JSON.stringify(fixtures.favorites)) + ');' +
        'localStorage.setItem("zily.companionPreferences",JSON.stringify({duration:50,length:"long",suggestMusic:true}));' +
        'localStorage.setItem("zily.navigationCollapsed","true");const group=await playlistLibrary.saveCategory("虚构分类");' +
        'for(const name of ["虚构歌单甲","虚构歌单乙"])await playlistLibrary.create({name,description:"验收描述 <&>",categoryId:group.id,tracks:[]});})()');
      aTarget = await ensureBlankMemory(a);
      for (const content of fixtures.memory) {
        assert.equal((await api(a, 'items', { category: 'music', kind: 'user_preference', content })).status, 201);
      }
      await server.command('seed-candidates', { target: aTarget });
      baselineMemory = (await api(a, 'backup/export')).body;
      assert.equal(baselineMemory.memories.length, 2);
      assert.equal(baselineMemory.candidates.length, 2);
      assert.equal(await server.command('mock-hits'), 2);
      await a.navigate();
      const state = await browserState(a);
      assert.deepEqual(state.chat.map(turn => turn[0]).sort(), [...fixtures.chats].sort());
      assert.equal(state.favorite.length, 3);
      assert.equal(state.playlists.length, 2);
      return { chatSessions: 2, favorites: 3, playlists: 2, categories: 1, memory: 2, candidates: 2, mockedChatRequests: 2 };
    });

    await step('C05 Chrome two tabs retain the draft and save an independent copy', async () => {
      const second = await aBrowser.open();
      await a.click('button[popovertarget="playlistLibraryPanel"]');
      await a.click('button[aria-label="打开歌单「虚构歌单甲」"]');
      await a.input('#playlistLibraryPanel textarea', '本地未保存的描述 <&>');
      await a.eval('document.querySelector("#playlistLibraryPanel textarea").dispatchEvent(new Event("input",{bubbles:true}))');
      await second.eval('(async()=>{const p=playlistLibrary.read().playlists.find(x=>x.name==="虚构歌单甲");' +
        'await playlistLibrary.update(p.id,p.revision,{name:p.name,description:"另一标签页已保存",categoryId:p.categoryId,tracks:p.tracks});})()');
      await a.eval('document.querySelector("#playlistLibraryPanel textarea").form.requestSubmit()');
      await a.wait('document.querySelector("#playlistLibraryPanel").textContent.includes("本地草稿已保留")', 'conflict displayed');
      assert.equal(await a.eval('document.querySelector("#playlistLibraryPanel textarea").value'), '本地未保存的描述 <&>');
      assert.ok((await a.text('#playlistLibraryPanel')).includes('另一标签页已保存'));
      await a.eval('[...document.querySelectorAll("#playlistLibraryPanel button")].find(x=>x.textContent==="将草稿另存为歌单").click()');
      await a.wait('playlistLibrary.read().playlists.some(x=>x.description==="本地未保存的描述 <&>")', 'copied draft');
      const descriptions = await a.eval('playlistLibrary.read().playlists.filter(x=>x.name==="虚构歌单甲").map(x=>x.description)');
      assert.deepEqual(descriptions.sort(), ['另一标签页已保存', '本地未保存的描述 <&>'].sort());
      await a.eval('(async()=>{const p=playlistLibrary.read().playlists.find(x=>x.description==="本地未保存的描述 <&>");await playlistLibrary.remove(p.id,p.revision)})()');
      await second.close();
      await a.navigate();
      return { localDraft: 'preserved', comparison: 'visible', originalAndCopy: 2 };
    }, seeded);

    const exported = await step('A actual downloads and backup integrity', async () => {
      exportAll = await download(a, aBrowser.downloads, '#exportAllBackup', 'all');
      exportMemory = await download(a, aBrowser.downloads, '#exportMemoryBackup', 'memory');
      allData = exportAll.data;
      assert.equal(allData.version, 1);
      assert.equal(allData.modules.browser.version, 1);
      assert.ok(allData.modules.browser.chat.sessions.every(session => session.version === 2));
      assert.equal(allData.modules.browser.playlists.schemaVersion, 1);
      assert.equal(allData.modules.memory.version, 1);
      assert.equal(exportMemory.data.modules.browser, null);
      assert.deepEqual(exportMemory.data.modules.memory, baselineMemory);
      assert.deepEqual(allData.modules.memory, baselineMemory);
      assert.deepEqual(allData.modules.browser.favorites, fixtures.favorites);
      assert.deepEqual(allData.modules.browser.chat.sessions.map(x => x.messages[0].content).sort(), [...fixtures.chats].sort());
      for (const file of [exportAll, exportMemory]) {
        const raw = await fsp.readFile(file.filename, 'utf8');
        assert.doesNotMatch(raw, /"[^"]*(?:api.?key|token|cookie|password|recovery|credential)[^"]*"\s*:/i);
      }
      return { allBytes: exportAll.bytes, memoryBytes: exportMemory.bytes, sha256: 'both verified independently',
        versions: { envelope: 1, browser: 1, session: 2, playlistSchema: 1, memory: 1 } };
    }, seeded);

    const restored = await step('B empty baseline, cancel, confirm, refresh and content round trip', async () => {
      const empty = await browserState(b);
      assert.deepEqual([empty.chat.length, empty.favorite.length, empty.playlists.length, empty.categories.length], [0, 0, 0, 0]);
      assert.equal(empty.prefs, null);
      assert.equal((await api(b, 'status')).body.enabled, false);
      await selectFile(b, exportAll.filename, '检查完成');
      const preview = await b.text('#backupPreview');
      assert.match(preview, /聊天 2 个会话、4 条消息/);
      assert.match(preview, /正式记忆 2 条、待确认候选 2 条/);
      const initial = await localBytes(b);
      b.decision(false);
      await b.click('#applyBackup');
      assert.deepEqual(await localBytes(b), initial);
      assert.equal((await api(b, 'status')).body.enabled, false);
      b.decision(true);
      await selectFile(b, exportAll.filename, '检查完成');
      await b.click('#applyBackup');
      await statusWait(b, '恢复完成');
      const result = await statusText(b);
      await b.navigate();
      const state = await browserState(b);
      assert.deepEqual(state.chat, [...fixtures.chats].sort().map(text => [text, '虚构回答：测试 <&> 🌙']));
      assert.deepEqual(state.favorite, fixtures.favorites.map(track => track.name));
      assert.deepEqual(state.playlists, ['虚构歌单乙','虚构歌单甲'].sort());
      assert.deepEqual(state.categories, ['虚构分类']);
      assert.deepEqual(state.prefs, {duration:50,length:'long',suggestMusic:true});
      assert.equal(state.navigation, 'true');
      assert.equal(state.journal, false);
      assert.deepEqual((await api(b, 'backup/export')).body, baselineMemory);
      const reexported = await download(b, bBrowser.downloads, '#exportAllBackup', 'all');
      assert.deepEqual({ ...reexported.data.modules.browser, chat: {
        ...reexported.data.modules.browser.chat,
        sessions: reexported.data.modules.browser.chat.sessions.slice().sort((x, y) => x.sessionId.localeCompare(y.sessionId)),
      } }, { ...allData.modules.browser, chat: {
        ...allData.modules.browser.chat, sessions: allData.modules.browser.chat.sessions.slice().sort((x, y) => x.sessionId.localeCompare(y.sessionId)),
      } });
      return { preview, result, before: [0,0,0,0,0,0], after: [2,3,2,1,2,2], cancelled: 'unchanged', content: 'browser re-export and memory compared' };
    }, exported);

    await step('B duplicate import and four malformed inputs preserve existing data', async () => {
      const before = await localBytes(b);
      const originalMemory = (await api(b, 'backup/export')).body;
      await selectFile(b, exportAll.filename, '存在冲突');
      assert.ok(await b.eval('document.querySelector("#applyBackup").disabled'));
      const complete = pack(allData);
      const { modules: { browser }, ...rest } = complete;
      const cases = [
        ['unknown', JSON.stringify({ ...complete, version: 99 }), '不支持此备份版本'],
        ['json', '{"format":', '不是有效的 JSON'],
        ['checksum', JSON.stringify({ ...complete, sha256: '0'.repeat(64) }), '完整性校验失败'],
        ['missing', JSON.stringify({ ...rest, modules: { browser } }), '缺少模块'],
      ];
      for (const [name, raw, expected] of cases) {
        const file = path.join(root, name + '.json');
        await fsp.writeFile(file, raw, 'utf8');
        await b.eval('document.querySelector("#backupStatus").textContent=""');
        await selectFile(b, file, expected);
        assert.ok(await b.eval('document.querySelector("#applyBackup").disabled'));
        assert.deepEqual(await localBytes(b), before);
        assert.deepEqual((await api(b, 'backup/export')).body, originalMemory);
      }
      return { duplicate: 'conflict, confirmation disabled', rejected: cases.map(item => item[0]), unchanged: true };
    }, restored);

    await step('B simulated browser quota failure after an earlier module writes', async () => {
      await clearB();
      const before = await server.command('profile-count');
      await b.eval('localStorage.setItem("zily.navigationCollapsed","true");' +
        'window.qaOriginalSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){' +
        'if(k==="zily.playlists.v1")throw new DOMException("synthetic quota","QuotaExceededError");return qaOriginalSet.call(this,k,v)}');
      try {
        await selectFile(b, exportAll.filename, '检查完成');
        await b.click('#applyBackup');
        await statusWait(b, '浏览器空间不足');
        const stored = await localBytes(b);
        assert.deepEqual(stored, {'zily.navigationCollapsed': 'true'});
        assert.equal((await api(b, 'backup/export')).status, 401);
        const identityEnabledAfterFailure = (await api(b, 'status')).body.enabled;
        assert.equal(identityEnabledAfterFailure, false);
        assert.equal(await server.command('profile-count'), before);
        return { earlierBrowserAdditionRolledBack: true, existingSetting: 'true', newProfiles: 0, identityEnabledAfterFailure };
      } finally { await b.eval('Storage.prototype.setItem=qaOriginalSet'); }
    }, exported);

    await step('B network disconnect before POST reaches the server', async () => {
      await clearB();
      const target = await ensureBlankMemory(b);
      const probe = interceptRestore(b, 'Request');
      await probe.enable();
      await selectFile(b, exportAll.filename, '检查完成');
      await b.click('#applyBackup');
      await probe.wait();
      assert.ok(await b.eval('localStorage.getItem(' + JSON.stringify(journal) + ')'));
      await probe.fail();
      await b.wait('localStorage.getItem(' + JSON.stringify(journal) + ')===null', 'network rollback');
      assert.equal((await browserState(b)).chat.length, 0);
      assert.deepEqual(await server.command('read', { target }), { memory: 0, candidates: 0, committed: 0 });
      return { restoreRequest: 'Network InternetDisconnected before upstream', settle: 200, rolledBack: true, duplicates: 0 };
    }, exported);

    await step('B close the page after server commit and before receiving the response', async () => {
      await clearB();
      const target = await ensureBlankMemory(b);
      const probe = interceptRestore(b, 'Response');
      await probe.enable();
      await selectFile(b, exportAll.filename, '检查完成');
      await b.click('#applyBackup');
      const paused = await probe.wait();
      assert.equal(paused.responseStatusCode, 200);
      assert.deepEqual(await server.command('read', { target }), { memory: 2, candidates: 2, committed: 1 });
      assert.ok(await b.eval('localStorage.getItem(' + JSON.stringify(journal) + ')'));
      await b.close();
      probe.detach();
      b = await bBrowser.open();
      await statusWait(b, '上次恢复已提交');
      assert.equal((await browserState(b)).chat.length, 2);
      assert.equal(await b.eval('localStorage.getItem(' + JSON.stringify(journal) + ')'), null);
      await selectFile(b, exportAll.filename, '存在冲突');
      assert.deepEqual(await server.command('read', { target }), { memory: 2, candidates: 2, committed: 1 });
      return { serverCommitStatus: 200, reply: 'withheld until tab closed', journal: 'settled on reopen', duplicateCommits: 0 };
    }, exported);


    await step('B fresh identity response lost after commit while the page stays open', async () => {
      await clearB();
      const before = await server.command('profile-count');
      const probe = interceptRestore(b, 'Response');
      await probe.enable();
      await selectFile(b, exportAll.filename, '检查完成');
      assert.equal((await api(b, 'status')).body.enabled, false);
      assert.equal(await server.command('profile-count'), before);
      await b.click('#applyBackup');
      assert.equal((await probe.wait()).responseStatusCode, 200);
      await b.cdp.send('Network.clearBrowserCookies');
      assert.equal((await api(b, 'status')).body.enabled, false);
      await probe.fail();
      await statusWait(b, '恢复完成');
      assert.equal(await b.eval('localStorage.getItem(' + JSON.stringify(journal) + ')'), null);
      assert.equal((await api(b, 'status')).body.enabled, true);
      assert.deepEqual((await api(b, 'backup/export')).body, baselineMemory);
      const { target } = (await api(b, 'backup/state')).body;
      assert.deepEqual(await server.command('read', { target }), { memory: 2, candidates: 2, committed: 1 });
      assert.equal(await server.command('profile-count'), before + 1);
      await b.navigate();
      assert.equal((await browserState(b)).chat.length, 2);
      await selectFile(b, exportAll.filename, '存在冲突');
      return { restoreCommitted: 200, response: 'dropped in Chrome', settle: 200, identityReattached: true,
        newProfiles: 1, duplicateCommits: 0 };
    }, exported);

    await step('B close the page before the restore request reaches the server', async () => {
      await clearB();
      const target = await ensureBlankMemory(b);
      const probe = interceptRestore(b, 'Request');
      await probe.enable();
      await selectFile(b, exportAll.filename, '检查完成');
      await b.click('#applyBackup');
      await probe.wait();
      assert.equal(await b.eval('localStorage.getItem(' + JSON.stringify(journal) + ')!==null'), true);
      await b.close();
      probe.detach();
      b = await bBrowser.open();
      await statusWait(b, '已撤销上次中断的恢复');
      assert.equal(await b.eval('localStorage.getItem(' + JSON.stringify(journal) + ')'), null);
      assert.equal((await browserState(b)).chat.length, 0);
      assert.deepEqual(await server.command('read', { target }), { memory: 0, candidates: 0, committed: 0 });
      return { request: 'paused before upstream', journal: 'rolled back on reopen', memory: 0, candidates: 0 };
    }, exported);

    await step('B fresh restore exits before rename, resumes, and cleans only the aged orphan', async () => {
      await clearB();
      const before = await server.command('profile-count');
      await selectFile(b, exportAll.filename, '检查完成');
      await server.command('block-memory');
      await b.click('#applyBackup');
      await until(() => server.messages.find(message => message.event === 'memory-rename-blocked'), 'atomic rename blocked');
      await server.stop();
      await statusWait(b, '恢复尚未确认');
      assert.equal(await b.eval('localStorage.getItem(' + JSON.stringify(journal) + ')!==null'), true);
      server = await startServer();
      await openBackup(b);
      await b.click('#checkBackupRecovery');
      await statusWait(b, '已撤销上次中断的恢复');
      await b.navigate();
      assert.equal((await browserState(b)).chat.length, 0);
      assert.equal((await api(b, 'status')).body.enabled, false);
      assert.equal(await server.command('profile-count'), before);
      const directory = path.join(root, 'memory');
      const temps = (await fsp.readdir(directory)).filter(name => name.includes('.zily-') && name.endsWith('.tmp'));
      assert.equal(temps.length, 1);
      const orphan = path.join(directory, temps[0]);
      const userFile = path.join(directory, 'synthetic-user-created.tmp');
      const aged = new Date(Date.now() - 2 * 24 * 60 * 60_000);
      await fsp.writeFile(userFile, 'keep');
      await fsp.utimes(userFile, aged, aged);
      await fsp.utimes(orphan, aged, aged);
      await server.stop();
      server = await startServer();
      await until(() => !fs.existsSync(orphan), 'aged dead-writer temp cleaned');
      assert.equal(await fsp.readFile(userFile, 'utf8'), 'keep');
      assert.equal(await server.command('profile-count'), before);
      return { process: 'terminated before rename', journal: 'rolled back after restart', newProfiles: 0,
        youngTempsKept: 1, agedOrphansRemoved: 1, unrelatedTempKept: true };
    }, exported);

    await step('A real browser and server automatic backups, retention, write failure and corrupt history', async () => {
      // Capture the production hourly callback and advance only this test page's clock.
      await a.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: '(()=>{const old=setInterval;const now=Date.now.bind(Date);let offset=0;' +
        'Date.now=()=>now()+offset;window.qaAdvanceBackupClock=()=>{offset+=3600001};window.setInterval=function(fn,ms,...args){' +
        'if(ms===3600000)window.qaBackupTick=fn;return old.call(this,fn,ms,...args)}})();' });
      await a.navigate();
      await openBackup(a);
      assert.equal(await a.eval('document.querySelector("#autoBrowserBackup").checked'), false);
      const browserDir = path.join(root, 'backups', 'browser-' + aTarget);
      const memoryDir = path.join(root, 'backups', 'memory-' + aTarget);
      assert.equal(fs.existsSync(browserDir), false);
      await until(() => fs.existsSync(memoryDir), 'server automatic memory backup');
      await a.click('#autoBrowserBackup');
      await statusWait(a, '本机自动备份已写入');
      assert.equal((await counts(browserDir)).valid.size, 1);
      for (let index = 1; index <= 6; index++) {
        await server.command('revision', { target: aTarget, count: index });
        await delay(520);
        const seen = traffic.filter(row => row.route === '/api/memory/backup/auto' && row.browser === 'A').length;
        await a.eval('qaAdvanceBackupClock();qaBackupTick()');
        await until(() => traffic.filter(row => row.route === '/api/memory/backup/auto' && row.browser === 'A').length > seen, 'periodic browser auto API');
        await until(async () => {
          for (const name of await fsp.readdir(browserDir)) {
            if (name.endsWith('.json') && (await fsp.readFile(path.join(browserDir, name), 'utf8')).includes('轮转合成资料 ' + index)) return true;
          }
          return false;
        }, 'rotated browser snapshot');
      }
      await until(async () => (await counts(browserDir)).valid.size === 5 && (await counts(memoryDir)).valid.size === 5, 'both rotate to five');
      const before = await counts(browserDir);
      const priorMemory = await counts(memoryDir);
      await server.command('fail-backup', { value: true });
      try {
        await server.command('revision', { target: aTarget, count: 7 });
        await delay(540);
        await a.click('#autoBrowserBackup');
        await a.wait('localStorage.getItem("zily.backup.v1.auto")==="false"', 'disabled auto');
        await a.click('#autoBrowserBackup');
        await statusWait(a, '暂时无法');
        assert.deepEqual(await counts(browserDir), before);
        assert.deepEqual(await counts(memoryDir), priorMemory);
      } finally { await server.command('fail-backup', { value: false }); }
      const bad = path.join(browserDir, String(Date.now()) + '-' + randomUUID() + '.json');
      await fsp.writeFile(bad, '{synthetic damaged backup', 'utf8');
      await server.stop();
      server = await startServer();
      await until(() => server.warningCount() > 0, 'startup damage warning');
      const after = await counts(browserDir);
      assert.deepEqual(after.valid, before.valid);
      assert.equal(after.damaged, 1);
      return { browserValid: after.valid.size, browserDamagedPreserved: after.damaged,
        serviceValid: (await counts(memoryDir)).valid.size, retention: 5, failedWritePreservedFiveInEachBucket: true, startupWarning: true };
    }, exported);

    await step('B new identity, wrong and correct password, A revoked, persistence after server restart', async () => {
      await clearB();
      const original = (await api(a, 'backup/export')).body;
      assert.equal(original.memories.length, 2);
      assert.equal(original.candidates.length, 2);
      const password = 'synthetic acceptance phrase 2026';
      await openBackup(a);
      await a.eval('document.querySelector("#backupPanel details").open=true');
      await a.input('#setupRecoveryPassword', password);
      await a.click('#setupBackupRecovery');
      await statusWait(a, '恢复口令已设置');
      const recoveryId = await a.eval('document.querySelector("#backupRecoveryId").value');
      assert.equal(recoveryId, aTarget);
      await recovery(b, recoveryId, 'incorrect synthetic password');
      await statusWait(b, '恢复编号或口令不正确');
      assert.equal((await api(b, 'status')).body.enabled, false);
      await recovery(b, recoveryId, password);
      await statusWait(b, '已连接原资料库');
      assert.equal((await api(b, 'backup/state')).body.target, aTarget);
      assert.deepEqual((await api(b, 'backup/export')).body, original);
      assert.equal((await api(a, 'backup/export')).status, 401);
      await server.stop();
      server = await startServer();
      await b.navigate();
      assert.equal((await api(b, 'backup/state')).body.target, aTarget);
      assert.deepEqual((await api(b, 'backup/export')).body, original);
      return { wrongPassword: 403, success: 200, oldIdentityExport: 401, sameOriginalLibrary: true,
        memory: 2, candidates: 2, survivesServerRestart: true };
    }, exported);

    await step('C06 and C08 Chrome memory deletion, clear and legacy import preview', async () => {
      await clearB();
      const target = await ensureBlankMemory(b);
      const created = await api(b, 'items', { category: 'music', kind: 'user_preference', content: '虚构删除验收记录' });
      const first = created.body.item;
      const endpoint = '/api/memory/items/' + first.id;
      const mutate = (url, method, body) => b.eval('(async()=>{const r=await fetch(' + JSON.stringify(url) + ',{method:' +
        JSON.stringify(method) + ',headers:{"Content-Type":"application/json"},body:' + JSON.stringify(JSON.stringify(body)) +
        '});return r.status})()');
      assert.equal(await mutate(endpoint, 'PATCH', { category: first.category, kind: first.kind,
        content: '虚构新版删除记录', revision: 1 }), 200);
      assert.equal(await mutate(endpoint, 'DELETE', { revision: 1 }), 409);
      await server.command('seed-candidates', { target });
      await openSettings(b);
      await b.click('button[popovertarget="memoryPanel"]:not([popovertargetaction])');
      await b.wait('!document.querySelector("#clearMemories").hidden', 'memory loaded');
      await b.click('#clearMemories');
      await b.wait('document.querySelector("#memoryStatus").textContent.includes("共 0 条")', 'clear reflected in UI');
      const blank = (await api(b, 'backup/export')).body;
      assert.deepEqual([blank.memories.length, blank.candidates.length], [0, 0]);
      await selectFile(b, exportMemory.filename, '目标库的删除或清空记录会阻止');
      assert.match(await b.text('#backupPreview'), /阻止 4 条/);
      await b.click('#applyBackup');
      await statusWait(b, '恢复完成');
      await b.navigate();
      const after = (await api(b, 'backup/export')).body;
      assert.deepEqual([after.memories.length, after.candidates.length], [0, 0]);
      return { staleRevision: 409, clearRemovedMemoryAndCandidates: true, preventedLegacyRecords: 4 };
    }, exported);

    await step('isolated npm.cmd test and npm.cmd run check', async () => regression(project, root), true);
  } finally {
    for (const resource of [aBrowser, bBrowser, server]) {
      if (resource) {
        try { await (resource.close ? resource.close() : resource.stop()); } catch { /* Cleanup verification below. */ }
      }
    }
    const map = new Map();
    for (const row of traffic) {
      const key = row.browser + ' ' + row.route + ' ' + row.status;
      map.set(key, (map.get(key) || 0) + 1);
    }
    info('api', { counts: Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b))) });
    assert.equal(await fsp.readFile(marker, 'utf8'), 'synthetic acceptance only');
    assert.equal(await fsp.realpath(root), root);
    checkInside(base, root);
    assert.match(path.basename(root), /^zily-browser-qa-/);
    await fsp.rm(root, { recursive: true, force: false, maxRetries: 8, retryDelay: 200 });
    info('cleanup', { removed: !fs.existsSync(root) });
    info('summary', { cases: outcomes });
  }
  if (outcomes.some(row => row.status !== 'PASS')) process.exitCode = 1;
}

async function regression(project, root) {
  const target = path.join(root, 'regression');
  await fsp.mkdir(target);
  for (const directory of ['server', 'test', 'web/js']) {
    await fsp.mkdir(path.join(target, directory), { recursive: true });
    for (const name of await fsp.readdir(path.join(project, directory))) {
      if (name.endsWith('.js')) await fsp.copyFile(path.join(project, directory, name), path.join(target, directory, name));
    }
  }
  await fsp.mkdir(path.join(target, 'scripts'));
  for (const name of ['package.json', 'web/index.html', 'scripts/start.js', 'scripts/ncm.js', 'scripts/ncm-log.js']) {
    await fsp.copyFile(path.join(project, name), path.join(target, name));
  }
  await fsp.writeFile(path.join(target, 'isolation.cjs'), 'const fs=require("node:fs"),path=require("node:path");\n' + blockEnvironmentFiles.toString() + '\nblockEnvironmentFiles();\n' +
    'const fetchLocal=globalThis.fetch;globalThis.fetch=(input,opts)=>{const url=new URL(String(input));' +
    'if(url.protocol!=="http:"||url.hostname!=="127.0.0.1")throw Error("Only loopback allowed");return fetchLocal(input,{...opts,redirect:"error"});};' +
    'Object.assign(process.env,{DEEPSEEK_API_KEY:"mock-regression-opaque-" + require("node:crypto").randomUUID(),' +
    'DEEPSEEK_MODEL:"synthetic",DEEPSEEK_BASE_URL:"http://127.0.0.1:1",NCM_API_URL:"http://127.0.0.1:1"});');
  const run = command => new Promise((resolve, reject) => {
    const processHandle = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
      { cwd: target, windowsHide: true, env: { ...process.env, npm_config_update_notifier: 'false', npm_config_offline: 'true' },
        stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    processHandle.stdout.on('data', data => { output += data.toString(); });
    processHandle.stderr.on('data', data => { output += data.toString(); });
    processHandle.once('error', reject);
    processHandle.once('exit', code => {
      if (code === 0) return resolve(output);
      const totals = output.split(/\r?\n/).filter(line => /^(?:ℹ|#) (?:tests|pass|fail|skipped) \d+$/.test(line));
      reject(new Error('Isolated regression failed (exit ' + code + '). ' + totals.join(', ')));
    });
  });
  const testResult = await run('npm.cmd --cache ./npm-cache test -- --require ./isolation.cjs; exit $LASTEXITCODE');
  const totals = testResult.split(/\r?\n/).filter(line => /\b(?:tests|pass|fail|skipped) \d+/.test(line)).slice(-9);
  const passed = /\bpass (\d+)\b/.exec(totals.join('\n'));
  assert.ok(passed && Number(passed[1]) >= 271, 'The existing 271 tests must be retained');
  assert.match(totals.join('\n'), /\bfail 0\b/);
  await run('npm.cmd --cache ./npm-cache run check; exit $LASTEXITCODE');
  return { totals, syntaxCheck: 'passed' };
}

if (require.main === module) {
  const run = process.argv[2] === '--worker'
    ? worker(process.argv[3], process.argv[4], process.argv[5]) : acceptance();
  run.catch(error => { console.error(error.message); process.exitCode = 1; if (process.connected) process.disconnect(); });
}

module.exports = { launch, until, checkInside };
