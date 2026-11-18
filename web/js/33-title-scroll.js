'use strict';

// 0-8A Phase 3 补充：长歌名滚动。
// 规则（2026-11-16 用户要求）：歌名超过 4 个字符才滚动，≤4 字保持原静态居中显示；
// 只刷歌名区（128×24），不碰歌手/时间/频谱/进度/字号。
// 实现：标题滚动模块按固定步长累加 offset，29 号渲染器用窗口裁剪绘制并内部取模循环；
// 同一时刻最多一次滚动更新在飞，显示忙时直接丢这一帧（下一周期继续），标题变化时从 0 重新开始。
// 窗口宽度 128 px、步长 6 px、周期 250 ms（约 24 px/s）；32 px 空白后接下一份文字，循环无缝。

const ZilyTitleScroll = (() => {
  const defaults = Object.freeze({
    intervalMs: 250,  // 约 4 次/秒
    stepPx: 6,        // 每次左移 6 px ≈ 24 px/s
    maxChars: 4       // ≤4 字不滚动
  });

  const textOf = value => String(value ?? '').trim();
  // 按字符数（而不是 UTF-16 单元）统计，避免 emoji/生僻字被算成两个。
  const charCount = value => Array.from(textOf(value)).length;

  function create({
    display,
    getTitle,
    isReady = () => true,
    onLog = () => {},
    intervalMs = defaults.intervalMs,
    stepPx = defaults.stepPx,
    maxChars = defaults.maxChars,
    setInterval: startTimer = (callback, ms) => {
      const id = setInterval(callback, ms);
      return () => clearInterval(id);
    }
  } = {}) {
    if (!display || typeof display.updateTitle !== 'function') {
      throw new TypeError('歌名滚动需要 display.updateTitle。');
    }
    if (typeof getTitle !== 'function') {
      throw new TypeError('歌名滚动需要 getTitle 函数。');
    }

    const state = {
      running: false,
      stopTimer: null,
      inflight: false,
      offset: 0,
      lastTitle: null,
      failureReported: false
    };

    function log(message) {
      try { onLog(message); } catch { /* 日志回调异常不影响滚动 */ }
    }

    function ready() {
      try { return Boolean(isReady()); } catch { return false; }
    }

    function readTitle() {
      try { return textOf(getTitle()); } catch { return ''; }
    }

    // 一轮滚动：长标题才发；显示忙时丢帧；失败按连续失败去重日志并下轮重试。
    // 单飞：同一时刻只允许一个 updateTitle 在飞，期间的新 tick 直接跳过。
    async function tick() {
      if (!state.running || state.inflight || !ready()) return;
      state.inflight = true;
      try {
        const title = readTitle();
        if (charCount(title) <= maxChars) {
          // ≤4 字交给 29 号的静态居中渲染；这里只复位，不刷屏。
          state.lastTitle = title;
          state.offset = 0;
          return;
        }
        if (title !== state.lastTitle) {
          state.lastTitle = title;
          state.offset = 0; // 切歌/改标题从第一屏重新开始
          log('OLED 歌名滚动开始 · ' + charCount(title) + ' 字 · ' + title);
        }
        if (typeof display.isBusy === 'function' && display.isBusy()) return;
        try {
          await display.updateTitle(title, state.offset);
          state.failureReported = false;
          state.offset += stepPx;
        } catch (error) {
          if (!state.failureReported) {
            state.failureReported = true;
            log('OLED 歌名滚动失败 · ' + (error?.message ?? '未知错误') + ' · 继续按帧重试');
          }
        }
      } finally {
        state.inflight = false;
      }
    }

    function safeTick() {
      void tick().catch(error => {
        log('OLED 歌名滚动轮询异常 · ' + (error?.message ?? '未知错误'));
      });
    }

    function start() {
      if (state.running) return false;
      state.running = true;
      state.offset = 0;
      state.lastTitle = null;
      state.failureReported = false;
      state.stopTimer = startTimer(safeTick, intervalMs);
      safeTick(); // 立即滚一帧；若 29 号正被跟随更新占用，本轮会自然跳过
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
      return true;
    }

    return {
      start,
      stop,
      isRunning: () => state.running,
      // 供测试/调试手动触发一轮；正常运行时由 start() 的定时器调用。
      tick
    };
  }

  return { defaults, charCount, create };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ZilyTitleScroll;