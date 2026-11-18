'use strict';

const { randomUUID } = require('node:crypto');
const credentials = require('../web/js/00-credentials');
const { MemoryItemError, validateFields } = require('./memory-items');
const { ID, safeText, eligibleUsers, validateCandidates } = require('./memory-extraction');

const { fingerprint, createRelationLookup, rejectFingerprint, recentlyRejected, explicitlyRememberAgain, hasCorrectionCue } = require('./memory-relations');

const INTERVAL = 5 * 60_000;
const EMPTY = { candidates: [], processed: [], skipped: [], rejected: [], lastExtractedAt: 0 };
const state = data => data.discovery || EMPTY;
const setting = data => ({ autoExtractEnabled: data.autoExtractEnabled === true, epoch: data.discoveryEpoch || 0,
  ...(data.clearEpoch ? { clearEpoch: data.clearEpoch } : {}) });
const reply = (body, status = 200) => ({ status, body });
const exact = (object, ...keys) => object && typeof object === 'object' && !Array.isArray(object) &&
  Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));

function validatedBatch(body) {
  if (!exact(body, 'sessionId', 'epoch', 'messages') || !ID.test(body.sessionId) ||
      !Number.isSafeInteger(body.epoch) || !Array.isArray(body.messages) ||
      body.messages.length < 8 || body.messages.length > 12 || body.messages.length % 2) {
    throw new MemoryItemError(400, '提取请求需要 4 至 6 个完整对话轮次');
  }
  const seen = new Set();
  for (const [index, message] of body.messages.entries()) {
    if (!exact(message, 'id', 'role', 'content') || !ID.test(message.id) || seen.has(message.id) ||
        message.role !== (index % 2 ? 'assistant' : 'user') ||
        typeof message.content !== 'string' || !message.content.trim() || message.content.length > 8000) {
      throw new MemoryItemError(400, '原始消息格式无效');
    }
    seen.add(message.id);
  }
  return body.messages;
}

function review(store, profileId, body, clock) {
  const editing = exact(body, 'id', 'action', 'fields');
  if ((!editing && !exact(body, 'id', 'action')) || !ID.test(body.id) ||
      !['save', 'reject'].includes(body.action) || (editing && body.action !== 'save')) {
    throw new MemoryItemError(400, '请指定候选和有效的确认操作');
  }
  const fields = editing ? validateFields(body.fields, false) : null;
  return store.mutate(profileId, current => {
    const data = state(current);
    const candidate = data.candidates.find(entry => entry.id === body.id);
    if (!candidate) throw new MemoryItemError(404, '找不到待确认记忆');
    const candidates = data.candidates.filter(entry => entry.id !== body.id);
    if (body.action === 'reject') {
      const rejected = [...data.rejected, rejectFingerprint(candidate.content, clock())];
      return { discovery: { ...data, candidates, rejected } };
    }
    const { category, kind, content } = fields || candidate;
    if (!safeText(content) || credentials.inData(candidate.evidence)) {
      throw new MemoryItemError(400, '候选记忆不能保存敏感信息');
    }
    const digest = fingerprint(content);
    if (current.memories.some(entry => entry.status === 'active' && typeof entry.content === 'string' && fingerprint(entry.content) === digest)) {
      throw new MemoryItemError(409, '已有相同记忆，可选择暂不保存');
    }
    const now = new Date().toISOString();
    const memory = {
      id: randomUUID(), revision: 1, category, kind, content, status: 'active',
      sourceType: 'manual', sourceRole: 'user', confirmation: 'candidate_review',
      evidence: candidate.evidence, createdAt: now, updatedAt: now, lastConfirmedAt: now,
    };
    return { memories: [memory, ...current.memories], discovery: { ...data, candidates } };
  });
}

function createDiscoveryHandler(extract, clock = Date.now) {
  const running = new Map();
  const attemptedAt = new Map();

  async function handle(route, method, body, store, profileId, current, res) {
    if (route === 'discovery') {
      if (method === 'GET') return reply(setting(current));
      if (!exact(body, 'autoExtractEnabled') || typeof body.autoExtractEnabled !== 'boolean') {
        throw new MemoryItemError(400, '请提供自动发现开关状态');
      }
      const saved = await store.mutate(profileId, data => setting(data).autoExtractEnabled === body.autoExtractEnabled
        ? null : { autoExtractEnabled: body.autoExtractEnabled, discoveryEpoch: setting(data).epoch + 1 });
      if (!saved.autoExtractEnabled) running.get(profileId)?.controller.abort();
      return reply(setting(saved));
    }
    if (route === 'candidates') {
      if (method === 'GET') {
        const { candidates } = state(current);
        if (!candidates.length) return reply({ items: [] });
        const relate = createRelationLookup(current.memories, candidates);
        return reply({ items: candidates.map(candidate => ({ ...candidate, relation: relate(candidate) })) });
      }
      await review(store, profileId, body, clock);
      return reply({ ok: true });
    }

    const messages = validatedBatch(body);
    const consent = setting(current);
    if (!consent.autoExtractEnabled || consent.epoch !== body.epoch) return reply({ stopped: true, ...consent }, 409);
    if (running.has(profileId)) return reply({ retryAfterMs: 5000 }, 429);
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    res.once('close', disconnect);
    if (res.destroyed) controller.abort();
    running.set(profileId, { controller, ids: messages.filter(message => message.role === "user").map(message => message.id) });
    const timer = setTimeout(disconnect, 25_000);
    timer.unref?.();
    try {
      const fresh = await store.inspect(profileId, latest => latest);
      if (controller.signal.aborted || !fresh?.autoExtractEnabled || setting(fresh).epoch !== body.epoch) {
        return reply({ stopped: true, ...(fresh ? setting(fresh) : {}) }, 409);
      }
      const existing = state(fresh);
      const processed = new Set(existing.processed);
      const skipped = new Set([...(existing.skipped || []), ...(fresh.deletion?.messages || [])]);
      const unseen = [];
      const done = [];
      const alreadySkipped = [];
      for (let index = 0; index < messages.length; index += 2) {
        const user = messages[index];
        const assistant = messages[index + 1];
        if (processed.has(user.id) || processed.has(assistant.id)) done.push(user.id);
        else if (skipped.has(user.id)) alreadySkipped.push(user.id);
        else unseen.push(user);
      }
      if (unseen.length < 4) return reply({ processed: done, skipped: alreadySkipped, added: 0 });

      const input = eligibleUsers(unseen);
      const submittedIds = new Set(input.map(message => message.id));
      const skippedIds = unseen.filter(message => !submittedIds.has(message.id)).map(message => message.id);
      const now = clock();
      let candidates = [];
      if (input.length) {
        if (existing.candidates.length >= 50) return reply({ retryAfterMs: INTERVAL }, 429);
        for (const [id, previous] of attemptedAt) {
          if (now - previous >= INTERVAL) attemptedAt.delete(id);
        }
        const previous = Math.max(existing.lastExtractedAt, attemptedAt.get(profileId) ?? 0);
        const wait = previous ? INTERVAL - (now - previous) : 0;
        if (wait > 0) return reply({ retryAfterMs: wait }, 429);
        if (!extract) return reply({ error: '暂时无法分析待确认记忆' }, 503);
        attemptedAt.set(profileId, now);
        const json = await extract(input, controller.signal);
        candidates = validateCandidates(json, input, body.sessionId, new Date(now).toISOString());
      }
      let added = 0;
      let committed = false;
      await store.mutate(profileId, data => {
        if (controller.signal.aborted || !data.autoExtractEnabled || setting(data).epoch !== body.epoch) return null;
        const latest = state(data);
        const active = data.memories.filter(entry => entry.status === 'active' && typeof entry.content === 'string');
        const exactMatches = new Set([...active, ...latest.candidates].map(entry => fingerprint(entry.content)));
        const originals = new Map(input.map(message => [message.id, message.content]));
        const kept = latest.candidates.slice();
        for (const candidate of candidates) {
          if (kept.length >= 50) break;
          const digest = fingerprint(candidate.content);
          if (exactMatches.has(digest)) continue;
          const original = originals.get(candidate.evidence[0].messageId);
          if (recentlyRejected(latest.rejected, digest, now) && !explicitlyRememberAgain(original)) continue;
          exactMatches.add(digest);
          kept.push(hasCorrectionCue(original) ? { ...candidate, correctionCue: true } : candidate);
          added++;
        }
        committed = true;
        return { discovery: {
          ...latest, candidates: kept,
          lastExtractedAt: input.length ? now : latest.lastExtractedAt,
          processed: [...latest.processed, ...submittedIds],
          skipped: [...(latest.skipped || []), ...skippedIds],
        } };
      }, () => !controller.signal.aborted);
      if (!committed || controller.signal.aborted) {
        return reply({ stopped: true, ...setting(await store.read(profileId)) }, 409);
      }
      return reply({ processed: [...done, ...submittedIds], skipped: [...alreadySkipped, ...skippedIds], added });
    } catch (error) {
      if (controller.signal.aborted) return reply({ stopped: true }, 409);
      if (error.code === 'not-found' || error.code === 'corrupt' || error.code === 'unsupported-version' || error.code === 'size-limit') throw error;
      return reply({ error: '暂时无法分析待确认记忆', retryAfterMs: INTERVAL }, 502);
    } finally {
      clearTimeout(timer);
      res.removeListener('close', disconnect);
      running.delete(profileId);
    }
  }
  handle.pendingEvidence = profileId => running.get(profileId)?.ids || [];
  return handle;
}

module.exports = { createDiscoveryHandler };
