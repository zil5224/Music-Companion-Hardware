'use strict';

const ZilyBackup = (() => {
  const credentials = typeof module === 'undefined' ? ZilyCredentials : require('./00-credentials');
  const maxBytes = 4 * 1024 * 1024;
  const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
  const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  const boolean = value => typeof value === 'boolean';
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const revision = value => integer(value) && value > 0;
  const literal = (...values) => value => values.includes(value);
  const optional = rule => value => value === undefined || rule(value);
  const nullable = rule => value => value === null || rule(value);
  const array = (rule, max) => value => Array.isArray(value) && value.length <= max && value.every(rule);
  const record = rules => value => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => Object.hasOwn(rules, key)) &&
    Object.entries(rules).every(([key, rule]) => rule(Object.hasOwn(value, key) ? value[key] : undefined));
  const text = max => value => typeof value === 'string' && value.length <= max && !credentials.contains(value);
  const songId = value => /^(?:[1-9]\d{0,19})$/.test(String(value)) && (typeof value === 'string' || Number.isSafeInteger(value));
  const cover = value => {
    if (value === '') return true;
    if (!text(1000)(value)) return false;
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
        ![...url.searchParams.keys()].some(key => /token|cookie|secret|pass|credential|(?:api)?key|signature|auth/i.test(key));
    } catch { return false; }
  };
  const message = record({ role: literal('user', 'assistant'), content: text(128 * 1024), id: optional(uuid),
    status: optional(literal('streaming', 'completed', 'interrupted', 'cancelled', 'failed')),
    searched: optional(boolean), awaitingSearchClarification: optional(boolean) });
  const summary = record({ text: text(1200), covered: integer });
  const session = record({ version: literal(2), sessionId: uuid, revision, updatedAt: integer,
    messages: array(message, 50000), summary });
  const favorite = record({ id: songId, name: text(1000), artist: text(1000), cover: optional(cover), searchKeyword: optional(text(1000)) });
  const category = record({ id: uuid, revision, name: text(60) });
  const track = record({ provider: literal('netease'), id: value => typeof value === 'string' && songId(value),
    title: text(100), artist: text(100), coverUrl: cover, phase: text(40), reason: text(160) });
  const playlist = record({ id: uuid, revision, name: text(60), description: text(500), categoryId: nullable(uuid),
    createdAt: timestamp, updatedAt: timestamp, tracks: array(track, 200) });
  const prefs = record({ duration: literal(25, 50), length: literal('short', 'long'), suggestMusic: boolean });
  const evidence = record({ sessionId: uuid, messageId: uuid, role: literal('user'), quote: text(1000) });
  const memoryFields = {
    id: uuid, category: literal('profile', 'preference', 'music', 'experience', 'decision', 'topic', 'goal', 'task'),
    kind: literal('user_fact', 'user_opinion', 'user_preference', 'confirmed_decision', 'manual_note'),
    content: text(1000), sourceRole: literal('user'), createdAt: timestamp, updatedAt: timestamp,
  };
  const memory = record({ ...memoryFields, revision, status: literal('active'), sourceType: literal('manual'),
    confirmation: optional(literal('candidate_review')), evidence: optional(array(evidence, 1)), lastConfirmedAt: timestamp });
  const candidate = record({ ...memoryFields, status: literal('pending'), sourceType: literal('conversation_candidate'),
    evidence: array(evidence, 1), reason: text(200), correctionCue: optional(boolean) });
  const suppression = record({ processed: array(uuid, 50000), skipped: array(uuid, 50000),
    rejected: array(record({ digest: hex, rejectedAt: optional(timestamp), suppressUntil: optional(timestamp) }), 10000) });
  const deletion = record({ ids: array(uuid, 50000), messages: array(uuid, 50000) });
  const memoryModule = record({ version: literal(1), useInChat: boolean, autoExtractEnabled: boolean,
    memories: array(memory, 10000), candidates: array(candidate, 50),
    suppression: optional(suppression), deletion: optional(deletion), clearEpoch: optional(integer),
    lineage: optional(hex) });
  const browserModule = record({
    version: literal(1),
    chat: nullable(record({ enabled: boolean, sessions: array(session, 5000) })),
    favorites: nullable(array(favorite, 10000)),
    playlists: nullable(record({ schemaVersion: literal(1), playlists: array(playlist, 5000), categories: array(category, 5000) })),
    preferences: record({ companion: nullable(prefs), navigationCollapsed: nullable(boolean) }),
  });
  const bodyRule = record({ format: literal('zily-backup'), version: literal(1), createdAt: timestamp,
    scope: literal('all', 'memory'), modules: record({ browser: value => value !== undefined, memory: value => value !== undefined }) });
  const unique = (items, key) => new Set(items.map(item => key(item))).size === items.length;

  function checkMemory(data) {
    if (!memoryModule(data) || !unique([...data.memories, ...data.candidates], item => item.id) ||
        data.memories.some(item => !item.content.trim()) ||
        data.candidates.some(item => !item.content.trim() || item.evidence.length !== 1 || item.content !== item.evidence[0].quote)) {
      throw new Error('长期记忆结构无效，含未知字段或疑似凭证。');
    }
    return data;
  }

  function checkBrowser(data) {
    if (!browserModule(data)) throw new Error('浏览器数据结构无效，含未知字段或疑似凭证。');
    const { chat, playlists, favorites } = data;
    if (chat && ((!chat.enabled && chat.sessions.length) || !unique(chat.sessions, item => item.sessionId) ||
        chat.sessions.some(item => item.summary.covered > item.messages.filter((message, index) => {
          const reply = message.role === 'assistant' ? message : item.messages[index + 1];
          return reply?.role !== 'assistant' || !reply.status || reply.status === 'completed';
        }).length))) throw new Error('聊天会话或摘要范围无效。');
    if (favorites && !unique(favorites, item => String(item.id))) throw new Error('收藏中包含重复曲目。');
    if (playlists) {
      const ids = new Set(playlists.categories.map(item => item.id));
      if (ids.size !== playlists.categories.length || !unique(playlists.categories, item => item.name.trim().toLowerCase()) ||
          !unique(playlists.playlists, item => item.id) || playlists.categories.some(item => !item.name.trim()) ||
          playlists.playlists.some(item => !item.name.trim() || (item.categoryId !== null && !ids.has(item.categoryId)) ||
            item.tracks.some(song => !song.title.trim() || !song.artist.trim()))) throw new Error('歌单或分类关系无效。');
    }
    return data;
  }

  function checkBody(body) {
    if (body?.version !== 1) throw new Error('不支持此备份版本。');
    if (!bodyRule(body) || (body.scope === 'memory' ? body.modules.browser !== null || !body.modules.memory : !body.modules.browser)) {
      throw new Error('备份缺少模块或包含未知字段。');
    }
    if (body.modules.browser !== null) checkBrowser(body.modules.browser);
    if (body.modules.memory !== null) checkMemory(body.modules.memory);
    return body;
  }

  function canonical(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }

  function createBody(scope, browser, memory, createdAt = new Date().toISOString()) {
    return checkBody({ format: 'zily-backup', version: 1, createdAt, scope, modules: { browser, memory } });
  }

  function split(file) {
    if (!file || typeof file !== 'object' || Array.isArray(file) || !hex(file.sha256)) throw new Error('备份缺少完整性校验值。');
    const { sha256, ...body } = file;
    return { sha256, body: checkBody(body) };
  }

  return { uuid, hex, maxBytes, canonical, createBody, split, checkBody, checkBrowser, checkMemory };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = ZilyBackup;
