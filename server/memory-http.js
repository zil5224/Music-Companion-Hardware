'use strict';

const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const { createMemoryStore } = require('./memory-store');
const { manageItems, MemoryItemError } = require('./memory-items');

const { createDiscoveryHandler } = require('./memory-discovery');
const { createBackupActions, setIdentityCookie, identityLifetime: MAX_AGE } = require('./memory-backup-http');

const COOKIE_NAME = 'zily_memory';
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

function isLoopback(address) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
}

function localOrigin(req) {
  if (!isLoopback(req.socket.remoteAddress) || !isLoopback(req.socket.localAddress)) return null;
  const protocol = req.socket.encrypted ? 'https:' : 'http:';
  const defaultPort = req.socket.encrypted ? 443 : 80;
  const port = req.socket.localPort;
  if (!port) return null;
  const suffix = port === defaultPort ? '' : ':' + port;
  const host = req.headers.host?.toLowerCase();
  for (const allowedHost of LOOPBACK_HOSTS) {
    if (host === allowedHost + suffix || (port === defaultPort && host === allowedHost + ':' + port)) {
      return protocol + '//' + allowedHost + suffix;
    }
  }
  return null;
}

function readToken(header = '') {
  const cookies = header.split(';').map(value => value.trim()).filter(value => value.startsWith(COOKIE_NAME + '='));
  if (cookies.length !== 1) return null;
  const token = cookies[0].slice(COOKIE_NAME.length + 1);
  return /^(?:v2\.[a-f0-9]{64}\.)?[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

function profileFor(token) {
  return createHash('sha256').update(token).digest('hex');
}

function createMemoryAccess(store) {
  function getStore() {
    return store ??= createMemoryStore();
  }

  async function resolve(req) {
    const origin = localOrigin(req);
    if (!origin || (req.headers.origin !== undefined && req.headers.origin !== origin)) return null;
    const token = readToken(req.headers.cookie);
    if (!token) return null;
    const parts = token.split('.');
    const renewed = parts.length === 3;
    const profileId = renewed ? parts[1] : profileFor(token);
    const current = await getStore().read(profileId);
    if (!current) return null;
    if (renewed) {
      const { hash, expiresAt } = current.identity || {};
      if (!/^[a-f0-9]{64}$/.test(hash || '') || !(Date.now() < Date.parse(expiresAt)) ||
          !timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(profileFor(parts[2]), 'hex'))) return null;
    } else {
      const expiresAt = current.identityExpiresAt ? Date.parse(current.identityExpiresAt) : Date.parse(current.createdAt) + MAX_AGE * 1000;
      if (current.identity || Date.now() >= expiresAt) return null;
    }
    const generation = current.identityEpoch || 0;
    const expires = renewed ? Date.parse(current.identity.expiresAt) :
      current.identityExpiresAt ? Date.parse(current.identityExpiresAt) : Date.parse(current.createdAt) + MAX_AGE * 1000;
    const authorizedStore = getStore().forIdentity(latest =>
      Date.now() < expires && (!latest || ((latest.identityEpoch || 0) === generation &&
        latest.identity?.hash === current.identity?.hash)));
    return { profileId, current, authorizedStore };
  }

  return { getStore, resolve };
}

function createMemoryHandler({ store, access = createMemoryAccess(store), sendJson, readJsonBody, extract, rotation, deletionRotation = rotation }) {
  const discovery = createDiscoveryHandler(extract);
  const backup = createBackupActions({ access, rotation, sendJson, readJsonBody });
  return async function handleMemory(req, res, url) {
    const origin = localOrigin(req);
    if (!origin || (req.headers.origin !== undefined && req.headers.origin !== origin)) {
      return sendJson(res, 403, { error: '长期记忆仅支持同源本机访问' });
    }

    const backupRoute = /^\/api\/memory\/backup\/(export|state|restore|settle|auto|recover|recovery-setup)$/.exec(url.pathname)?.[1];
    if (backupRoute) {
      if (url.search || (req.method !== 'GET' && req.headers.origin !== origin)) {
        return sendJson(res, 403, { error: '备份与恢复需要同源本机请求。' });
      }
      try { return await backup(backupRoute, req, res); }
      catch (error) { return handleMemoryError(error, res); }
    }

    const activation = url.pathname === '/api/memory/activate';
    const statusRequest = url.pathname === '/api/memory/status';
    const settings = url.pathname === '/api/memory/settings';
    if (settings) res.setHeader('Cache-Control', 'no-store');
    const discoveryRoute = /^\/api\/memory\/(discovery|extract|candidates)$/.exec(url.pathname)?.[1];
    if (discoveryRoute) res.setHeader('Cache-Control', 'no-store');
    const collection = url.pathname === '/api/memory/items';
    const itemId = url.pathname.match(/^\/api\/memory\/items\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/)?.[1];
    if (!activation && !statusRequest && !settings && !discoveryRoute && !collection && !itemId) {
      return sendJson(res, 404, { error: '未找到记忆接口' });
    }
    const methods = discoveryRoute === 'extract' ? ['POST'] : discoveryRoute === 'discovery' ? ['GET', 'PATCH']
      : discoveryRoute === 'candidates' ? ['GET', 'POST'] : activation ? ['POST'] : statusRequest ? ['GET'] : collection
      ? ['GET', 'POST', 'DELETE'] : settings ? ['GET', 'PATCH'] : ['PATCH', 'DELETE'];
    if (!methods.includes(req.method)) return sendJson(res, 405, { error: '不支持的方法' });
    if (req.method !== 'GET' && req.headers.origin !== origin) {
      return sendJson(res, 403, { error: '修改长期记忆需要同源请求' });
    }
    const expectsBody = (discoveryRoute && req.method !== 'GET') || collection && req.method !== 'GET' || req.method === 'PATCH' || (itemId && req.method === 'DELETE');
    const hasBody = req.headers['transfer-encoding'] ||
      (req.headers['content-length'] && req.headers['content-length'] !== '0');
    if (url.search || (!expectsBody && hasBody)) {
      return sendJson(res, 400, { error: '记忆接口不接受查询参数或多余的请求体' });
    }

    try {
      const { profileId, current, authorizedStore } = await access.resolve(req) ?? {};
      if (collection || itemId || settings || discoveryRoute) {
        if (!current) return sendJson(res, 401, { error: '长期记忆尚未启用，或当前身份已过期' });
        let body;
        if (expectsBody) {
          if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
            return sendJson(res, 415, { error: '记忆请求需要 JSON 格式' });
          }
          try { body = await readJsonBody(req, discoveryRoute === 'extract' ? 48 * 1024 : 8192); }
          catch (error) {
            if (error.status === 413) res.once('finish', () => req.destroy());
            return sendJson(res, error.status || 400, { error: '记忆请求格式无效或过大' });
          }
        }
        if (discoveryRoute) {
          const result = await discovery(discoveryRoute, req.method, body, authorizedStore, profileId, current, res);
          if (!res.destroyed) return sendJson(res, result.status, result.body);
          return;
        }
        if (settings) {
          if (req.method === 'GET') return sendJson(res, 200, { useInChat: current.useInChat === true });
          if (!body || Object.keys(body).length !== 1 || typeof body.useInChat !== 'boolean') {
            return sendJson(res, 400, { error: '只接受布尔类型的 useInChat' });
          }
          const saved = await authorizedStore.updateSettings(profileId, body.useInChat);
          return sendJson(res, 200, { useInChat: saved.useInChat });
        }
        const result = await manageItems(authorizedStore, profileId, current, req.method, itemId, body,
          async (latest, fields) => {
            try {
              await authorizedStore.assertNoTemps(profileId);
              await deletionRotation?.()?.removeMemory(profileId, latest, fields);
            }
            catch { throw new MemoryItemError(503, '无法清除自动备份中的记忆，资料库未删除。请检查本机备份和临时文件。'); }
          },
          () => discovery.pendingEvidence(profileId));
        return sendJson(res, result.status, result.body);
      }
      if (current) return sendJson(res, 200, { enabled: true, schemaVersion: current.schemaVersion });
      if (!activation) return sendJson(res, 200, { enabled: false });

      const newToken = randomBytes(32).toString('base64url');
      const created = await access.getStore().initialize(profileFor(newToken), new Date(Date.now() + MAX_AGE * 1000).toISOString());
      setIdentityCookie(req, res, newToken);
      return sendJson(res, 201, { enabled: true, schemaVersion: created.schemaVersion });
    } catch (error) { return handleMemoryError(error, res); }
  };

  function handleMemoryError(error, res) {
    if (error instanceof MemoryItemError) return sendJson(res, error.status, { error: error.message });
    if (error.code === 'not-found') return sendJson(res, 401, { error: '当前记忆身份已失效' });
    if (error.code === 'size-limit') return sendJson(res, 413, { error: '记忆资料库已达容量上限' });
    if (error.code === 'corrupt') return sendJson(res, 500, { error: '记忆资料库损坏，原文件已保留' });
    if (error.code === 'unsupported-version') return sendJson(res, 409, { error: '不支持该记忆资料库版本' });
    return sendJson(res, 500, { error: '暂时无法访问记忆资料库' });
  }
}

module.exports = { createMemoryAccess, createMemoryHandler, localOrigin };
