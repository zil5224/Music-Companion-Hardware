'use strict';

const QUEUE_FAILURE_LIMIT = 3;
const queueOutcomeLabels = {
  'not-found': '搜索不到匹配歌曲',
  'no-source': '无法获取音源',
  'audio-load': '音频加载失败',
  'browser-play': '浏览器未能开始播放',
  'preview': '试听结束，完整版受限',
};

function createPlaybackQueue({ load, onChange = () => {}, canLoad = () => true, now = Date.now, id = () => crypto.randomUUID() }) {
  const state = { queueId: id(), revision: 0, status: 'idle', currentEntryId: null, entries: [] };
  let request = null;
  let failures = 0;
  let lastSwitch = -Infinity;
  let message = '';

  const pending = () => state.entries.filter(entry => entry.status === 'pending');
  const current = () => state.entries.find(entry => entry.entryId === state.currentEntryId);
  function changed(text) {
    if (text !== undefined) message = text;
    state.revision++;
    onChange();
  }
  function cancel() {
    const previous = request;
    request = null;
    previous?.controller.abort();
  }
  function entryFor(track) {
    const trackId = typeof track?.id === 'string' || Number.isSafeInteger(track?.id) ? String(track.id) : '';
    const title = track?.song ?? track?.name;
    if (!/^[1-9]\d{0,19}$/u.test(trackId) || typeof title !== 'string' || !title.trim() ||
        typeof track.artist !== 'string' || !track.artist.trim()) return false;
    return { entryId: id(), track: { id: trackId, song: title, artist: track.artist,
      cover: typeof track.cover === 'string' ? track.cover : '' }, status: 'pending', addedAt: now() };
  }
  function waitForCurrent() {
    if (state.status === 'active') return;
    state.status = current()?.status === 'playing' ? 'active' : 'waiting';
    failures = 0;
  }
  function addMany(tracks, followCurrent = false) {
    const entries = tracks.map(entryFor).filter(Boolean);
    if (entries.length) {
      state.entries.push(...entries);
      if (followCurrent) waitForCurrent();
      changed(entries.length === 1 ? '已加入队列 · ' + entries[0].track.song : '已加入 ' + entries.length + ' 首歌曲');
    }
    return entries.length;
  }
  function add(track, followCurrent = false) {
    return addMany([track], followCurrent) > 0;
  }
  function insertNext(track, followCurrent = false) {
    const entry = entryFor(track);
    if (!entry) return false;
    const index = state.entries.findIndex(item => item.status === 'pending' && item.entryId !== request?.entryId);
    if (index < 0) state.entries.push(entry);
    else state.entries.splice(index, 0, entry);
    if (followCurrent) waitForCurrent();
    changed('下一首 · ' + entry.track.song);
    return true;
  }
  async function playTracks(tracks) {
    if (request || !canLoad()) return false;
    const entries = tracks.map(entryFor).filter(Boolean);
    if (!entries.length) return false;
    // Play this batch first and keep the original pending tracks in their order.
    state.entries.unshift(...entries);
    await start();
    return true;
  }
  function remove(entryId) {
    const index = state.entries.findIndex(entry => entry.entryId === entryId && entry.status === 'pending');
    if (index < 0) return false;
    const interrupted = request?.entryId === entryId;
    if (interrupted) cancel();
    state.entries.splice(index, 1);
    if (state.status === 'waiting' && !pending().length) state.status = 'idle';
    changed('已移除待播歌曲');
    if (interrupted) void advance('continue');
    return true;
  }
  function move(entryId, direction) {
    const movable = pending().filter(entry => entry.entryId !== request?.entryId);
    const from = movable.findIndex(entry => entry.entryId === entryId);
    const to = direction === 'first' ? 0 : from + direction;
    if (from < 0 || to < 0 || to >= movable.length || from === to) return false;
    const entry = movable[from];
    const position = state.entries.indexOf(movable[to]);
    state.entries.splice(state.entries.indexOf(entry), 1);
    state.entries.splice(position, 0, entry);
    changed();
    return true;
  }
  function clear() {
    cancel();
    state.entries = state.entries.filter(entry => entry.status !== 'pending');
    if (state.status === 'waiting') state.status = 'idle';
    if (state.status === 'active' && !current()) state.status = 'exhausted';
    changed('待播队列已清空');
  }
  function leave() {
    if (state.status === 'idle') return;
    cancel();
    if (current()?.status === 'playing') current().status = 'skipped';
    state.currentEntryId = null;
    state.status = 'idle';
    changed('已退出队列播放，待播歌曲保留');
  }
  function finish(text) {
    state.status = 'exhausted';
    changed(text);
  }

  function settlePlaying(trigger, outcome) {
    const entry = current();
    if (entry?.status !== 'playing') return false;
    entry.status = trigger === 'error' ? 'failed' : outcome === 'preview' ? 'skipped' : 'played';
    entry.outcome = outcome;
    failures = trigger === 'error' ? failures + 1 : 0;
    state.currentEntryId = null;
    return true;
  }

  async function advance(trigger, outcome) {
    if (request || !canLoad()) return;
    if (trigger === 'next' && now() - lastSwitch < 250) return;
    const previous = current();
    if (trigger === 'ended' || trigger === 'error') {
      if (!settlePlaying(trigger, outcome)) return;
    } else if (trigger === 'next' && previous?.status === 'playing') {
      failures = 0;
    }
    if (failures >= QUEUE_FAILURE_LIMIT) {
      finish('连续 3 首无法播放，已停止尝试。剩余歌曲可以手动继续。');
      return;
    }
    const run = { controller: new AbortController(), entryId: null };
    request = run;
    let lastFailure = outcome;
    try {
      while (request === run) {
        const entry = pending()[0];
        if (!entry) {
          if (trigger === 'next' && previous?.status === 'playing') {
            changed('没有待播歌曲，当前歌曲继续播放');
          } else {
            finish(lastFailure ? '队列已完成 · ' + queueOutcomeLabels[lastFailure] : '队列已完成');
          }
          return;
        }
        run.entryId = entry.entryId;
        changed('正在加载《' + entry.track.song + '》…');
        let result;
        try { result = await load(entry.track, run.controller.signal); }
        catch { result = { ok: false, outcome: 'audio-load' }; }
        if (request !== run || run.controller.signal.aborted) return;
        if (result.ok) {
          if (previous?.status === 'playing') previous.status = 'skipped';
          entry.status = 'playing';
          state.currentEntryId = entry.entryId;
          lastSwitch = now();
          changed('正在播放队列 · ' + entry.track.song);
          return;
        }
        lastFailure = Object.hasOwn(queueOutcomeLabels, result.outcome) ? result.outcome : 'audio-load';
        entry.status = 'failed';
        entry.outcome = lastFailure;
        failures++;
        changed('《' + entry.track.song + '》· ' + queueOutcomeLabels[lastFailure]);
        if (failures >= QUEUE_FAILURE_LIMIT) {
          finish('连续 3 首无法播放，已停止尝试。剩余歌曲可以手动继续。');
          return;
        }
      }
    } finally {
      if (request === run) {
        request = null;
        onChange();
      }
    }
  }
  async function start() {
    if (request || !pending().length) return;
    if (!canLoad()) { changed('播放器正在切歌，请稍后开始队列'); return; }
    state.status = 'active';
    failures = 0;
    await advance('start');
  }
  async function next() {
    if (state.status === 'waiting') await start();
    else if (state.status === 'active') await advance('next');
  }
  function ended(preview) {
    const outcome = preview ? 'preview' : undefined;
    if (state.status === 'waiting') void start();
    else if (state.status === 'exhausted' || request) {
      if (settlePlaying('ended', outcome)) changed();
    } else if (state.status === 'active') void advance('ended', outcome);
  }
  function audioError() {
    if (state.status === 'waiting') {
      void start();
      return;
    }
    if (state.status === 'exhausted') {
      if (settlePlaying('error', 'audio-load')) changed();
      return;
    }
    if (state.status !== 'active') return;
    if (request) {
      if (!settlePlaying('error', 'audio-load')) return;
      if (failures >= QUEUE_FAILURE_LIMIT) {
        cancel();
        finish('连续 3 首无法播放，已停止尝试。剩余歌曲可以手动继续。');
      } else changed();
      return;
    }
    void advance('error', 'audio-load');
  }
  return { state, add, addMany, insertNext, playTracks, remove, move, clear, leave, start, next, ended, audioError,
    get busy() { return !!request; }, get loadingEntryId() { return request?.entryId; }, get message() { return message; } };
}

const queuePanel = document.getElementById('playbackQueuePanel');
const playbackQueue = createPlaybackQueue({
  load: (track, signal) => playOnlineMusic(track.song, track.artist, true, 0, track.id,
    { cover: track.cover, verified: true }, signal),
  canLoad: () => !loadingSong && !recommendingNext,
  onChange: renderPlaybackQueue,
});

function addQueueTrack(track, feedback) {
  const added = playbackQueue.add(track);
  if (feedback) feedback.textContent = added ? '已加入队列' : '没有可用的曲库歌曲 ID';
  return added;
}

function enqueueClickedTrack(track, feedback, { showSuccess = true } = {}) {
  if (!currentSong || audio.paused || audio.ended || String(track.id) === String(currentSong.id)) return false;
  const added = playbackQueue.add(track, true);
  feedback.hidden = added && !showSuccess;
  feedback.textContent = added ? (showSuccess ? '已加入队列，按顺序播放。' : '') : '没有可用的曲库歌曲 ID，暂时无法加入队列。';
  return true;
}

function queueButton(text, action, options = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mood-chip';
  button.textContent = text;
  if (options.label) button.setAttribute('aria-label', options.label);
  button.disabled = options.disabled === true;
  button.addEventListener('click', action);
  return button;
}

function renderPlaybackQueue() {
  if (!queuePanel) return;
  const list = document.getElementById('queueEntries');
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.queueFocus : null;
  const pending = playbackQueue.state.entries.filter(entry => entry.status === 'pending');
  const movable = pending.filter(entry => entry.entryId !== playbackQueue.loadingEntryId);
  document.getElementById('queueCount').textContent = String(pending.length);
  document.getElementById('queueStatus').textContent = playbackQueue.message;
  document.getElementById('queueEmpty').hidden = pending.length !== 0;
  document.getElementById('queueStart').disabled = !pending.length || playbackQueue.busy;
  document.getElementById('queueClear').disabled = !pending.length;
  document.getElementById('queueAddCurrent').disabled = !currentSong?.id;
  document.getElementById('queueCurrent').textContent = currentSong
    ? (audio.paused ? '当前曲目 · ' : '正在播放 · ') + currentSong.name + ' · ' + currentSong.artist : '还没有播放歌曲';
  const visible = playbackQueue.state.entries.filter(entry => entry.status === 'pending' || entry.outcome);
  list.replaceChildren(...visible.map(entry => {
    const row = document.createElement('li');
    row.className = 'queue-entry';
    const title = document.createElement('p');
    const index = pending.indexOf(entry);
    title.textContent = (index >= 0 ? (index + 1) + '. ' : '') + entry.track.song + ' · ' + entry.track.artist;
    if (/^https?:\/\//iu.test(entry.track.cover)) {
      const cover = document.createElement('img');
      cover.alt = '';
      cover.loading = 'lazy';
      cover.referrerPolicy = 'no-referrer';
      cover.src = entry.track.cover;
      row.append(cover);
    } else {
      const placeholder = document.createElement('span');
      placeholder.className = 'queue-cover-placeholder';
      placeholder.setAttribute('aria-hidden', 'true');
      placeholder.textContent = '♫';
      row.append(placeholder);
    }
    row.append(title);
    if (entry.outcome) {
      const outcome = document.createElement('small');
      outcome.textContent = queueOutcomeLabels[entry.outcome];
      row.append(outcome);
    }
    if (entry.status === 'pending') {
      const actions = document.createElement('div');
      actions.className = 'queue-actions';
      const moveIndex = movable.indexOf(entry);
      const name = entry.track.song;
      const addButton = (label, action, disabled) => {
        const button = queueButton(label, action, { label: label + ' ' + name, disabled });
        button.dataset.queueFocus = entry.entryId + label;
        actions.append(button);
      };
      addButton('上移', () => playbackQueue.move(entry.entryId, -1), moveIndex <= 0);
      addButton('下移', () => playbackQueue.move(entry.entryId, 1), moveIndex < 0 || moveIndex === movable.length - 1);
      addButton('插播下一首', () => playbackQueue.move(entry.entryId, 'first'), moveIndex <= 0);
      addButton('删除', () => playbackQueue.remove(entry.entryId), false);
      row.append(actions);
    }
    return row;
  }));
  if (focused) {
    const replacement = Array.from(list.querySelectorAll('button')).find(button => button.dataset.queueFocus === focused && !button.disabled);
    (replacement || list.querySelector('button:not(:disabled)') || document.getElementById('queueAddCurrent')).focus();
  }
}

function renderQueueRecommendationActions(container, message) {
  if (!lastVerifiedRecommendation || lastVerifiedRecommendation.message !== message) return;
  const target = container.querySelector('.msg-ai');
  if (!target) return;
  const actions = document.createElement('div');
  actions.className = 'queue-actions';
  const feedback = document.createElement('small');
  feedback.setAttribute('role', 'status');
  for (const [index, track] of lastVerifiedRecommendation.tracks.entries()) {
    actions.append(queueButton('第 ' + (index + 1) + ' 首加入队列', () => addQueueTrack(track, feedback),
      { label: '把《' + track.song + '》加入队列' }));
  }
  actions.append(feedback);
  target.append(actions);
}

if (queuePanel) {
  const searchForm = document.getElementById('queueSearchForm');
  let searchRequest = null;
  queuePanel.addEventListener('beforetoggle', event => {
    if (event.newState === 'open') renderPlaybackQueue();
    else searchRequest?.abort();
  });
  document.getElementById('queueAddCurrent').addEventListener('click', () => addQueueTrack(currentSong));
  document.getElementById('queueStart').addEventListener('click', () => void playbackQueue.start());
  document.getElementById('queueClear').addEventListener('click', () => playbackQueue.clear());
  searchForm.addEventListener('submit', async event => {
    event.preventDefault();
    const title = document.getElementById('queueSearchTitle').value.trim();
    const artist = document.getElementById('queueSearchArtist').value.trim();
    if (!title) return;
    searchRequest?.abort();
    const controller = new AbortController();
    searchRequest = controller;
    const result = document.getElementById('queueSearchResults');
    const feedback = document.getElementById('queueSearchStatus');
    result.replaceChildren();
    feedback.textContent = '正在核对网易云曲库…';
    try {
      const tracks = await verifyMusicTrack(title, artist, controller.signal);
      if (controller.signal.aborted) return;
      feedback.textContent = tracks.length ? '选择要加入的版本' : queueOutcomeLabels['not-found'];
      result.replaceChildren(...tracks.map(track => queueButton(
        '加入《' + track.song + '》· ' + track.artist, () => addQueueTrack(track, feedback)
      )));
    } catch {
      if (!controller.signal.aborted) feedback.textContent = '暂时无法查询网易云曲库';
    }
  });
  for (const event of ['playing', 'pause']) audio.addEventListener(event, renderPlaybackQueue);
}
