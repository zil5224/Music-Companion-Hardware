'use strict';

const { randomUUID } = require('node:crypto');
const credentials = require('../web/js/00-credentials');

const categories = new Set(['profile', 'preference', 'music', 'experience', 'decision', 'topic', 'goal', 'task']);
const kinds = new Set(['user_fact', 'user_opinion', 'user_preference', 'confirmed_decision', 'manual_note']);

class MemoryItemError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validateFields(body, editing, allowsClearEpoch = false) {
  const allowed = editing ? ['category', 'kind', 'content', 'revision'] : ['category', 'kind', 'content'];
  if (allowsClearEpoch) allowed.push('clearEpoch');
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !allowed.includes(key))) {
    throw new MemoryItemError(400, '只允许提交记忆分类、类型和正文；编辑时需提供版本');
  }
  if (!categories.has(body.category)) throw new MemoryItemError(400, '不支持该记忆分类');
  if (!kinds.has(body.kind)) throw new MemoryItemError(400, '不支持该记忆类型');
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) throw new MemoryItemError(400, '请输入记忆内容');
  if (credentials.contains(content)) throw new MemoryItemError(400, '记忆中含疑似凭证，请删除或替换后再保存。');
  if (content.length > 1000) throw new MemoryItemError(400, '记忆内容不能超过 1000 个字符');
  if (editing && (!Number.isSafeInteger(body.revision) || body.revision < 1)) {
    throw new MemoryItemError(400, '请提供有效的记忆版本');
  }
  return { category: body.category, kind: body.kind, content };
}

function publicItem({ id, revision, category, kind, content, status, sourceType, sourceRole,
  createdAt, updatedAt, lastConfirmedAt }) {
  return { id, revision, category, kind, content, status, sourceType, sourceRole, createdAt, updatedAt, lastConfirmedAt };
}

async function manageItems(store, profileId, current, method, id, body, purge, pendingEvidence = () => []) {
  if (method === 'GET') {
    const items = current.memories.map(publicItem).sort((a, b) =>
      String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return { status: 200, body: { items, total: items.length } };
  }

  if (method === 'DELETE' && !id) {
    if (body?.confirm !== true || Object.keys(body).some(key => !['confirm', 'clearEpoch'].includes(key))) {
      throw new MemoryItemError(400, '请明确确认清空长期记忆');
    }
    const saved = await store.mutate(profileId, async latest => {
      checkClearEpoch(latest, current, body.clearEpoch);
      const fields = deletionFields(latest, latest.memories, pendingEvidence(), true);
      await purge?.(latest, fields);
      return fields;
    });
    return { status: 200, body: { total: 0, epoch: saved.discoveryEpoch } };
  }

  let item;
  if (method === 'POST') {
    const clearEpoch = body?.clearEpoch;
    const fields = validateFields(body, false, true);
    const now = new Date().toISOString();
    item = { id: randomUUID(), revision: 1, ...fields, status: 'active', sourceType: 'manual',
      sourceRole: 'user', createdAt: now, updatedAt: now, lastConfirmedAt: now };
    await store.mutate(profileId, latest => {
      checkClearEpoch(latest, current, clearEpoch);
      return { memories: [item, ...latest.memories] };
    });
    return { status: 201, body: { item: publicItem(item) } };
  }

  const fields = method === 'PATCH' ? validateFields(body, true) : null;
  if (method === 'DELETE' && (!Number.isSafeInteger(body?.revision) || body.revision < 1 || Object.keys(body).length !== 1)) {
    throw new MemoryItemError(400, '请提供当前记忆版本');
  }
  const saved = await store.mutate(profileId, async latest => {
    const memories = latest.memories;
    const index = memories.findIndex(entry => entry.id === id);
    if (index < 0) throw new MemoryItemError(404, '找不到这条记忆');
    const previous = memories[index];
    if (previous.revision !== body.revision) {
      throw new MemoryItemError(409, '这条记忆已被修改，请刷新后重试');
    }
    if (method === 'DELETE') {
      const fields = deletionFields(latest, [previous], pendingEvidence(), false);
      await purge?.(latest, fields);
      return fields;
    }
    const now = new Date().toISOString();
    item = { ...previous, ...fields, revision: previous.revision + 1, updatedAt: now, lastConfirmedAt: now };
    memories[index] = item;
    return { memories };
  });
  return { status: 200, body: method === 'DELETE' ? { deleted: true, epoch: saved.discoveryEpoch } : { item: publicItem(item) } };
}

function checkClearEpoch(latest, current, clientEpoch = 0) {
  const epoch = latest.clearEpoch || 0;
  if (clientEpoch !== epoch || (current?.clearEpoch || 0) !== epoch) {
    throw new MemoryItemError(409, '资料库已清空，请刷新后重试');
  }
}

function deletionFields(profile, removed, pendingEvidence, clear) {
  const old = profile.discovery;
  const evidence = items => items.flatMap(item => (item.evidence || []).map(entry => entry.messageId));
  const messages = new Set([...evidence(removed), ...pendingEvidence]);
  const candidates = old?.candidates || [];
  const dropped = clear ? candidates : candidates.filter(item => evidence([item]).some(id => messages.has(id)));
  const ids = new Set([...removed, ...dropped].map(item => item.id));
  const deleted = profile.deletion || { ids: [], messages: [] };
  const epoch = (profile.discoveryEpoch || 0) + 1;
  return {
    memories: profile.memories.filter(item => !ids.has(item.id)),
    discoveryEpoch: epoch,
    ...(clear ? { clearEpoch: (profile.clearEpoch || 0) + 1 } : {}),
    deletion: { ids: [...new Set([...deleted.ids, ...ids])],
      messages: [...new Set([...deleted.messages, ...messages, ...evidence(dropped)])] },
    ...(old ? { discovery: { ...old, candidates: candidates.filter(item => !ids.has(item.id)), lastExtractedAt: 0 } } : {}),
  };
}

module.exports = { manageItems, MemoryItemError, categories, kinds, validateFields };
