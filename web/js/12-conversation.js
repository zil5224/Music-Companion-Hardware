const conversationKey = 'zily.conversation';
const legacySaveKey = 'zily.saveConversation';
const conversationControlKey = 'zily.conversation.v2.control';
const conversationPrefix = 'zily.conversation.v2.session.';
const conversationLockName = 'zily.conversation.v2';
const conversationCheckpointMs = 750;
const conversationBytesLimit = 512 * 1024;
const conversationLibraryBytesLimit = 2 * 1024 * 1024;
const conversationIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const conversationLegacyId = '00000000-0000-4000-8000-000000000001';
const conversationStatuses = {
  streaming: '正在回复',
  completed: '',
  interrupted: '回复中断',
  cancelled: '已停止',
  failed: '回复失败',
};

const saveChatToggle = document.getElementById('saveConversation');
const resumeChat = document.getElementById('resumeConversation');
const savedConversationSelect = document.getElementById('savedConversations');
const deleteSavedConversation = document.getElementById('deleteSavedConversation');
const conversationSaveStatus = document.getElementById('conversationSaveStatus');
const copyConversation = document.getElementById('copyConversation');
const retryConversationSave = document.getElementById('retryConversationSave');
const welcomeMessage = chatMsgs.firstElementChild;
const newConversationId = () => globalThis.crypto?.randomUUID?.();
const emptyConversationSummary = () => ({ text: '', covered: 0 });
let conversationArchive = [];
let conversationSummary = emptyConversationSummary();
let summaryTask = null;
let checkpointTimer;
let lastCheckpoint = -Infinity;
let saveChatEnabled = false;
let currentConversation;
let conversationId;
let listedConversationVersions = new Map();

function conversationStatus(message, retry = false) {
  if (conversationSaveStatus.textContent !== message) conversationSaveStatus.textContent = message;
  retryConversationSave.hidden = !retry;
}

function readConversationControl() {
  const raw = localStorage.getItem(conversationControlKey);
  if (raw == null) {
    return { enabled: localStorage.getItem(legacySaveKey) === 'true', epoch: 'legacy', legacyHandled: false };
  }
  const control = JSON.parse(raw);
  if (typeof control?.enabled !== 'boolean' || (control.epoch !== 'legacy' && !conversationIdPattern.test(control.epoch)) ||
      typeof control.legacyHandled !== 'boolean') throw new Error('聊天保存设置损坏，已保留原数据。');
  return control;
}

function startConversationState(epoch, id = newConversationId(), revision = 0, writeId = null) {
  conversationId = id;
  currentConversation = { id, epoch, revision, writeId, dirty: false, blocked: false, writeSequence: 0 };
  copyConversation.hidden = true;
}

function withConversationLock(task) {
  if (!globalThis.navigator?.locks || !globalThis.crypto?.randomUUID) {
    return Promise.reject(new Error('当前浏览器不支持安全写入聊天。可继续查看已保存的记录。'));
  }
  return ZilyStorage.withWrite(conversationLockName, task);
}

function conversationStorageKeys(prefix) {
  const keys = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

const conversationEpochPrefix = epoch => conversationPrefix + epoch + '.';
const conversationSessionKey = (epoch, id) => conversationEpochPrefix(epoch) + id;
const validConversationMessage = message => message && ['user', 'assistant'].includes(message.role) &&
  typeof message.content === 'string' &&
  (message.role !== 'assistant' || message.status === undefined || Object.hasOwn(conversationStatuses, message.status));

function completedConversationMessages(messages) {
  return messages.filter((message, index) => {
    const assistant = message.role === 'assistant' ? message : messages[index + 1];
    return assistant?.role !== 'assistant' || assistant.status === undefined || assistant.status === 'completed';
  });
}

function redactConversationMessages(messages) {
  return messages.map(message => ({ ...message, content: ZilyCredentials.redact(message.content) }));
}

function restoredSummary(summary, messages) {
  return typeof summary?.text === 'string' && Number.isInteger(summary.covered) && summary.covered >= 0 &&
    summary.covered <= completedConversationMessages(messages).length
    ? { text: ZilyCredentials.redact(summary.text).slice(0, 1200), covered: summary.covered } : emptyConversationSummary();
}

function readLegacyConversation(raw = localStorage.getItem(conversationKey)) {
  if (raw == null) return null;
  const stored = JSON.parse(raw);
  const messages = Array.isArray(stored) ? stored : stored?.messages;
  if (!Array.isArray(messages) || !messages.every(validConversationMessage)) throw new Error('旧聊天记录损坏，已保留原数据。');
  if (!messages.length) return null;
  const sessionId = conversationIdPattern.test(stored?.sessionId) ? stored.sessionId : conversationLegacyId;
  return { sessionId, revision: 0, updatedAt: 0, messages: redactConversationMessages(messages), summary: restoredSummary(stored?.summary, messages) };
}

function readConversationSession(key) {
  const raw = localStorage.getItem(key);
  if (raw == null) return null;
  const snapshot = JSON.parse(raw);
  if (snapshot?.version !== 2 || snapshot.sessionId !== key.slice(-36) || !conversationIdPattern.test(snapshot.sessionId) ||
      !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1 || !Number.isFinite(snapshot.updatedAt) ||
      (snapshot.writeId !== undefined && (typeof snapshot.writeId !== 'string' || !conversationIdPattern.test(snapshot.writeId))) ||
      (snapshot.legacySourceId !== undefined && (typeof snapshot.legacySourceId !== 'string' || !conversationIdPattern.test(snapshot.legacySourceId))) ||
      !Array.isArray(snapshot.messages) || !snapshot.messages.every(validConversationMessage)) {
    throw new Error('已保存的聊天记录损坏，已保留原数据。');
  }
  return { ...snapshot, messages: redactConversationMessages(snapshot.messages),
    summary: snapshot.summary && { ...snapshot.summary, text: ZilyCredentials.redact(snapshot.summary.text) } };
}

function savedConversationList(control) {
  if (!control.enabled) return { sessions: [], damaged: false };
  const sessions = [];
  let damaged = false;
  for (const key of conversationStorageKeys(conversationEpochPrefix(control.epoch))) {
    try {
      const snapshot = readConversationSession(key);
      if (snapshot?.messages.length) sessions.push(snapshot);
    } catch { damaged = true; }
  }
  if (!control.legacyHandled) {
    try {
      const legacy = readLegacyConversation();
      if (legacy && !sessions.some(session => session.sessionId === legacy.sessionId)) sessions.push(legacy);
    } catch { damaged = true; }
  }
  return { sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt), damaged };
}

function sameConversationVersion(snapshot, state) {
  return (snapshot?.revision || 0) === state.revision && (snapshot?.writeId ?? null) === state.writeId;
}

function refreshSavedConversations(control, preferredId) {
  const { sessions, damaged } = savedConversationList(control);
  listedConversationVersions = new Map(sessions.map(session => [session.sessionId,
    { epoch: control.epoch, revision: session.revision, writeId: session.writeId ?? null }]));
  const selection = preferredId || savedConversationSelect.value;
  const options = sessions.map(session => {
    const option = document.createElement('option');
    option.value = session.sessionId;
    const title = session.messages.find(message => message.role === 'user')?.content || '已保存的聊天';
    option.textContent = title.replace(/\s+/g, ' ').slice(0, 45);
    return option;
  });
  savedConversationSelect.replaceChildren(...options);
  savedConversationSelect.hidden = deleteSavedConversation.hidden = !options.length;
  savedConversationSelect.value = sessions.some(session => session.sessionId === selection)
    ? selection : (sessions[0]?.sessionId || '');
  resumeChat.disabled = !options.length || savedConversationSelect.value === conversationId;
  if (damaged) conversationStatus('部分聊天数据无法读取，原数据已保留。');
}

function writeConversationSnapshot(key, snapshot) {
  const raw = JSON.stringify({ ...snapshot, messages: redactConversationMessages(snapshot.messages),
    summary: snapshot.summary && { ...snapshot.summary, text: ZilyCredentials.redact(snapshot.summary.text) } });
  const bytes = raw.length * 2;
  const prefix = key.slice(0, -36);
  const otherBytes = conversationStorageKeys(prefix)
    .filter(other => other !== key)
    .reduce((sum, other) => sum + (localStorage.getItem(other)?.length || 0) * 2, 0);
  if (bytes > conversationBytesLimit) throw new Error('当前会话已达本地保存上限。可在新标签页开始新对话。');
  if (bytes + otherBytes > conversationLibraryBytesLimit) throw new Error('聊天保存空间已满。可删除不需要的已存会话后重试。');
  localStorage.setItem(key, raw);
}

function sameConversationContent(a, b) {
  return JSON.stringify(a.messages) === JSON.stringify(b.messages) &&
    JSON.stringify(a.summary) === JSON.stringify(b.summary);
}

function legacyExtendsSnapshot(legacy, existing) {
  if (legacy.messages.length <= existing.messages.length ||
      JSON.stringify(legacy.summary) !== JSON.stringify(existing.summary)) return false;
  const ids = legacy.messages.flatMap(message => message.id ? [message.id] : []);
  return ids.length === new Set(ids).size &&
    JSON.stringify(legacy.messages.slice(0, existing.messages.length)) === JSON.stringify(existing.messages);
}

function migrateConversation(control) {
  const raw = localStorage.getItem(conversationKey);
  if (!control.enabled || control.legacyHandled || raw === null) return;
  const legacy = readLegacyConversation(raw);
  let copiedSeparately = false;
  if (legacy) {
    const key = conversationSessionKey(control.epoch, legacy.sessionId);
    const stored = readConversationSession(key);
    if (!stored) {
      writeConversationSnapshot(key, { ...legacy, version: 2, revision: 1, writeId: newConversationId() });
    } else if (!sameConversationContent(legacy, stored)) {
      if (legacyExtendsSnapshot(legacy, stored)) {
        writeConversationSnapshot(key, { ...stored, messages: legacy.messages, revision: stored.revision + 1,
          writeId: stored.writeId ?? newConversationId(), updatedAt: Date.now() });
      } else {
        const alreadyCopied = conversationStorageKeys(conversationEpochPrefix(control.epoch))
          .map(candidate => {
            try { return readConversationSession(candidate); } catch { return null; }
          })
          .some(snapshot => snapshot?.legacySourceId === legacy.sessionId && sameConversationContent(legacy, snapshot));
        if (!alreadyCopied) {
          const id = newConversationId();
          writeConversationSnapshot(conversationSessionKey(control.epoch, id), { ...legacy, sessionId: id, version: 2,
            revision: 1, writeId: newConversationId(), legacySourceId: legacy.sessionId, updatedAt: Date.now() });
        }
        copiedSeparately = true;
      }
    }
  }
  // Older tabs cannot join the lock. Keep their source whenever it changes during migration.
  if (localStorage.getItem(conversationKey) !== raw) throw new Error('旧聊天在迁移时发生变化，已保留原记录。');
  const previousControl = localStorage.getItem(conversationControlKey);
  localStorage.setItem(conversationControlKey, JSON.stringify({ ...control, legacyHandled: true }));
  if (localStorage.getItem(conversationKey) !== raw) {
    if (previousControl === null) localStorage.removeItem(conversationControlKey);
    else localStorage.setItem(conversationControlKey, previousControl);
    throw new Error('旧聊天在迁移时发生变化，已保留原记录。');
  }
  localStorage.removeItem(conversationKey);
  return copiedSeparately;
}

function reportConversationConflict(state, control) {
  state.blocked = true;
  state.dirty = true;
  if (state !== currentConversation) return;
  copyConversation.hidden = !control.enabled;
  conversationStatus('已存聊天已被另一标签页修改、删除或停止保存。当前内容仍在本页，可在开启保存时另存。');
}

async function saveConversation() {
  if (!saveChatEnabled || !conversationArchive.length || currentConversation.blocked) return false;
  const state = currentConversation;
  const messages = conversationArchive;
  const summary = conversationSummary;
  state.dirty = true;
  const writeSequence = ++state.writeSequence;
  try {
    return await withConversationLock(() => {
      if (state.blocked) return false;
      const control = readConversationControl();
      if (!control.enabled || control.epoch !== state.epoch) {
        reportConversationConflict(state, control);
        return false;
      }
      const key = conversationSessionKey(state.epoch, state.id);
      const stored = readConversationSession(key);
      if (!sameConversationVersion(stored, state)) {
        reportConversationConflict(state, control);
        return false;
      }
      const revision = state.revision + 1;
      const writeId = state.writeId ?? newConversationId();
      writeConversationSnapshot(key, { version: 2, sessionId: state.id, revision, writeId, updatedAt: Date.now(), messages, summary,
        ...(stored?.legacySourceId ? { legacySourceId: stored.legacySourceId } : {}) });
      state.revision = revision;
      state.writeId = writeId;
      if (state.writeSequence === writeSequence) state.dirty = false;
      if (state === currentConversation) {
        conversationStatus('聊天已保存到此浏览器。');
        if (revision === 1) {
          try { refreshSavedConversations(control, state.id); }
          catch { conversationStatus('聊天已保存，暂时无法刷新会话列表。'); }
        }
      }
      return true;
    });
  } catch (error) {
    if (state === currentConversation) {
      const full = error?.name === 'QuotaExceededError';
      const detail = full ? '浏览器存储空间不足。' : error?.message || '浏览器存储不可用。';
      conversationStatus('本次更改未保存，当前内容仍在本页。' + detail, true);
    }
    return false;
  }
}

retryConversationSave.onclick = () => saveConversation();

function checkpointConversation() {
  if (!saveChatEnabled || currentConversation.blocked) return;
  currentConversation.dirty = true;
  const elapsed = Date.now() - lastCheckpoint;
  if (elapsed >= conversationCheckpointMs) {
    clearTimeout(checkpointTimer);
    checkpointTimer = undefined;
    lastCheckpoint = Date.now();
    void saveConversation();
  } else if (checkpointTimer === undefined) {
    checkpointTimer = setTimeout(flushConversationCheckpoint, conversationCheckpointMs - elapsed);
  }
}

function flushConversationCheckpoint() {
  if (checkpointTimer !== undefined) clearTimeout(checkpointTimer);
  checkpointTimer = undefined;
  lastCheckpoint = Date.now();
  return saveConversation();
}

function clearConversation(epoch) {
  if (typeof cancelPlaylistChat === 'function') cancelPlaylistChat();
  if (typeof clearPlaylistPreview === 'function') clearPlaylistPreview();
  if (typeof resetMemoryDiscoveryQueue === 'function') resetMemoryDiscoveryQueue();
  if (checkpointTimer !== undefined) clearTimeout(checkpointTimer);
  checkpointTimer = undefined;
  lastCheckpoint = -Infinity;
  summaryTask?.abort();
  summaryTask = null;
  conversationArchive = [];
  chatContext = [];
  conversationSummary = emptyConversationSummary();
  startConversationState(epoch ?? currentConversation.epoch);
  chatMsgs.replaceChildren(welcomeMessage);
  conversationStatus('');
}

function showRestoredConversation(snapshot, epoch) {
  clearConversation(epoch);
  startConversationState(epoch, snapshot.sessionId, snapshot.revision, snapshot.writeId ?? null);
  conversationArchive = snapshot.messages.map(message =>
    message.status === 'streaming' ? { ...message, status: 'interrupted' } : message);
  chatContext = completedConversationMessages(conversationArchive);
  conversationSummary = restoredSummary(snapshot.summary, conversationArchive);
  for (const message of conversationArchive) {
    if (message.role === 'user') addUMsg(message.content);
    else setAIMessageText(addAIMsg(''), conversationReplyText(message));
  }
}

function conversationReplyText(message, note = '') {
  const status = note || conversationStatuses[message.status];
  return [message.content, status].filter(Boolean).join('\n');
}

function discardUnsavedConversation() {
  return !conversationArchive.length ||
    (currentConversation.revision && !currentConversation.dirty && !currentConversation.blocked) ||
    confirm('当前对话有未保存的内容。离开会丢失这些内容，继续吗？');
}

document.getElementById('newConversation').onclick = () => {
  if (chatPending && !activeChat?.playlistDraft) return;
  // Starting a new temporary conversation retains the existing no-save behavior.
  if ((saveChatEnabled || currentConversation.blocked) && !discardUnsavedConversation()) return;
  try {
    const control = readConversationControl();
    clearConversation(control.epoch);
    refreshSavedConversations(control);
  } catch {
    clearConversation();
    conversationStatus('浏览器无法读取聊天保存设置。');
  }
  chatInput.focus();
};

savedConversationSelect.onchange = () => {
  resumeChat.disabled = !savedConversationSelect.value || savedConversationSelect.value === conversationId;
};

resumeChat.onclick = async () => {
  if ((chatPending && !activeChat?.playlistDraft) || !discardUnsavedConversation()) return;
  const state = currentConversation;
  await conversationStartup;
  if (currentConversation !== state || (chatPending && !activeChat?.playlistDraft)) return;
  try {
    const control = readConversationControl();
    const snapshot = savedConversationList(control).sessions.find(session => session.sessionId === savedConversationSelect.value);
    if (!snapshot || snapshot.sessionId === conversationId) return;
    showRestoredConversation(snapshot, control.epoch);
    refreshSavedConversations(control, snapshot.sessionId);
  } catch { conversationStatus('无法恢复已保存的聊天，原数据已保留。'); }
};

function clearSavedConversations(enabled) {
  const control = { enabled, epoch: newConversationId(), legacyHandled: true };
  localStorage.setItem(conversationControlKey, JSON.stringify(control));
  let cleaned = true;
  try {
    for (const key of [...conversationStorageKeys(conversationPrefix), conversationKey]) {
      try { localStorage.removeItem(key); } catch { cleaned = false; }
    }
  } catch { cleaned = false; }
  return { control, cleaned };
}

saveChatToggle.onchange = async () => {
  const enabled = saveChatToggle.checked;
  saveChatToggle.checked = saveChatEnabled;
  saveChatToggle.disabled = true;
  try {
    await withConversationLock(() => {
      const previous = readConversationControl();
      let control = previous;
      let cleaned = true;
      if (enabled !== previous.enabled) {
        if (enabled) {
          control = { enabled: true, epoch: newConversationId(), legacyHandled: previous.legacyHandled };
          localStorage.setItem(conversationControlKey, JSON.stringify(control));
        } else {
          ({ control, cleaned } = clearSavedConversations(false));
        }
      }
      saveChatToggle.checked = saveChatEnabled = control.enabled;
      if (currentConversation.epoch !== control.epoch) startConversationState(control.epoch);
      refreshSavedConversations(control);
      conversationStatus(cleaned
        ? (enabled ? '已开启此浏览器的聊天保存。' : '已关闭保存，当前聊天只留在本页。')
        : '已关闭保存。部分旧记录未能从浏览器存储清除。');
    });
    if (enabled) await saveConversation();
  } catch (error) {
    conversationStatus('无法更新聊天保存设置。' + (error?.message || ''));
  } finally {
    saveChatToggle.checked = saveChatEnabled;
    saveChatToggle.disabled = false;
  }
};

document.getElementById('deleteConversation').onclick = async () => {
  if ((chatPending && !activeChat?.playlistDraft) || !confirm('删除当前聊天和此浏览器中全部已保存的聊天？')) return;
  try {
    await withConversationLock(() => {
      const { control, cleaned } = clearSavedConversations(readConversationControl().enabled);
      clearConversation(control.epoch);
      refreshSavedConversations(control);
      conversationStatus(cleaned ? '已删除聊天记录。' : '已阻止旧聊天恢复，但部分旧数据未能清除。');
    });
  } catch { conversationStatus('无法删除已保存的聊天，当前内容已保留。'); }
};

deleteSavedConversation.onclick = async () => {
  const selected = savedConversationSelect.value;
  const expected = selected === conversationId ? { ...currentConversation } : listedConversationVersions.get(selected);
  if (!selected || !expected || (chatPending && selected === conversationId) || !confirm('删除选中的已保存会话？')) return;
  try {
    await withConversationLock(() => {
      const control = readConversationControl();
      const key = conversationSessionKey(control.epoch, selected);
      // Remove a duplicate legacy copy first, so it cannot become visible again.
      let legacy;
      if (!control.legacyHandled) {
        try { legacy = readLegacyConversation(); } catch { /* Preserve an unreadable legacy record. */ }
      }
      const primary = readConversationSession(key);
      const stored = primary || (legacy?.sessionId === selected ? legacy : null);
      if (!stored || control.epoch !== expected.epoch || !sameConversationVersion(stored, expected)) {
        refreshSavedConversations(control);
        conversationStatus('会话已在另一标签页更新或恢复，请重新检查后再删除。');
        return;
      }
      const legacyDiffers = legacy?.sessionId === selected && primary && !sameConversationContent(legacy, primary);
      if (legacy?.sessionId === selected && !legacyDiffers) localStorage.removeItem(conversationKey);
      localStorage.removeItem(key);
      if (selected === conversationId) clearConversation(control.epoch);
      refreshSavedConversations(control);
      conversationStatus(legacyDiffers ? '已删除选中的会话。已保留内容不同的旧版记录。' : '已删除选中的会话。');
    });
  } catch { conversationStatus('无法删除选中的会话，当前内容已保留。'); }
};

copyConversation.onclick = async () => {
  if (chatPending || !saveChatEnabled || !currentConversation.blocked || !conversationArchive.length ||
      !confirm('将本页内容保存为一个新会话？')) return;
  try {
    const control = readConversationControl();
    if (!control.enabled) return;
    startConversationState(control.epoch);
    await saveConversation();
  } catch { conversationStatus('无法另存聊天，当前内容仍在本页。'); }
};

function syncConversationStorage(eventKey) {
  try {
    const control = readConversationControl();
    saveChatToggle.checked = saveChatEnabled = control.enabled;
    if (currentConversation.epoch !== control.epoch) {
      if (conversationArchive.length) reportConversationConflict(currentConversation, control);
      else startConversationState(control.epoch);
    } else if (currentConversation.revision && (eventKey === null ||
        eventKey === conversationSessionKey(control.epoch, conversationId))) {
      const stored = readConversationSession(conversationSessionKey(control.epoch, conversationId));
      if (!sameConversationVersion(stored, currentConversation)) reportConversationConflict(currentConversation, control);
    }
    refreshSavedConversations(control);
  } catch { conversationStatus('浏览器无法读取聊天保存设置，原数据已保留。'); }
}

startConversationState('legacy');
syncConversationStorage();
const conversationStartup = saveChatEnabled && globalThis.navigator?.locks
  ? withConversationLock(() => migrateConversation(readConversationControl()))
    .then(copiedSeparately => {
      syncConversationStorage();
      if (copiedSeparately) conversationStatus('检测到不同版本，旧聊天已另存为独立会话。');
    }, () => {
      syncConversationStorage();
      conversationStatus('旧聊天暂未迁移，原记录已保留。');
    })
  : Promise.resolve();
globalThis.addEventListener?.('storage', event => {
  if (event.key == null || [conversationKey, legacySaveKey, conversationControlKey].includes(event.key) ||
      event.key.startsWith(conversationPrefix)) syncConversationStorage(event.key);
});
function savePendingConversationOnHide() {
  if (currentConversation.dirty) void flushConversationCheckpoint();
}
globalThis.addEventListener?.('pagehide', savePendingConversationOnHide);
document.addEventListener?.('visibilitychange', () => {
  if (document.visibilityState === 'hidden') savePendingConversationOnHide();
});

function beginConversationTurn(user) {
  lastCheckpoint = -Infinity;
  const turn = [
    { role: 'user', content: ZilyCredentials.redact(user), id: newConversationId() },
    { role: 'assistant', content: '', id: newConversationId(), status: 'streaming' },
  ];
  conversationArchive.push(...turn);
  return turn;
}

function finishConversationTurn(turn, status, searched, awaitingSearchClarification, discover) {
  const reply = turn[1];
  if (reply.status !== 'streaming') return;
  reply.status = status;
  if (status !== 'completed') return;
  if (searched) reply.searched = true;
  if (awaitingSearchClarification) reply.awaitingSearchClarification = true;
  chatContext.push(...turn);
  if (discover && conversationId && typeof queueMemoryTurn === 'function') queueMemoryTurn(conversationId, turn);
}

function retryConversationTurn(turn) {
  if (conversationArchive.at(-1) !== turn[1] || turn[1].status === 'completed') return false;
  lastCheckpoint = -Infinity;
  turn[1].status = 'streaming';
  return true;
}

function conversationMessages() {
  let start = Math.max(conversationSummary.covered, chatContext.length - CHAT_HISTORY_LIMIT);
  while (start < chatContext.length && chatContext[start].role === 'assistant') start++;
  return chatContext.slice(start);
}

function summaryBatch(start, end) {
  const previous = conversationSummary.text
    ? [{ role: 'user', content: '【旧摘要】\n' + conversationSummary.text }]
    : [];
  let batchEnd = start;
  let messages = previous;
  const candidates = [...previous];
  for (let index = start; index < Math.min(end, start + 20); index++) {
    const { role, content } = chatContext[index];
    candidates.push({ role, content: content.slice(0, CHAT_MESSAGE_LIMIT) });
    if (chatContext[index + 1]?.role === 'assistant') continue;
    if (!chatBodyFits(chatRequestBody(candidates, 700, 0.2, { mode: 'summary' }))) break;
    batchEnd = index + 1;
    messages = candidates.slice();
  }
  return { messages, batchEnd };
}

async function refreshConversationSummary() {
  if (summaryTask) return;
  const end = chatContext.length - 10;
  const start = conversationSummary.covered;
  if (end <= start || (conversationSummary.text && end - start < 4)) return;
  const { messages, batchEnd } = summaryBatch(start, end);
  if (batchEnd === start) return;
  const lastCovered = chatContext[batchEnd - 1];
  const task = new AbortController();
  summaryTask = task;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    task.abort();
  }, 30000);
  try {
    const summary = (await streamChatMessages(messages, null, task.signal, 700, 0.2, { mode: 'summary' })).trim();
    if (summaryTask !== task || task.signal.aborted) return;
    if (!summary || summary.length > 1200) {
      console.warn('[摘要]', summary ? '正文超过 1200 字符' : '没有收到正式正文');
      return;
    }
    const covered = chatContext.indexOf(lastCovered) + 1;
    if (!covered) return;
    conversationSummary = { text: ZilyCredentials.redact(summary), covered };
    await saveConversation();
  } catch (error) {
    if (summaryTask !== task) return;
    if (timedOut) console.warn('[摘要] 请求超过 30 秒，已取消');
    else if (!task.signal.aborted) {
      const knownFailure = ['summary-http', 'summary-length', 'summary-incomplete'].includes(error?.cause);
      console.warn('[摘要]', knownFailure ? error.message : '请求失败，保留原有摘要');
    }
  } finally {
    clearTimeout(timeout);
    if (summaryTask === task) summaryTask = null;
  }
}

function recentSearchTopic() {
  // Reuse one grounded turn, for at most five intervening exchanges.
  for (let index = chatContext.length - 1; index >= Math.max(1, chatContext.length - 11); index--) {
    if (chatContext[index].role === 'assistant' && chatContext[index].searched === true && chatContext[index - 1].role === 'user') {
      return chatContext.slice(index - 1, index + 1).map(({ role, content }) => ({ role, content: content.slice(0, 600) }));
    }
  }
  return [];
}

function searchClarificationContext(text) {
  const [question, clarification] = chatContext.slice(-2);
  if (question?.role !== 'user' || clarification?.awaitingSearchClarification !== true) return [];
  const selection = text.trim().match(/^(?:(?:我说的是|我指的是|是|就)(?:\s*))?([\p{L}· ]{2,30})[。！!]?$/u)?.[1].trim();
  if (!selection || !clarification.content.includes(selection)) return [];
  return [...recentSearchTopic(), question, clarification]
    .map(({ role, content }) => ({ role, content: content.slice(0, 600) }));
}

async function answerWithSearch(query, resultMessage, signal, context = []) {
  setAIMessageText(resultMessage, '正在查资料…');
  if (query.length > 200) throw new Error('请用 200 字以内概括要查的内容。');

    const response = await fetch('/api/search', {
      signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        context
      })
    });
    const { results, answer, clarification, code } = await response.json();
    if (response.status === 503) throw new Error('我现在还不能联网核实这件事。你可以贴一段节目介绍或相关资料，我们接着聊。');
    if (code === 'credential_detected') throw new Error(ZilyCredentials.notice, { cause: code });
    if (!response.ok) throw new Error('搜索暂不可用。');
    if (clarification) {
      setAIMessageText(resultMessage, clarification);
      return { answer: clarification, searched: false, awaitingSearchClarification: true };
    }
    if (!results.length) throw new Error('这轮没拿到可核对的来源，暂时没法确认。');
    const clean = answer || "";
    setAIMessageText(resultMessage, clean || '找到了以下来源，暂时无法生成摘要。');
    const links = document.createElement('ol');
    links.className = 'search-sources';
    results.forEach(({ title, url }, i) => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = '[' + (i + 1) + '] ' + title;
      item.append(link);
      links.append(item);
    });
    const disclosure = document.createElement('details');
    disclosure.className = 'search-sources';
    const summary = document.createElement('summary');
    summary.textContent = '来源（' + results.length + '）';
    disclosure.append(summary, links);
    resultMessage.querySelector('.msg-ai').append(disclosure);
    scrollChat();
    return {answer: clean || '找到了来源，暂时无法生成摘要。', searched: true};
}
