'use strict';

const ZilyBackupBrowser = (() => {
  const format = typeof module === 'undefined' ? ZilyBackup : require('./22-backup-format');
  const credentials = typeof module === 'undefined' ? ZilyCredentials : require('./00-credentials');
  const journalKey = typeof module === 'undefined' ? ZilyStorage.journalKey : 'zily.backup.v1.restore';
  const newOwner = typeof module === 'undefined' ? () => crypto.randomUUID() : require('node:crypto').randomUUID;
  const chatControlKey = 'zily.conversation.v2.control';
  const chatPrefix = 'zily.conversation.v2.session.';
  const browserKeys = new Set(['healed_songs', 'zily.playlists.v1', 'zily.companionPreferences', 'zily.navigationCollapsed', chatControlKey]);
  const chatKeyPattern = /^zily\.conversation\.v2\.session\.(?:legacy|[a-f0-9-]{36})\.[a-f0-9-]{36}$/i;
  const keyOK = key => browserKeys.has(key) || chatKeyPattern.test(key);
  const browserBudget = 2 * 1024 * 1024;
  const sessionBudget = 512 * 1024;

  function read(storage, key) {
    const raw = storage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  }

  function collect(storage, control, sessions) {
    return format.checkBrowser({
      version: 1,
      chat: control.enabled || storage.getItem(chatControlKey) !== null || storage.getItem('zily.saveConversation') !== null
        ? { enabled: control.enabled, sessions: sessions.map(({ sessionId, revision, updatedAt, messages, summary }) => ({
          version: 2, sessionId, revision: Math.max(revision, 1), updatedAt, messages, summary,
        })) } : null,
      favorites: read(storage, 'healed_songs'), playlists: read(storage, 'zily.playlists.v1'),
      preferences: {
        companion: read(storage, 'zily.companionPreferences'),
        navigationCollapsed: read(storage, 'zily.navigationCollapsed'),
      },
    });
  }

  function plan(storage, browser, control, newId) {
    const writes = [];
    const conflicts = [];
    if (!browser) return { writes, conflicts };
    format.checkBrowser(browser);
    function add(key, value, label, session = false) {
      if (value === null) return;
      const previous = storage.getItem(key);
      if (previous === null) {
        const stored = session ? { ...value, writeId: newId() } : value;
        writes.push({ key, value: JSON.stringify(stored) });
        return;
      }
      const stored = JSON.parse(previous);
      if (session && stored && typeof stored === 'object') {
        delete stored.writeId;
        delete stored.legacySourceId;
      }
      if (format.canonical(stored) !== format.canonical(value)) conflicts.push(label);
    }
    add('healed_songs', browser.favorites, '收藏');
    add('zily.playlists.v1', browser.playlists, '歌单与分类');
    add('zily.companionPreferences', browser.preferences.companion, '陪伴偏好');
    add('zily.navigationCollapsed', browser.preferences.navigationCollapsed, '导航设置');
    if (browser.chat) {
      if (storage.getItem('zily.conversation') !== null && browser.chat.sessions.length) {
        conflicts.push('当前浏览器有尚未迁移的旧聊天');
      }

      const configured = storage.getItem(chatControlKey) !== null || storage.getItem('zily.saveConversation') !== null;
      const epoch = configured ? control.epoch : newId();
      if (configured && control.enabled !== browser.chat.enabled) conflicts.push('聊天保存设置');
      if (!configured) add(chatControlKey, { enabled: browser.chat.enabled, epoch, legacyHandled: true }, '聊天保存设置');
      let size = 0;
      const prefix = chatPrefix + epoch + '.';
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (key?.startsWith(prefix)) size += (storage.getItem(key)?.length || 0) * 2;
      }
      for (const session of browser.chat.sessions) {
        const key = prefix + session.sessionId;
        const raw = JSON.stringify(session);
        if (raw.length * 2 > sessionBudget) conflicts.push('单会话超过保存上限');
        if (storage.getItem(key) === null) size += raw.length * 2;
        add(key, session, '同一会话已有不同记录', true);
      }
      if (size > browserBudget) conflicts.push('聊天记录超过整库保存上限');
    }
    return { writes, conflicts: [...new Set(conflicts)] };
  }

  function validOperation(operation) {
    if (!operation || !format.uuid(operation.id) || Object.keys(operation).length !== 3) return false;
    return Object.hasOwn(operation, 'proof')
      ? format.hex(operation.proof) && Number.isSafeInteger(operation.issuedAt) && operation.issuedAt > 0
      : format.hex(operation.target) && format.hex(operation.expected);
  }

  function checkWriteValues(writes) {
    for (const { value } of writes) {
      let parsed;
      try { parsed = JSON.parse(value); } catch { throw new Error('恢复数据无效，现有数据已保留。'); }
      if (credentials.inData(parsed)) throw new Error('恢复数据含疑似凭证，现有数据已保留。');
    }
  }

  function readJournal(storage) {
    const entry = read(storage, journalKey);
    if (entry === null) return null;
    const versionTwo = entry?.version === 2;
    if ((!versionTwo && entry?.version !== 1) ||
        (versionTwo && (!format.uuid(entry.owner) || typeof entry.committed !== 'boolean')) ||
        !Array.isArray(entry.writes) || typeof entry.sent !== 'boolean' ||
        (entry.operation !== null && !validOperation(entry.operation)) || (entry.sent && !entry.operation) ||
        entry.writes.some(item => !item || !keyOK(item.key) || typeof item.value !== 'string')) {
      throw new Error('恢复日志损坏，现有数据已保留。');
    }
    checkWriteValues(entry.writes);
    return entry;
  }

  // JSON readers accept trailing whitespace. Keep the transaction ID in the
  // same storage write as the data, so an identical ordinary write drops it.
  function ownedValue(value, owner) {
    const bits = [...owner.replaceAll('-', '')].map(digit =>
      parseInt(digit, 16).toString(2).padStart(4, '0')).join('');
    return value + '\n' + bits.replaceAll('0', ' ').replaceAll('1', '\t');
  }

  function finish(storage, entry, committed) {
    if (entry.version === 1) {
      const retainedLegacy = !committed && entry.writes.some(({ key }) => storage.getItem(key) !== null);
      storage.removeItem(journalKey);
      return retainedLegacy ? { committed, retainedLegacy } : { committed };
    }

    // Persist the decision before removing ownership, including browser-only restores.
    if (committed && !entry.committed) {
      storage.setItem(journalKey, JSON.stringify({ ...entry, committed: true }));
    }
    for (const { key, value } of entry.writes) {
      if (storage.getItem(key) !== ownedValue(value, entry.owner)) continue;
      if (committed) storage.setItem(key, value);
      else storage.removeItem(key);
    }
    storage.removeItem(journalKey);
    return { committed };
  }

  async function reconcile(storage, settle) {
    const entry = readJournal(storage);
    if (!entry) return null;
    const committed = entry.committed === true || (entry.sent && (await settle(entry.operation)).committed === true);
    return finish(storage, entry, committed);
  }

  async function restore({ storage, writes, operation, memory, send, settle }) {
    if (readJournal(storage)) throw new Error('请先完成上一次恢复。');
    if (writes.some(({ key }) => !keyOK(key) || storage.getItem(key) !== null)) {
      throw new Error('已有数据在预览后变化，请重新检查冲突。');
    }
    checkWriteValues(writes);
    if (credentials.inData(memory)) throw new Error('恢复数据含疑似凭证，现有数据已保留。');
    const entry = { version: 2, owner: newOwner(), writes, operation, sent: false, committed: false };
    storage.setItem(journalKey, JSON.stringify(entry));
    try {
      for (const { key, value } of writes) storage.setItem(key, ownedValue(value, entry.owner));
      if (operation) {
        storage.setItem(journalKey, JSON.stringify({ ...entry, sent: true }));
        entry.sent = true;
        const result = await send({ ...operation, confirm: true, memory });
        if (result.committed !== true) throw new Error('长期记忆恢复尚未提交。');
      }
      finish(storage, entry, true);
      return { committed: true, writes: writes.length };
    } catch (error) {
      let result;
      try { result = await reconcile(storage, settle); }
      catch { throw new Error('恢复尚未确认。请保留此浏览器数据，服务恢复后点击「检查未完成的恢复」。'); }
      if (result?.committed) return { committed: true, writes: writes.length };
      throw error;
    }
  }

  return { journalKey, collect, plan, readJournal, reconcile, restore };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = ZilyBackupBrowser;
