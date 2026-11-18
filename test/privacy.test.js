'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const key = ['mock', 'opaque', 'runtime', 'value'].join('-');
const token = 'sk-' + 'T'.repeat(28);
const cookieValue = 'MUSIC_U=' + 'C'.repeat(30);
process.env.DEEPSEEK_API_KEY = key;
process.env.DEEPSEEK_BASE_URL = 'https://model.invalid/v1';
const { createServer, config } = require('../server/server');
const { createMemoryStore } = require('../server/memory-store');
const { eligibleUsers, validateCandidates } = require('../server/memory-extraction');
const { digest } = require('../server/backup-store');
const credentials = require('../web/js/00-credentials');
const format = require('../web/js/22-backup-format');
const browser = require('../web/js/23-backup-browser');
const { runNcm } = require('../scripts/ncm');

const stamp = '2026-01-01T00:00:00.000Z';
const done = 'data: [DONE]\n\n';
const frame = (content, reason) => 'data: ' + JSON.stringify({
  choices: [{ delta: { content }, ...(reason ? { finish_reason: reason } : {}) }],
}) + '\n\n';

function noSecrets(value, ...extras) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [key, token, cookieValue, ...extras]) {
    assert.equal(text.includes(secret), false, 'a synthetic sensitive value crossed the privacy boundary');
  }
}

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zily-privacy-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function setup(t, mock = () => { throw new Error('unexpected mock request'); }) {
  const directory = await temporary(t);
  const store = createMemoryStore(path.join(directory, 'memory'));
  const app = createServer({ memoryStore: store });
  await new Promise((resolve, reject) => app.once('error', reject).listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + app.address().port;
  const native = global.fetch;
  const warn = console.warn;
  const logs = [];
  let hits = 0;
  console.warn = (...args) => logs.push(args.join(' '));
  global.fetch = async (url, options) => {
    const target = new URL(String(url));
    if (target.origin === origin) return native(url, { ...options, redirect: 'error' });
    if (target.origin !== 'https://model.invalid') throw new Error('external network denied in tests');
    hits++;
    return mock(target, options);
  };
  t.after(async () => {
    global.fetch = native;
    console.warn = warn;
    app.closeAllConnections();
    await new Promise(resolve => app.close(resolve));
  });
  function request(route, body, cookie, method = body === undefined ? 'GET' : 'POST') {
    return fetch(origin + '/api/' + route, {
      method, signal: AbortSignal.timeout(4500), ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    });
  }
  const chat = (content, options) => request('chat', { messages: [{ role: 'user', content }], ...options });
  async function activate() {
    const result = await request('memory/activate', undefined, undefined, 'POST');
    assert.equal(result.status, 201);
    return result.headers.get('set-cookie').split(';')[0];
  }
  return { chat, request, activate, logs, store, hits: () => hits };
}

const item = content => ({
  id: randomUUID(), revision: 1, category: 'music', kind: 'manual_note', content, status: 'active',
  sourceType: 'manual', sourceRole: 'user', createdAt: stamp, updatedAt: stamp, lastConfirmedAt: stamp,
});
const memory = content => ({ version: 1, useInChat: false, autoExtractEnabled: false, memories: [item(content)], candidates: [] });

test('credential detection permits ordinary placeholder-based code discussion', () => {
  const jwt = ['eyJ' + 'A'.repeat(9), 'B'.repeat(14), 'C'.repeat(15)].join('.');
  for (const text of [key, token, cookieValue, jwt, 'Authorization: Bearer ' + 'B'.repeat(24),
    'Set-Cookie: session=' + 'S'.repeat(15), 'password="' + 'p'.repeat(16) + '"',
    'https://local.invalid/?access_token=' + 'D'.repeat(18), '-----BEGIN CERTIFICATE-----',
    '-----BEGIN EC PRIVATE KEY-----']) assert.equal(credentials.contains(text), true, 'expected a credential classification');
  for (const text of ['How does Authorization work?', 'password = process.env.PASSWORD',
    'api_key = "<YOUR_API_KEY>"', 'Bearer $' + '{ACCESS_TOKEN}', 'sessionId comes from the current session.']) {
    assert.equal(credentials.contains(text), false, 'ordinary discussion or a placeholder was blocked');
  }
});

test('AI HTTP errors discard upstream bodies and log structured diagnostics', async t => {
  const app = await setup(t, () => new Response(key + ' ' + cookieValue + '\n at C:\\private\\main.js:4:2', { status: 401 }));
  const response = await app.chat('你好');
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['code', 'error']);
  assert.equal(body.code, 'ai_upstream_error');
  noSecrets(body, 'C:\\private');
  assert.equal(app.logs.length, 1);
  assert.match(app.logs[0], /"stage":"ai_chat","category":"upstream_http","status":401/);
  assert.equal(app.logs[0].includes(response.headers.get('x-request-id')), true);
  noSecrets(app.logs, 'C:\\private');
});

test('AI connection and unexpected request exceptions omit raw errors and stacks', async t => {
  const synthetic = new Error(key + ' ' + cookieValue + ' C:\\private\\main.js');
  const app = await setup(t, () => { throw synthetic; });
  const response = await app.chat('你好');
  assert.equal(response.status, 502);
  noSecrets(await response.text(), 'C:\\private');
  const original = Object.getOwnPropertyDescriptor(config, 'deepseekModel');
  Object.defineProperty(config, 'deepseekModel', { configurable: true, get() { throw synthetic; } });
  try {
    const health = await app.request('health');
    assert.equal(health.status, 500);
    noSecrets(await health.text(), 'C:\\private');
  } finally {
    Object.defineProperty(config, 'deepseekModel', original);
  }
  assert.equal(app.logs.length, 2);
  assert.match(app.logs[0], /upstream_unavailable/);
  assert.match(app.logs[1], /internal_error/);
  noSecrets(app.logs, 'C:\\private', 'at TestContext');
});

test('normal SSE emits a first delta before the upstream finishes and preserves completion', async t => {
  const encoder = new TextEncoder();
  let producer;
  const app = await setup(t, () => new Response(new ReadableStream({
    start(controller) { producer = controller; controller.enqueue(encoder.encode(frame('正常回复'))); },
  })));
  const reader = (await app.chat('你好')).body.getReader();
  const decoder = new TextDecoder();
  assert.equal(decoder.decode((await reader.read()).value).includes('正常回复'), true);
  producer.enqueue(encoder.encode(frame('继续。', 'stop') + done));
  producer.close();
  let rest = '';
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    rest += decoder.decode(result.value, { stream: true });
  }
  assert.equal(rest.includes('继续。'), true);
  assert.equal(rest.includes('[DONE]'), true);
});

for (const [label, opening, early, tail] of [
  ['mixed-language prose', '你好，Music Companion', '你好，', 'Music Companion'],
  ['complete lines', 'Music Companion\n', 'Music Companion\n', ''],
]) {
  test('SSE sends ' + label + ' early and withholds a split credential', async t => {
    const encoder = new TextEncoder();
    let producer;
    const app = await setup(t, () => new Response(new ReadableStream({
      start(controller) { producer = controller; controller.enqueue(encoder.encode(frame(opening))); },
    })));
    const reader = (await app.chat('你好')).body.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    assert.equal(JSON.parse(first.trim().slice(6)).choices[0].delta.content, early);
    producer.enqueue(encoder.encode(frame((tail ? '\n' : '') + key.slice(0, 8))));
    producer.enqueue(encoder.encode(frame(key.slice(8)) + done));
    producer.close();
    let rest = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += decoder.decode(chunk.value, { stream: true });
    }
    assert.match(rest, /ai_stream_sensitive/);
    assert.equal(rest.includes(key.slice(0, 8)), false);
    assert.doesNotMatch(rest, /\[DONE\]/);
  });
}

test('SSE discards raw error fields, IDs and stack text', async t => {
  const app = await setup(t, () => new Response(frame('安全正文。') + 'event: error\r\nid: ' + key +
    '\r\ndata: ' + JSON.stringify({ error: { message: token + ' C:\\private\\worker.js:12:2' } }) + '\r\n\r\n'));
  const text = await (await app.chat('你好')).text();
  assert.match(text, /安全正文/);
  assert.match(text, /ai_stream_error/);
  assert.doesNotMatch(text, /\[DONE\]/);
  noSecrets(text, 'C:\\private');
  noSecrets(app.logs, 'C:\\private');
});

test('SSE rejects the configured opaque Key split across deltas', async t => {
  const app = await setup(t, () => new Response(frame('安全正文。') + frame(key.slice(0, 8)) + frame(key.slice(8)) + done));
  const text = await (await app.chat('你好')).text();
  assert.match(text, /ai_stream_sensitive/);
  assert.equal(text.includes(key.slice(0, 8)), false, 'a credential fragment crossed the stream');
  noSecrets(text);
});

test('SSE rejects split labelled credentials and ignores non-content fields', async t => {
  const hidden = 'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: cookieValue }, secret: key }] }) + '\n\n';
  const app = await setup(t, () => new Response(hidden + frame('Authoriz') + frame('ation: Bearer ') + frame(token) + done));
  const text = await (await app.chat('你好')).text();
  assert.match(text, /ai_stream_sensitive/);
  noSecrets(text);
});

test('chat and search reject credentials in messages, summaries and context before model requests', async t => {
  const app = await setup(t);
  for (const request of [
    () => app.chat(token), () => app.chat(key), () => app.chat('你好', { summary: 'Cookie: ' + cookieValue }),
    () => app.request('search', { query: '近期节目', context: [{ role: 'user', content: 'password="' + token + '"' }] }),
  ]) {
    const result = await request();
    assert.equal(result.status, 400);
    const body = await result.json();
    assert.equal(body.code, 'credential_detected');
    noSecrets(body);
  }
  assert.equal(app.hits(), 0);
});

test('local preflight rejects the configured opaque Key for chat and backup without forwarding either', async t => {
  const app = await setup(t);
  assert.equal((await app.request('privacy/check', { message: '普通聊天' })).status, 204);
  const backup = format.createBody('memory', null, memory('普通记忆'), stamp);
  backup.modules.memory.memories[0].content = key;
  for (const data of [{ message: key }, { backup }]) {
    const result = await app.request('privacy/check', data);
    assert.equal(result.status, 400);
    const body = await result.json();
    assert.equal(body.code, 'credential_detected');
    noSecrets(body);
  }
  assert.equal(app.hits(), 0);
});

test('manual memory API rejects known formats and the configured opaque Key', async t => {
  const app = await setup(t);
  const cookie = await app.activate();
  for (const content of [token, key]) {
    const result = await app.request('memory/items', { category: 'music', kind: 'manual_note', content }, cookie);
    assert.equal(result.status, 400);
    assert.match(await result.text(), /疑似凭证/);
  }
  const data = await (await app.request('memory/backup/export', undefined, cookie)).json();
  assert.equal(data.memories.length, 0);
  assert.equal(data.candidates.length, 0);
  noSecrets(data);
});

test('automatic extraction rejects credential evidence before the model or candidate storage', async t => {
  const app = await setup(t);
  const cookie = await app.activate();
  const enabled = await app.request('memory/discovery', { autoExtractEnabled: true }, cookie, 'PATCH');
  assert.equal(enabled.status, 200);
  const { epoch } = await enabled.json();
  const sessionId = randomUUID();
  const batch = Array.from({ length: 8 }, (_, index) => ({ id: randomUUID(), role: index % 2 ? 'assistant' : 'user',
    content: index % 2 ? '收到' : '我长期使用 ' + key }));
  assert.equal(eligibleUsers(batch).length, 0);
  assert.equal(validateCandidates({ candidates: [{ category: 'music', kind: 'user_fact', content: batch[0].content,
    sourceMessageIds: [batch[0].id], evidenceQuote: batch[0].content, reason: '测试' }] }, batch, sessionId, stamp).length, 0);
  const result = await app.request('memory/extract', { sessionId, epoch, messages: batch }, cookie);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).added, 0);
  assert.equal(app.hits(), 0);
});

test('backup export fails closed on credentials in old memory and preserves the original', async t => {
  const app = await setup(t);
  const cookie = await app.activate();
  const id = createHash('sha256').update(cookie.split('=')[1]).digest('hex');
  const entry = item('Cookie: ' + cookieValue);
  await app.store.update(id, () => [entry]);
  const result = await app.request('memory/backup/export', undefined, cookie);
  assert.equal(result.status, 422);
  noSecrets(await result.text());
  assert.equal((await app.store.read(id)).memories[0].id, entry.id);
});

test('backup import rejects a credential even with a valid checksum, and browser restore refuses raw writes', async () => {
  const body = format.createBody('memory', null, memory('普通记忆'), stamp);
  body.modules.memory.memories[0].content = 'Authorization: Bearer ' + token;
  assert.throws(() => format.split({ ...body, sha256: digest(body) }), /疑似凭证/);
  const data = new Map();
  const storage = { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
  await assert.rejects(browser.restore({ storage, writes: [{ key: 'healed_songs', value: JSON.stringify([cookieValue]) }],
    operation: null }), /疑似凭证/);
  assert.equal(data.size, 0);
});

test('server restore refuses credential data before writing or granting an identity', async t => {
  const app = await setup(t);
  const result = await app.request('memory/backup/restore', {
    id: randomUUID(), issuedAt: Date.now(), proof: 'a'.repeat(64), confirm: true, memory: memory(key),
  });
  assert.equal(result.status, 422);
  assert.equal(result.headers.has('set-cookie'), false);
  assert.equal((await app.store.listProfiles()).length, 0);
  noSecrets(await result.text());
});

test('music subprocess emits safe diagnostics for request URLs, error bodies and raw stderr', async t => {
  const directory = await temporary(t);
  const entry = path.join(directory, 'mock-ncm.cjs');
  await fs.writeFile(entry, [
    'console.log("[OK]", ' + JSON.stringify('/login/qr/check?key=' + token) + ');',
    'console.log("[ERR]", ' + JSON.stringify('/song/url?cookie=' + cookieValue) + ', { status: 502, body: ' + JSON.stringify(key) + ' });',
    'console.error(new Error(' + JSON.stringify(cookieValue) + '));',
    'process.stderr.write(' + JSON.stringify(token) + ');',
    'process.disconnect();',
  ].join('\n'));
  const logs = [];
  const warn = console.warn;
  console.warn = (...args) => logs.push(args.join(' '));
  try {
    const worker = runNcm(entry);
    t.after(() => { if (worker.exitCode === null) worker.kill(); });
    const [status] = await once(worker, 'exit');
    assert.equal(status, 0);
    assert.match(logs.join('\n'), /"category":"request_error","status":502/);
    assert.match(logs.join('\n'), /dependency_error/);
    noSecrets(logs, '/song/url', '/login/qr/check');
  } finally { console.warn = warn; }
});
