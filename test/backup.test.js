'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const format = require('../web/js/22-backup-format');
const browser = require('../web/js/23-backup-browser');
const { atomicWrite, cleanupAtomicTemps, pack, verify, memoryData, createBackupRotation, startMemoryBackups } = require('../server/backup-store');
const { createMemoryStore } = require('../server/memory-store');
const { createMemoryHandler } = require('../server/memory-http');

const stamp = '2026-01-01T00:00:00.000Z';
const item = (content = '测试偏好') => ({ id: randomUUID(), revision: 1, category: 'music', kind: 'user_preference',
  content, status: 'active', sourceType: 'manual', sourceRole: 'user', createdAt: stamp, updatedAt: stamp, lastConfirmedAt: stamp });
const candidate = () => ({
  id: randomUUID(), category: 'music', kind: 'user_preference', content: '我一直喜欢爵士乐。',
  status: 'pending', sourceType: 'conversation_candidate', sourceRole: 'user', createdAt: stamp, updatedAt: stamp,
  evidence: [{ sessionId: randomUUID(), messageId: randomUUID(), role: 'user', quote: '我一直喜欢爵士乐。' }],
  reason: '稳定偏好', correctionCue: true,
});
const memory = (content, extra = {}) => ({ version: 1, useInChat: false, autoExtractEnabled: false,
  memories: [item(content)], candidates: [candidate()], ...extra });
const local = () => {
  const category = { id: randomUUID(), revision: 1, name: '手动分类' };
  return { version: 1, chat: { enabled: true, sessions: [{ version: 2, sessionId: randomUUID(), revision: 2,
    updatedAt: 10, messages: [{ role: 'user', content: '测试聊天', id: randomUUID() },
      { role: 'assistant', content: '部分回复', id: randomUUID(), status: 'interrupted' }], summary: { text: '', covered: 0 } }] },
    favorites: [{ id: 1, name: '测试曲目', artist: '歌手' }],
    playlists: { schemaVersion: 1, categories: [category], playlists: [
      { id: randomUUID(), revision: 1, name: '我的歌单', description: '', categoryId: category.id, createdAt: stamp, updatedAt: stamp, tracks: [] }
    ] },
    preferences: { companion: { duration: 25, length: 'short', suggestMusic: false }, navigationCollapsed: true } };
};

function makeStorage(entries = [], beforeWrite = () => {}) {
  const data = new Map(entries);
  return { data, get length() { return data.size; }, key: index => [...data.keys()][index] ?? null,
    getItem: key => data.get(key) ?? null, setItem(key, value) { beforeWrite(key, value); data.set(key, value); },
    removeItem: key => data.delete(key) };
}

const plan = (storage, data, control = { enabled: false, epoch: 'legacy' }) => browser.plan(storage, data, control, randomUUID);
const operation = () => ({ id: randomUUID(), target: 'a'.repeat(64), expected: 'b'.repeat(64) });
const settleNo = async () => ({ committed: false });

async function fixture(t, disk) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zily-backup-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createMemoryStore(path.join(root, 'memory'), disk);
  const origin = 'http://127.0.0.1:8080';
  let rotation;
  const handler = createMemoryHandler({
    store, rotation: () => rotation,
    sendJson(res, status, body) { return { status, body, headers: res.headers }; },
    readJsonBody: async req => typeof req.body === "function" ? req.body() : req.body,
  });
  function request(route, { cookie, body, confirmOrigin = origin, method = body === undefined ? 'GET' : 'POST' } = {}) {
    const req = { method, body, socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1', localPort: 8080 },
      headers: { host: '127.0.0.1:8080', origin: confirmOrigin, cookie, 'content-type': 'application/json' } };
    const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; } };
    return handler(req, res, new URL('/api/memory/' + route, origin));
  }
  const cookieFor = response => response.headers['Set-Cookie'].split(';')[0];
  const activate = async () => cookieFor(await request('activate', { method: 'POST' }));
  const identity = cookie => createHash('sha256').update(cookie.split('=')[1]).digest('hex');
  return { root, store, request, activate, cookieFor, identity, setRotation(value) { rotation = value; } };
}

test('portable backup round-trips browser modules and memory into a new profile', async t => {
  const { activate, request, identity, store } = await fixture(t);
  const data = local();
  const source = memory(undefined, { useInChat: true, autoExtractEnabled: true });
  const exported = pack(format.createBody('all', data, source, stamp));
  const imported = verify(JSON.parse(JSON.stringify(exported)));
  const storage = makeStorage();
  const localPlan = plan(storage, imported.modules.browser);
  const cookie = await activate();
  const state = (await request('backup/state', { cookie })).body;
  const op = { id: randomUUID(), target: state.target, expected: state.expected };
  const result = await browser.restore({ storage, writes: localPlan.writes, operation: op, memory: imported.modules.memory,
    send: async body => (await request('backup/restore', { cookie, body })).body, settle: settleNo });
  assert.equal(result.committed, true);
  assert.equal(result.writes, 6);
  assert.deepEqual(JSON.parse(storage.getItem('zily.playlists.v1')), data.playlists);
  const { writeId, ...chat } = JSON.parse(storage.getItem(localPlan.writes.find(write => write.key.includes('.session.')).key));
  assert.ok(format.uuid(writeId));
  assert.deepEqual(chat, data.chat.sessions[0]);
  assert.deepEqual(memoryData(await store.read(identity(cookie))), source);
  assert.deepEqual((await request('backup/export', { cookie })).body, source);
  assert.equal(storage.getItem(browser.journalKey), null);
});

test('recovery after an expired legacy browser credential reconnects the same library', async t => {
  const { activate, request, cookieFor, store, identity } = await fixture(t);
  const original = await activate();
  const id = identity(original);
  const entry = item();
  await store.update(id, () => [entry]);
  const password = 'test recovery phrase 2026';
  const setup = await request('backup/recovery-setup', { cookie: original, body: { password, confirm: true } });
  assert.equal(setup.status, 200);
  assert.equal(setup.body.recoveryId, id);
  await store.mutate(id, () => ({ identityExpiresAt: stamp }));
  assert.equal((await request('backup/export', { cookie: original })).status, 401);
  const otherBrowser = await activate();
  assert.equal((await request('backup/export', { cookie: otherBrowser })).body.memories.length, 0);
  const recovered = await request('backup/recover', { cookie: otherBrowser, body: { recoveryId: id, password, confirm: true } });
  assert.equal(recovered.status, 200);
  assert.deepEqual((await request('backup/export', { cookie: cookieFor(recovered) })).body.memories, [entry]);
  assert.equal((await request('backup/export', { cookie: original })).status, 401);
  const stored = await fs.readFile(path.join(store.directory, id + '.json'), 'utf8');
  assert.ok(!stored.includes(password) && !stored.includes(cookieFor(recovered).split('.').at(-1)));
  assert.equal((await store.listProfiles()).length, 2);
});

test('wrong recovery password and unconfirmed recovery leave the original library intact', async t => {
  const { activate, request, identity, store } = await fixture(t);
  const cookie = await activate();
  const id = identity(cookie);
  await request('backup/recovery-setup', { cookie, body: { password: 'original test password', confirm: true } });
  const before = await store.read(id);
  const body = { recoveryId: id, password: 'wrong test password', confirm: true };
  const wrong = await request('backup/recover', { body });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.headers['Set-Cookie'], undefined);
  assert.equal((await request('backup/recover', { body: { ...body, confirm: false } })).status, 400);
  assert.deepEqual(await store.read(id), before);
});

test('damaged JSON and edited payload fail integrity validation', () => {
  const file = pack(format.createBody('memory', null, memory(), stamp));
  assert.throws(() => verify(JSON.parse('{"format":')), SyntaxError);
  file.modules.memory.memories[0].content = '改动后的正文';
  assert.throws(() => verify(file), /完整性/);
});

test('unknown backup versions and unknown fields are rejected', () => {
  const file = pack(format.createBody('memory', null, memory(), stamp));
  assert.throws(() => verify({ ...file, version: 99 }), /版本/);
  assert.throws(() => verify({ ...file, credential: 'fake' }), /未知字段/);
  file.modules.memory.candidates[0].unknown = true;
  assert.throws(() => verify(file), /未知字段/);
});

test('an incomplete backup or invalid cross-module reference cannot be restored', () => {
  const file = pack(format.createBody('all', local(), memory(), stamp));
  delete file.modules.memory;
  assert.throws(() => verify(file), /缺少模块/);
  const data = local();
  data.playlists.playlists[0].categoryId = randomUUID();
  assert.throws(() => format.createBody('all', data, null, stamp), /分类关系/);
});

test('a later browser write failure rolls back earlier writes and keeps existing data', async () => {
  const storage = makeStorage([['zily.navigationCollapsed', 'true'], ['outside', 'keep']], key => {
    if (key === 'zily.playlists.v1') throw Object.assign(new Error('mock quota'), { name: 'QuotaExceededError' });
  });
  const writes = plan(storage, local()).writes;
  let upstream = 0;
  await assert.rejects(browser.restore({ storage, writes, operation: operation(), memory: memory(),
    send: async () => upstream++, settle: settleNo }), /mock quota/);
  assert.equal(upstream, 0);
  assert.deepEqual([...storage.data], [['zily.navigationCollapsed', 'true'], ['outside', 'keep']]);
});

test('a failed memory commit rolls back browser additions without overwriting current data', async t => {
  let fail = false;
  const disk = { ...fs, async rename(from, to) { if (fail) throw new Error('mock disk failure'); return fs.rename(from, to); } };
  const { activate, request, store, identity } = await fixture(t, disk);
  const cookie = await activate();
  const state = (await request('backup/state', { cookie })).body;
  const original = await store.read(identity(cookie));
  const storage = makeStorage([['outside', 'keep']]);
  const writes = plan(storage, local()).writes;
  const op = { id: randomUUID(), target: state.target, expected: state.expected };
  const route = async (name, body) => {
    const result = await request('backup/' + name, { cookie, body });
    if (result.status !== 200) throw new Error(result.body.error);
    return result.body;
  };
  await assert.rejects(browser.restore({ storage, writes, operation: op, memory: memory(),
    send: async body => {
      fail = true;
      try { return await route('restore', body); }
      finally { fail = false; }
    }, settle: body => route('settle', body) }), /暂时无法/);
  assert.deepEqual([...storage.data], [['outside', 'keep']]);
  const latest = await store.read(identity(cookie));
  assert.deepEqual(latest.memories, original.memories);
  assert.equal(latest.backupReceipts[0].committed, false);
  assert.equal((await request('backup/restore', { cookie, body: { ...op, confirm: true, memory: memory() } })).status, 409);
});

test('a real child process exit after a partial restore leaves a recoverable journal', async t => {
  const { root } = await fixture(t);
  const simulatedStorage = path.join(root, 'storage.json');
  const implementation = require.resolve('../web/js/23-backup-browser');
  const child = spawnSync(process.execPath, ['-e', 
    'const fs=require("node:fs");const restore=require(process.argv[1]);const file=process.argv[2];' +
    'const map=new Map([["existing","keep"]]);const storage={getItem:k=>map.get(k)??null,setItem(k,v){' +
    'map.set(k,v);fs.writeFileSync(file,JSON.stringify([...map]));if(k==="healed_songs")process.exit(73);},' +
    'removeItem:k=>map.delete(k)};void restore.restore({storage,writes:[{key:"healed_songs",value:"[]"},' +
    '{key:"zily.navigationCollapsed",value:"true"}],operation:null});', implementation, simulatedStorage
  ], { encoding: 'utf8' });
  assert.equal(child.status, 73, child.stderr);
  const storage = makeStorage(JSON.parse(await fs.readFile(simulatedStorage, 'utf8')));
  const interrupted = storage.getItem('healed_songs');
  assert.deepEqual(JSON.parse(interrupted), []);
  assert.notEqual(interrupted, '[]');
  assert.deepEqual(await browser.reconcile(storage, settleNo), { committed: false });
  assert.deepEqual([...storage.data], [['existing', 'keep']]);
});

test('a lost response after a durable memory commit preserves the browser side on restart', async t => {
  const { activate, request } = await fixture(t);
  const cookie = await activate();
  const { target, expected } = (await request('backup/state', { cookie })).body;
  const op = { id: randomUUID(), target, expected };
  const storage = makeStorage();
  const writes = plan(storage, local()).writes;
  const content = memory();
  await assert.rejects(browser.restore({ storage, writes, operation: op, memory: content,
    send: async body => {
      assert.equal((await request('backup/restore', { cookie, body })).body.committed, true);
      throw new Error('mock lost reply');
    }, settle: async () => { throw new Error('mock server offline'); } }), /尚未确认/);
  const restarted = makeStorage([...storage.data]);
  const result = await browser.reconcile(restarted, async body => (await request('backup/settle', { cookie, body })).body);
  assert.deepEqual(result, { committed: true });
  assert.equal(restarted.getItem(browser.journalKey), null);
  const stagedFavorites = storage.getItem('healed_songs');
  const restoredFavorites = restarted.getItem('healed_songs');
  assert.deepEqual(JSON.parse(restoredFavorites), JSON.parse(stagedFavorites));
  assert.equal(restoredFavorites, writes.find(write => write.key === 'healed_songs').value);
  assert.notEqual(stagedFavorites, restoredFavorites);
  assert.deepEqual((await request('backup/export', { cookie })).body, content);
});

test('existing browser values and memory changed after preview are not overwritten', async t => {
  const { activate, request, store, identity } = await fixture(t);
  const storage = makeStorage([['healed_songs', JSON.stringify([{ id: 2, name: 'Existing', artist: 'Artist' }])]]);
  assert.deepEqual(plan(storage, local()).conflicts, ['收藏']);
  assert.match(storage.getItem('healed_songs'), /Existing/);
  const cookie = await activate();
  const { target, expected } = (await request('backup/state', { cookie })).body;
  const existing = item('本来就在的资料');
  await store.update(identity(cookie), () => [existing]);
  const result = await request('backup/restore', { cookie, body: { id: randomUUID(), target, expected, confirm: true, memory: memory() } });
  assert.equal(result.status, 409);
  assert.deepEqual((await store.read(identity(cookie))).memories, [existing]);
});

test('a restore without explicit confirmation cannot change a profile', async t => {
  const { activate, request, store, identity } = await fixture(t);
  const cookie = await activate();
  const state = (await request('backup/state', { cookie })).body;
  const original = await store.read(identity(cookie));
  const body = { id: randomUUID(), target: state.target, expected: state.expected, confirm: false, memory: memory() };
  assert.equal((await request('backup/restore', { cookie, body })).status, 400);
  assert.equal((await request('backup/restore', { cookie, body: { ...body, confirm: true },
    confirmOrigin: 'http://localhost:8080' })).status, 403);
  assert.deepEqual(await store.read(identity(cookie)), original);
});

test('rotation prunes only old valid snapshots and retains a damaged file for inspection', async t => {
  const { root } = await fixture(t);
  let now = Date.parse(stamp);
  const rotation = createBackupRotation({ directory: root, intervalMs: 1000, retention: 2, clock: () => now });
  const bucket = 'memory-' + 'a'.repeat(64);
  const fixed = memory();
  await rotation.save(bucket, format.createBody('memory', null, fixed, stamp));
  assert.equal((await rotation.save(bucket, format.createBody('memory', null, memory('too soon'), stamp))).saved, false);
  now += 2000;
  assert.equal((await rotation.save(bucket, format.createBody('memory', null, fixed, stamp))).saved, false);
  for (const value of ['next', 'latest']) {
    now += 2000;
    assert.equal((await rotation.save(bucket, format.createBody('memory', null, memory(value), stamp))).saved, true);
  }
  const dir = path.join(root, bucket);
  assert.equal((await fs.readdir(dir)).length, 2);
  const broken = path.join(dir, String(now + 500) + '-' + randomUUID() + '.json');
  await fs.writeFile(broken, '{broken');
  assert.deepEqual(await rotation.check(), { valid: 2, damaged: 1 });
  assert.equal(await fs.readFile(broken, 'utf8'), '{broken');
});

test('automatic backup rename failure preserves the last valid snapshot', async t => {
  const { root } = await fixture(t);
  let now = Date.parse(stamp);
  let fail = false;
  const disk = { ...fs, async rename(from, to) { if (fail) throw new Error('mock rename failure'); return fs.rename(from, to); } };
  const rotation = createBackupRotation({ directory: root, intervalMs: 1000, retention: 1, clock: () => now, disk });
  const bucket = 'memory-' + 'b'.repeat(64);
  const first = format.createBody('memory', null, memory(), stamp);
  await rotation.save(bucket, first);
  now += 2000;
  fail = true;
  await assert.rejects(rotation.save(bucket, format.createBody('memory', null, memory('replacement'), stamp)), /mock rename failure/);
  const dir = path.join(root, bucket);
  const files = await fs.readdir(dir);
  assert.equal(files.length, 1);
  assert.deepEqual(verify(JSON.parse(await fs.readFile(path.join(dir, files[0]), 'utf8'))), first);
});

test('backup excludes app credentials, recovery proof, activity metadata and detects credential patterns', async t => {
  const { activate, request, identity, store } = await fixture(t);
  const cookie = await activate();
  const id = identity(cookie);
  const password = 'separate recovery phrase test';
  await request('backup/recovery-setup', { cookie, body: { password, confirm: true } });
  await store.mutate(id, () => ({ memories: [item()], discovery: { candidates: [], processed: ['runtime'], rejected: [], lastExtractedAt: 0 } }));
  const storage = makeStorage([['netease_cookie', 'mock-cookie'], ['runtimeQueue', 'mock-queue']]);
  const body = format.createBody('all', browser.collect(storage, { enabled: false }, []),
    (await request('backup/export', { cookie })).body, stamp);
  const json = JSON.stringify(pack(body));
  for (const excluded of ['mock-cookie', 'mock-queue', 'runtime', password, id, cookie.split('=')[1], 'recovery', 'identity']) {
    assert.equal(json.includes(excluded), false);
  }
  assert.throws(() => format.createBody('memory', null, memory('DEEPSEEK_API_KEY=mock_secret_value_123'), stamp), /疑似凭证/);
});

test('automatic browser backup is scoped to the authenticated profile and uses server memory', async t => {
  const setup = await fixture(t);
  const directory = path.join(setup.root, 'backups');
  setup.setRotation(createBackupRotation({ directory, intervalMs: 1000 }));
  const cookie = await setup.activate();
  const entry = item('本机正式记录');
  await setup.store.update(setup.identity(cookie), () => [entry]);
  const body = { file: pack(format.createBody('all', local(), memory('客户端文件里的替代内容'), stamp)) };
  assert.equal((await setup.request('backup/auto', { body })).status, 401);
  assert.equal((await setup.request('backup/auto', { cookie, body })).body.saved, true);
  const dir = path.join(directory, 'browser-' + setup.identity(cookie));
  const [file] = await fs.readdir(dir);
  assert.deepEqual(verify(JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'))).modules.memory.memories, [entry]);
});

test('startup checks backup integrity and captures a current memory profile', async t => {
  const { root, activate, store } = await fixture(t);
  await activate();
  const reports = [];
  let resolveSaved;
  const saved = new Promise(resolve => { resolveSaved = resolve; });
  const actual = createBackupRotation({ directory: path.join(root, 'backups'), intervalMs: 1000 });
  const stop = startMemoryBackups(store, { check: actual.check, async save(...args) {
    const result = await actual.save(...args); resolveSaved(result);
  } }, 1000, result => reports.push(result));
  t.after(stop);
  assert.equal((await saved).saved, true);
  assert.deepEqual(reports, [{ valid: 0, damaged: 0 }]);
  assert.deepEqual(await actual.check(), { valid: 1, damaged: 0 });
});

test('recovering a different identity protects the currently connected nonempty library', async t => {
  const { activate, request, identity, store } = await fixture(t);
  const original = await activate();
  const current = await activate();
  const recoveryId = identity(original);
  const password = 'test passphrase for separate library';
  assert.equal((await request('backup/recovery-setup', { cookie: original, body: { password, confirm: true } })).status, 200);
  const owned = item('当前设备原有的记忆');
  await store.update(identity(current), () => [owned]);
  const response = await request('backup/recover', { cookie: current, body: { recoveryId, password, confirm: true } });
  assert.equal(response.status, 409);
  assert.equal(response.headers['Set-Cookie'], undefined);
  assert.deepEqual((await store.read(identity(current))).memories, [owned]);
  assert.equal((await store.read(recoveryId)).identity, undefined);
});


const freshOperation = () => ({ id: randomUUID(),
  proof: createHash('sha256').update(randomUUID() + randomUUID()).digest('hex'), issuedAt: Date.now() });

test('fresh restore browser write failure never submits or creates a formal memory identity', async t => {
  const { request, store } = await fixture(t);
  const storage = makeStorage([['outside', 'keep']], key => {
    if (key === 'zily.playlists.v1') throw new DOMException('synthetic quota', 'QuotaExceededError');
  });
  let sent = 0;
  assert.equal((await request('backup/state')).status, 401);
  await assert.rejects(browser.restore({ storage, writes: plan(storage, local()).writes,
    operation: freshOperation(), memory: memory(), send: async body => {
      sent++;
      return (await request('backup/restore', { body })).body;
    }, settle: settleNo }), /synthetic quota/);
  assert.equal(sent, 0);
  assert.equal((await request('status')).body.enabled, false);
  assert.deepEqual(await store.listProfiles(), []);
  assert.deepEqual([...storage.data], [['outside', 'keep']]);
});

test('fresh restore enables a cookie only after the full memory profile and receipt are committed', async t => {
  const { request, store, cookieFor, identity } = await fixture(t);
  const op = freshOperation();
  const contents = memory();
  const response = await request('backup/restore', { body: { ...op, confirm: true, memory: contents } });
  assert.deepEqual(response.body, { committed: true });
  const cookie = cookieFor(response);
  assert.equal((await request('status', { cookie })).body.enabled, true);
  assert.deepEqual((await request('backup/export', { cookie })).body, contents);
  assert.deepEqual(await store.listProfiles(), [identity(cookie)]);
  assert.deepEqual((await store.read(identity(cookie))).backupReceipts, [{ id: op.id, committed: true }]);
});

test('a fresh restore cannot replace an already active identity', async t => {
  const { activate, request, identity, store } = await fixture(t);
  const cookie = await activate();
  const target = identity(cookie);
  await store.update(target, () => [item('original')]);
  const before = await store.read(target);
  const op = freshOperation();
  const result = await request('backup/restore', { cookie, body: { ...op, confirm: true, memory: memory() } });
  assert.equal(result.status, 409);
  assert.equal(result.headers['Set-Cookie'], undefined);
  assert.deepEqual((await request('backup/settle', { cookie, body: op })).body, { committed: false });
  assert.deepEqual(await store.read(target), before);
  assert.deepEqual(await store.listProfiles(), [target]);
});

test('lost fresh restore response reissues the same identity, without repeating the commit', async t => {
  const { request, store, cookieFor, identity } = await fixture(t);
  const op = freshOperation();
  const contents = memory();
  const first = await request('backup/restore', { body: { ...op, confirm: true, memory: contents } });
  assert.equal(first.status, 200);
  const original = cookieFor(first);
  const before = await store.read(identity(original));
  const settled = await request('backup/settle', { body: op });
  assert.equal(settled.status, 200);
  assert.equal(cookieFor(settled), original);
  const replay = await request('backup/restore', { body: { ...op, confirm: true, memory: memory('changed replay') } });
  assert.equal(replay.status, 200);
  assert.equal(cookieFor(replay), original);
  assert.deepEqual(await store.listProfiles(), [identity(original)]);
  assert.deepEqual(await store.read(identity(original)), before);
});

test('a cancellation receipt fences a late fresh restore across memory store restarts', async t => {
  const { request, store, root } = await fixture(t);
  const op = freshOperation();
  const storage = makeStorage();
  const writes = plan(storage, local()).writes;
  await assert.rejects(browser.restore({ storage, writes, operation: op, memory: memory(),
    send: async () => { throw new Error('simulated worker exit before write'); },
    settle: async () => { throw new Error('worker offline'); } }), /尚未确认/);
  const restartedStorage = makeStorage([...storage.data]);
  assert.deepEqual(await browser.reconcile(restartedStorage, async body => (await request('backup/settle', { body })).body), { committed: false });
  assert.equal(restartedStorage.data.size, 0);
  const replacementStore = createMemoryStore(path.join(root, 'memory'));
  const handler = createMemoryHandler({ store: replacementStore,
    sendJson: (res, status, body) => ({ status, body }), readJsonBody: async req => req.body });
  const result = await handler({
    method: 'POST', body: { ...op, confirm: true, memory: memory() },
    socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1', localPort: 8080 },
    headers: { host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080', 'content-type': 'application/json' },
  }, { setHeader() {} }, new URL('http://127.0.0.1:8080/api/memory/backup/restore'));
  assert.equal(result.status, 409);
  assert.deepEqual(await store.listProfiles(), []);
});

test('stale new-identity operation cannot create a new profile', async t => {
  const { request, store } = await fixture(t);
  const op = { ...freshOperation(), issuedAt: Date.now() - 2 * 24 * 60 * 60_000 };
  const response = await request('backup/restore', { body: { ...op, confirm: true, memory: memory() } });
  assert.equal(response.status, 409);
  assert.deepEqual(await store.listProfiles(), []);
  assert.deepEqual((await request('backup/settle', { body: op })).body, { committed: false });
});

test('fresh proof cannot restore revoked browser credentials after password recovery', async t => {
  const { request, cookieFor, identity } = await fixture(t);
  const op = freshOperation();
  const committed = await request('backup/restore', { body: { ...op, confirm: true, memory: memory() } });
  const original = cookieFor(committed);
  const password = 'synthetic restored identity password';
  assert.equal((await request('backup/recovery-setup', { cookie: original, body: { password, confirm: true } })).status, 200);
  assert.equal((await request('backup/recover', { body: { recoveryId: identity(original), password, confirm: true } })).status, 200);
  const replay = await request('backup/settle', { body: op });
  assert.equal(replay.status, 409);
  assert.equal(replay.headers['Set-Cookie'], undefined);
  assert.equal((await request('status', { cookie: original })).body.enabled, false);
});

const oldMtime = new Date(Date.now() - 2 * 24 * 60 * 60_000);
const testHostTag = createHash('sha256').update(os.hostname().toLowerCase()).digest('hex').slice(0, 16);
function tempName(target, pid, host = testHostTag) {
  return target + '.zily-' + host + '-' + pid + '.' + randomUUID() + '.tmp';
}
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', '']);
  assert.equal(child.status, 0);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  return child.pid;
}

async function writeOldTemp(file) {
  await fs.writeFile(file, 'synthetic unfinished write');
  await fs.utimes(file, oldMtime, oldMtime);
}

test('startup cleanup removes expired dead-writer temps from memory and backup scopes', async t => {
  const { root, store } = await fixture(t);
  await fs.mkdir(store.directory);
  const backupDirectory = path.join(root, 'backups');
  const bucket = path.join(backupDirectory, 'memory-' + 'a'.repeat(64));
  await fs.mkdir(bucket, { recursive: true });
  const pid = deadPid();
  const candidates = [path.join(store.directory, tempName('a'.repeat(64) + '.json', pid)),
    path.join(bucket, tempName('1767225600000-' + randomUUID() + '.json', pid))];
  for (const candidate of candidates) await writeOldTemp(candidate);
  assert.deepEqual(await cleanupAtomicTemps({ memoryDirectory: store.directory, backupDirectory }), { removed: 2, retained: 0, failed: 0 });
  for (const candidate of candidates) await assert.rejects(fs.stat(candidate), { code: 'ENOENT' });
});

test('cleanup keeps new temps, unowned module files and old files without trustworthy ownership', async t => {
  const { store } = await fixture(t);
  await fs.mkdir(store.directory);
  const pid = deadPid();
  const target = 'b'.repeat(64) + '.json';
  const young = path.join(store.directory, tempName(target, pid));
  await fs.writeFile(young, 'recent synthetic');
  const foreignHost = testHostTag === 'f'.repeat(16) ? 'a'.repeat(16) : 'f'.repeat(16);
  const files = [path.join(store.directory, 'user-created.tmp'),
    path.join(store.directory, tempName('other-module.json', pid)),
    path.join(store.directory, target + '.' + randomUUID() + '.tmp'),
    path.join(store.directory, tempName(target, pid, foreignHost))];
  for (const file of files) await writeOldTemp(file);
  assert.deepEqual(await cleanupAtomicTemps({ memoryDirectory: store.directory }), { removed: 0, retained: 2, failed: 0 });
  for (const file of [young, ...files]) assert.ok(await fs.stat(file));
});

test('cleanup skips an active atomic write even if its temporary file is old', async t => {
  const { store } = await fixture(t);
  const target = path.join(store.directory, 'c'.repeat(64) + '.json');
  let resume, paused;
  const gate = new Promise(resolve => { resume = resolve; });
  const waiting = new Promise(resolve => { paused = resolve; });
  const disk = { ...fs, async rename(from, to) { paused(from); await gate; return fs.rename(from, to); } };
  const pending = atomicWrite(target, '{"test":true}', disk);
  try {
    const temp = await waiting;
    await fs.utimes(temp, oldMtime, oldMtime);
    assert.deepEqual(await cleanupAtomicTemps({ memoryDirectory: store.directory }), { removed: 0, retained: 1, failed: 0 });
    assert.ok(await fs.stat(temp));
  } finally { resume(); await pending; }
  assert.equal(await fs.readFile(target, 'utf8'), '{"test":true}');
});

test('startup reports cleanup failure without blocking server or altering backups', async t => {
  const { root, store } = await fixture(t);
  await fs.mkdir(store.directory);
  const filename = path.join(store.directory, tempName('d'.repeat(64) + '.json', deadPid()));
  await writeOldTemp(filename);
  const backupDirectory = path.join(root, 'backups');
  const rotation = createBackupRotation({ directory: backupDirectory });
  const bucket = 'memory-' + 'd'.repeat(64);
  const body = format.createBody('memory', null, memory(), stamp);
  await rotation.save(bucket, body);
  const [snapshot] = await fs.readdir(path.join(backupDirectory, bucket));
  const disk = { ...fs, async unlink(file) {
    if (file === filename) throw Object.assign(new Error('synthetic access denied'), { code: 'EACCES' });
    return fs.unlink(file);
  } };
  const { createServer } = require('../server/server');
  const app = createServer({ memoryStore: store, backupOptions: { directory: backupDirectory, intervalMs: 60_000, disk } });
  const listening = new Promise((resolve, reject) => app.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  let notified;
  const warned = new Promise(resolve => { notified = resolve; });
  const originalWarn = console.warn;
  console.warn = message => { if (message.includes('临时文件检查')) notified(); else originalWarn(message); };
  try {
    await listening;
    await warned;
    assert.ok(await fs.stat(filename));
    assert.deepEqual(await rotation.check(), { valid: 1, damaged: 0 });
    assert.deepEqual(verify(JSON.parse(await fs.readFile(path.join(backupDirectory, bucket, snapshot), 'utf8'))), body);
  } finally { console.warn = originalWarn; }
});

test('a routed write with a stalled body cannot commit after identity rotation', async t => {
  const app = await fixture(t);
  const cookie = await app.activate();
  const recoveryId = app.identity(cookie);
  const password = 'synthetic rotation check';
  assert.equal((await app.request('backup/recovery-setup', { cookie, body: { password, confirm: true } })).status, 200);
  let entered;
  let release;
  const reachedBody = new Promise(resolve => { entered = resolve; });
  const stalledBody = new Promise(resolve => { release = resolve; });
  const pending = app.request('items', { cookie, body() { entered(); return stalledBody; } });
  await reachedBody;
  const rotated = await app.request('backup/recover', { body: { recoveryId, password, confirm: true } });
  assert.equal(rotated.status, 200);
  release({ category: 'music', kind: 'user_preference', content: 'stalled synthetic request' });
  assert.equal((await pending).status, 401);
  assert.equal((await app.request('items', { cookie })).status, 401);
  assert.deepEqual((await app.request('items', { cookie: app.cookieFor(rotated) })).body.items, []);
  assert.equal((await createMemoryStore(path.join(app.root, 'memory')).read(recoveryId)).identityEpoch, 1);
});

test('single deletion prevents restoring a legacy row and preserves target suppression', async t => {
  const app = await fixture(t);
  const cookie = await app.activate();
  const profileId = app.identity(cookie);
  const removed = item('permanently deleted synthetic memory');
  const kept = item('unrelated source record');
  const targetOnly = randomUUID();
  const sourceOnly = randomUUID();
  const digest = 'a'.repeat(64);
  const later = new Date(Date.now() + 600000).toISOString();
  const sooner = new Date(Date.now() + 300000).toISOString();
  await app.store.mutate(profileId, () => ({ memories: [removed],
    discovery: { candidates: [], processed: [targetOnly], skipped: [], rejected: [{ digest, suppressUntil: later }], lastExtractedAt: 0 } }));
  assert.equal((await app.request('items/' + removed.id, { method: 'DELETE', cookie, body: { revision: 1 } })).status, 200);
  const { target, expected } = (await app.request('backup/state', { cookie })).body;
  const body = { id: randomUUID(), target, expected, confirm: true, memory: memory('', { memories: [removed, kept], candidates: [],
    suppression: { processed: [targetOnly, sourceOnly], skipped: [targetOnly],
      rejected: [{ digest, suppressUntil: sooner }, { digest: 'b'.repeat(64), suppressUntil: stamp }] } }) };
  for (let i = 0; i < 2; i++) assert.deepEqual((await app.request('backup/restore', { cookie, body })).body, { committed: true });
  const latest = await createMemoryStore(path.join(app.root, 'memory')).read(profileId);
  assert.deepEqual(latest.memories, [kept]);
  assert.deepEqual(latest.discovery.processed, [targetOnly, sourceOnly]);
  assert.deepEqual(latest.discovery.skipped, []);
  assert.deepEqual(latest.discovery.rejected, [{ digest, suppressUntil: later }]);
  assert.deepEqual((await app.request('backup/export', { cookie })).body.suppression.rejected, [{ digest, suppressUntil: later }]);
});

test('clear sanitizes both application backup buckets and blocks old imports', async t => {
  const app = await fixture(t);
  const cookie = await app.activate();
  const profileId = app.identity(cookie);
  const old = memory('temporary confidential fixture');
  const directory = path.join(app.root, 'backup');
  const rotation = createBackupRotation({ directory, intervalMs: 1 });
  app.setRotation(rotation);
  await app.store.mutate(profileId, () => ({ memories: old.memories,
    discovery: { candidates: old.candidates, processed: [], skipped: [], rejected: [], lastExtractedAt: 0 } }));
  await rotation.save('memory-' + profileId, format.createBody('memory', null, old));
  const browserModules = local();
  await rotation.save('browser-' + profileId, format.createBody('all', browserModules, old));
  assert.equal((await app.request('items', { cookie, method: 'DELETE', body: { confirm: true } })).status, 200);
  for (const kind of ['memory', 'browser']) {
    const bucket = path.join(directory, kind + '-' + profileId);
    const [file] = await fs.readdir(bucket);
    const raw = await fs.readFile(path.join(bucket, file), 'utf8');
    const snapshot = verify(JSON.parse(raw));
    assert.doesNotMatch(raw, /temporary confidential fixture|我一直喜欢爵士乐/u);
    assert.deepEqual(snapshot.modules.memory.memories, []);
    assert.deepEqual(snapshot.modules.memory.candidates, []);
    if (kind === 'browser') assert.deepEqual(snapshot.modules.browser, browserModules);
  }
  const { target, expected } = (await app.request('backup/state', { cookie })).body;
  const result = await app.request('backup/restore', { cookie, body: { id: randomUUID(), target, expected, confirm: true, memory: old } });
  assert.equal(result.status, 200);
  assert.deepEqual((await app.store.read(profileId)).memories, []);
  assert.deepEqual((await app.store.read(profileId)).discovery.candidates, []);
});

test('failed backup redaction preserves the live record and returns an explicit failure', async t => {
  const app = await fixture(t);
  const cookie = await app.activate();
  const profileId = app.identity(cookie);
  const old = memory('write failure fixture');
  let fail = false;
  const disk = { ...fs, rename(from, to) { return fail ? Promise.reject(new Error('synthetic rename failure')) : fs.rename(from, to); } };
  const rotation = createBackupRotation({ directory: path.join(app.root, 'backup'), disk });
  app.setRotation(rotation);
  await app.store.update(profileId, () => old.memories);
  await rotation.save('memory-' + profileId, format.createBody('memory', null, old));
  fail = true;
  const result = await app.request('items/' + old.memories[0].id, { method: 'DELETE', cookie, body: { revision: 1 } });
  assert.equal(result.status, 503);
  assert.deepEqual((await app.store.read(profileId)).memories, old.memories);
});

test('write-lock wait cannot carry a pre-rotation authorization into the new generation', async t => {
  const app = await fixture(t);
  const cookie = await app.activate();
  const profile = app.identity(cookie);
  const store = app.store.forIdentity(latest => !latest || (latest.identityEpoch || 0) === 0);
  let entered;
  let release;
  const locked = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const rotation = app.store.mutate(profile, async () => {
    entered();
    await gate;
    return { identityEpoch: 1 };
  });
  await locked;
  const queued = store.update(profile, () => [item()]);
  const rejected = assert.rejects(queued, { code: 'not-found' });
  release();
  await Promise.all([rotation, rejected]);
  assert.deepEqual((await app.store.read(profile)).memories, []);
});

test('an unresolved profile temp file prevents reporting permanent deletion', async t => {
  const app = await fixture(t);
  const cookie = await app.activate();
  const profile = app.identity(cookie);
  const saved = item();
  await app.store.update(profile, () => [saved]);
  const file = path.join(app.root, 'memory', profile + '.json.' + randomUUID() + '.tmp');
  await fs.writeFile(file, 'synthetic orphan');
  const response = await app.request('items/' + saved.id, { cookie, method: 'DELETE', body: { revision: 1 } });
  assert.equal(response.status, 503);
  assert.deepEqual((await app.store.read(profile)).memories, [saved]);
  assert.equal(await fs.readFile(file, 'utf8'), 'synthetic orphan');
});
