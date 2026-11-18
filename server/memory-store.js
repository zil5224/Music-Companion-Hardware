'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { atomicWrite, assertNoMemoryTemps } = require('./backup-store');

const SCHEMA_VERSION = 1;
const MAX_STORE_BYTES = 1024 * 1024;
const pendingWrites = new Map();

class MemoryStoreError extends Error {
  constructor(code) {
    super(code);
    this.name = 'MemoryStoreError';
    this.code = code;
  }
}

function defaultMemoryDirectory() {
  let base;
  if (process.platform === 'win32') {
    base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  } else if (process.platform === 'darwin') {
    base = path.join(os.homedir(), 'Library', 'Application Support');
  } else {
    base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  }
  const directory = path.resolve(base, 'Zily', 'memory');
  const relative = path.relative(path.resolve(__dirname, '..'), directory);
  if (!path.isAbsolute(base) || (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)))) {
    throw new MemoryStoreError('unavailable');
  }
  return directory;
}

function isTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validateStore(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Number.isInteger(data.schemaVersion)) {
    throw new MemoryStoreError('corrupt');
  }
  if (data.schemaVersion !== SCHEMA_VERSION) throw new MemoryStoreError('unsupported-version');
  if (!isTimestamp(data.createdAt) || !isTimestamp(data.updatedAt) ||
      (Object.hasOwn(data, 'identityExpiresAt') && !isTimestamp(data.identityExpiresAt)) ||
      (Object.hasOwn(data, 'identity') && (!/^[a-f0-9]{64}$/.test(data.identity?.hash || '') || !isTimestamp(data.identity?.expiresAt))) ||
      (Object.hasOwn(data, 'recovery') && (!/^[a-f0-9]{32}$/.test(data.recovery?.salt || '') || !/^[a-f0-9]{64}$/.test(data.recovery?.hash || ''))) ||
      (Object.hasOwn(data, 'backupReceipts') && (!Array.isArray(data.backupReceipts) || data.backupReceipts.length > 128 ||
        data.backupReceipts.some(item => !/^[a-f0-9-]{36}$/i.test(item?.id || '') || typeof item?.committed !== 'boolean'))) ||
      (Object.hasOwn(data, 'useInChat') && typeof data.useInChat !== 'boolean') ||
      (Object.hasOwn(data, 'autoExtractEnabled') && typeof data.autoExtractEnabled !== 'boolean') ||
      ['identityEpoch', 'clearEpoch'].some(key => Object.hasOwn(data, key) && (!Number.isSafeInteger(data[key]) || data[key] < 0)) ||
      (Object.hasOwn(data, 'deletion') && (!data.deletion || !['ids', 'messages'].every(key =>
        Array.isArray(data.deletion[key]) && data.deletion[key].every(id => typeof id === 'string')))) ||
      (Object.hasOwn(data, 'discoveryEpoch') && (!Number.isSafeInteger(data.discoveryEpoch) || data.discoveryEpoch < 0)) ||
      (Object.hasOwn(data, 'discovery') && (!data.discovery || !Array.isArray(data.discovery.candidates) ||
        !Array.isArray(data.discovery.processed) || !Array.isArray(data.discovery.rejected) ||
        (Object.hasOwn(data.discovery, 'skipped') && !Array.isArray(data.discovery.skipped)) ||
        !Number.isFinite(data.discovery.lastExtractedAt))) ||
      !Array.isArray(data.memories) || !data.memories.every(item => item && typeof item === 'object' && !Array.isArray(item))) {
    throw new MemoryStoreError('corrupt');
  }
  return data;
}

function createMemoryStore(directory = defaultMemoryDirectory(), fileSystem = fs) {
  const root = path.resolve(directory);

  function fileFor(profileId) {
    if (typeof profileId !== 'string' || !/^[a-f0-9]{64}$/.test(profileId)) {
      throw new MemoryStoreError('invalid-profile');
    }
    return path.join(root, profileId + '.json');
  }

  async function readFile(file) {
    try {
      const stat = await fileSystem.lstat(file);
      if (!stat.isFile() || stat.size > MAX_STORE_BYTES) throw new MemoryStoreError('corrupt');
      return validateStore(JSON.parse(await fileSystem.readFile(file, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error instanceof MemoryStoreError) throw error;
      if (error instanceof SyntaxError) throw new MemoryStoreError('corrupt');
      throw new MemoryStoreError('unavailable');
    }
  }

  async function replaceFile(file, data, shouldCommit = () => true) {
    const text = JSON.stringify(validateStore(data));
    if (Buffer.byteLength(text) > MAX_STORE_BYTES) throw new MemoryStoreError('size-limit');
    try { return await atomicWrite(file, text, fileSystem, shouldCommit); }
    catch (error) { if (error instanceof MemoryStoreError) throw error; throw new MemoryStoreError('unavailable'); }
  }

  async function withWriteLock(file, operation) {
    const pending = pendingWrites.get(file) || Promise.resolve();
    const write = pending.catch(() => {}).then(operation);
    pendingWrites.set(file, write);
    try {
      return await write;
    } finally {
      if (pendingWrites.get(file) === write) pendingWrites.delete(file);
    }
  }

  async function read(profileId) {
    return readFile(fileFor(profileId));
  }

  const inspect = (id, visit) => withWriteLock(fileFor(id), async () => visit(await read(id)));

  async function initialize(profileId, identityExpiresAt) {
    const file = fileFor(profileId);
    return withWriteLock(file, async () => {
      const existing = await readFile(file);
      if (existing) return existing;
      const now = new Date().toISOString();
      const data = { schemaVersion: SCHEMA_VERSION, createdAt: now, updatedAt: now, memories: [],
        ...(identityExpiresAt ? { identityExpiresAt } : {}) };
      await replaceFile(file, data);
      return data;
    });
  }

  async function restoreNew(profileId, data, canCreate) {
    const file = fileFor(profileId);
    const cancelled = file + '.restore-cancelled';
    return withWriteLock(file, async () => {
      const existing = await readFile(file);
      if (existing) return existing;
      if (!canCreate()) return null;
      try {
        try { await fileSystem.lstat(cancelled); return null; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!data) {
          await atomicWrite(cancelled, 'cancelled\n', fileSystem);
          return null;
        }
        const now = new Date().toISOString();
        const profile = { schemaVersion: SCHEMA_VERSION, createdAt: now, updatedAt: now, ...data };
        return await replaceFile(file, profile, canCreate) ? profile : null;
      } catch (error) {
        if (error instanceof MemoryStoreError) throw error;
        throw new MemoryStoreError('unavailable');
      }
    });
  }

  async function mutate(profileId, change, shouldCommit) {
    const file = fileFor(profileId);
    return withWriteLock(file, async () => {
      const existing = await readFile(file);
      if (!existing) throw new MemoryStoreError('not-found');
      const fields = await change(existing);
      if (!fields) return existing;
      const next = { ...existing, ...fields, updatedAt: new Date().toISOString() };
      return await replaceFile(file, next, shouldCommit) ? next : existing;
    });
  }

  function forIdentity(isCurrent) {
    const guard = latest => {
      if (!latest || !isCurrent(latest)) throw new MemoryStoreError('not-found');
    };
    const authorizedMutate = (id, change, shouldCommit) => mutate(id, latest => {
      guard(latest);
      return change(latest);
    }, () => {
      if (!isCurrent()) throw new MemoryStoreError('not-found');
      return shouldCommit ? shouldCommit() : true;
    });
    return {
      read: async id => { const latest = await read(id); guard(latest); return latest; },
      mutate: authorizedMutate,
      update: (id, change) => authorizedMutate(id, async latest => ({ memories: await change(latest.memories) })),
      updateSettings: (id, useInChat) => authorizedMutate(id, () => ({ useInChat })),
      assertNoTemps: id => assertNoMemoryTemps(root, name => name === path.basename(fileFor(id)), fileSystem),
      inspect: (id, visit) => withWriteLock(fileFor(id), async () => {
        const latest = await read(id);
        guard(latest);
        return visit(latest);
      }),
    };
  }

  async function listProfiles() {
    let entries;
    try { entries = await fileSystem.readdir(root, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return entries.filter(entry => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name))
      .map(entry => entry.name.slice(0, -5));
  }

  return {
    read, initialize, restoreNew, mutate, listProfiles, forIdentity, inspect, directory: root,
    update: (profileId, change) => mutate(profileId, async existing => ({ memories: await change(existing.memories) })),
    updateSettings: (profileId, useInChat) => mutate(profileId, () => ({ useInChat })),
  };
}

module.exports = { createMemoryStore, defaultMemoryDirectory, MemoryStoreError };
