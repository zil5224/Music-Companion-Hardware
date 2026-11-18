'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createMemoryStore } = require('../server/memory-store');
const { manageItems } = require('../server/memory-items');
const { createDiscoveryHandler } = require('../server/memory-discovery');
const { fingerprint, createRelationLookup, rejectFingerprint } = require('../server/memory-relations');

const active = (content, category = 'preference') => ({ id: randomUUID(), content, category, status: 'active' });
const user = content => ({ id: randomUUID(), role: 'user', content });
const steel = '我平时喜欢钢琴独奏。';

async function fixture(t, generate) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zily-relations-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createMemoryStore(directory);
  const profile = 'a'.repeat(64);
  await store.initialize(profile);
  let now = Date.now();
  let calls = 0;
  const handler = createDiscoveryHandler(async input => {
    calls++;
    if (generate) return generate(input);
    const [{ id, content }] = input;
    const quote = content.replace(/^请重新记住[：:]/u, '').replace(/^我之前说错了。/u, '');
    const goal = quote.startsWith('我打算长期');
    const entry = { content: quote, evidenceQuote: quote, sourceMessageIds: [id],
      category: goal ? 'goal' : 'preference', kind: goal ? 'user_fact' : 'user_preference', reason: '长期信息' };
    return { candidates: [entry, entry] };
  }, () => now);
  const request = async (route, method, body, owner = profile) =>
    handler(route, method, body, store, owner, await store.read(owner), new EventEmitter());
  await request('discovery', 'PATCH', { autoExtractEnabled: true });
  const batch = content => ({ sessionId: randomUUID(), epoch: 1, messages:
    (Array.isArray(content) ? content : [content, '继续聊。', '你好。', '谢谢。']).flatMap(text => [user(text), { id: randomUUID(), role: 'assistant', content: '嗯。' }]) });
  return { store, profile, request, batch, calls: () => calls, advance: (ms = 300001) => { now += ms; },
    extract: input => request('extract', 'POST', input), list: async () => (await request('candidates', 'GET')).body.items };
}

const examples = [
  {
    category: 'preference',
    existing: '我喜欢温柔知性、自然不做作的交流方式，但也希望对方有自己的思想和判断，不要一味附和我。',
    candidate: '我一直比较喜欢自然、不做作的交流方式，不喜欢那种特别官方、像客服一样的对话。',
  },
  {
    category: 'goal',
    existing: '我正在开发子夜电台，希望打造一个拥有独立人格、自然交流能力和长期记忆的 AI 音乐伙伴，使用 DeepSeek 作为模型。',
    candidate: '我打算长期经营子夜电台，希望把子超真正做成一个拥有独立人格、自然交流能力和长期记忆的 AI 音乐伙伴。',
  },
];

for (const [index, example] of examples.entries()) {
  test('acceptance example ' + (index + 1) + ' is retained as a possible supplement without touching the existing memory', async t => {
    const app = await fixture(t);
    const old = active(example.existing, example.category);
    await app.store.update(app.profile, () => [old]);
    const result = await app.extract(app.batch(example.candidate));
    assert.equal(result.body.added, 1);
    const [candidate] = await app.list();
    assert.equal(candidate.content, example.candidate);
    assert.equal(candidate.relation.type, 'possible_supplement');
    assert.equal(candidate.relation.target.content, old.content);
    assert.match(candidate.relation.reason, /共享措辞/);
    assert.deepEqual((await app.store.read(app.profile)).memories, [old]);
    await app.request('candidates', 'POST', { id: candidate.id, action: 'save' });
    const saved = (await app.store.read(app.profile)).memories;
    assert.deepEqual(saved.map(entry => entry.content), [example.candidate, example.existing]);
  });
}

const longProject = '子夜电台这个项目我打算长期做下去，希望把子超真正做成一个拥有独立人格、自然交流能力和长期记忆的 AI 音乐伙伴。';
const independentJudgment = '我不太喜欢别人一味附和我。我更希望对方有自己的判断，即使不同意我，也可以直接说出理由。';

function proposed(user, category = 'preference', kind = 'user_preference') {
  return { category, kind, content: user.content, evidenceQuote: user.content, sourceMessageIds: [user.id], reason: '长期信息' };
}

test('four browser acceptance candidates are retained, with same-batch and historical pending relations', async t => {
  const app = await fixture(t, input => ({ candidates: input.slice(0, 3).map(user =>
    /长期/u.test(user.content) ? proposed(user, 'goal', 'user_fact') : proposed(user)) }));
  const existing = examples.map(example => active(example.existing, example.category));
  await app.store.update(app.profile, () => existing);
  const first = app.batch([examples[0].candidate, independentJudgment, '今天不想聊天。', '你好。']);
  assert.equal((await app.extract(first)).body.added, 2);
  app.advance();
  const second = app.batch([examples[1].candidate, longProject, '窗外有一辆车经过。', '你好。']);
  assert.equal((await app.extract(second)).body.added, 2);
  const [natural, judgment, earlier, later] = await app.list();
  assert.equal((await app.list()).length, 4);
  assert.equal(natural.content, examples[0].candidate);
  assert.equal(natural.relation.target.id, existing[0].id);
  assert.equal(natural.relation.target.source, 'active');
  assert.equal(judgment.content, independentJudgment);
  assert.equal(judgment.relation.target.id, existing[0].id);
  assert.equal(earlier.content, examples[1].candidate);
  assert.equal(earlier.relation.type, 'possible_supplement');
  assert.equal(earlier.relation.target.id, existing[1].id);
  assert.equal(earlier.relation.other.target.id, later.id);
  assert.equal(later.content, longProject);
  assert.equal(later.relation.type, 'possible_duplicate');
  assert.equal(later.relation.target.source, 'pending');
  assert.equal(later.relation.target.id, earlier.id);
  assert.match(later.relation.reason, /子夜电台/);
  assert.deepEqual((await app.store.read(app.profile)).memories, existing);
  assert.equal(app.calls(), 2);
  assert.equal((await app.extract(second)).body.added, 0);
  assert.equal(app.calls(), 2);
});

test('pending goals across separate batches match and remain independent of other browser profiles', async t => {
  const app = await fixture(t, input => ({ candidates: [proposed(input[0], 'goal', 'user_fact')] }));
  await app.extract(app.batch(longProject));
  app.advance();
  await app.extract(app.batch(examples[1].candidate));
  const [earlier, later] = await app.list();
  assert.equal(earlier.relation.target.id, later.id);
  assert.equal(later.relation.type, 'possible_duplicate');
  assert.equal(later.relation.target.id, earlier.id);
  const otherProfile = 'b'.repeat(64);
  await app.store.initialize(otherProfile);
  assert.deepEqual((await app.request('candidates', 'GET', undefined, otherProfile)).body.items, []);
  assert.equal((await app.request('discovery', 'GET', undefined, otherProfile)).body.autoExtractEnabled, false);
  await app.request('discovery', 'PATCH', { autoExtractEnabled: false });
  app.advance();
  assert.equal((await app.extract(app.batch(longProject))).status, 409);
  assert.equal(app.calls(), 2);
  assert.equal((await app.list()).length, 2);
});

test('pending comparison distinguishes complementary expression, conflicting scoped preference and independent facts', () => {
  const items = [
    '我喜欢自然、不做作的交流方式。', '我不喜欢官方、客服式的表达。',
    '我喜欢工作时听纯音乐。', '我不喜欢工作时听音乐。', '我平时喜欢吃芹菜。',
  ].map(content => ({ ...active(content), status: 'pending' }));
  const lookup = createRelationLookup([], items);
  assert.equal(lookup(items[1]).type, 'possible_supplement');
  assert.equal(lookup(items[1]).target.id, items[0].id);
  assert.equal(lookup(items[2]).type, 'possible_conflict');
  assert.equal(lookup(items[3]).target.id, items[2].id);
  assert.deepEqual(lookup(items[4]), { type: 'independent' });
  const narrower = { ...active('我不喜欢工作时听纯音乐。'), status: 'pending' };
  const broader = { ...active('我喜欢工作时听音乐。'), status: 'pending' };
  assert.notEqual(createRelationLookup([], [narrower, broader])(narrower).type, 'possible_conflict');
});

test('relation reads reflect reject, edit-and-save, formal edit and deletion without changing review actions', async t => {
  const app = await fixture(t, input => ({ candidates: input.map(user => proposed(user)) }));
  const sameBatch = app.batch([steel, '我偏爱钢琴独奏。', '我一直喜欢听钢琴独奏。', '你好。']);
  assert.equal((await app.extract(sameBatch)).body.added, 3);
  const [first, second, third] = await app.list();
  assert.equal(second.relation.target.id, first.id);
  await app.request('candidates', 'POST', { id: first.id, action: 'reject' });
  assert.ok((await app.list()).every(item => item.relation.target?.id !== first.id));
  const edited = '我很喜欢钢琴独奏。';
  await app.request('candidates', 'POST', { id: second.id, action: 'save',
    fields: { category: 'preference', kind: 'user_preference', content: edited } });
  const [stored] = (await app.store.read(app.profile)).memories;
  assert.deepEqual(stored.evidence, second.evidence);
  let [remaining] = await app.list();
  assert.equal(remaining.id, third.id);
  assert.equal(remaining.relation.target.source, 'active');
  assert.equal(remaining.relation.target.content, edited);
  await manageItems(app.store, app.profile, null, 'PATCH', stored.id, {
    category: 'preference', kind: 'user_preference', content: '我非常偏爱钢琴独奏。', revision: 1,
  });
  [remaining] = await app.list();
  assert.equal(remaining.relation.target.content, '我非常偏爱钢琴独奏。');
  await manageItems(app.store, app.profile, null, 'DELETE', stored.id, { revision: stored.revision + 1 });
  [remaining] = await app.list();
  assert.deepEqual(remaining.relation, { type: 'independent' });
  await app.request('candidates', 'POST', { id: remaining.id, action: 'save' });
  assert.equal((await app.list()).length, 0);
  assert.equal((await app.store.read(app.profile)).memories[0].content, remaining.content);
});

test('exact normalization preserves case, negation, time, degree and decisions', () => {
  const exact = fingerprint('  我喜欢ＡＢＣ。 ');
  assert.equal(exact, fingerprint('我喜欢ABC。'));
  for (const changed of ['我不喜欢ABC。', '我以前喜欢ABC。', '我很喜欢ABC。', '我决定采用ABC。', '我喜欢abc。']) {
    assert.notEqual(exact, fingerprint(changed));
  }
});

test('high lexical overlap is a visible hint, not a filter, for both pending and active records', async t => {
  const app = await fixture(t);
  const old = active(steel);
  await app.store.update(app.profile, () => [old]);
  const replay = app.batch(steel);
  assert.equal((await app.extract(replay)).body.added, 0);
  assert.equal((await app.extract(replay)).body.added, 0);
  assert.equal(app.calls(), 1);
  app.advance();
  const paraphrase = app.batch('我偏爱钢琴独奏。');
  assert.equal((await app.extract(paraphrase)).body.added, 1);
  const [candidate] = await app.list();
  assert.equal(candidate.relation.type, 'possible_duplicate');
  app.advance();
  assert.equal((await app.extract(app.batch('我一直喜欢听钢琴独奏。'))).body.added, 1);
  assert.equal((await app.list()).length, 2);
  const results = await Promise.allSettled([
    app.request('candidates', 'POST', { id: candidate.id, action: 'save' }),
    app.request('candidates', 'POST', { id: candidate.id, action: 'save' }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 404);
});

test('different facts, negative expressions and explicit correction receive conservative hints', async t => {
  const old = active('我喜欢钢琴独奏。');
  const lookup = createRelationLookup([old, active('子夜电台使用蓝色界面。', 'topic')]);
  assert.equal(lookup({ content: '子夜电台支持桌面播放。', category: 'topic' }).type, 'related_unresolved');
  assert.equal(lookup({ content: '我不喜欢吃芹菜。', category: 'preference' }).type, 'independent');
  const normal = lookup({ content: '我不喜欢钢琴独奏。', category: 'preference' });
  assert.equal(normal.type, 'possible_conflict');
  assert.doesNotMatch(normal.reason, /更正/);
  const app = await fixture(t);
  await app.store.update(app.profile, () => [old]);
  await app.extract(app.batch('我之前说错了。我不喜欢钢琴独奏。'));
  const [correction] = await app.list();
  assert.equal(correction.relation.type, 'possible_conflict');
  assert.match(correction.relation.reason, /更正措辞/);
  assert.deepEqual((await app.store.read(app.profile)).memories, [old]);
  app.advance();
  assert.equal((await app.extract(app.batch('我今天不太喜欢钢琴独奏。'))).body.added, 0);
});

test('timed rejection expires and explicit re-request bypasses it, but old message IDs still do not replay', async t => {
  const app = await fixture(t);
  const original = app.batch(steel);
  await app.extract(original);
  const reject = async () => {
    const [candidate] = await app.list();
    await app.request('candidates', 'POST', { id: candidate.id, action: 'reject' });
  };
  await reject();
  const [record] = (await app.store.read(app.profile)).discovery.rejected;
  assert.equal(Date.parse(record.suppressUntil) - Date.parse(record.rejectedAt), 7 * 86400000);
  app.advance();
  assert.equal((await app.extract(app.batch(steel))).body.added, 0);
  app.advance();
  assert.equal((await app.extract(app.batch('请重新记住：' + steel))).body.added, 1);
  assert.equal((await app.list())[0].content, steel);
  await reject();
  app.advance(7 * 86400000);
  assert.equal((await app.extract(original)).body.added, 0);
  assert.equal((await app.extract(app.batch(steel))).body.added, 1);
});

test('schema v1 rejection fingerprint without timestamps neither changes nor permanently suppresses a new message', async t => {
  const app = await fixture(t);
  const legacy = { digest: rejectFingerprint(steel, 0).digest, negative: false, tokens: ['legacy'] };
  await app.store.mutate(app.profile, () => ({
    discovery: { candidates: [], processed: [], rejected: [legacy], lastExtractedAt: 0 },
  }));
  assert.equal((await app.extract(app.batch(steel))).body.added, 1);
  const reopened = await app.store.read(app.profile);
  assert.equal(reopened.schemaVersion, 1);
  assert.deepEqual(reopened.discovery.rejected, [legacy]);
});
