'use strict';

// Standalone acceptance with a new Chrome profile and loopback-only mocks.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { launch, until, checkInside } = require('./backup-browser-acceptance.cjs');
const { runNcm } = require('./ncm');

const exact = ['browser', 'mock', 'opaque', 'configuration'].join('-');
const pasted = 'sk-' + 'Z'.repeat(30);
const musicCookie = 'MUSIC_U=' + 'N'.repeat(30);
const marker = 'synthetic browser acceptance';
const frame = text => 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assertSafe = value => {
  for (const fixture of [exact, pasted, musicCookie]) {
    assert.equal(value.includes(fixture), false, 'synthetic credential crossed boundary');
  }
};
async function listen(server) {
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
}
async function close(server) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

let stage = 'initialization';
async function run() {
  const chrome = process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  assert.ok((await fs.stat(chrome)).isFile());
  const base = await fs.realpath(os.tmpdir());
  const root = await fs.realpath(await fs.mkdtemp(path.join(base, 'zily-privacy-chrome-')));
  checkInside(base, root);
  const markerPath = path.join(root, '.synthetic-only');
  await fs.writeFile(markerPath, marker, { flag: 'wx' });
  const logs = [];
  const warn = console.warn;
  const nativeFetch = global.fetch;
  let app, ai, worker, browser;
  let modelHits = 0;
  const cases = [];
  async function step(label, task) {
    try { await task(); cases.push({ label, result: 'PASS' }); }
    catch (error) {
      const line = /privacy-browser-acceptance\.cjs:(\d+):\d+/.exec(error.stack)?.[1];
      cases.push({ label, result: 'FAIL', line });
    }
  }

  try {
    console.warn = (...args) => logs.push(args.join(' '));
    const entry = path.join(root, 'mock-ncm.cjs');
    const portFile = path.join(root, 'mock-ncm.port');
    await fs.writeFile(entry, [
      'const http = require("node:http"); const fs = require("node:fs");',
      'const server = http.createServer(async (req, res) => {',
      '  const chunks = []; for await (const chunk of req) chunks.push(chunk);',
      '  const input = JSON.parse(Buffer.concat(chunks));',
      '  if (input.cookie !== ' + JSON.stringify(musicCookie) + ') { res.writeHead(400); res.end("{}"); return; }',
      '  console.log("[OK]", req.url);',
      '  console.log("[ERR]", req.url, {status: 503, body: {cookie: input.cookie}});',
      '  process.stderr.write(input.cookie);',
      '  res.writeHead(200, {"Content-Type":"application/json"}); res.end("{\\"result\\":{\\"songs\\":[]}}");',
      '});',
      'server.listen(0, "127.0.0.1", () => fs.writeFileSync(' + JSON.stringify(portFile) +
        ', String(server.address().port), "utf8"));',
    ].join('\n'));
    stage = 'music mock startup';
    worker = runNcm(entry);
    const ncm = 'http://127.0.0.1:' + await until(async () => {
      const port = await fs.readFile(portFile, 'utf8');
      return /^\d+$/.test(port) ? port : null;
    }, 'music mock ready');
    ai = http.createServer(async (req, res) => {
      if (req.url !== '/chat/completions') { req.resume(); res.writeHead(404).end(); return; }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      const text = body.messages.at(-1).content;
      modelHits++;
      if (text === '模型错误验收') {
        res.writeHead(401).end(exact + '\n at C:\\private\\server.js:20:3');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(frame('模拟回复。'));
      await sleep(50);
      if (text === '流错误验收') {
        res.end('event: error\ndata: ' + JSON.stringify({ error: { message: exact } }) + '\n\n');
      } else {
        res.end(frame('流结束。') + 'data: [DONE]\n\n');
      }
    });
    stage = 'AI mock startup';
    const aiOrigin = await listen(ai);
    Object.assign(process.env, { DEEPSEEK_API_KEY: exact, DEEPSEEK_MODEL: 'test', DEEPSEEK_BASE_URL: aiOrigin, NCM_API_URL: ncm });
    global.fetch = (url, options) => {
      const origin = new URL(String(url)).origin;
      if (origin !== aiOrigin && origin !== ncm) {
        throw new Error('test network guard');
      }
      return nativeFetch(url, { ...options, redirect: 'error' });
    };
    const { createServer } = require('../server/server');
    const { createMemoryStore } = require('../server/memory-store');
    const { digest } = require('../server/backup-store');
    app = createServer({ memoryStore: createMemoryStore(path.join(root, 'memory')) });
    stage = 'Music Companion startup';
    const origin = await listen(app);
    stage = 'Chrome startup';
    browser = await launch(chrome, root, 'privacy', () => origin, [], nativeFetch);
    stage = 'isolated browser page';
    const tab = await browser.open();
    const request = (route, method, body) => tab.eval('(async () => { const result = await fetch(' +
      JSON.stringify(route) + ', ' + JSON.stringify({ method, headers: { 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }) +
      '); return {status: result.status, text: await result.text()}; })()');
    const directChat = content => request('/api/chat', 'POST', { messages: [{ role: 'user', content }] });

    await step('normal UI chat streams and is saved', async () => {
      await tab.click('#saveConversation');
      await tab.wait('saveChatEnabled === true', 'chat saving');
      await tab.input('#chatInput', '你好');
      await tab.click('#chatSend');
      await tab.wait('!chatPending && document.querySelector("#chatMessages").textContent.includes("流结束。")', 'chat response');
      await tab.wait('JSON.stringify(savedConversationList(readConversationControl()).sessions).includes("模拟回复。流结束。")',
        'normal chat snapshot committed');
      const stored = await tab.eval('JSON.stringify(savedConversationList(readConversationControl()).sessions)');
      assert.equal(stored.includes('模拟回复。流结束。'), true);
      assertSafe(stored);
    });

    await step('HTTP errors and service diagnostics hide upstream values', async () => {
      const result = await directChat('模型错误验收');
      assert.equal(result.status, 502);
      assertSafe(result.text);
      assert.equal(result.text.includes('C:\\private'), false);
      assert.match(logs.join('\n'), /upstream_http/);
      assertSafe(logs.join('\n'));
    });

    await step('SSE errors are safe and normal completion is preserved', async () => {
      const error = await directChat('流错误验收');
      assert.match(error.text, /ai_stream_error/);
      assertSafe(error.text);
      const normal = await directChat('普通流');
      assert.match(normal.text, /\[DONE\]/);
      assert.match(normal.text, /流结束/);
      assertSafe(normal.text);
    });

    await step('music requests preserve results and isolate credential logging', async () => {
      const result = await request('/ncm/cloudsearch?keywords=synthetic', 'POST', { cookie: musicCookie });
      assert.equal(result.status, 200);
      assert.equal(JSON.parse(result.text).result.songs.length, 0);
      await until(() => logs.some(line => line.includes('"category":"request_error"')), 'music diagnosis');
      assertSafe(logs.join('\n'));
      assert.equal(logs.join('\n').includes('keywords='), false);
    });

    await step('pasted credentials are blocked before model requests, snapshots or memory', async () => {
      const before = modelHits;
      await tab.input('#chatInput', pasted);
      await tab.click('#chatSend');
      await tab.wait('document.querySelector("#chatMessages").textContent.includes("检测到疑似凭证")', 'credential notice');
      assert.equal(modelHits, before);
      assertSafe(await tab.eval('JSON.stringify(localStorage)'));
      await tab.eval('sendMessage(false, ' + JSON.stringify(exact) + ')');
      assert.equal(modelHits, before);
      assertSafe(await tab.eval('JSON.stringify(localStorage)'));
      assert.equal((await request('/api/memory/activate', 'POST')).status, 201);
      const rejected = await request('/api/memory/items', 'POST', { category: 'music', kind: 'manual_note', content: pasted });
      assert.equal(rejected.status, 400);
      assertSafe(rejected.text);
      const saved = await request('/api/memory/backup/export', 'GET');
      assert.equal(saved.status, 200);
      assert.equal(JSON.parse(saved.text).memories.length, 0);
      assertSafe(saved.text);
    });

    let exported;
    await step('real browser export excludes stored music login and pasted credentials', async () => {
      await tab.eval('localStorage.setItem("netease_cookie", ' + JSON.stringify(musicCookie) + ')');
      await tab.click('#exportAllBackup');
      const name = await until(async () => (await fs.readdir(browser.downloads)).find(file => file.endsWith('.json')), 'backup download');
      const text = await fs.readFile(path.join(browser.downloads, name), 'utf8');
      assertSafe(text);
      exported = JSON.parse(text);
      assert.equal(exported.format, 'zily-backup');
      assert.equal(text.includes('netease_cookie'), false);
    });

    await step('browser import rejects credential content even with a recomputed checksum', async () => {
      assert.ok(exported);
      const { sha256, ...body } = exported;
      body.modules.browser.chat.sessions[0].messages[0].content = exact;
      const filename = path.join(root, 'synthetic-invalid-backup.json');
      await fs.writeFile(filename, JSON.stringify({ ...body, sha256: digest(body) }));
      await tab.file(filename);
      await tab.wait('document.querySelector("#backupStatus").textContent.includes("疑似凭证")', 'backup rejected');
      assertSafe(await tab.eval('JSON.stringify(savedConversationList(readConversationControl()).sessions)'));
    });
    console.log(JSON.stringify({ browser: browser.product, cases, mockModelRequests: modelHits, realModelRequests: 0, realMusicRequests: 0 }));
    if (cases.some(result => result.result !== 'PASS')) process.exitCode = 1;
  } finally {
    try {
      if (browser) await browser.close();
    } finally {
      try {
        await close(app);
        await close(ai);
        if (worker?.exitCode === null && worker.signalCode === null) {
          const exited = once(worker, 'exit');
          if (worker.connected) worker.disconnect();
          else worker.kill();
          await exited;
        }
      } finally {
        console.warn = warn;
        global.fetch = nativeFetch;
        assert.equal(await fs.readFile(markerPath, 'utf8'), marker);
        assert.equal(await fs.realpath(root), root);
        checkInside(base, root);
        await fs.rm(root, { recursive: true, force: false, maxRetries: 8, retryDelay: 200 });
        console.log('isolated browser and data directory removed');
      }
    }
  }
}

run().catch(error => {
  const line = /(?:privacy|backup)-browser-acceptance\.cjs:(\d+):\d+/.exec(error.stack)?.[1];
  const timeout = /^Timeout: (isolated Chrome debugger|Chrome target|page load event|Music Companion UI ready|music mock ready)/.exec(error.message)?.[1];
  console.error(JSON.stringify({ setupOrCleanup: 'FAIL', stage, line, timeout }));
  process.exitCode = 1;
});
