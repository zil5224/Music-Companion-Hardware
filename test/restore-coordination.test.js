'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const backup = require('../web/js/23-backup-browser');

const journal = backup.journalKey;
const favoriteKey = 'healed_songs';
const navKey = 'zily.navigationCollapsed';
const prefsKey = 'zily.companionPreferences';
const locks = ['zily.conversation.v2', 'zily.playlists.v1', favoriteKey, 'zily.browser.preferences'];
const scripts = ['00-storage-coordination.js', '10-favorites.js', '11-companion.js', '13-navigation.js']
  .map(file => readFileSync(join(__dirname, '../web/js', file), 'utf8'));
const song = id => ({ id, name: 'synthetic ' + id, artist: 'test', searchKeyword: 'synthetic ' + id });
const restoredPreferences = { duration: 50, length: 'long', suggestMusic: true };
const writes = [
  { key: favoriteKey, value: JSON.stringify([song(1)]) },
  { key: navKey, value: 'true' },
  { key: prefsKey, value: JSON.stringify(restoredPreferences) },
];
const operation = () => ({ id: randomUUID(), target: 'a'.repeat(64), expected: 'b'.repeat(64) });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

function fixture() {
  const data = new Map(), tails = new Map();
  let fail;
  const storage = {
    getItem: key => data.get(key) ?? null,
    setItem(key, value) { fail?.(key, value); data.set(key, value); },
    removeItem: key => data.delete(key),
  };
  function tab() {
    const nodes = new Map();
    const element = id => {
      if (!nodes.has(id)) {
        const flags = new Set();
        nodes.set(id, {
          hidden: true, checked: false, value: '', events: {},
          setAttribute() {}, matches() { return false; },
          classList: { toggle(name, active) { if (active) flags.add(name); else flags.delete(name); },
            contains: name => flags.has(name) },
          addEventListener(name, callback) { this.events[name] = callback; },
        });
      }
      return nodes.get(id);
    };
    const context = vm.createContext({
      localStorage: storage,
      navigator: { locks: { request(name, task) {
        const next = (tails.get(name) || Promise.resolve()).then(task);
        tails.set(name, next.catch(() => {}));
        return next;
      } } },
      document: { getElementById: element, querySelectorAll: () => [] },
      audio: new EventTarget(), currentSong: null, escHTML: text => text,
      setPlaying() {}, resizeVis() {}, startBearAnim() {}, updateLoginStatusUI() {}, triggerBearBoost() {},
    });
    for (const source of scripts) vm.runInContext(source, context);
    const coordinator = vm.runInContext('ZilyStorage', context);
    return {
      coordinated: task => coordinator.withRestoreLocks(locks, task),
      favorite(id) { context.currentSong = song(id); return context.toggleFavorite(); },
      navigation: () => element('navToggle').events.click(),
      preference(value) { element('replyLength').value = value; return element('replyLength').events.change(); },
      hasFavorite: id => context.isFavorited(id),
      collapsed: () => element('stationNav').classList.contains('is-collapsed'),
      duration: () => Number(element('focusDuration').value),
      element,
    };
  }
  return { storage, data, tab, fail(hook) { fail = hook; } };
}

test('favorites, navigation and preference writes wait for a failed restore to roll back', async () => {
  const { storage, tab } = fixture();
  const restoring = tab(), ordinary = tab();
  const ready = deferred(), response = deferred();
  const restore = restoring.coordinated(() => backup.restore({ storage, writes, operation: operation(), memory: {},
    send: () => { ready.resolve(); return response.promise; }, settle: async () => ({ committed: false }) }));
  await ready.promise;
  const favorite = ordinary.favorite(2), navigation = ordinary.navigation(), preference = ordinary.preference('long');
  assert.deepEqual(JSON.parse(storage.getItem(favoriteKey)), [song(1)]);
  assert.notEqual(storage.getItem(navKey), 'true');
  const rejected = assert.rejects(restore, /simulated restore/);
  response.reject(new Error('simulated restore'));
  await rejected;
  await Promise.all([favorite, navigation, preference]);
  assert.deepEqual(JSON.parse(storage.getItem(favoriteKey)), [song(2)]);
  assert.equal(storage.getItem(navKey), 'true');
  assert.deepEqual(JSON.parse(storage.getItem(prefsKey)), { duration: 25, length: 'long', suggestMusic: false });
  assert.equal(storage.getItem(journal), null);
});

test('an independent untagged write back to the same JSON survives recovery rollback', async () => {
  const { storage, tab } = fixture();
  const entered = deferred(), response = deferred();
  const restore = tab().coordinated(() => backup.restore({ storage, writes, operation: operation(), memory: {},
    send: () => { entered.resolve(); return response.promise; }, settle: async () => ({ committed: false }) }));
  await entered.promise;
  assert.equal(JSON.parse(storage.getItem(navKey)), true);
  storage.setItem(navKey, 'false');
  storage.setItem(navKey, 'true');
  const rejected = assert.rejects(restore, /synthetic fail/);
  response.reject(new Error('synthetic fail'));
  await rejected;
  assert.equal(storage.getItem(navKey), 'true');
  assert.equal(storage.getItem(favoriteKey), null);
  assert.equal(storage.getItem(prefsKey), null);
});

test('ordinary writers cannot modify a pending restore after its original locks release', async () => {
  const { storage, tab } = fixture();
  const a = tab(), b = tab();
  await assert.rejects(a.coordinated(() => backup.restore({ storage, writes, operation: operation(), memory: {},
    send: async () => { throw Error('offline'); }, settle: async () => { throw Error('offline'); } })), /尚未确认/);
  const before = storage.getItem(navKey);
  assert.equal(await b.favorite(2), false);
  await b.navigation();
  await b.preference('short');
  assert.equal(storage.getItem(navKey), before);
  assert.match(b.element('navigationSaveStatus').textContent, /未完成的恢复/);
  assert.match(b.element('preferenceWriteStatus').textContent, /未完成的恢复/);
  assert.deepEqual(await b.coordinated(() => backup.reconcile(storage, async () => ({ committed: false }))), { committed: false });
  assert.equal(await b.favorite(2), true);
  assert.deepEqual(JSON.parse(storage.getItem(favoriteKey)), [song(2)]);
});

test('two restores serialize and the second cannot overwrite a committed addition', async () => {
  const { storage, tab } = fixture();
  const a = tab(), b = tab(), entered = deferred(), response = deferred();
  const first = a.coordinated(() => backup.restore({ storage, writes, operation: operation(), memory: {},
    send: () => { entered.resolve(); return response.promise; }, settle: async () => ({ committed: true }) }));
  await entered.promise;
  const second = b.coordinated(() => backup.restore({ storage, writes: [{ key: navKey, value: 'false' }], operation: null }));
  const refused = assert.rejects(second, /已有数据/);
  response.resolve({ committed: true });
  await first;
  await refused;
  assert.equal(storage.getItem(navKey), 'true');
});

test('a refreshed page reads restored favorites, navigation and preferences after successful finalization', async () => {
  const { storage, tab } = fixture();
  const a = tab();
  const result = await a.coordinated(() => backup.restore({ storage, writes, operation: null }));
  assert.equal(result.committed, true);
  const refreshed = tab();
  assert.equal(refreshed.hasFavorite(1), true);
  assert.equal(refreshed.collapsed(), true);
  assert.equal(refreshed.duration(), 50);
  for (const { key, value } of writes) assert.equal(storage.getItem(key), value);
  assert.equal(storage.getItem(journal), null);
});

test('a lost server response is settled as committed and removes ownership without rolling back data', async () => {
  const { storage, tab } = fixture();
  const op = operation();
  const result = await tab().coordinated(() => backup.restore({ storage, writes, operation: op, memory: {},
    send: async () => { throw Error('response lost after server commit'); },
    settle: async pending => { assert.deepEqual(pending, op); return { committed: true }; } }));
  assert.equal(result.committed, true);
  for (const { key, value } of writes) assert.equal(storage.getItem(key), value);
  assert.equal(storage.getItem(journal), null);
});

test('interrupted finalization after a browser-only commit resumes without rollback', async () => {
  const { storage, tab, fail } = fixture();
  fail((key, value) => { if (key === navKey && value === 'true') throw Error('synthetic failure after decision'); });
  await assert.rejects(tab().coordinated(() => backup.restore({ storage, writes, operation: null })), /尚未确认/);
  assert.equal(JSON.parse(storage.getItem(journal)).committed, true);
  assert.equal(storage.getItem(favoriteKey), writes[0].value);
  fail(undefined);
  assert.deepEqual(await tab().coordinated(() => backup.reconcile(storage, () => { throw Error('unexpected call'); })), { committed: true });
  assert.equal(storage.getItem(navKey), 'true');
  assert.deepEqual(JSON.parse(storage.getItem(prefsKey)), restoredPreferences);
});

test('an uncommitted version-one journal preserves data with unknown ownership', async () => {
  const { storage, tab } = fixture();
  storage.setItem(navKey, 'true');
  storage.setItem(journal, JSON.stringify({ version: 1, writes: [{ key: navKey, value: 'true' }], operation: null, sent: false }));
  assert.deepEqual(await tab().coordinated(() => backup.reconcile(storage)), { committed: false, retainedLegacy: true });
  assert.equal(storage.getItem(navKey), 'true');
  assert.equal(storage.getItem(journal), null);
});
