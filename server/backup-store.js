'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { hostname } = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const format = require('../web/js/22-backup-format');

const localHostTag = createHash('sha256').update(hostname().toLowerCase()).digest('hex').slice(0, 16);
const tempMaxAgeMs = 24 * 60 * 60_000;

function digest(value) {
  return createHash('sha256').update(format.canonical(value)).digest('hex');
}

function pack(body) {
  const file = { ...format.checkBody(body), sha256: digest(body) };
  if (Buffer.byteLength(JSON.stringify(file)) > format.maxBytes) throw new Error('备份文件过大。');
  return file;
}

function verify(file) {
  const { body, sha256 } = format.split(file);
  if (digest(body) !== sha256) throw new Error('备份完整性校验失败。');
  return body;
}

function memoryData(profile, id) {
  const state = profile.discovery || {};
  const processed = (state.processed || []).filter(format.uuid);
  const skipped = (state.skipped || []).filter(format.uuid);
  const rejected = (state.rejected || []).filter(entry => format.hex(entry?.digest));
  const suppression = processed.length || skipped.length || rejected.length ? { processed, skipped, rejected } : undefined;
  return format.checkMemory({ version: 1, useInChat: profile.useInChat === true,
    autoExtractEnabled: profile.autoExtractEnabled === true, memories: profile.memories,
    candidates: profile.discovery?.candidates || [],
    ...(suppression ? { suppression } : {}),
    ...(profile.deletion ? { deletion: profile.deletion } : {}),
    ...(profile.clearEpoch ? { clearEpoch: profile.clearEpoch, ...(id ? { lineage: memoryLineage(id) } : {}) } : {}),
  });
}

const memoryLineage = id => digest(['memory-lineage', id]);
function deletionFilter(deletion) {
  const ids = new Set(deletion?.ids);
  const messages = new Set(deletion?.messages);
  return item => ids.has(item.id) || (item.evidence || []).some(entry => messages.has(entry.messageId));
}

async function syncDirectory(directory, disk) {
  let handle;
  try {
    handle = await disk.open(directory, 'r');
    await handle.sync();
  } catch {
    // Windows and some filesystems cannot flush a directory handle via Node.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function atomicWrite(file, bytes, disk = fs, shouldCommit = () => true) {
  const directory = path.dirname(file);
  const temp = file + '.zily-' + localHostTag + '-' + process.pid + '.' + randomUUID() + '.tmp';
  let handle;
  let created = false;
  try {
    await disk.mkdir(directory, { recursive: true, mode: 0o700 });
    handle = await disk.open(temp, 'wx', 0o600);
    created = true;
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    if (!shouldCommit()) return false;
    await disk.rename(temp, file);
    await syncDirectory(directory, disk);
    return true;
  } finally {
    await handle?.close().catch(() => {});
    if (created) await disk.unlink(temp).catch(() => {});
  }
}

const bucketName = /^(?:memory-[a-f0-9]{64}|browser-[a-f0-9]{64})$/i;
const snapshotName = /^\d{13}-[a-f0-9-]{36}\.json$/i;

const profileTargetName = /^[a-f0-9]{64}\.json(?:\.restore-cancelled)?$/i;
const ownedTempName = /^(.+)\.zily-([a-f0-9]{16})-([1-9]\d{0,9})\.([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.tmp$/i;
const legacyTempName = /^(.+)\.([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.tmp$/i;

async function assertNoMemoryTemps(directory, isTarget, disk = fs) {
  let names;
  try { names = await disk.readdir(directory); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (names.some(name => {
    const target = (ownedTempName.exec(name) || legacyTempName.exec(name))?.[1];
    return target && isTarget(target);
  })) throw new Error('尚有未确认清理的记忆写入临时文件。');
}

function ownerIsGone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

async function cleanupAtomicTemps({ memoryDirectory, backupDirectory, disk = fs, clock = Date.now }) {
  const result = { removed: 0, retained: 0, failed: 0 };
  const cutoff = clock() - tempMaxAgeMs;

  async function directoryEntries(directory) {
    try {
      const stat = await disk.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) { result.retained++; return []; }
      return await disk.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') result.failed++;
      return [];
    }
  }

  async function scan(directory, targetPattern) {
    for (const entry of await directoryEntries(directory)) {
      const owner = ownedTempName.exec(entry.name);
      const target = (owner || legacyTempName.exec(entry.name))?.[1];
      if (!target || !targetPattern.test(target)) continue;
      const file = path.join(directory, entry.name);
      try {
        const stat = await disk.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink()) { result.retained++; continue; }
        if (!(stat.mtimeMs < cutoff)) continue;
        const pid = Number(owner?.[3]);
        if (!owner || owner[2] !== localHostTag || pid === process.pid || !ownerIsGone(pid)) {
          result.retained++;
          continue;
        }
        const latest = await disk.lstat(file);
        if (!latest.isFile() || latest.isSymbolicLink() || latest.ino !== stat.ino || latest.dev !== stat.dev ||
            latest.mtimeMs !== stat.mtimeMs || latest.size !== stat.size) {
          result.retained++;
          continue;
        }
        await disk.unlink(file);
        result.removed++;
      } catch (error) { if (error.code !== 'ENOENT') result.failed++; }
    }
  }

  if (memoryDirectory) await scan(memoryDirectory, profileTargetName);
  if (backupDirectory) {
    for (const entry of await directoryEntries(backupDirectory)) {
      if (entry.isDirectory() && bucketName.test(entry.name)) await scan(path.join(backupDirectory, entry.name), snapshotName);
    }
  }
  return result;
}

function createBackupRotation({ directory, intervalMs = 24 * 60 * 60_000, retention = 5, disk = fs, clock = Date.now }) {
  if (!path.isAbsolute(directory) || !Number.isSafeInteger(intervalMs) || intervalMs < 1 ||
      !Number.isInteger(retention) || retention < 1 || retention > 100) throw new Error('自动备份配置无效。');
  const tasks = new Map();

  async function entries(directory) {
    try { return await disk.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }

  async function inspect(bucket) {
    const location = path.join(directory, bucket);
    const files = await entries(location);
    const valid = [];
    const damagedFiles = [];
    for (const entry of files) {
      if (!entry.isFile() || !snapshotName.test(entry.name)) continue;
      const file = path.join(location, entry.name);
      try {
        const stat = await disk.stat(file);
        if (stat.size > format.maxBytes) throw new Error('size-limit');
        const body = verify(JSON.parse(await disk.readFile(file, 'utf8')));
        valid.push({ file, body, time: Number(entry.name.slice(0, 13)) });
      } catch { damagedFiles.push(file); }
    }
    valid.sort((a, b) => b.time - a.time);
    return { valid, damaged: damagedFiles.length, damagedFiles };
  }

  async function check() {
    const totals = { valid: 0, damaged: 0 };
    for (const entry of await entries(directory)) {
      if (!entry.isDirectory() || !bucketName.test(entry.name)) continue;
      const report = await inspect(entry.name);
      totals.valid += report.valid.length;
      totals.damaged += report.damaged;
    }
    return totals;
  }

  async function save(bucket, body) {
    if (!bucketName.test(bucket)) throw new Error('无效备份分组。');
    const file = pack(body);
    return serialize(bucket, async () => {
      const { valid, damaged } = await inspect(bucket);
      const now = clock();
      const latest = valid[0];
      if (latest && (now - latest.time < intervalMs || digest(latest.body.modules) === digest(body.modules))) {
        return { saved: false, damaged, nextAfterMs: Math.max(intervalMs - (now - latest.time), 0) };
      }
      const target = path.join(directory, bucket, String(now).padStart(13, '0') + '-' + randomUUID() + '.json');
      await atomicWrite(target, JSON.stringify(file), disk);
      verify(JSON.parse(await disk.readFile(target, 'utf8')));
      // Retention runs only after a new independent copy has been read back successfully.
      let pruneFailed = 0;
      for (const old of valid.slice(retention - 1)) {
        try { await disk.unlink(old.file); } catch { pruneFailed++; }
      }
      return { saved: true, damaged, pruneFailed, nextAfterMs: intervalMs };
    });
  }

  async function serialize(bucket, task) {
    const prior = tasks.get(bucket) || Promise.resolve();
    const pending = prior.catch(() => {}).then(task);
    tasks.set(bucket, pending);
    try { return await pending; }
    finally { if (tasks.get(bucket) === pending) tasks.delete(bucket); }
  }

  async function removeMemory(id, previous, fields) {
    const clear = (fields.clearEpoch || 0) > (previous.clearEpoch || 0);
    const blocked = deletionFilter(fields.deletion);
    for (const bucket of ['memory-' + id, 'browser-' + id]) {
      await serialize(bucket, async () => {
        await assertNoMemoryTemps(path.join(directory, bucket), name => snapshotName.test(name), disk);
        const { valid, damagedFiles } = await inspect(bucket);
        if (damagedFiles.length) throw new Error('无法确认损坏的自动备份已移除被删除内容。');
        for (const { file, body } of valid) {
          const memory = body.modules.memory;
          if (!memory) continue;
          const keep = item => !clear && !blocked(item);
          const memories = memory.memories.filter(keep);
          const candidates = memory.candidates.filter(keep);
          if (memories.length === memory.memories.length && candidates.length === memory.candidates.length) continue;
          const cleaned = { ...memory, memories, candidates, deletion: fields.deletion,
            ...(clear ? { clearEpoch: fields.clearEpoch, lineage: memoryLineage(id) } : {}) };
          const next = format.createBody(body.scope, body.modules.browser, cleaned, body.createdAt);
          await atomicWrite(file, JSON.stringify(pack(next)), disk);
        }
      });
    }
  }

  return { check, save, removeMemory };
}

function startMemoryBackups(store, rotation, intervalMs, report = () => {}) {
  let stopped = false;
  let timer;
  async function tick(startup) {
    try {
      if (startup) report(await rotation.check());
      for (const id of await store.listProfiles()) {
        if (stopped) return;
        try {
          await store.inspect(id, async profile => {
            if (profile) await rotation.save('memory-' + id, format.createBody('memory', null, memoryData(profile, id)));
          });
        } catch { report({ failed: 1 }); }
      }
    } catch { report({ failed: 1 }); }
    finally {
      if (!stopped) {
        timer = setTimeout(() => void tick(false), intervalMs);
        timer.unref?.();
      }
    }
  }
  void tick(true);
  return () => { stopped = true; clearTimeout(timer); };
}

module.exports = { atomicWrite, cleanupAtomicTemps, digest, pack, verify, memoryData, memoryLineage, deletionFilter, assertNoMemoryTemps, createBackupRotation, startMemoryBackups };
