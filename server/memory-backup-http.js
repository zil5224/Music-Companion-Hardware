'use strict';

const { createHash, randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const format = require('../web/js/22-backup-format');
const { digest, memoryData, memoryLineage, deletionFilter, verify } = require('./backup-store');
const { fingerprint } = require('./memory-relations');
const { MemoryItemError } = require('./memory-items');

const derive = promisify(scrypt);
const identityLifetime = 180 * 24 * 60 * 60;
const freshRestoreLifetime = 24 * 60 * 60_000;
const freshRestoreClockSkew = 5 * 60_000;
const reject = (status, message) => { throw new MemoryItemError(status, message); };
const passwordOK = value => typeof value === 'string' && value.length >= 12 && value.length <= 128;
const exact = (value, ...fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const confirmed = body => body?.confirm === true;
const memoryState = (id, profile) => digest([id, profile]);
const hasMemory = profile => Boolean(profile.memories.length || profile.discovery?.candidates?.length);

function setIdentityCookie(req, res, token) {
  const secure = req.socket.encrypted ? '; Secure' : '';
  res.setHeader('Set-Cookie', 'zily_memory=' + token +
    '; Max-Age=' + identityLifetime + '; Path=/api; HttpOnly; SameSite=Strict' + secure);
}

function restoredFields(memory, discoveryEpoch, latest = {}, profileId, now = Date.now()) {
  const source = memory.suppression || {};
  const target = latest.discovery || {};
  const union = (a = [], b = []) => [...new Set([...a, ...b])];
  const rejected = new Map();
  for (const entry of [...(target.rejected || []), ...(source.rejected || [])]) {
    const until = Date.parse(entry.suppressUntil);
    if (!(until > now) || !format.hex(entry.digest)) continue;
    if (!rejected.has(entry.digest) || until > Date.parse(rejected.get(entry.digest).suppressUntil)) {
      rejected.set(entry.digest, entry);
    }
  }
  const deletion = {
    ids: union(latest.deletion?.ids, memory.deletion?.ids),
    messages: union(latest.deletion?.messages, memory.deletion?.messages),
  };
  const cleared = latest.clearEpoch && (memory.lineage !== memoryLineage(profileId) ||
    (memory.clearEpoch || 0) < latest.clearEpoch);
  const blocked = deletionFilter(deletion);
  const keep = item => !cleared && !blocked(item);
  const processed = union(target.processed, source.processed);
  const processedIds = new Set(processed);
  const skipped = union(target.skipped, source.skipped).filter(id => !processedIds.has(id));
  return { memories: memory.memories.filter(keep), useInChat: memory.useInChat,
    autoExtractEnabled: memory.autoExtractEnabled, discoveryEpoch,
    ...(deletion.ids.length || deletion.messages.length ? { deletion } : {}),
    ...(latest.clearEpoch || memory.clearEpoch ? { clearEpoch: Math.max(latest.clearEpoch || 0, memory.clearEpoch || 0) } : {}),
    discovery: { candidates: memory.candidates.filter(item => keep(item) && !rejected.has(fingerprint(item.content))), processed, skipped,
      rejected: [...rejected.values()], lastExtractedAt: target.lastExtractedAt || 0 } };
}

function checkRestoreMemory(body) {
  if (!confirmed(body)) reject(400, '恢复需要明确确认。');
  try { format.checkMemory(body.memory); }
  catch (error) { reject(422, error.message); }
}

function readRestoreState(profileId, current) {
  return { target: profileId, expected: memoryState(profileId, current), occupied: hasMemory(current),
    useInChat: current.useInChat === true, autoExtractEnabled: current.autoExtractEnabled === true,
    ...(current.clearEpoch ? { clearEpoch: current.clearEpoch, lineage: memoryLineage(profileId) } : {}),
    ...(current.deletion ? { deletion: current.deletion } : {}),
    suppression: { rejected: current.discovery?.rejected?.filter(item => Date.parse(item.suppressUntil) > Date.now()).length || 0,
      processed: current.discovery?.processed?.length || 0, skipped: current.discovery?.skipped?.length || 0 } };
}

function createBackupActions({ access, rotation, sendJson, readJsonBody, clock = Date.now }) {
  let recent = [];
  let deriving = false;
  async function passwordHash(password, salt) {
    const now = clock();
    recent = recent.filter(at => now - at < 60_000);
    if (deriving || recent.length >= 8) reject(429, '恢复请求过于频繁，请稍后重试。');
    deriving = true;
    recent.push(now);
    try { return await derive(password, Buffer.from(salt, 'hex'), 32); }
    finally { deriving = false; }
  }

  async function restoreFresh(route, req, res, store, body) {
    const restoring = route === 'restore';
    const fields = restoring ? ['id', 'proof', 'issuedAt', 'confirm', 'memory'] : ['id', 'proof', 'issuedAt'];
    if (!exact(body, ...fields) || !format.uuid(body.id) || !format.hex(body.proof) ||
        !Number.isSafeInteger(body.issuedAt) || body.issuedAt <= 0 || body.issuedAt > clock() + freshRestoreClockSkew) {
      reject(400, '新身份恢复事务无效。');
    }
    if (restoring) checkRestoreMemory(body);
    const canCreate = () => clock() - body.issuedAt < freshRestoreLifetime;
    const token = createHash('sha256').update('zily-fresh-restore-v1:' + body.id + ':' + body.issuedAt + ':' + body.proof).digest('base64url');
    const target = createHash('sha256').update(token).digest('hex');
    const active = await access.resolve(req);
    if (restoring && active && active.profileId !== target) reject(409, '当前浏览器已连接其他资料库。');
    const data = restoring ? { ...restoredFields(body.memory, 1, {}, target, clock()),
      identityExpiresAt: new Date(clock() + identityLifetime * 1000).toISOString(),
      backupReceipts: [{ id: body.id, committed: true }] } : null;
    const profile = await store.restoreNew(target, data, canCreate);
    if (!profile) {
      if (restoring) reject(409, '该恢复事务已撤销或过期。');
      return sendJson(res, 200, { committed: false });
    }
    if (!profile.backupReceipts?.some(receipt => receipt.id === body.id && receipt.committed)) {
      reject(409, '恢复回执与事务不匹配。');
    }
    if (active?.profileId !== target) {
      if (active || !canCreate() || profile.identity || !(clock() < Date.parse(profile.identityExpiresAt))) {
        reject(409, '恢复已提交，但无法重新连接。请保留恢复日志并检查当前身份。');
      }
      setIdentityCookie(req, res, token);
    }
    return sendJson(res, 200, { committed: true });
  }

  return async function handleBackup(route, req, res) {
    const get = route === 'export' || route === 'state';
    if (req.method !== (get ? 'GET' : 'POST')) return sendJson(res, 405, { error: '不支持的方法。' });
    const store = access.getStore();
    if (get) {
      const identity = await access.resolve(req);
      if (!identity) return sendJson(res, 401, { error: '请先启用或恢复长期记忆身份。' });
      let result;
      try {
        result = route === 'export' ? memoryData(identity.current, identity.profileId) : readRestoreState(identity.profileId, identity.current);
      } catch { reject(422, '记忆数据未通过备份结构或凭证检查。'); }
      return sendJson(res, 200, result);
    }

    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      return sendJson(res, 415, { error: '备份请求需要 JSON。' });
    }
    const identityAtStart = await access.resolve(req);
    let body;
    try { body = await readJsonBody(req, route === 'auto' || route === 'restore' ? format.maxBytes + 4096 : 8192); }
    catch (error) {
      if (error.status === 413) res.once('finish', () => req.destroy());
      return sendJson(res, error.status || 400, { error: '备份请求无效或过大。' });
    }

    if (route === 'auto') {
      if (!rotation) reject(503, '本机自动备份不可用。');
      const owner = identityAtStart;
      if (!owner) reject(401, '自动备份需要有效的长期记忆身份。');
      if (!exact(body, 'file')) reject(400, '自动备份请求无效。');
      let backup;
      try { backup = verify(body.file); }
      catch (error) { reject(422, error.message); }
      if (backup.scope !== 'all') reject(400, '自动浏览器备份需要完整范围。');
      return sendJson(res, 200, await owner.authorizedStore.inspect(owner.profileId, latest =>
        rotation().save('browser-' + owner.profileId, format.createBody('all', backup.modules.browser, memoryData(latest, owner.profileId)))));
    }

    if (route === 'recover') {
      if (!exact(body, 'recoveryId', 'password', 'confirm') || !confirmed(body) ||
          !format.hex(body.recoveryId) || !passwordOK(body.password)) reject(400, '请输入有效的恢复编号和口令，并确认恢复。');
      const active = await access.resolve(req);
      if (active && active.profileId !== body.recoveryId &&
          (hasMemory(active.current) || active.current.useInChat || active.current.autoExtractEnabled || active.current.recovery)) {
        reject(409, '当前浏览器已经连接其他有资料的记忆库。请使用新的浏览器配置文件恢复。');
      }
      const profile = await store.read(body.recoveryId);
      const recovery = profile?.recovery;
      const salt = /^[a-f0-9]{32}$/.test(recovery?.salt || '') ? recovery.salt : '0'.repeat(32);
      const calculated = await passwordHash(body.password, salt);
      if (!format.hex(recovery?.hash) || !timingSafeEqual(calculated, Buffer.from(recovery.hash, 'hex'))) {
        reject(403, '恢复编号或口令不正确。');
      }
      const token = randomBytes(32).toString('base64url');
      await store.mutate(body.recoveryId, latest => {
        if (latest.recovery?.hash !== recovery.hash || latest.recovery?.salt !== salt) reject(409, '恢复设置已更改，请重试。');
        return { identityEpoch: (latest.identityEpoch || 0) + 1,
          discoveryEpoch: (latest.discoveryEpoch || 0) + 1,
          identity: { hash: createHash('sha256').update(token).digest('hex'),
          expiresAt: new Date(clock() + identityLifetime * 1000).toISOString() } };
      });
      setIdentityCookie(req, res, 'v2.' + body.recoveryId + '.' + token);
      return sendJson(res, 200, { enabled: true });
    }

    if ((route === 'restore' || route === 'settle') && body && Object.hasOwn(body, 'proof')) {
      if (identityAtStart) await identityAtStart.authorizedStore.read(identityAtStart.profileId);
      return restoreFresh(route, req, res, store, body);
    }
    const identity = identityAtStart;
    if (!identity) reject(401, '请先启用或恢复长期记忆身份。');
    const { profileId, current, authorizedStore } = identity;
    if (route === 'recovery-setup') {
      if (!exact(body, 'password', 'confirm') || !confirmed(body) || !passwordOK(body.password)) {
        reject(400, '恢复口令须为 12 至 128 个字符，请确认设置。');
      }
      const salt = randomBytes(16).toString('hex');
      const hash = (await passwordHash(body.password, salt)).toString('hex');
      await authorizedStore.mutate(profileId, latest => {
        if (memoryState(profileId, latest) !== memoryState(profileId, current)) reject(409, '记忆资料已更新，请重试。');
        return { recovery: { salt, hash } };
      });
      return sendJson(res, 200, { recoveryId: profileId });
    }

    const restoring = route === 'restore';
    const fields = restoring ? ['id', 'target', 'expected', 'confirm', 'memory'] : ['id', 'target', 'expected'];
    if (!exact(body, ...fields) || !format.uuid(body.id) || !format.hex(body.expected) || !format.hex(body.target)) {
      reject(400, '恢复事务无效。');
    }
    if (body.target !== profileId) reject(409, '当前浏览器身份与恢复目标不同。');
    if (restoring) checkRestoreMemory(body);
    let committed = false;
    await authorizedStore.mutate(profileId, latest => {
      const receipts = latest.backupReceipts || [];
      const receipt = receipts.find(item => item.id === body.id);
      if (receipt) {
        committed = receipt.committed;
        if (restoring && !committed) reject(409, '该恢复事务已撤销。');
        return null;
      }
      if (memoryState(profileId, latest) !== body.expected) {
        if (!restoring) return null; // A changed baseline also fences a delayed restore request.
        reject(409, '预览后长期记忆已变化，请重新检查冲突。');
      }
      if (receipts.length >= 128) reject(409, '此资料库的恢复事务记录已满。');
      if (!restoring) return { backupReceipts: [...receipts, { id: body.id, committed: false }] };
      const memory = body.memory;
      if (hasMemory(latest) || (latest.useInChat === true && !memory.useInChat) ||
          (latest.autoExtractEnabled === true && !memory.autoExtractEnabled)) reject(409, '当前资料库有冲突，请保留现有资料。');
      committed = true;
      return { ...restoredFields(memory, (latest.discoveryEpoch || 0) + 1, latest, profileId, clock()),
        backupReceipts: [...receipts, { id: body.id, committed: true }] };
    });
    return sendJson(res, 200, { committed });
  };
}

module.exports = { createBackupActions, setIdentityCookie, identityLifetime };
