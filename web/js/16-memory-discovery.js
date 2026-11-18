// This queue is per page and per conversation. Only successful ordinary turns enter it.
let memoryDiscoverySetting = null;
let memoryDiscoveryQueue = [];
let memoryDiscoveryTask = null;
let memoryDiscoveryTimer;
let memoryDiscoverySettingVersion = 0;

function resetMemoryDiscoveryQueue() {
  memoryDiscoveryQueue = [];
  clearTimeout(memoryDiscoveryTimer);
  memoryDiscoveryTimer = undefined;
  memoryDiscoveryTask?.abort();
  memoryDiscoveryTask = null;
}

function setMemoryDiscovery(setting) {
  memoryDiscoverySettingVersion++;
  const enabled = setting?.autoExtractEnabled === true && Number.isSafeInteger(setting.epoch);
  if (!enabled || memoryDiscoverySetting?.epoch !== setting.epoch) resetMemoryDiscoveryQueue();
  memoryDiscoverySetting = enabled ? setting : null;
}

function queueMemoryTurn(sessionId, turn) {
  if (!memoryDiscoverySetting || turn.some(message => !message.id || !message.content.trim() || message.content.length > 8000)) return;
  const messages = turn.map(({ id, role, content }) => ({ id, role, content }));
  // Keep whole turns and keep four turns below the endpoint body limit.
  if (new TextEncoder().encode(JSON.stringify(messages)).length > 11000) return;
  if (memoryDiscoveryQueue.length >= 80) return;
  memoryDiscoveryQueue.push({ sessionId, messages });
  void discoverMemoryCandidates();
}

async function discoverMemoryCandidates() {
  if (!memoryDiscoverySetting || memoryDiscoveryQueue.length < 4 || memoryDiscoveryTask || memoryDiscoveryTimer) return;
  const batch = memoryDiscoveryQueue.slice(0, 4);
  const controller = new AbortController();
  memoryDiscoveryTask = controller;
  let retryAfter = 0;
  let continueNow = false;
  try {
    const response = await fetch('/api/memory/extract', {
      method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: batch[0].sessionId, epoch: memoryDiscoverySetting.epoch,
        messages: batch.flatMap(turn => turn.messages),
      }),
    });
    const result = await response.json();
    if (memoryDiscoveryTask !== controller) return;
    if (response.status === 401 || (response.status === 409 && result.stopped)) {
      setMemoryDiscovery(null);
      if (response.status === 409 && Number.isSafeInteger(result.epoch)) setMemoryDiscovery(result);
    } else if (response.ok) {
      const done = new Set([...(result.processed || []), ...(result.skipped || [])]);
      if (!done.size) return;
      memoryDiscoveryQueue = memoryDiscoveryQueue.filter(turn => !done.has(turn.messages[0].id));
      continueNow = true;
      if (result.added) document.dispatchEvent(new Event('memory-candidates-updated'));
    } else {
      retryAfter = Math.max(1000, Math.min(300000, Number(result.retryAfterMs) || 300000));
    }
  } catch {
    retryAfter = 300000;
  } finally {
    if (memoryDiscoveryTask === controller) {
      memoryDiscoveryTask = null;
      if (retryAfter) {
        memoryDiscoveryTimer = setTimeout(() => {
          memoryDiscoveryTimer = undefined;
          void discoverMemoryCandidates();
        }, retryAfter);
      } else if (continueNow) {
        void discoverMemoryCandidates();
      }
    }
  }
}

const initialMemoryDiscoveryVersion = memoryDiscoverySettingVersion;
void fetch('/api/memory/discovery', { cache: 'no-store' })
  .then(response => response.ok ? response.json() : null)
  .then(setting => {
    if (memoryDiscoverySettingVersion === initialMemoryDiscoveryVersion) setMemoryDiscovery(setting);
  }).catch(() => {});
