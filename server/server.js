'use strict';
/**
 * Music Companion 后端（项目运行环境为 Node.js ≥ 22.12.0）
 *
 * 职责：
 *   1. 托管前端静态文件（web/）
 *   2. POST /api/chat  → 转发到 DeepSeek（API Key 只存在于服务端 .env，不会下发给浏览器）
 *   4. GET  /ncm/*     → 白名单反向代理到本机 NeteaseCloudMusicApi
 *   5. GET  /api/health
 *
 * 配置全部来自环境变量 / 项目根目录的 .env（见 .env.example）。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const credentials = require('../web/js/00-credentials');
const { sendAIStream } = require('./ai-stream');
const { buildPersonaPrompt, isChatMode } = require('./persona');
const { createMemoryAccess, createMemoryHandler, localOrigin } = require('./memory-http');
const backupFormat = require('../web/js/22-backup-format');
const { createExtractor } = require('./memory-extraction');
const { addMemoryContext } = require('./memory-retrieval');
const { cleanupAtomicTemps, createBackupRotation, startMemoryBackups } = require('./backup-store');

const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');

// ───────────────────────── .env 加载（不依赖 dotenv）─────────────────────────
function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      val = val.replace(/\s+#.*$/, ''); // 去掉行尾注释
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
if (require.main === module) loadEnvFile(path.join(ROOT, '.env'));

const config = {
  host: process.env.ZILY_HOST || '127.0.0.1',
  port: Number(process.env.ZILY_PORT) || 8080,
  deepseekKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  deepseekBase: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
  ncmUrl: (process.env.NCM_API_URL || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
  upstreamTimeoutMs: 15000,
};

// ───────────────────────── 工具函数 ─────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  };
  if (status === 413) headers.Connection = 'close'; // 请求体还没读完，响应后关闭连接
  res.writeHead(status, headers);
  res.end(body);
}

function readJsonBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return; // 超限后丢弃剩余数据，等响应发完再断开连接
      size += c.length;
      if (size > limitBytes) {
        tooLarge = true;
        chunks.length = 0;
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// 简易内存限流：每个 IP 在窗口内最多 limit 次
function createLimiter(limit, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of hits) {
      const kept = arr.filter((t) => now - t < windowMs);
      if (kept.length) hits.set(k, kept); else hits.delete(k);
    }
  }, windowMs).unref();
  return (ip) => {
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (arr.length >= limit) { hits.set(ip, arr); return false; }
    arr.push(now);
    hits.set(ip, arr);
    return true;
  };
}
const searchLimiter = createLimiter(10, 60_000);

function diagnose(requestId, stage, category, status) {
  console.warn('[Music Companion]', JSON.stringify({ requestId, stage, category, status }));
}

function rejectCredential(res) {
  return sendJson(res, 400, { code: 'credential_detected', error: credentials.notice });
}

async function checkLocalPrivacy(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: '仅支持 POST' });
  const origin = localOrigin(req);
  if (!origin || req.headers.origin !== origin) return sendJson(res, 403, { error: '需要同源本机请求' });
  let body;
  try { body = await readJsonBody(req, backupFormat.maxBytes + 4096); }
  catch (error) {
    if (error.status === 413) res.once('finish', () => req.destroy());
    return sendJson(res, error.status === 413 ? 413 : 400, { error: '凭证检查请求无效或过大' });
  }
  if (!body || Object.keys(body).length !== 1) return sendJson(res, 400, { error: '凭证检查请求无效' });
  if (typeof body.message === 'string' && body.message.length <= 8000) {
    if (credentials.contains(body.message, config.deepseekKey)) return rejectCredential(res);
  } else if (body.backup) {
    if (credentials.inData(body.backup, config.deepseekKey)) return rejectCredential(res);
  } else {
    return sendJson(res, 400, { error: '凭证检查请求无效' });
  }
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

async function handleSearch(req, res, requestId) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: '仅支持 POST' });
  let body;
  try { body = await readJsonBody(req, 16 * 1024); }
  catch { return sendJson(res, 400, { error: '搜索请求格式无效' }); }
  const query = typeof body?.query === 'string' ? body.query.trim() : '';
  if (credentials.inData([body?.query, body?.context], config.deepseekKey)) return rejectCredential(res);
  const context = Array.isArray(body?.context) ? body.context.slice(-4)
    .filter(message => ['user', 'assistant'].includes(message?.role) && typeof message.content === 'string')
    .map(({ role, content }) => ({ role, content: content.slice(0, 600) })) : [];
  if (!query || query.length > 200) return sendJson(res, 400, { error: '请输入 1 到 200 字的搜索词' });
  if (!config.deepseekKey || !/^https:\/\/(?:token-plan\.)?maas\.qianwenaiapi\.com\/compatible-mode\/v1$/.test(config.deepseekBase)) {
    return sendJson(res, 503, { error: '联网搜索需要配置支持搜索的千问 AI 平台模型。' });
  }
  if (!searchLimiter(req.socket.remoteAddress || 'unknown')) return sendJson(res, 429, { error: '查询太频繁，请稍后再试' });
  try {
    const upstream = await fetch(config.deepseekBase + '/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.deepseekKey },
      body: JSON.stringify({
        model: config.deepseekModel,
        instructions: buildPersonaPrompt('search'),
        input: [...context, { role: 'user', content: query }],
        tools: [{ type: 'web_search' }],
        max_output_tokens: 1400
      }),
      signal: AbortSignal.timeout(60_000)
    });
    if (!upstream.ok) {
      diagnose(requestId, 'ai_search', 'upstream_http', upstream.status);
      void upstream.body?.cancel().catch(() => {});
      return sendJson(res, 502, { code: 'ai_search_unavailable', error: '千问联网搜索暂不可用，请稍后重试。' });
    }
    const data = await upstream.json();
    const output = data.output || [];
    const answer = output.filter(item => item.type === 'message')
      .flatMap(item => item.content || []).filter(part => part.type === 'output_text')
      .map(part => part.text).join('\n').trim();
    if (credentials.unsafeOutput(answer, config.deepseekKey)) {
      diagnose(requestId, 'ai_search', 'upstream_sensitive', 502);
      return sendJson(res, 502, { code: 'ai_search_unavailable', error: '搜索结果暂时不可用，请稍后重试。' });
    }
    if (context.length && answer.startsWith('[CLARIFY]')) {
      const clarification = answer.slice('[CLARIFY]'.length).trim();
      if (clarification) return sendJson(res, 200, { clarification });
    }
    const links = new Map();
    for (const item of output.filter(item => item.type === 'web_search_call')) {
      for (const source of item.action?.sources || []) {
        const link = typeof source === 'string' ? source : source?.url;
        if (typeof link !== 'string' || !/^https?:\/\//i.test(link) || links.has(link)) continue;
        const url = new URL(link);
        const title = typeof source?.title === 'string' ? source.title : url.hostname;
        if (url.username || url.password || credentials.inData(Object.fromEntries(url.searchParams), config.deepseekKey) ||
            credentials.unsafeOutput(link, config.deepseekKey) || credentials.unsafeOutput(title, config.deepseekKey)) continue;
        links.set(link, { url: link, title });
      }
    }
    return sendJson(res, 200, { answer, results: [...links.values()].sort((a,b) => Number(/(^|\.)mgtv\.com$/i.test(new URL(b.url).hostname)) - Number(/(^|\.)mgtv\.com$/i.test(new URL(a.url).hostname))).slice(0, 10) });
  } catch {
    diagnose(requestId, 'ai_search', 'upstream_unavailable', 502);
    return sendJson(res, 502, { code: 'ai_search_unavailable', error: '千问联网搜索连接失败或超时。' });
  }
}

const CHAT_BODY_BYTES = 64 * 1024;

// ───────────────────────── /api/chat ─────────────────────────
const ALLOWED_ROLES = new Set(['user', 'assistant']);

function validateChatPayload(body) {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) return '缺少 messages';
  if (body.mode !== undefined && !isChatMode(body.mode)) return '不支持的聊天模式';
  if (body.messages.length > 40) return 'messages 过多';
  for (const m of body.messages) {
    if (!m || !ALLOWED_ROLES.has(m.role) || typeof m.content !== 'string') return 'messages 格式不正确';
    if (m.content.length > 8000) return '单条消息过长';
  }
  return null;
}

function normalizeMusicContext(value) {
  if (!value || typeof value !== 'object') return null;
  const track = item => item && typeof item.song === 'string' && typeof item.artist === 'string'
    ? { song: item.song.trim().slice(0, 100), artist: item.artist.trim().slice(0, 100) } : null;
  const list = items => Array.isArray(items) ? items.slice(0, 3).map(track).filter(Boolean) : [];
  return { current: track(value.current), playing: value.playing === true,
    recent: list(value.recent), favorites: list(value.favorites) };
}

function normalizePlaylistReference(value) {
  const field = (text, limit) => typeof text === 'string' ? text.trim().slice(0, limit) : '';
  const name = field(value?.name, 60);
  if (!name || !Array.isArray(value.tracks)) return null;
  const tracks = value.tracks.slice(0, 12).map(track => ({
    song: field(track?.song, 100), artist: field(track?.artist, 100), phase: field(track?.phase, 40),
  })).filter(track => track.song && track.artist);
  return { name, description: field(value.description, 500), tracks };
}

async function handleChat(req, res, chatLimiter, memoryAccess, requestId) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: '仅支持 POST' });
  if (!config.deepseekKey) {
    return sendJson(res, 503, { code: 'ai_unconfigured', error: '服务端未配置 DEEPSEEK_API_KEY，请在本机配置自己的 Key。' });
  }
  if (!chatLimiter(req.socket.remoteAddress || 'unknown')) {
    return sendJson(res, 429, { error: '请求太频繁，请稍后再试' });
  }

  let body;
  try { body = await readJsonBody(req, CHAT_BODY_BYTES); }
  catch (e) {
    if (e.status === 413) res.once('finish', () => req.destroy());
    return sendJson(res, e.status === 413 ? 413 : 400, { error: e.status === 413 ? '请求体过大' : '聊天请求格式无效' });
  }

  const problem = validateChatPayload(body);
  if (problem) return sendJson(res, 400, { error: problem });

  if (credentials.inData([body.messages.map(message => message.content), body.summary, body.recentPlayed,
    body.musicContext, body.playlistReference], config.deepseekKey)) return rejectCredential(res);

  const mode = body.mode ?? 'chat';
  const playlistDraft = mode === 'music' && body.musicIntent === 'playlist_draft';
  if (playlistDraft && body.messages.at(-1).role !== 'user') {
    return sendJson(res, 400, { error: '歌单生成需要本轮用户需求' });
  }
  const summary = !playlistDraft && mode !== 'summary' && typeof body.summary === 'string' ? body.summary.slice(0, 1200).trim() : '';
  const recentPlayed = !playlistDraft && mode === 'music' && typeof body.recentPlayed === 'string' ? body.recentPlayed.slice(0, 800).trim() : '';
  let musicContext = mode === 'music' ? normalizeMusicContext(body.musicContext) : null;
  if (playlistDraft && musicContext) musicContext = { recent: musicContext.recent, favorites: musicContext.favorites };
  const playlistReference = playlistDraft ? normalizePlaylistReference(body.playlistReference) : null;
  const background = summary || recentPlayed || musicContext || playlistReference
    ? [{ role: 'user', content: '【背景资料】\n' + JSON.stringify({
      summary, recentPlayed, ...(musicContext ? { musicContext } : {}), ...(playlistReference ? { playlistReference } : {}),
    }) }]
    : [];
  // 人格、模型和任务规则由服务端构造，浏览器只提交模式与对话数据。
  const payload = {
    model: config.deepseekModel,
    messages: [
      { role: 'system', content: buildPersonaPrompt(mode, body) },
      ...background,
      ...(playlistDraft ? body.messages.slice(-1) : body.messages).map(({ role, content }) => ({ role, content })),
      ...(mode === 'summary' ? [{ role: 'user', content: '请根据以上对话资料更新会话摘要。' }] : []),
    ],
    temperature: Math.min(Math.max(Number(body.temperature) || 0.85, 0), 1.5),
    max_tokens: Math.min(Math.max(parseInt(body.max_tokens, 10) || 1400, 1), 2000),
    stream: true,
  };
  if (mode === 'summary' && ['deepseek-v4-pro', 'deepseek-v4-pro-0813'].includes(config.deepseekModel)) {
    payload.enable_thinking = false;
  }

  const ac = new AbortController();
  res.on('close', () => ac.abort());
  await addMemoryContext(payload, req, mode, memoryAccess, CHAT_BODY_BYTES, { playlistDraft });
  if (ac.signal.aborted || res.destroyed) return;
  // Guard data added by retrieval, including memories written by older releases.
  if (payload.messages.some(message => credentials.contains(message.content, config.deepseekKey))) {
    return rejectCredential(res);
  }

  let upstream;
  try {
    upstream = await fetch(`${config.deepseekBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.deepseekKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
  } catch {
    if (ac.signal.aborted || res.destroyed) return;
    diagnose(requestId, 'ai_chat', 'upstream_unavailable', 502);
    return sendJson(res, 502, { code: 'ai_unavailable', error: '无法连接 AI 服务，请检查配置或稍后重试。' });
  }

  if (!upstream.ok || !upstream.body) {
    const status = upstream.ok || upstream.status === 401 ? 502 : upstream.status;
    diagnose(requestId, 'ai_chat', 'upstream_http', upstream.status);
    void upstream.body?.cancel().catch(() => {});
    return sendJson(res, status, { code: 'ai_upstream_error', error: 'AI 服务暂时不可用，请检查配置或稍后重试。' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  await sendAIStream(upstream.body, res, config.deepseekKey,
    category => diagnose(requestId, 'ai_stream', category, upstream.status));
}

// ───────────────────────── /ncm/*（白名单反向代理）─────────────────────────
const { NCM_ALLOWED } = require('./ncm-routes');

const NCM_COOKIE_POST = new Set(['/cloudsearch', '/song/url', '/lyric']);

async function handleNcm(req, res, url) {
  const sub = url.pathname.slice('/ncm'.length) || '/';
  if (!NCM_ALLOWED.has(sub)) return sendJson(res, 404, { error: '接口不在白名单内' });
  url.searchParams.delete('proxy');
  const options = { signal: AbortSignal.timeout(config.upstreamTimeoutMs) };
  if (req.method === 'POST' && NCM_COOKIE_POST.has(sub)) {
    let body;
    try { body = await readJsonBody(req); }
    catch (error) {
      if (error.status === 413) res.once('finish', () => req.destroy());
      return sendJson(res, error.status || 400, { error: '音乐请求格式无效' });
    }
    if (typeof body?.cookie !== 'string' || !body.cookie.trim()) {
      return sendJson(res, 400, { error: '音乐请求缺少登录凭证' });
    }
    url.searchParams.delete('cookie');
    options.method = 'POST';
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify({ cookie: body.cookie });
  } else if (req.method !== 'GET') {
    return sendJson(res, 405, { error: '不支持的方法' });
  }

  try {
    const upstream = await fetch(`${config.ncmUrl}${sub}${url.search}`, options);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch (e) {
    sendJson(res, 502, { error: '网易云 API 不可用，请确认其服务已启动' });
  }
}

// ───────────────────────── 静态文件 ─────────────────────────
function serveStatic(req, res, url, requestId) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '不支持的方法' });
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return sendJson(res, 400, { error: '路径不合法' }); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(WEB_DIR, rel));
  if (file !== WEB_DIR && !file.startsWith(WEB_DIR + path.sep)) {
    return sendJson(res, 403, { error: '禁止访问' }); // 防目录穿越
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: '未找到' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => {
      diagnose(requestId, 'static', 'read_error', 500);
      res.destroy();
    }).pipe(res);
  });
}

// ───────────────────────── 路由 ─────────────────────────
function createServer({ memoryStore, backupOptions, backupEnabled = true, backupUnavailable = false, cleanupAtStartup = false } = {}) {
  const memoryAccess = createMemoryAccess(memoryStore);
  let backupRotation;
  const deletionRotation = backupUnavailable ? () => { throw new Error('自动备份目录配置无效'); }
    : backupOptions && (() => backupRotation ??= createBackupRotation(backupOptions));
  const rotation = backupEnabled && !backupUnavailable ? deletionRotation : undefined;
  const handleMemory = createMemoryHandler({ access: memoryAccess, sendJson, readJsonBody, rotation, deletionRotation, extract: createExtractor(config) });
  const chatLimiter = createLimiter(30, 60_000);
  const app = http.createServer(handleRequest);
  if (cleanupAtStartup || memoryStore || rotation) app.once('listening', () => {
    void (async () => {
      const result = await cleanupAtomicTemps({ memoryDirectory: memoryAccess.getStore().directory,
        backupDirectory: backupOptions?.directory, disk: backupOptions?.disk });
      if (result.retained || result.failed) console.warn('[Music Companion] 临时文件检查保留了归属不明、可能仍在使用或无法清理的文件。');
    })().catch(() => console.warn('[Music Companion] 临时文件检查失败，已保留现有文件。'));
  });
  if (rotation) app.once('listening', () => {
    const stop = startMemoryBackups(memoryAccess.getStore(), rotation(), backupOptions.intervalMs, report => {
      if (report.damaged || report.failed) console.warn('[Music Companion] 自动备份检查发现异常，请检查备份目录。');
    });
    app.once('close', stop);
  });
  return app;

  async function handleRequest(req, res) {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    try {
      const url = new URL(req.url, 'http://localhost');
      const origin = localOrigin(req);
      const isApi = /^\/(?:api|ncm)(?:\/|$)/.test(url.pathname);
      if (!origin || (req.headers.origin !== undefined && req.headers.origin !== origin) ||
          (isApi && req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
        return sendJson(res, 403, { error: '服务仅接受本机同源访问' });
      }
      if (url.pathname.startsWith('/api/memory/')) return await handleMemory(req, res, url);
      if (url.pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, chatConfigured: Boolean(config.deepseekKey), model: credentials.unsafeOutput(config.deepseekModel, config.deepseekKey) ? '' : config.deepseekModel });
      }
      if (url.pathname === '/api/privacy/check') return await checkLocalPrivacy(req, res);
      if (url.pathname === '/api/search') return await handleSearch(req, res, requestId);
      if (url.pathname === '/api/chat') return await handleChat(req, res, chatLimiter, memoryAccess, requestId);
      if (url.pathname === '/ncm' || url.pathname.startsWith('/ncm/')) return await handleNcm(req, res, url);
      return serveStatic(req, res, url, requestId);
    } catch {
      diagnose(requestId, 'request', 'internal_error', 500);
      if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误' });
      else res.end();
    }
  }
}

function localBackupOptions() {
  const memoryDirectory = require('./memory-store').defaultMemoryDirectory();
  const directory = process.env.ZILY_BACKUP_DIR || path.join(path.dirname(memoryDirectory), 'backups');
  const relative = path.relative(ROOT, directory);
  const hours = Number(process.env.ZILY_BACKUP_INTERVAL_HOURS ?? 24);
  const retention = Number(process.env.ZILY_BACKUP_RETENTION ?? 5);
  if (!path.isAbsolute(directory) || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) ||
      !Number.isFinite(hours) || hours < 1 || hours > 168 || !Number.isInteger(retention) || retention < 1 || retention > 100) {
    throw new Error('自动备份配置无效。');
  }
  return { directory, intervalMs: Math.round(hours * 3600000), retention };
}

let backupOptions;
let backupUnavailable = false;
if (require.main === module) {
  try { backupOptions = localBackupOptions(); }
  catch { backupUnavailable = true; console.warn('[Music Companion] 自动备份配置无效，本次启动已停用自动备份。'); }
}
const server = createServer({ backupOptions, backupUnavailable, backupEnabled: process.env.ZILY_BACKUP_ENABLED !== 'false', cleanupAtStartup: require.main === module });

if (require.main === module) {
  server.once('error', () => {
    diagnose(randomUUID(), 'startup', 'listen_error', 500);
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    console.log(`[Music Companion] 网页服务已启动，端口 ${config.port}`);
    if (!config.deepseekKey) console.warn('[Music Companion] 提示：未配置 DEEPSEEK_API_KEY，请配置自己的模型 Key');
  });
}

module.exports = { server, config, createServer };
