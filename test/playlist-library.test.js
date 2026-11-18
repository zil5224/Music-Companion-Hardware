'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { join } = require('node:path');
const vm = require('node:vm');

const source = file => readFileSync(join(__dirname, '../web/js', file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const key = 'zily.playlists.v1';
const song = (id, title) => ({ provider: 'netease', id, title, artist: '歌手', coverUrl: '', phase: '', reason: '' });
const input = (overrides = {}) => ({ name: '夜色', description: '', categoryId: null, tracks: [], ...overrides });

function boot() {
  const values = new Map();
  const storage = { getItem: name => values.get(name) ?? null, setItem: (name, value) => values.set(name, value) };
  let queue = Promise.resolve();
  const lock = (_, write) => {
    const result = queue.then(write);
    queue = result.catch(() => {});
    return result;
  };
  const context = vm.createContext({ URL, crypto: { randomUUID }, AbortController, TextEncoder, TextDecoder,
    document: { getElementById: () => null } });
  for (const file of ['00-storage-coordination.js', '18-playback-queue.js', '19-playlist-draft.js', '20-playlist-library.js']) vm.runInContext(source(file), context);
  const open = () => context.createPlaylistLibrary(storage, lock);
  return { context, storage, values, open, library: open() };
}

test('empty library has no default categories or storage writes, and empty user categories persist', async () => {
  const { open, library, values } = boot();
  assert.deepEqual(plain(library.read()), { schemaVersion: 1, playlists: [], categories: [] });
  assert.equal(values.size, 0);
  const saved = await library.saveCategory('  Night  ');
  assert.equal(open().read().categories[0].name, 'Night');
  await assert.rejects(library.saveCategory(' night '), /同名/);
  await assert.rejects(library.saveCategory('  '), /为空/);
  const renamed = await library.saveCategory('晚间', saved.id, saved.revision);
  assert.equal(renamed.revision, 2);
  assert.equal(open().read().categories[0].name, '晚间');
});

test('moves and category deletion retain playlists, reset category, and invalidate older edit revisions', async () => {
  const { library } = boot();
  const group = await library.saveCategory('晚间');
  const other = await library.saveCategory('钢琴');
  const a = await library.create(input({ categoryId: group.id, tracks: [song('1', '甲')] }));
  const b = await library.create(input({ name: '保留', categoryId: other.id }));
  const moved = await library.update(a.id, a.revision, { ...a, categoryId: other.id });
  await library.removeCategory(other.id, other.revision);
  const [first, second] = library.read().playlists;
  assert.equal(first.categoryId, null);
  assert.equal(first.revision, moved.revision + 1);
  assert.equal(first.tracks[0].id, '1');
  assert.equal(second.id, b.id);
  assert.equal(second.categoryId, null);
  assert.equal(library.read().categories[0].id, group.id);
  await assert.rejects(library.update(a.id, moved.revision, moved), { code: 'revision_conflict' });
});

test('empty playlists can be edited, reordered, removed, and recovered through a fresh store instance', async () => {
  const { open, library } = boot();
  const a = await library.create(input());
  assert.deepEqual(plain(a.tracks), []);
  const b = await library.create(input({ name: '保留' }));
  let current = await library.update(a.id, a.revision, input({ name: '新夜色', description: '慢到快',
    tracks: [song('1', '甲'), song('2', '乙')] }));
  assert.deepEqual(plain(current.tracks.map(track => track.id)), ['1', '2']);
  current = await open().update(a.id, current.revision, { ...current, tracks: current.tracks.slice().reverse() });
  assert.deepEqual(plain(current.tracks.map(track => track.id)), ['2', '1']);
  current = await open().update(a.id, current.revision, { ...current,
    tracks: [{ ...current.tracks[0], phase: '开场', reason: '先从钢琴开始' }] });
  assert.equal(open().read().playlists[0].tracks[0].phase, '开场');
  assert.equal(current.name, '新夜色');
  assert.equal(current.description, '慢到快');
  assert.equal(current.createdAt, a.createdAt);
  assert.equal(current.revision, 4);
  assert.equal(open().read().playlists[0].tracks[0].id, '2');
  await library.remove(a.id, current.revision);
  assert.deepEqual(plain(open().read().playlists.map(item => item.id)), [b.id]);
});

test('verified draft save is an immutable snapshot and a simultaneous double save creates once', async () => {
  const { context, library, open } = boot();
  const track = { id: '11', song: '甲曲', artist: '甲歌手', cover: 'https://example.test/cover.jpg' };
  const row = { track, status: 'verified', suggestion: { phase: '开场', reason: '安静' } };
  const draft = { name: 'AI 歌单', description: '从轻到重', repeat: false, entries: [row, row, { status: 'ambiguous' }] };
  const snapshot = context.playlistDraftSnapshot(draft);
  const id = randomUUID();
  const first = library.create(snapshot, id);
  const second = open().create(snapshot, id);
  track.song = '变更';
  snapshot.tracks[0].title = '也变更';
  const results = await Promise.all([first, second]);
  assert.equal(results.filter(Boolean).length, 1);
  const [saved] = open().read().playlists;
  assert.equal(saved.categoryId, null);
  assert.deepEqual(plain(saved.tracks), [{ provider: 'netease', id: '11', title: '甲曲', artist: '甲歌手',
    coverUrl: 'https://example.test/cover.jpg', phase: '开场', reason: '安静' }]);
});

test('concurrent edits serialize and reject stale updates and deletes', async () => {
  const { library, open } = boot();
  const a = await library.create(input());
  const changed = library.update(a.id, a.revision, input({ name: '已保存' }));
  const stale = open().update(a.id, a.revision, input({ name: '过期编辑' }));
  await changed;
  await assert.rejects(stale, { code: 'revision_conflict' });
  await assert.rejects(open().remove(a.id, a.revision), { code: 'revision_conflict' });
  assert.equal(open().read().playlists[0].name, '已保存');
});

test('malformed storage, unsupported schema, and storage write failures preserve stored bytes', async () => {
  const { library, values, storage } = boot();
  for (const invalid of ['not json', '{"schemaVersion":2}', '{"schemaVersion":1,"playlists":[{}],"categories":[]}']) {
    values.set(key, invalid);
    assert.throws(library.read, /已保留原数据/);
    await assert.rejects(library.create(input()), /已保留原数据/);
    assert.equal(values.get(key), invalid);
  }
  values.delete(key);
  const a = await library.create(input());
  const saved = values.get(key);
  storage.setItem = () => { throw Error('quota'); };
  await assert.rejects(library.update(a.id, a.revision, input({ name: '写入失败' })), /原有数据已保留/);
  assert.equal(values.get(key), saved);
});

test('rejects invalid tracks and excludes unsafe covers and source URLs', async () => {
  const { library } = boot();
  await assert.rejects(library.create(input({ tracks: [song('fake', '假 ID')] })), /已核验/);
  const a = await library.create(input({ tracks: [{ ...song('11', '甲'), coverUrl: 'javascript:alert(1)', url: 'https://audio.test/x' }] }));
  assert.equal(a.tracks[0].coverUrl, '');
  assert.equal(a.tracks[0].url, undefined);
});

test('real queue adapters add a single song, append all, and prioritize playlist playback independently', async () => {
  const { context, library } = boot();
  const saved = await library.create(input({ tracks: [song('11', '甲'), song('12', '乙')] }));
  const loaded = [];
  const queue = context.createPlaybackQueue({ load: async track => { loaded.push(track.id); return { ok: true }; } });
  const tracks = context.playlistQueueTracks(saved.tracks);
  assert.equal(queue.add(tracks[1]), true);
  assert.equal(queue.addMany(tracks), 2);
  assert.deepEqual(loaded, []);
  await queue.playTracks(tracks);
  assert.deepEqual(loaded, ['11']);
  assert.deepEqual(plain(queue.state.entries.map(entry => entry.track.id)), ['11', '12', '12', '11', '12']);
  assert.equal(new Set(queue.state.entries.map(entry => entry.entryId)).size, 5);
  queue.state.entries[0].track.song = '变更';
  assert.equal(saved.tracks[0].title, '甲');
  assert.equal(library.read().playlists[0].tracks[0].title, '甲');
});

test('explicit named reference includes only one bounded snapshot and ordinary generation remains independent', async () => {
  const { context, library } = boot();
  await library.create(input({ name: '另一份' }));
  await library.create(input({ name: '周杰伦' }));
  await library.create(input({ description: '前后段', tracks: Array.from({ length: 24 }, (_, i) =>
    ({ ...song(String(i + 1), '歌' + (i + 1)), phase: '阶段', reason: '只在本地' })) }));
  const request = text => context.playlistReferenceIntent(text, library.read);
  const { reference } = request('按照我已有的歌单《夜色》，换一批歌曲，生成 5 首。');
  assert.equal(reference.name, '夜色');
  assert.equal(reference.tracks.length, 12);
  assert.equal(reference.tracks[0].song, '歌1');
  assert.equal(reference.tracks.at(-1).song, '歌24');
  assert.deepEqual(Object.keys(reference.tracks[0]).sort(), ['artist', 'phase', 'song']);
  assert.equal(request('参考已保存歌单《夜色》的情绪走向，生成一份歌单。').reference.name, '夜色');
  assert.match(request('参考这份歌单，换一批歌曲。').error, /打开/);
  assert.match(request('参考歌单《不存在》，生成新歌单。').error, /没有找到/);
  assert.equal(request('参考周杰伦的风格生成歌单。'), null);
  assert.equal(request('参考《演员》生成歌单。'), null);
  assert.equal(request('参考夜色歌单，生成新歌单。').reference.name, '夜色');
  assert.equal(request('生成一个深夜歌单。'), null);
  await library.create(input());
  assert.match(request('参考歌单《夜色》，生成一份类似的。').error, /同名/);
});
