'use strict';

// 0-8A Phase 3：OLED 实时频谱同步。
// 数据源：06-audio.js 里的 AnalyserNode（getByteFrequencyData），由 27 号面板传进来；
// 本模块只做「采样 → 对数频段映射 → 推给 29 号 updateSpectrum」，不碰播放器核心。
// 节奏：默认 125 ms 一次（约 8 Hz）；29 号忙时直接丢帧、不排队，避免拖住文本更新与
// 应用命令；暂停时**保持 OLED 上最后一帧频谱不变**（不再发归零帧），恢复播放自动继续。
// 形状：24 根细竖条，柱宽 3 px、间隔 2 px（24×3+23×2=118 px，居中后两侧各 5 px 留白，
// 与歌手行 5 px 内边距对齐）；频段按 60 Hz–16 kHz 对数分布并做轻度 gamma，
// 避免低频一侧长期贴顶、右侧几条几乎不动。

const ZilyOledSpectrum = (() => {
  const defaults = Object.freeze({
    intervalMs: 125,  // 约 8 Hz
    barCount: 24,
    gamma: 0.75,      // <1 抬高中高段，避免频谱整体偏左
    minHz: 60,
    maxHz: 16000
  });

  function zeroLevels(barCount = defaults.barCount) {
    return new Array(barCount).fill(0);
  }

  // AnalyserNode 频域数据 → barCount 个 0–1 等级；没有 Analyser（未播放/创建失败）时全 0。
  function readAnalyserLevels(analyser, barCount = defaults.barCount) {
    const count = Number.isInteger(barCount) && barCount > 0 ? barCount : defaults.barCount;
    if (!analyser || typeof analyser.getByteFrequencyData !== 'function') return zeroLevels(count);
    const bins = Number(analyser.frequencyBinCount) || 0;
    if (bins <= 1) return zeroLevels(count);
    const fftSize = Number(analyser.fftSize) || 256;
    const sampleRate = Number(analyser.context?.sampleRate) || 44100;
    const binHz = sampleRate / fftSize;
    const lowBin = Math.max(1, Math.round(defaults.minHz / binHz));
    const highBin = Math.min(bins - 1, Math.max(lowBin + 1, Math.round(defaults.maxHz / binHz)));

    // 对数频段边界；每段至少 1 个 bin，段数为 barCount。
    const edges = new Array(count + 1);
    edges[0] = lowBin;
    for (let i = 1; i < count; i++) {
      const ratio = Math.pow(highBin / lowBin, i / count);
      edges[i] = Math.min(highBin, Math.max(edges[i - 1] + 1, Math.round(lowBin * ratio)));
    }
    edges[count] = highBin + 1;

    const data = readAnalyserLevels.bufferFor(analyser, bins);
    analyser.getByteFrequencyData(data);
    const levels = zeroLevels(count);
    for (let i = 0; i < count; i++) {
      let sum = 0;
      let seen = 0;
      for (let bin = edges[i]; bin < edges[i + 1] && bin < bins; bin++) {
        sum += data[bin];
        seen++;
      }
      const average = seen ? sum / seen / 255 : 0;
      levels[i] = average < 0.02 ? 0 : Math.pow(average, defaults.gamma);
    }
    return levels;
  }

  // 给同一个 AnalyserNode 复用 Uint8Array，避免 8 Hz 下反复分配。
  const buffers = new WeakMap();
  readAnalyserLevels.bufferFor = (analyser, bins) => {
    let buffer = buffers.get(analyser);
    if (!buffer || buffer.length !== bins) {
      buffer = new Uint8Array(bins);
      buffers.set(analyser, buffer);
    }
    return buffer;
  };

  function create({
    display,
    getLevels,
    isPlaying = () => true,
    onLog = () => {},
    onUpdate = () => {},
    intervalMs = defaults.intervalMs,
    barCount = defaults.barCount,
    setInterval: startTimer = (callback, ms) => {
      const id = setInterval(callback, ms);
      return () => clearInterval(id);
    }
  } = {}) {
    if (!display || typeof display.updateSpectrum !== 'function') {
      throw new TypeError('频谱同步需要 display.updateSpectrum。');
    }
    if (typeof getLevels !== 'function') {
      throw new TypeError('频谱同步需要 getLevels 函数。');
    }
    const state = {
      running: false,
      stopTimer: null,
      inflight: false,
      failureReported: false
    };

    function log(message) {
      try { onLog(message); } catch { /* 日志回调异常不影响频谱 */ }
    }

    function report(update) {
      try { onUpdate(update); } catch { /* 状态回调异常不影响频谱 */ }
    }

    function reportFailure(prefix, error) {
      if (state.failureReported) return;
      state.failureReported = true;
      log(prefix + ' · ' + (error?.message ?? '未知错误') + ' · 继续按帧重试');
    }

    function normalize(levels) {
      const list = Array.isArray(levels) || ArrayBuffer.isView(levels) ? levels : [];
      const out = new Array(barCount).fill(0);
      for (let i = 0; i < barCount && i < list.length; i++) {
        const value = Number(list[i]);
        out[i] = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
      }
      return out;
    }

    async function push(levels) {
      if (state.inflight) return;
      state.inflight = true;
      try {
        await display.updateSpectrum(levels);
        state.failureReported = false;
        report({ kind: 'spectrum', levels: Array.from(levels) });
      } catch (error) {
        reportFailure('OLED 频谱更新失败', error);
      } finally {
        state.inflight = false;
      }
    }

    // 一轮频谱推送：播放中才发；暂停/无歌时直接跳过，保持 OLED 上最后一帧不变。
    // 显示忙时丢这一帧（不排队，保证文本更新与命令优先）。
    async function tick() {
      if (!state.running || state.inflight) return;
      let playing = false;
      try {
        playing = Boolean(isPlaying());
      } catch {
        playing = false;
      }
      if (!playing) return; // 暂停：频谱冻结在最后一帧，不再发归零帧
      if (typeof display.isBusy === 'function' && display.isBusy()) return;
      let levels;
      try {
        levels = getLevels();
      } catch (error) {
        reportFailure('OLED 频谱采样失败', error);
        return;
      }
      await push(normalize(levels));
    }

    function safeTick() {
      void tick().catch(error => {
        log('OLED 频谱轮询异常 · ' + (error?.message ?? '未知错误'));
      });
    }

    function start() {
      if (state.running) return false;
      state.running = true;
      state.failureReported = false;
      state.stopTimer = startTimer(safeTick, intervalMs);
      safeTick(); // 立即出一帧，恢复跟随时不用等一个周期
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
      // 供测试/调试手动触发一轮频谱推送；正常运行时由 start() 的定时器调用。
      tick
    };
  }

  return { defaults, barCount: defaults.barCount, zeroLevels, readAnalyserLevels, create };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ZilyOledSpectrum;