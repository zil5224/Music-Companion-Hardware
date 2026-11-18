'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const scripts = ['00-storage-coordination.js', '10-favorites.js'].map(file =>
  readFileSync(join(__dirname, '../web/js', file), 'utf8'));
const key = 'healed_songs';
const song = id => ({ id, name: 'synthetic ' + id, artist: 'test' });

function fixture(raw) {
  const data = new Map(raw === undefined ? [] : [[key, raw]]);
  const listeners = new Set();
  let pending = Promise.resolve();
  let failure;
  function tab() {
    const nodes = new Map();
    const context = vm.createContext({
      navigator: { locks: { request(name, task) {
        assert.equal(name, key);
        const next = pending.then(task);
        pending = next.catch(() => {});
        return next;
      } } },
      localStorage: { getItem: name => data.get(name) ?? null, setItem(name, value) {
        if (failure) throw failure;
        data.set(name, value);
      } },
      addEventListener(name, callback) { if (name === 'storage') listeners.add(callback); },
      document: { getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, { classList: { toggle() {} }, setAttribute() {} });
        return nodes.get(id);
      } },
      setPlaying() {}, resizeVis() {}, startBearAnim() {}, updateLoginStatusUI() {}, triggerBearBoost() {},
      escHTML: text => text,
    });
    for (const script of scripts) vm.runInContext(script, context);
    return {
      async toggle(track) {
        context.currentSong = track;
        return context.toggleFavorite();
      },
      has: id => context.isFavorited(id),
      status: () => nodes.get('favoriteWriteStatus').textContent,
    };
  }
  return { tab, raw: () => data.get(key), ids: () => JSON.parse(data.get(key)).map(track => track.id),
    fail(error) { failure = error; }, broadcast() { for (const listener of listeners) listener({ key }); } };
}

test('two tabs adding different favorites preserve both', async () => {
  const f = fixture();
  const a = f.tab(), b = f.tab();
  assert.deepEqual(await Promise.all([a.toggle(song(1)), b.toggle(song(2))]), [true, true]);
  assert.deepEqual(f.ids(), [1, 2]);
  f.broadcast();
  assert.equal(a.has(2), true);
  assert.equal(b.has(1), true);
});

test('concurrent adds of the same favorite are idempotent', async () => {
  const f = fixture();
  const a = f.tab(), b = f.tab();
  await Promise.all([a.toggle(song(1)), b.toggle(song('1'))]);
  assert.deepEqual(f.ids(), [1]);
});

test('stale add after a deletion preserves the new song and cannot revive the deleted one', async () => {
  const f = fixture(JSON.stringify([song(1)]));
  const a = f.tab(), b = f.tab();
  await a.toggle(song(1));
  await b.toggle(song(2));
  assert.deepEqual(f.ids(), [2]);
});

test('two old tabs removing the same favorite do not add it back', async () => {
  const f = fixture(JSON.stringify([song(1), song(2)]));
  const a = f.tab(), b = f.tab();
  await Promise.all([a.toggle(song(1)), b.toggle(song(1))]);
  assert.deepEqual(f.ids(), [2]);
});

test('quota failure preserves stored and rendered favorites', async () => {
  const f = fixture(JSON.stringify([song(1)]));
  const a = f.tab();
  f.fail(new DOMException('synthetic', 'QuotaExceededError'));
  assert.equal(await a.toggle(song(2)), false);
  assert.equal(a.has(2), false);
  assert.equal(await a.toggle(song(1)), false);
  assert.equal(a.has(1), true);
  assert.deepEqual(f.ids(), [1]);
  assert.match(a.status(), /存储空间不足/);
});

test('malformed JSON, object shape and invalid track records are preserved', async () => {
  for (const raw of ['{broken', '{}', '[null]', '[{"id":1,"name":123}]']) {
    const f = fixture(raw);
    const a = f.tab();
    assert.equal(await a.toggle(song(2)), false);
    assert.equal(f.raw(), raw);
    assert.match(a.status(), /收藏数据损坏/);
  }
});

test('a fresh tab restores the latest committed favorites', async () => {
  const f = fixture();
  const a = f.tab();
  await a.toggle(song(1));
  await a.toggle(song(2));
  await a.toggle(song(1));
  const refreshed = f.tab();
  assert.equal(refreshed.has(1), false);
  assert.equal(refreshed.has('2'), true);
});
