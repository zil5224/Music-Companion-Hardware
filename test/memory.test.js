'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createMemoryStore, defaultMemoryDirectory } = require('../server/memory-store');
const { createMemoryHandler } = require('../server/memory-http');

const activatePath = '/api/memory/activate';
const statusPath = '/api/memory/status';
const firstId = 'a'.repeat(64);

async function setup(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'zily-memory-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const directory = path.join(temporary, 'memory');
  return { directory, store: createMemoryStore(directory) };
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function start(t, store) {
  const handler = createMemoryHandler({
    store, sendJson,
    async readJsonBody(req) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
  });
  const server = http.createServer((req, res) => handler(req, res, new URL(req.url, 'http://localhost')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const port = server.address().port;
  const origin = 'http://127.0.0.1:' + port;
  function request(route, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const requestHeaders = body === undefined ? headers : { 'Content-Length': Buffer.byteLength(body), ...headers };
      const req = http.request(origin + route, { method, headers: requestHeaders }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, body: JSON.parse(text) }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(body);
    });
  }
  const activate = headers => request(activatePath, { method: 'POST', headers: { Origin: origin, ...headers } });
  return { request, activate, origin };
}

function cookieFrom(response) {
  return response.headers['set-cookie'][0].split(';')[0];
}

function idFrom(cookie) {
  return createHash('sha256').update(cookie.slice('zily_memory='.length)).digest('hex');
}

test('default memory directory is outside the project and named Zily/memory', () => {
  const directory = defaultMemoryDirectory();
  assert.equal(path.basename(directory), 'memory');
  assert.equal(path.basename(path.dirname(directory)), 'Zily');
  const relative = path.relative(path.resolve(__dirname, '..'), directory);
  assert(relative.startsWith('..' + path.sep) || path.isAbsolute(relative));
});

test('anonymous or unrecognized status never creates the memory directory or a credential', async t => {
  const { directory, store } = await setup(t);
  const { request } = await start(t, store);
  for (const headers of [{}, { Cookie: 'zily_memory=' + 'a'.repeat(43) }]) {
    const res = await request(statusPath, { headers });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { enabled: false });
    assert.equal(res.headers['set-cookie'], undefined);
  }
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('explicit activation issues a host-only 256-bit token and initializes a versioned store', async t => {
  const { directory, store } = await setup(t);
  const { activate } = await start(t, store);
  const res = await activate();
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { enabled: true, schemaVersion: 1 });
  const header = res.headers['set-cookie'][0];
  const cookie = cookieFrom(res);
  const token = cookie.slice('zily_memory='.length);
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.match(header, /; Max-Age=15552000; Path=\/api; HttpOnly; SameSite=Strict$/);
  assert.doesNotMatch(header, /Domain=|; Secure/);
  const id = idFrom(cookie);
  assert.deepEqual(await fs.readdir(directory), [id + '.json']);
  const data = await store.read(id);
  assert.equal(data.schemaVersion, 1);
  assert.deepEqual(data.memories, []);
  assert.equal(data.createdAt, data.updatedAt);
  assert.doesNotMatch(await fs.readFile(path.join(directory, id + '.json'), 'utf8'), new RegExp(token));
});

test('repeat activation with a valid cookie reuses the same file without issuing a new credential', async t => {
  const { directory, store } = await setup(t);
  const { activate } = await start(t, store);
  const cookie = cookieFrom(await activate());
  const first = await store.read(idFrom(cookie));
  const repeat = await activate({ Cookie: cookie });
  assert.equal(repeat.status, 200);
  assert.equal(repeat.headers['set-cookie'], undefined);
  assert.equal((await fs.readdir(directory)).length, 1);
  assert.deepEqual(await store.read(idFrom(cookie)), first);
});

test('two browser identities are isolated and cannot select a file through request data', async t => {
  const { directory, store } = await setup(t);
  const { request, activate, origin } = await start(t, store);
  const first = cookieFrom(await activate());
  const second = cookieFrom(await activate());
  assert.notEqual(first, second);
  const owner = idFrom(first);
  const other = idFrom(second);
  await store.update(owner, memories => [...memories, { content: '只属于第一个浏览器' }]);
  assert.deepEqual((await store.read(other)).memories, []);
  assert.equal((await fs.readdir(directory)).length, 2);

  const headers = { Cookie: second, 'X-Profile-Id': owner };
  const status = await request(statusPath, { headers });
  assert.deepEqual(status.body, { enabled: true, schemaVersion: 1 });
  assert.doesNotMatch(status.text, /第一个浏览器|memories|profileId/);
  assert.equal((await request(statusPath + '?profileId=' + owner, { headers })).status, 400);
  const body = JSON.stringify({ profileId: owner });
  assert.equal((await request(activatePath, {
    method: 'POST', headers: { ...headers, Origin: origin, 'Content-Length': Buffer.byteLength(body) }, body
  })).status, 400);
  assert.equal((await request('/api/memory/' + owner, { headers })).status, 404);
  assert.equal((await store.read(owner)).memories.length, 1);
});

test('new handler and store instances recover the same browser data after simulated restart', async t => {
  const { directory, store } = await setup(t);
  const initial = await start(t, store);
  const cookie = cookieFrom(await initial.activate());
  await store.update(idFrom(cookie), () => [{ content: '跨重启保留' }]);
  const reopened = createMemoryStore(directory);
  const restarted = await start(t, reopened);
  const status = await restarted.request(statusPath, { headers: { Cookie: cookie } });
  assert.deepEqual(status.body, { enabled: true, schemaVersion: 1 });
  assert.equal(status.headers['set-cookie'], undefined);
  assert.deepEqual((await reopened.read(idFrom(cookie))).memories, [{ content: '跨重启保留' }]);
});

test('lost cookies and invented tokens never reconnect to an existing library', async t => {
  const { store } = await setup(t);
  const { request, activate } = await start(t, store);
  const original = cookieFrom(await activate());
  await store.update(idFrom(original), () => [{ content: '原资料库' }]);
  const unknown = 'zily_memory=' + 'z'.repeat(43);
  assert.deepEqual((await request(statusPath, { headers: { Cookie: unknown } })).body, { enabled: false });
  const replacement = cookieFrom(await activate({ Cookie: unknown }));
  assert.notEqual(replacement, unknown);
  assert.notEqual(replacement, original);
  assert.deepEqual((await store.read(idFrom(replacement))).memories, []);
  assert.equal((await store.read(idFrom(original))).memories.length, 1);
});

test('concurrent read-modify-write updates are serialized across store instances', async t => {
  const { directory, store } = await setup(t);
  const other = createMemoryStore(directory);
  await Promise.all([store.initialize(firstId), other.initialize(firstId)]);
  await Promise.all(Array.from({ length: 20 }, (_, index) =>
    (index % 2 ? store : other).update(firstId, async memories => {
      await Promise.resolve();
      return [...memories, { index }];
    })));
  const data = await store.read(firstId);
  assert.deepEqual(data.memories.map(item => item.index), Array.from({ length: 20 }, (_, index) => index));
});

test('failed atomic replacement keeps old bytes and removes its temporary file', async t => {
  const { directory, store } = await setup(t);
  await store.initialize(firstId);
  await store.update(firstId, () => [{ content: '旧数据' }]);
  const target = path.join(directory, firstId + '.json');
  const before = await fs.readFile(target, 'utf8');
  const interrupted = createMemoryStore(directory, {
    ...fs,
    async rename() { throw Object.assign(Error('simulated failure'), { code: 'EIO' }); }
  });
  await assert.rejects(interrupted.update(firstId, () => [{ content: '新数据' }]), { code: 'unavailable' });
  assert.equal(await fs.readFile(target, 'utf8'), before);
  assert.deepEqual(await fs.readdir(directory), [firstId + '.json']);
  await store.update(firstId, items => [...items, { content: '重试成功' }]);
  assert.equal((await store.read(firstId)).memories.length, 2);
});

test('malformed JSON is reported without replacing the old file', async t => {
  const { directory, store } = await setup(t);
  await store.initialize(firstId);
  const target = path.join(directory, firstId + '.json');
  await fs.writeFile(target, '{broken', 'utf8');
  await assert.rejects(store.read(firstId), { code: 'corrupt' });
  await assert.rejects(store.initialize(firstId), { code: 'corrupt' });
  await assert.rejects(store.update(firstId, () => []), { code: 'corrupt' });
  assert.equal(await fs.readFile(target, 'utf8'), '{broken');
});

test('unsupported schema versions are rejected and never rewritten', async t => {
  const { directory, store } = await setup(t);
  const data = await store.initialize(firstId);
  const target = path.join(directory, firstId + '.json');
  const old = JSON.stringify({ ...data, schemaVersion: 2 });
  await fs.writeFile(target, old, 'utf8');
  await assert.rejects(store.read(firstId), { code: 'unsupported-version' });
  await assert.rejects(store.initialize(firstId), { code: 'unsupported-version' });
  assert.equal(await fs.readFile(target, 'utf8'), old);
});

test('invalid or traversal-like internal identifiers cannot select a path', async t => {
  const { directory, store } = await setup(t);
  for (const id of ['../other', '..\\other', 'C:\\data', '/tmp/data', '%2e%2e', firstId + '/x']) {
    await assert.rejects(store.read(id), { code: 'invalid-profile' });
    await assert.rejects(store.initialize(id), { code: 'invalid-profile' });
    await assert.rejects(store.update(id, () => []), { code: 'invalid-profile' });
  }
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('malicious Host, wrong Origin and preflight cannot activate or create data', async t => {
  const { directory, store } = await setup(t);
  const { request, activate, origin } = await start(t, store);
  for (const headers of [
    { Host: 'rebound.example' },
    { Host: '127.0.0.1:9999' },
    { Origin: 'https://other.example' },
    { Origin: 'null' },
    { Origin: origin + '/path' },
  ]) {
    const res = await activate(headers);
    assert.equal(res.status, 403);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  }
  assert.equal((await request(activatePath, { method: 'POST' })).status, 403);
  assert.equal((await request(activatePath, { method: 'OPTIONS', headers: { Origin: origin } })).status, 405);
  assert.equal((await request(statusPath, { headers: { Host: 'bad.example' } })).status, 403);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('a non-loopback peer cannot access the memory handler even with valid-looking headers', async () => {
  let result;
  const handler = createMemoryHandler({
    store: { initialize() { assert.fail('no file access'); } },
    sendJson: (_, status) => { result = status; }
  });
  await handler({
    method: 'POST',
    socket: { remoteAddress: '192.168.1.8', localAddress: '127.0.0.1', localPort: 8080 },
    headers: { host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080' }
  }, {}, new URL(activatePath, 'http://localhost'));
  assert.equal(result, 403);
});

test('corrupt and incompatible API responses expose neither token, path nor raw errors', async t => {
  const { directory, store } = await setup(t);
  const { request, activate } = await start(t, store);
  const first = await activate();
  const cookie = cookieFrom(first);
  const token = cookie.split('=')[1];
  const target = path.join(directory, idFrom(cookie) + '.json');
  const valid = await store.read(idFrom(cookie));
  assert(!first.text.includes(token));
  const headers = { Cookie: cookie };
  const log = [];
  const originals = ['log', 'warn', 'error'].map(key => [key, console[key]]);
  for (const [key] of originals) console[key] = (...values) => log.push(values.join(' '));
  try {
    await fs.writeFile(target, 'invalid JSON ' + token);
    const broken = await request(statusPath, { headers });
    assert.equal(broken.status, 500);
    assert.match(broken.body.error, /损坏/);
    assert(!broken.text.includes(token));
    assert(!broken.text.includes(directory));
    const attempted = await activate(headers);
    assert.equal(attempted.status, 500);
    assert.equal(attempted.headers['set-cookie'], undefined);
    assert.equal(await fs.readFile(target, 'utf8'), 'invalid JSON ' + token);
    await fs.writeFile(target, JSON.stringify({ ...valid, schemaVersion: 2 }));
    const incompatible = await request(statusPath, { headers });
    assert.equal(incompatible.status, 409);
    assert(!incompatible.text.includes(token));
    assert(!incompatible.text.includes(directory));
    assert.deepEqual(log, []);
  } finally {
    for (const [key, fn] of originals) console[key] = fn;
  }
});
test('expired credentials cannot reopen their previous library', async t => {
  const { directory, store } = await setup(t);
  const { request, activate } = await start(t, store);
  const cookie = cookieFrom(await activate());
  const id = idFrom(cookie);
  const target = path.join(directory, id + '.json');
  const old = await store.read(id);
  await fs.writeFile(target, JSON.stringify({ ...old, identityExpiresAt: '2020-01-01T00:00:00.000Z' }));
  assert.deepEqual((await request(statusPath, { headers: { Cookie: cookie } })).body, { enabled: false });
  const replacement = await activate({ Cookie: cookie });
  assert.equal(replacement.status, 201);
  assert.notEqual(cookieFrom(replacement), cookie);
  assert.equal((await fs.readdir(directory)).length, 2);
});

test('HTTPS loopback activation marks the host-only identity cookie Secure', async t => {
  const { store } = await setup(t);
  const headers = {};
  let result;
  const handler = createMemoryHandler({ store, sendJson: (_, status) => { result = status; } });
  await handler({
    method: 'POST',
    socket: { remoteAddress: '::1', localAddress: '::1', localPort: 443, encrypted: true },
    headers: { host: '[::1]', origin: 'https://[::1]' }
  }, { setHeader: (name, value) => { headers[name] = value; } }, new URL(activatePath, 'http://localhost'));
  assert.equal(result, 201);
  assert.match(headers['Set-Cookie'], /; Secure$/);
});

const itemsPath = '/api/memory/items';
const draft = { category: 'music', kind: 'user_preference', content: '工作时喜欢纯音乐' };

async function manager(t) {
  const data = await setup(t);
  const api = await start(t, data.store);
  const cookie = cookieFrom(await api.activate());
  function items(method = 'GET', id = '', payload, headers = {}) {
    return api.request(itemsPath + (id ? '/' + id : ''), {
      method,
      headers: { Cookie: cookie, Origin: api.origin, ...(payload === undefined ? {} : {
        'Content-Type': 'application/json'
      }), ...headers },
      body: payload === undefined ? undefined : JSON.stringify(payload)
    });
  }
  return { ...data, ...api, cookie, items };
}

test('an active identity can list its empty memory library', async t => {
  const { items } = await manager(t);
  const res = await items();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { items: [], total: 0 });
});

test('anonymous and unknown identities cannot list or add memories and no library is created', async t => {
  const { directory, store } = await setup(t);
  const { request, origin } = await start(t, store);
  assert.equal((await request(itemsPath)).status, 401);
  assert.equal((await request(itemsPath, { headers: { Cookie: 'zily_memory=' + 'z'.repeat(43) } })).status, 401);
  const write = await request(itemsPath, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
  assert.equal(write.status, 401);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('manual creation trims content and generates identity, metadata and timestamps on the server', async t => {
  const { items } = await manager(t);
  const res = await items('POST', '', { ...draft, content: '  ' + draft.content + '  ' });
  assert.equal(res.status, 201);
  const { item } = res.body;
  assert.match(item.id, /^[0-9a-f-]{36}$/);
  assert.equal(item.revision, 1);
  assert.equal(item.content, draft.content);
  assert.equal(item.status, 'active');
  assert.equal(item.sourceType, 'manual');
  assert.equal(item.sourceRole, 'user');
  assert.equal(item.createdAt, item.updatedAt);
  assert.equal(item.createdAt, item.lastConfirmedAt);
  assert(!('sourceSessionId' in item));
  assert(!('sourceMessageIds' in item));
  assert.deepEqual((await items()).body, { items: [item], total: 1 });
});

for (const [name, extra, message] of [
  ['empty content', { content: ' \n ' }, /请输入/],
  ['oversized content', { content: '字'.repeat(1001) }, /1000/],
  ['unsupported category', { category: '__proto__' }, /分类/],
  ['unsupported kind', { kind: 'ai_guess' }, /类型/],
  ['forged ID', { id: 'forged' }, /只允许/],
  ['forged provenance', { sourceType: 'chat', sourceRole: 'assistant', evidence: [] }, /只允许/],
  ['forged status and timestamps', { status: 'candidate', createdAt: '2020-01-01' }, /只允许/]
]) {
  test('manual creation rejects ' + name, async t => {
    const { items } = await manager(t);
    const res = await items('POST', '', { ...draft, ...extra });
    assert.equal(res.status, 400);
    assert.match(res.body.error, message);
    assert.equal((await items()).body.total, 0);
  });
}

test('editing increments revision and updates confirmation while preserving provenance', async t => {
  const { items } = await manager(t);
  const initial = (await items('POST', '', draft)).body.item;
  const update = await items('PATCH', initial.id, { ...draft, content: '改成白噪声', revision: initial.revision });
  assert.equal(update.status, 200);
  const next = update.body.item;
  assert.equal(next.revision, 2);
  assert.equal(next.createdAt, initial.createdAt);
  assert(next.updatedAt >= initial.updatedAt);
  assert.equal(next.lastConfirmedAt, next.updatedAt);
  assert.equal(next.sourceType, 'manual');
  assert.equal(next.sourceRole, 'user');
  assert.equal(next.content, '改成白噪声');
  assert.equal((await items('PATCH', initial.id, { ...draft, revision: 2, sourceRole: 'assistant' })).status, 400);
});

test('single deletion removes a row from JSON and missing IDs return 404', async t => {
  const { items, store, cookie } = await manager(t);
  const item = (await items('POST', '', draft)).body.item;
  const res = await items('DELETE', item.id, { revision: item.revision });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { deleted: true, epoch: 1 });
  assert.deepEqual((await store.read(idFrom(cookie))).memories, []);
  assert.equal((await items('DELETE', item.id, { revision: item.revision })).status, 404);
});

test('clearing requires confirmation and removes all rows without disabling memory', async t => {
  const { items, request, store, cookie } = await manager(t);
  await items('POST', '', draft);
  await items('POST', '', { ...draft, content: '另一条记忆' });
  assert.equal((await items('DELETE', '', { confirm: false })).status, 400);
  assert.equal((await items()).body.total, 2);
  assert.equal((await items('DELETE', '', { confirm: true })).status, 200);
  assert.deepEqual((await store.read(idFrom(cookie))).memories, []);
  assert.deepEqual((await request(statusPath, { headers: { Cookie: cookie } })).body, { enabled: true, schemaVersion: 1 });
});

test('different cookie identities cannot view, edit or delete each other’s items', async t => {
  const { items, activate } = await manager(t);
  const first = (await items('POST', '', draft)).body.item;
  const other = cookieFrom(await activate());
  const headers = { Cookie: other, 'X-Profile-Id': idFrom(other) };
  assert.deepEqual((await items('GET', '', undefined, headers)).body.items, []);
  assert.equal((await items('PATCH', first.id, { ...draft, revision: 1 }, headers)).status, 404);
  assert.equal((await items('DELETE', first.id, { revision: first.revision }, headers)).status, 404);
  assert.equal((await items('DELETE', '', { confirm: true }, headers)).status, 200);
  assert.deepEqual((await items()).body.items, [first]);
});

test('concurrent edits to the same revision produce one success and one conflict', async t => {
  const { items } = await manager(t);
  const first = (await items('POST', '', draft)).body.item;
  const results = await Promise.all(['改动 A', '改动 B'].map(content =>
    items('PATCH', first.id, { ...draft, content, revision: 1 })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const success = results.find(result => result.status === 200).body.item;
  assert.equal(success.revision, 2);
  assert.deepEqual((await items()).body.items, [success]);
});

test('memory management rejects foreign Origin, missing Origin and foreign Host', async t => {
  const { items, request, cookie } = await manager(t);
  assert.equal((await items('POST', '', draft, { Origin: 'http://other.example' })).status, 403);
  assert.equal((await items('GET', '', undefined, { Host: 'other.example' })).status, 403);
  assert.equal((await request(itemsPath, { method: 'DELETE', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{"confirm":true}' })).status, 403);
  assert.equal((await items()).body.total, 0);
});

test('updated manual memory survives a new server handler and store instance', async t => {
  const { items, cookie, directory } = await manager(t);
  const initial = (await items('POST', '', draft)).body.item;
  const edit = (await items('PATCH', initial.id, { ...draft, content: '修改后内容', revision: 1 })).body.item;
  const restarted = await start(t, createMemoryStore(directory));
  const res = await restarted.request(itemsPath, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items, [edit]);
});

test('manual memory operations do not invoke any model or network client', async t => {
  const { items } = await manager(t);
  const original = globalThis.fetch;
  globalThis.fetch = () => assert.fail('memory operations must not call a model');
  try {
    const created = await items('POST', '', draft);
    assert.equal(created.status, 201);
    assert.equal((await items()).status, 200);
    assert.equal((await items('PATCH', created.body.item.id, { ...draft, revision: 1 })).status, 200);
    assert.equal((await items('DELETE', '', { confirm: true })).status, 200);
  } finally {
    globalThis.fetch = original;
  }
});

test('a stale tab cannot delete a newer memory revision', async t => {
  const { items } = await manager(t);
  const initial = (await items('POST', '', draft)).body.item;
  const edited = await items('PATCH', initial.id, { ...draft, content: '较新修订', revision: 1 });
  assert.equal(edited.status, 200);
  assert.equal((await items('DELETE', initial.id, { revision: 1 })).status, 409);
  assert.deepEqual((await items()).body.items, [edited.body.item]);
  assert.equal((await items('DELETE', initial.id, { revision: 2 })).status, 200);
});

test('an old tab cannot submit a pre-clear draft or clear a later generation', async t => {
  const { items, request, cookie } = await manager(t);
  assert.equal((await items('DELETE', '', { confirm: true })).status, 200);
  assert.equal((await items('POST', '', draft)).status, 409);
  const { body: { clearEpoch } } = await request('/api/memory/discovery', { headers: { Cookie: cookie } });
  assert.equal(clearEpoch, 1);
  assert.equal((await items('POST', '', { ...draft, clearEpoch })).status, 201);
  assert.equal((await items('DELETE', '', { confirm: true })).status, 409);
  assert.equal((await items()).body.total, 1);
});
