'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createMemoryStore } = require('../server/memory-store');
const { manageItems } = require('../server/memory-items');
const { createDiscoveryHandler } = require('../server/memory-discovery');
const { createExtractor, validateCandidates } = require('../server/memory-extraction');
const { retrieveMemories } = require('../server/memory-retrieval');

const preference = '我平时喜欢钢琴独奏。';
const modelEntry = (message, fields) => ({
  category: 'music', kind: 'user_preference', content: message.content,
  evidenceQuote: message.content, sourceMessageIds: [message.id], reason: '长期偏好', ...fields,
});
const message = (content, role = 'user') => ({ id: randomUUID(), role, content });
function batch(content = preference) {
  return { sessionId: randomUUID(), epoch: 1, messages: [
    message(content), message('了解了。', 'assistant'),
    ...Array.from({ length: 3 }, () => [message('继续聊。'), message('好的。', 'assistant')]).flat(),
  ] };
}

async function fixture(t, generate = async input => ({ candidates: [modelEntry(input[0])] })) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zily-discovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createMemoryStore(directory);
  const profile = 'a'.repeat(64);
  await store.initialize(profile);
  let now = Date.now();
  const calls = [];
  const handler = createDiscoveryHandler(generate && (async (input, signal) => {
    calls.push(input);
    return generate(input, signal);
  }), () => now);
  const request = async (route, method, body, res = new EventEmitter(), id = profile) =>
    handler(route, method, body, store, id, await store.read(id), res);
  const toggle = enabled => request('discovery', 'PATCH', { autoExtractEnabled: enabled });
  return {
    calls, store, profile, request, toggle, directory, pendingEvidence: () => handler.pendingEvidence(profile), advance: () => { now += 300001; },
    extract: (body, res) => request('extract', 'POST', body, res),
    candidates: async () => (await request('candidates', 'GET')).body.items,
    read: () => store.read(profile),
  };
}

test('auto discovery defaults off, persists independently, and preserves the v1 document', async t => {
  const app = await fixture(t);
  await app.store.update(app.profile, () => [{ content: 'Existing manual entry' }]);
  assert.equal((await app.request('discovery', 'GET')).body.autoExtractEnabled, false);
  assert.equal((await app.extract(batch())).status, 409);
  assert.equal(app.calls.length, 0);
  await app.store.updateSettings(app.profile, true);
  await app.toggle(true);
  const reopened = await createMemoryStore(app.directory).read(app.profile);
  assert.equal(reopened.schemaVersion, 1);
  assert.equal(reopened.autoExtractEnabled, true);
  assert.equal(reopened.useInChat, true);
  assert.deepEqual(reopened.memories, [{ content: 'Existing manual entry' }]);
  await app.toggle(false);
  assert.equal((await app.read()).useInChat, true);
  assert.equal((await app.extract(batch())).status, 409);
});

test('server enforces four successful-turn slots, role layout, UUIDs and exact request fields', async t => {
  const app = await fixture(t);
  await app.toggle(true);
  const input = batch();
  await assert.rejects(app.extract({ ...input, messages: input.messages.slice(0, 6) }), { status: 400 });
  await assert.rejects(app.extract({ ...input, profileId: 'fake' }), { status: 400 });
  await assert.rejects(app.extract({ ...input, messages: [input.messages[1], ...input.messages.slice(1)] }), { status: 400 });
  assert.equal(app.calls.length, 0);
  assert.equal((await app.extract(input)).body.added, 1);
  assert.deepEqual(app.calls[0].map(entry => entry.role), ['user']);
  const replay = (await app.extract(input)).body;
  assert.deepEqual(replay.processed, [input.messages[0].id]);
  assert.deepEqual(replay.skipped, input.messages.filter(m => m.role === 'user').slice(1).map(m => m.id));
  assert.equal(app.calls.length, 1);
  assert.equal((await app.extract(batch())).status, 429);
});

test('failed or malformed model output keeps the cursor unchanged and permits later retry', async t => {
  let attempts = 0;
  const app = await fixture(t, async input => {
    if (++attempts === 1) throw new Error('mock error');
    if (attempts === 2) return { candidates: 'wrong shape' };
    return { candidates: [modelEntry(input[0])] };
  });
  await app.toggle(true);
  const input = batch();
  for (let i = 0; i < 2; i++) {
    assert.equal((await app.extract(input)).status, 502);
    assert.equal((await app.read()).discovery, undefined);
    app.advance();
  }
  assert.equal((await app.extract(input)).body.added, 1);
});

test('evidence must match a full original user sentence, known ID, valid category and supported kind', () => {
  const user = message(preference);
  const assistant = message('我喜欢爵士钢琴。', 'assistant');
  const input = [user, assistant];
  const validate = entries => validateCandidates({ candidates: entries }, input, randomUUID(), new Date().toISOString());
  for (const invalid of [
    modelEntry(assistant), modelEntry(user, { sourceMessageIds: [randomUUID()] }),
    modelEntry(user, { evidenceQuote: '钢琴独奏' }), modelEntry(user, { content: '用户喜欢爵士钢琴' }),
    modelEntry(user, { category: 'unknown' }), modelEntry(user, { kind: 'user_fact' }),
  ]) assert.deepEqual(validate([invalid]), []);
  assert.equal(validate([modelEntry(user)]).length, 1);
});

for (const [quote, expected] of [
  ['我喜欢晚上听安静的歌', true],
  ['最近晚上比较喜欢一些安静的歌', true],
  ['最近晚上比较喜欢听一些安静的歌，感觉比白天更容易静下心来。', true],
  ['平时我更喜欢钢琴独奏', true],
  ['这段时间一直喜欢晚上听安静的歌', true],
  ['我今天有点累，想听歌放松', false],
  ['今天突然想听一首摇滚', false],
  ['最近晚上突然想听一首摇滚', false],
]) {
  test('timed music preference evidence ' + (expected ? 'accepts ' : 'rejects ') + quote, () => {
    const user = message(quote);
    const candidates = validateCandidates({ candidates: [modelEntry(user)] }, [user], randomUUID(), new Date().toISOString());
    assert.equal(candidates.length, Number(expected));
    if (expected) assert.equal(candidates[0].evidence[0].quote, quote);
  });
}

test('only explicit concrete confirmation qualifies, not refusal, speculation or bare acceptance', () => {
  for (const [text, expected] of [
    ['我确认采用蓝色设计方案。', 1], ['我不会采用蓝色设计方案。', 0],
    ['我确认采用蓝色设计方案吗？', 0], ['我确认采用蓝色设计方案但是我不愿接受。', 0],
    ['好吧。', 0], ['我可能会采用蓝色设计方案。', 0], ['你说我确认采用蓝色设计方案。', 0],
  ]) {
    const user = message(text);
    const entry = modelEntry(user, { kind: 'confirmed_decision', category: 'decision' });
    assert.equal(validateCandidates({ candidates: [entry] }, [user], randomUUID(), new Date().toISOString()).length, expected, text);
  }
});

test('sensitive content and unsupported casual turns never reach the model', async t => {
  const app = await fixture(t);
  await app.toggle(true);
  for (const text of [
    '我喜欢用密码测试。', '我喜欢用 myaddress@example.com 注册。',
    '我长期负责收集病历。', '你好。', '我喜欢使用 abcdef1234567890abcdef1234567890。',
  ]) assert.equal((await app.extract(batch(text))).body.added, 0);
  assert.equal(app.calls.length, 0);
});

test('the original eight acceptance messages reach the production extractor and yield three pending memories', async t => {
  const input = { sessionId: randomUUID(), epoch: 1, messages: [
    message('我一直比较喜欢自然、不做作的交流方式，不喜欢那种特别官方、像客服一样的对话。'),
    message('我明白，交流自然一些会更舒服，不需要刻意使用官方表达。', 'assistant'),
    message('我不太喜欢别人一味附和我。我更希望对方有自己的判断，即使不同意我，也可以直接说出理由。'),
    message('我觉得有独立判断确实很重要，交流不应该只是互相赞同。', 'assistant'),
    message('不过我今天有点累，暂时不太想思考复杂的问题。'),
    message('那今天就轻松一点，不用勉强自己。', 'assistant'),
    message('子夜电台这个项目我打算长期做下去，希望把子超真正做成一个拥有独立人格、自然交流能力和长期记忆的AI音乐伙伴。'),
    message('这个方向值得慢慢打磨，尤其是人格和记忆之间的配合。', 'assistant'),
  ] };
  const [natural, independent, temporary, goal] = input.messages.filter(entry => entry.role === 'user');
  const entries = [modelEntry(natural, { category: 'preference' }), modelEntry(independent, { category: 'preference' }),
    modelEntry(goal, { category: 'goal', kind: 'user_fact' })];
  const app = await fixture(t, async received => {
    assert.deepEqual(received, [natural, independent, temporary, goal]);
    return { candidates: entries };
  });
  await app.toggle(true);
  const result = await app.extract(input);
  assert.equal(result.status, 200);
  assert.equal(result.body.added, 3);
  assert.equal(app.calls.length, 1);
  const pending = await app.candidates();
  assert.deepEqual(pending.map(entry => [entry.category, entry.kind]), [
    ['preference', 'user_preference'], ['preference', 'user_preference'], ['goal', 'user_fact'],
  ]);
  assert.deepEqual(pending.map(entry => entry.evidence[0]), [natural, independent, goal].map(user => ({
    sessionId: input.sessionId, messageId: user.id, role: 'user', quote: user.content,
  })));
  assert.ok(pending.every(entry => entry.status === 'pending'));
  assert.deepEqual((await app.read()).memories, []);

  const assistant = input.messages[3];
  const invalid = { candidates: [
    modelEntry(temporary), modelEntry(assistant),
    modelEntry(independent, { content: '我不太喜欢别人一味附和我', evidenceQuote: '我不太喜欢别人一味附和我' }),
  ] };
  assert.deepEqual(validateCandidates(invalid, input.messages, input.sessionId, new Date().toISOString()), []);
  assert.deepEqual(validateCandidates({ candidates: [
    modelEntry(goal, { category: 'goal', kind: 'confirmed_decision' }),
  ] }, input.messages, input.sessionId, new Date().toISOString()), []);

  assert.equal((await app.extract(input)).body.added, 0);
  assert.equal(app.calls.length, 1);
  assert.equal((await app.candidates()).length, 3);
});

test('a refusal of a specific suggestion is not a stable dislike', () => {
  const specific = message('我不喜欢你刚才推荐的这首歌。');
  const stable = message('我不太喜欢别人一味附和我。');
  const now = new Date().toISOString();
  const valid = validateCandidates({ candidates: [modelEntry(specific), modelEntry(stable)] },
    [specific, stable], randomUUID(), now);
  assert.deepEqual(valid.map(entry => entry.content), [stable.content]);
});

test('a fully filtered batch only records explicit skips, with no extraction cooldown', async t => {
  const app = await fixture(t);
  await app.toggle(true);
  const input = batch('我喜欢用虚构 API Key 和 Cookie 测试。');
  const userIds = input.messages.filter(entry => entry.role === 'user').map(entry => entry.id);
  const result = await app.extract(input);
  assert.deepEqual(result.body, { processed: [], skipped: userIds, added: 0 });
  assert.deepEqual((await app.read()).discovery.processed, []);
  assert.deepEqual((await app.read()).discovery.skipped, userIds);
  assert.equal((await app.read()).discovery.lastExtractedAt, 0);
  assert.equal(app.calls.length, 0);
  assert.deepEqual((await app.extract(input)).body.skipped, userIds);
  assert.equal((await app.extract(batch())).body.added, 1);
});

test('without an extractor, a potentially valuable batch stays unprocessed', async t => {
  const app = await fixture(t, null);
  await app.toggle(true);
  const input = batch('以后想把手工模型做得更细致。');
  assert.equal((await app.extract(input)).status, 503);
  assert.equal((await app.read()).discovery, undefined);
  assert.equal((await app.extract(input)).status, 503);
});

test('a valid empty response advances submitted user IDs only and keeps legacy progress', async t => {
  const app = await fixture(t, async () => ({ candidates: [] }));
  await app.toggle(true);
  const legacyId = randomUUID();
  await app.store.mutate(app.profile, () => ({
    discovery: { candidates: [], processed: [legacyId], rejected: [], lastExtractedAt: 0 },
  }));
  const input = batch('我以后想持续学习木工。');
  assert.equal((await app.extract(input)).body.added, 0);
  const state = (await app.read()).discovery;
  assert.deepEqual(state.processed, [legacyId, input.messages[0].id]);
  assert.equal(state.skipped.length, 3);
  assert.ok(state.lastExtractedAt > 0);
  assert.equal((await app.extract(input)).body.added, 0);
  assert.equal(app.calls.length, 1);
});

test('pending entries are separate, and edit-before-confirm preserves evidence and enables retrieval', async t => {
  const app = await fixture(t);
  await app.toggle(true);
  const input = batch();
  await app.extract(input);
  const [candidate] = await app.candidates();
  assert.equal(candidate.evidence[0].sessionId, input.sessionId);
  assert.equal(candidate.evidence[0].messageId, input.messages[0].id);
  assert.deepEqual(retrieveMemories((await app.read()).memories, '聊聊钢琴独奏', 'chat'), []);
  const fields = { content: '我喜欢德彪西的钢琴独奏。', category: 'music', kind: 'user_preference' };
  await app.request('candidates', 'POST', { id: candidate.id, action: 'save', fields });
  const [confirmed] = (await app.read()).memories;
  assert.equal(confirmed.status, 'active');
  assert.equal(confirmed.confirmation, 'candidate_review');
  assert.ok(confirmed.lastConfirmedAt);
  assert.deepEqual(confirmed.evidence, candidate.evidence);
  assert.equal(confirmed.content, fields.content);
  assert.equal(retrieveMemories([confirmed], '聊聊钢琴独奏', 'chat').length, 1);
  assert.deepEqual(await app.candidates(), []);
  await assert.rejects(app.request('candidates', 'POST', { id: candidate.id, action: 'save' }), { status: 404 });
});

test('same-batch, pending, rejected and active duplicates are filtered while an opposite preference can be proposed', async t => {
  const app = await fixture(t, async input => ({ candidates: [modelEntry(input[0]), modelEntry(input[0])] }));
  await app.toggle(true);
  assert.equal((await app.extract(batch())).body.added, 1);
  app.advance();
  assert.equal((await app.extract(batch(preference.normalize('NFKC')))).body.added, 0);
  const [candidate] = await app.candidates();
  await app.request('candidates', 'POST', { id: candidate.id, action: 'reject' });
  assert.deepEqual((await app.read()).memories, []);
  assert.deepEqual(await app.candidates(), []);
  app.advance();
  assert.equal((await app.extract(batch(preference))).body.added, 0);
  app.advance();
  assert.equal((await app.extract(batch('我不喜欢钢琴独奏。'))).body.added, 1);
  const [newCandidate] = await app.candidates();
  await app.request('candidates', 'POST', { id: newCandidate.id, action: 'save' });
  app.advance();
  assert.equal((await app.extract(batch('我不喜欢钢琴独奏。'))).body.added, 0);
});

for (const cancel of ['disconnect', 'disable-and-reenable']) {
  test(cancel + ' aborts the job, prevents late writes, and does not allow a concurrent extraction', async t => {
    let resolve;
    let started;
    let signal;
    const ready = new Promise(done => { started = done; });
    const app = await fixture(t, (input, activeSignal) => new Promise(done => {
      signal = activeSignal;
      resolve = () => done({ candidates: [modelEntry(input[0])] });
      started();
    }));
    await app.toggle(true);
    const res = new EventEmitter();
    const job = app.extract(batch(), res);
    await ready;
    assert.equal((await app.extract(batch())).status, 429);
    if (cancel === 'disconnect') res.emit('close');
    else {
      await app.toggle(false);
      assert.equal((await app.toggle(true)).body.epoch, 3);
    }
    assert.equal(signal.aborted, true);
    resolve();
    assert.equal((await job).status, 409);
    assert.deepEqual(await app.candidates(), []);
    assert.equal((await app.read()).discovery, undefined);
  });
}

test('profiles cannot review or list one another’s pending candidates', async t => {
  const app = await fixture(t);
  await app.toggle(true);
  await app.extract(batch());
  const [candidate] = await app.candidates();
  const other = 'b'.repeat(64);
  await app.store.initialize(other);
  assert.deepEqual((await app.request('candidates', 'GET', undefined, undefined, other)).body.items, []);
  await assert.rejects(app.request('candidates', 'POST', { id: candidate.id, action: 'save' }, undefined, other), { status: 404 });
});

test('bad JSON cannot be overwritten by a discovery or a toggle', async t => {
  const app = await fixture(t);
  const file = path.join(app.directory, app.profile + '.json');
  await fs.writeFile(file, '{bad json');
  await assert.rejects(app.toggle(true), { code: 'corrupt' });
  assert.equal(await fs.readFile(file, 'utf8'), '{bad json');
});

test('extractor uses configured server model, nonstreaming JSON and ignores reasoning', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://mock.invalid/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'deepseek-v4-pro');
    assert.equal(body.stream, false);
    assert.equal(body.enable_thinking, false);
    assert.equal(body.response_format.type, 'json_object');
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[0].content, /用户原始消息/);
    return { ok: true, json: async () => ({ choices: [
      { finish_reason: 'stop', message: { content: '{"candidates":[]}', reasoning_content: 'never parsed' } },
    ] }) };
  };
  const extract = createExtractor({ deepseekBase: 'https://mock.invalid', deepseekModel: 'deepseek-v4-pro', deepseekKey: 'fake' });
  assert.deepEqual(await extract([], new AbortController().signal), { candidates: [] });
});

test('HTTP routes enforce cookie and origin, and the production chat route remains SSE after extraction failure', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zily-discovery-http-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { createServer, config } = require('../server/server');
  const previousConfig = { ...config };
  Object.assign(config, { deepseekKey: 'mock-only', deepseekBase: 'https://mock.invalid', deepseekModel: 'mock-model' });
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; Object.assign(config, previousConfig); });
  const hits = [];
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://mock.invalid/chat/completions');
    const body = JSON.parse(options.body);
    hits.push(body.stream);
    return body.stream
      ? new Response('data: [DONE]\n\n')
      : new Response('{}', { status: 503 });
  };
  const server = createServer({ memoryStore: createMemoryStore(directory) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  let cookie;
  function request(route, method = 'GET', value, origin = base) {
    return new Promise((resolve, reject) => {
      const req = http.request(base + '/api/' + route, {
        method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}),
          ...(value ? { 'Content-Type': 'application/json' } : {}) },
      }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
      });
      req.on('error', reject);
      req.end(value ? JSON.stringify(value) : undefined);
    });
  }
  assert.equal((await request('memory/candidates')).status, 401);
  const activated = await request('memory/activate', 'POST');
  cookie = activated.headers['set-cookie'][0].split(';')[0];
  const setting = { autoExtractEnabled: true };
  assert.equal((await request('memory/discovery', 'PATCH', setting, 'https://different.invalid')).status, 403);
  assert.equal((await request('memory/discovery', 'PATCH', setting)).status, 200);
  assert.equal((await request('memory/extract', 'POST', batch())).status, 502);
  assert.deepEqual(JSON.parse((await request('memory/candidates')).body), { items: [] });
  const chat = await request('chat', 'POST', { messages: [{ role: 'user', content: '你好' }] });
  assert.match(chat.headers['content-type'], /text\/event-stream/);
  assert.equal(chat.body, 'data: [DONE]\n\n');
  assert.deepEqual(hits, [false, true]);
});

test('browser batches four turns, cancels on session reset, and ignores late results', async () => {
  const source = await fs.readFile(path.join(__dirname, '../web/js/16-memory-discovery.js'), 'utf8');
  const requests = [];
  let settleRequest;
  let rendered = 0;
  const context = vm.createContext({
    AbortController, TextEncoder, Event, setTimeout, clearTimeout,
    document: { dispatchEvent() { rendered++; } },
    fetch(url, options) {
      if (url.endsWith('/discovery')) return Promise.resolve({ ok: true, json: async () => ({ autoExtractEnabled: true, epoch: 1 }) });
      requests.push(options);
      return new Promise(resolve => { settleRequest = resolve; });
    },
  });
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  const id = randomUUID();
  const turn = () => [message(preference), message('听起来不错。', 'assistant')];
  for (let i = 0; i < 3; i++) context.queueMemoryTurn(id, turn());
  assert.equal(requests.length, 0);
  context.queueMemoryTurn(id, turn());
  context.queueMemoryTurn(id, turn());
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(requests[0].body).sessionId, id);
  assert.equal(JSON.parse(requests[0].body).messages.length, 8);
  context.resetMemoryDiscoveryQueue();
  assert.equal(requests[0].signal.aborted, true);
  settleRequest({ ok: true, json: async () => ({ added: 1, processed: [] }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rendered, 0);
  const next = randomUUID();
  for (let i = 0; i < 3; i++) context.queueMemoryTurn(next, turn());
  assert.equal(requests.length, 1);
  context.queueMemoryTurn(next, turn());
  assert.equal(requests.length, 2);
  assert.equal(JSON.parse(requests[1].body).sessionId, next);
  context.resetMemoryDiscoveryQueue();
});

for (const clear of [true, false]) {
  test((clear ? 'clear' : 'single delete') + ' fences a stalled extraction and allows new evidence', async t => {
    let entered;
    let release;
    const started = new Promise(resolve => { entered = resolve; });
    const waiting = new Promise(resolve => { release = resolve; });
    const app = await fixture(t, async input => {
      entered();
      await waiting;
      return { candidates: [modelEntry(input[0])] };
    });
    await app.toggle(true);
    const { body: { item } } = await manageItems(app.store, app.profile, await app.read(), 'POST', null,
      { category: 'music', kind: 'user_preference', content: preference });
    const old = batch();
    const extraction = app.extract(old);
    await started;
    const deleted = await manageItems(app.store, app.profile, await app.read(), 'DELETE', clear ? null : item.id,
      clear ? { confirm: true } : { revision: item.revision }, undefined, app.pendingEvidence);
    release();
    assert.equal((await extraction).status, 409);
    assert.deepEqual(await app.candidates(), []);
    assert.equal((await app.extract({ ...old, epoch: deleted.body.epoch })).body.added, 0);
    app.advance();
    const fresh = { ...batch(), epoch: deleted.body.epoch };
    assert.equal((await app.extract(fresh)).body.added, 1);
    const [candidate] = await app.candidates();
    assert.equal(candidate.content, preference);
    assert.equal(candidate.evidence[0].messageId, fresh.messages[0].id);
    assert.notEqual(candidate.evidence[0].messageId, old.messages[0].id);
  });
}

test('the extraction commit guard rejects a rotated identity even after upstream completed', async t => {
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const app = await fixture(t);
  await app.toggle(true);
  const handler = createDiscoveryHandler(async input => {
    entered();
    await waiting;
    return { candidates: [modelEntry(input[0])] };
  });
  const current = await app.read();
  const authorized = app.store.forIdentity(latest => !latest || !(latest.identityEpoch > 0));
  const pending = handler('extract', 'POST', batch(), authorized, app.profile, current, new EventEmitter());
  await started;
  await app.store.mutate(app.profile, latest => ({ identityEpoch: 1, discoveryEpoch: latest.discoveryEpoch + 1 }));
  release();
  await assert.rejects(pending, { code: 'not-found' });
  assert.deepEqual(await app.candidates(), []);
});
