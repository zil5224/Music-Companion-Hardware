'use strict';

// 0-8A Phase 2：播放器观察器。
// 职责：轮询播放器**公开状态**（歌名/歌手 DOM + <audio> 元素），把歌名/歌手/进度
// 交给 ZilyOledDisplay.updateSong/updateProgress。不修改播放器核心，也不把串口
// 逻辑塞进播放器/AI；观察器只依赖注入的 display 接口，便于离线测试。
// 节奏：歌名/歌手变化在下一个轮询周期（默认 250 ms）内推送；进度每秒一次；
// 暂停后只推一次冻结画面，恢复播放后继续；暂停中拖动进度也会补推一次。
// 更新合并：同一时刻最多一次显示更新在飞；期间读到的新状态只保留最新值，
// 当前更新结束后再按「歌名 → 进度」的顺序补齐，避免阻塞应用命令。
// 失败隔离：显示更新失败只记日志并在冷却后重试，不影响播放/AI 与下一次轮询。

const ZilyPlayerObserver = (() => {
  const defaults = Object.freeze({
    pollIntervalMs: 250,       // 播放器状态轮询周期
    progressIntervalMs: 1000,  // 进度推送周期
    retryDelayMs: 1000         // 显示更新失败后的重试冷却
  });

  const text = value => String(value ?? '').trim();
  const numberOrNull = value => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  // 只读播放器公开状态：歌名/歌手取 DOM 文本，进度取 <audio> 元素。
  // 返回 { title, artist, playing, currentTime, duration }；duration 未知时为 null。
  function readPlayerSnapshot(doc = typeof document === 'undefined' ? null : document) {
    if (!doc || typeof doc.getElementById !== 'function') return null;
    const audioEl = doc.getElementById('audioEl');
    if (!audioEl) return null;
    const titleEl = doc.getElementById('songTitle');
    const artistEl = doc.getElementById('songArtist');
    const duration = numberOrNull(audioEl.duration);
    const currentTime = numberOrNull(audioEl.currentTime);
    const source = String(audioEl.currentSrc || audioEl.src || '');
    return {
      title: text(titleEl?.textContent),
      artist: text(artistEl?.textContent),
      playing: !audioEl.paused && !audioEl.ended && source !== '',
      currentTime: currentTime === null ? 0 : Math.max(0, currentTime),
      duration: duration !== null && duration > 0 ? duration : null
    };
  }

  // 创建观察器。display 需提供 updateSong(title, artist) 与 updateProgress(current, total)。
  function create({
    display,
    getSnapshot,
    onLog = () => {},
    onUpdate = () => {},
    isReady = () => true,
    pollIntervalMs = defaults.pollIntervalMs,
    progressIntervalMs = defaults.progressIntervalMs,
    retryDelayMs = defaults.retryDelayMs,
    now = () => Date.now(),
    setInterval: startTimer = (callback, ms) => {
      const id = setInterval(callback, ms);
      return () => clearInterval(id);
    }
  } = {}) {
    if (!display || typeof display.updateSong !== 'function' ||
        typeof display.updateProgress !== 'function') {
      throw new TypeError('播放器观察器需要 display.updateSong/updateProgress。');
    }
    if (typeof getSnapshot !== 'function') {
      throw new TypeError('播放器观察器需要 getSnapshot 函数。');
    }

    const state = {
      running: false,
      stopTimer: null,
      inflight: false,        // 是否已有一次显示更新在飞
      pendingSong: false,     // 待发送的歌名/歌手更新
      pendingProgress: false, // 待发送的进度更新
      latest: null,           // 最近一次读到的播放器快照（合并用）
      lastTitle: null,        // 已接受的歌名/歌手（变化检测）
      lastArtist: null,
      lastProgressKey: null,  // 已发送的进度签名（秒级），避免重复推送
      lastProgressAt: Number.NEGATIVE_INFINITY,
      lastPlaying: null,
      songRetryAt: Number.NEGATIVE_INFINITY,     // 歌名/歌手失败的冷却（只拦歌名）
      progressRetryAt: Number.NEGATIVE_INFINITY  // 进度失败的冷却（只拦进度）
    };

    function log(message) {
      try { onLog(message); } catch { /* 日志回调异常不影响观察 */ }
    }

    function report(update) {
      try { onUpdate(update); } catch { /* 状态回调异常不影响观察 */ }
    }

    function ready() {
      try { return Boolean(isReady()); } catch { return true; }
    }

    // 读取并归一化快照；读失败（null/异常）时跳过本轮，不打断播放。
    function snapshot() {
      let raw;
      try {
        raw = getSnapshot();
      } catch (error) {
        log('播放器观察器读取状态失败 · ' + (error?.message ?? '未知错误'));
        return null;
      }
      if (!raw || typeof raw !== 'object') return null;
      const currentTime = numberOrNull(raw.currentTime);
      const duration = numberOrNull(raw.duration);
      return {
        title: text(raw.title),
        artist: text(raw.artist),
        playing: Boolean(raw.playing),
        currentTime: currentTime === null ? 0 : Math.max(0, currentTime),
        duration: duration !== null && duration > 0 ? duration : null
      };
    }

    // 进度签名只取整秒（OLED 时间显示 m:ss、进度条 128 px），避免亚秒级抖动。
    function progressKey(snap) {
      return Math.floor(snap.currentTime) + '/' +
        (snap.duration === null ? 0 : Math.floor(snap.duration));
    }

    function resetTracking() {
      state.latest = null;
      state.pendingSong = false;
      state.pendingProgress = false;
      state.lastTitle = null;
      state.lastArtist = null;
      state.lastProgressKey = null;
      state.lastProgressAt = Number.NEGATIVE_INFINITY;
      state.lastPlaying = null;
      state.songRetryAt = Number.NEGATIVE_INFINITY;
      state.progressRetryAt = Number.NEGATIVE_INFINITY;
    }

    async function pushSong(snap, stamp) {
      try {
        await display.updateSong(snap.title, snap.artist);
        state.songRetryAt = Number.NEGATIVE_INFINITY;
        if (!state.running) return true; // stop() 之后的在飞更新不再回报，避免误导日志/状态
        report({
          kind: 'song', title: snap.title, artist: snap.artist,
          playing: snap.playing, at: stamp
        });
        log('OLED 歌名/歌手已更新 · ' + (snap.title || '（空）') + ' / ' + (snap.artist || '（空）'));
        return true;
      } catch (error) {
        // 保留旧画面；清掉已接受标记，让冷却后能重新推送同一首歌。
        state.lastTitle = null;
        state.lastArtist = null;
        state.songRetryAt = stamp + retryDelayMs;
        log('OLED 歌名/歌手更新失败，' + retryDelayMs + ' ms 后重试 · ' +
          (error?.message ?? '未知错误'));
        return false;
      }
    }

    async function pushProgress(snap, stamp) {
      const total = snap.duration === null ? 0 : snap.duration;
      try {
        await display.updateProgress(snap.currentTime, total);
        state.lastProgressKey = progressKey(snap);
        state.lastProgressAt = stamp;
        state.progressRetryAt = Number.NEGATIVE_INFINITY;
        if (!state.running) return; // stop() 之后的在飞更新不再回报
        report({
          kind: 'progress', title: snap.title, artist: snap.artist,
          current: snap.currentTime, total, playing: snap.playing, at: stamp
        });
      } catch (error) {
        state.progressRetryAt = stamp + retryDelayMs;
        log('OLED 进度更新失败，' + retryDelayMs + ' ms 后重试 · ' +
          (error?.message ?? '未知错误'));
      }
    }

    // 串行泵：一次只发一个显示更新；切歌后先发歌名/歌手，再补一次进度
    // （复位时间行与进度条），期间新读到的状态由 pending 标记合并到下一发。
    // 失败冷却按类型分开：进度失败只推迟进度，不会把无关的切歌也拦下。
    async function pump() {
      if (state.inflight || !state.running) return;
      state.inflight = true;
      try {
        while (state.running) {
          const snap = state.latest;
          if (!snap) break;
          if (state.pendingSong) {
            if (now() < state.songRetryAt) break; // 歌名失败的冷却只拦歌名
            state.pendingSong = false;
            // 歌名失败时不要紧接着推进度：29 号会用旧的歌手/时间状态渲染，
            // 画面反而更乱；清掉待发进度，等冷却后歌名+进度一起重试。
            if (await pushSong(snap, now())) state.pendingProgress = true;
            else state.pendingProgress = false;
            continue;
          }
          if (state.pendingProgress) {
            if (now() < state.progressRetryAt) break; // 进度失败的冷却只拦进度
            state.pendingProgress = false;
            await pushProgress(snap, now());
            continue;
          }
          break;
        }
      } catch (error) {
        log('播放器观察器更新异常 · ' + (error?.message ?? '未知错误'));
      } finally {
        state.inflight = false;
      }
    }

    // 一轮轮询：检测变化、按节奏决定要不要推送，然后交给串行泵。
    async function poll() {
      if (!state.running || !ready()) return;
      const snap = snapshot();
      if (!snap) return;
      state.latest = snap;
      const stamp = now();
      const songChanged = snap.title !== state.lastTitle || snap.artist !== state.lastArtist;
      const playingChanged = state.lastPlaying !== null && state.lastPlaying !== snap.playing;
      let progressDue = false;
      if (songChanged) {
        state.lastTitle = snap.title;
        state.lastArtist = snap.artist;
        state.pendingSong = true;
        progressDue = true; // 切歌后立刻复位时间行/进度条
      } else if (playingChanged) {
        progressDue = true; // 暂停/恢复时推一次冻结或恢复中的进度
      } else if (!snap.playing) {
        progressDue = state.lastProgressKey !== progressKey(snap); // 暂停中拖动进度
      } else if (state.lastProgressKey !== progressKey(snap) &&
                 stamp - state.lastProgressAt >= progressIntervalMs) {
        progressDue = true;
      }
      state.lastPlaying = snap.playing;
      if (progressDue) state.pendingProgress = true;
      if (!state.pendingSong && !state.pendingProgress) return;
      await pump();
    }

    function safePoll() {
      void poll().catch(error => {
        log('播放器观察器轮询异常 · ' + (error?.message ?? '未知错误'));
      });
    }

    function start() {
      if (state.running) return false;
      state.running = true;
      resetTracking(); // 连接/恢复后重新同步一次完整画面
      state.stopTimer = startTimer(safePoll, pollIntervalMs);
      log('OLED 跟随播放已启动 · 歌名/歌手变化即时推送 · 进度每 ' +
        progressIntervalMs + ' ms 一次。');
      safePoll(); // 立即同步，重连后不用等一个轮询周期
      return true;
    }

    function stop() {
      if (!state.running) return false;
      state.running = false;
      const cancel = state.stopTimer;
      state.stopTimer = null;
      if (cancel) {
        try { cancel(); } catch { /* 定时器取消异常不影响停止 */ }
      }
      state.pendingSong = false;
      state.pendingProgress = false;
      log('OLED 跟随播放已停止。');
      return true;
    }

    return {
      start,
      stop,
      isRunning: () => state.running,
      // 供测试/调试手动触发一轮轮询；正常运行时由 start() 的定时器调用。
      poll
    };
  }

  return { defaults, readPlayerSnapshot, create };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ZilyPlayerObserver;