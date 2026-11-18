'use strict';

// 0-8A Phase 3 实时频谱模块离线测试（node:test + node:assert/strict）。
// 覆盖：AnalyserNode 频段映射（对数分段/gamma/静音）、启动/停止、暂停冻结、
// 显示忙丢帧、单飞合并、失败/采样异常隔离，以及与真实 29 号模块的帧级联调。

const test = require('node:test');
const assert = require('node:assert/strict');
const spectrumModule = require('../web/js/31-oled-spectrum');
const ZilyOledDisplay = require('../web/js/29-oled-display');

const settle = () => new Promise(resolve => { setImmediate(resolve); });
const zeros = (count = 24) => new Array(count).fill(0);
const names = ZilyOledDisplay.names;

// 假显示模块：记录 updateSpectrum 调用，可注入挂起、失败与 busy 状态。
function createDisplay() {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  let gate = null;
  let failures = 0;
  let busy = false;
  return {
    calls,
    get maxActive() { return maxActive; },
    isBusy: () => busy,
    setBusy(value) { busy = value; },
    hold() {
      let release;
      const promise = new Promise(resolve => { release = resolve; });
      gate = { promise, release };
      return { release: () => { gate = null; release(); } };
    },
    failNext(count = 1) { failures += count; },
    async updateSpectrum(levels) {
      calls.push([...levels]);
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        if (gate) {
          const current = gate;
          await current.promise;
        }
        if (failures > 0) {
          failures--;
          throw new Error('模拟频谱发送失败');
        }
      } finally {
        active--;
      }
    }
  };
}

function createHarness({ display = createDisplay(), levels = new Array(24).fill(0.5), playing = true } = {}) {
  const timers = [];
  const logs = [];
  const updates = [];
  const harness = {
    display,
    timers,
    logs,
    updates,
    levels: [...levels],
    playing,
    throwLevels: false
  };
  harness.spectrum = spectrumModule.create({
    display,
    getLevels: () => {
      if (harness.throwLevels) throw new Error('采样爆炸');
      return harness.levels;
    },
    isPlaying: () => harness.playing,
    onLog: message => logs.push(message),
    onUpdate: update => updates.push(update),
    setInterval: (callback, ms) => {
      const timer = { callback, ms, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    }
  });
  return harness;
}

test('常量与 create 参数校验', () => {
  assert.deepEqual({ ...spectrumModule.defaults }, {
    intervalMs: 125, barCount: 24, gamma: 0.75, minHz: 60, maxHz: 16000
  });
  assert.equal(spectrumModule.barCount, 24);
  assert.deepEqual(spectrumModule.zeroLevels(24), zeros());
  assert.equal(typeof spectrumModule.readAnalyserLevels, 'function');
  assert.throws(() => spectrumModule.create({}), /updateSpectrum/);
  assert.throws(() => spectrumModule.create({ display: { updateSpectrum() {} } }), /getLevels/);
});

function fakeAnalyser({ fill = 0, sampleRate = 44100, fftSize = 256 } = {}) {
  const bins = fftSize / 2;
  const analyser = {
    fftSize,
    frequencyBinCount: bins,
    context: { sampleRate },
    calls: 0,
    buffers: [],
    getByteFrequencyData(target) {
      analyser.calls++;
      analyser.buffers.push(target);
      target.fill(typeof fill === 'function' ? 0 : fill);
      if (typeof fill === 'function') {
        for (let i = 0; i < target.length; i++) target[i] = fill(i, target.length);
      }
    }
  };
  return analyser;
}

test('readAnalyserLevels：无 Analyser/非法 bins 返回全 0，长度等于 barCount', () => {
  assert.deepEqual(spectrumModule.readAnalyserLevels(null), zeros());
  assert.deepEqual(spectrumModule.readAnalyserLevels({}), zeros());
  assert.deepEqual(spectrumModule.readAnalyserLevels({ frequencyBinCount: 1, getByteFrequencyData() {} }), zeros());
  assert.deepEqual(spectrumModule.readAnalyserLevels(fakeAnalyser({ fill: 0 }), 6), zeros(6));
});

test('readAnalyserLevels：全 255 → 全 1；低 bins 有能量时低频柱高、高频柱为 0；gamma 抬高中段', () => {
  const full = spectrumModule.readAnalyserLevels(fakeAnalyser({ fill: 255 }));
  assert.equal(full.length, 24);
  for (const level of full) assert.ok(Math.abs(level - 1) < 1e-9);

  const lowOnly = spectrumModule.readAnalyserLevels(fakeAnalyser({ fill: bin => (bin < 4 ? 255 : 0) }));
  assert.ok(lowOnly[0] > 0.5);
  assert.equal(lowOnly[23], 0);

  const mid = spectrumModule.readAnalyserLevels(fakeAnalyser({ fill: 128 })); // 128/255 ≈ 0.5
  assert.ok(mid.every(level => level > 0.5)); // 0.75 次幂抬高
  assert.ok(mid.every(level => level < 1));
});

test('readAnalyserLevels 复用同一个 Uint8Array（8 Hz 下不反复分配）', () => {
  const analyser = fakeAnalyser({ fill: 1 });
  spectrumModule.readAnalyserLevels(analyser);
  spectrumModule.readAnalyserLevels(analyser);
  assert.equal(analyser.calls, 2);
  assert.equal(analyser.buffers[0], analyser.buffers[1]);
  assert.equal(analyser.buffers[0].length, analyser.frequencyBinCount);
});

test('start 立即推一帧并注册 125 ms 定时器；重复 start 无效；stop 取消定时器', async () => {
  const h = createHarness();
  assert.equal(h.spectrum.start(), true);
  assert.equal(h.spectrum.start(), false);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 125);
  await settle();
  assert.deepEqual(h.display.calls, [new Array(24).fill(0.5)]);
  assert.equal(h.updates.at(-1).kind, 'spectrum');

  assert.equal(h.spectrum.stop(), true);
  assert.equal(h.timers[0].cancelled, true);
  assert.equal(h.spectrum.stop(), false);
  await h.spectrum.tick();
  assert.equal(h.display.calls.length, 1); // 已停止
});

test('暂停时不再发帧（频谱冻结在最后一帧），恢复播放继续发', async () => {
  const h = createHarness({ playing: false });
  h.spectrum.start();
  await settle();
  assert.deepEqual(h.display.calls, []); // 未播放：不发归零帧，频谱区保持原样

  await h.spectrum.tick();
  await h.spectrum.tick();
  assert.equal(h.display.calls.length, 0); // 不空转

  // 播放时正常发；随后暂停，帧数不再增长（保留最后一帧）。
  h.playing = true;
  h.levels = new Array(24).fill(0.7);
  await h.spectrum.tick();
  assert.deepEqual(h.display.calls.at(-1), h.levels);
  h.playing = false;
  await h.spectrum.tick();
  await h.spectrum.tick();
  assert.equal(h.display.calls.length, 1); // 暂停后不再发

  h.playing = true;
  h.levels = new Array(24).fill(0).map((_, index) => (index % 5) / 4);
  await h.spectrum.tick();
  assert.deepEqual(h.display.calls.at(-1), h.levels);
});

test('显示的文本更新忙时直接丢帧，不排队', async () => {
  const h = createHarness();
  h.display.setBusy(true);
  h.spectrum.start();
  await settle();
  assert.deepEqual(h.display.calls, []); // 忙 → 丢帧
  h.display.setBusy(false);
  await h.spectrum.tick();
  assert.equal(h.display.calls.length, 1);
});

test('单飞：在飞期间的新帧被跳过，结束后下一帧取最新等级', async () => {
  const display = createDisplay();
  const harness = createHarness({ display });
  const hold = display.hold();
  harness.spectrum.start();
  await settle();
  assert.equal(display.calls.length, 1); // 第一帧被挂起
  harness.levels = new Array(24).fill(0.9);
  await harness.spectrum.tick(); // 在飞，跳过
  assert.equal(display.calls.length, 1);
  hold.release();
  await settle();
  await harness.spectrum.tick();
  assert.equal(display.calls.length, 2);
  assert.deepEqual(display.calls[1], new Array(24).fill(0.9));
  assert.equal(display.maxActive, 1);
});

test('发送失败只记一次日志，成功后恢复；采样异常同样只记一次', async () => {
  const display = createDisplay();
  const harness = createHarness({ display });
  display.failNext(2);
  harness.spectrum.start();
  await settle();
  await harness.spectrum.tick();
  assert.equal(harness.logs.filter(text => /频谱更新失败/.test(text)).length, 1);
  await harness.spectrum.tick(); // 失败已恢复日志节流，本次成功
  assert.equal(display.calls.length, 3);

  harness.throwLevels = true;
  await harness.spectrum.tick();
  await harness.spectrum.tick();
  assert.equal(harness.logs.filter(text => /频谱采样失败/.test(text)).length, 1);
});

test('等级数组裁剪：越界/NaN 归一化，缺省补 0，长度固定 24', async () => {
  const h = createHarness();
  h.spectrum.start();
  await settle();
  h.levels = [2, -1, 0.5, Number.NaN, 0.25];
  await h.spectrum.tick();
  assert.deepEqual(h.display.calls.at(-1), [1, 0, 0.5, 0, 0.25, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('与 29 号模块联调：频谱帧序列 BEGIN→2×DATA→END，区域 (0,40,128,16)', async () => {
  const requests = [];
  const bridge = {
    request(message, replyType, payload, validate) {
      assert.equal(replyType, ZilyOledDisplay.type.ACK);
      requests.push({ message, payload: Uint8Array.from(payload) });
      const frame = {
        type: ZilyOledDisplay.type.ACK, seq: requests.length, length: 3,
        payload: Uint8Array.of(message, ZilyOledDisplay.status.OK, 0)
      };
      const error = validate ? validate(frame) : null;
      return error ? Promise.reject(error) : Promise.resolve(frame);
    }
  };
  const renderer = {
    renderTestScreen: () => [],
    renderSong: () => [],
    renderProgress: () => [],
    renderSpectrum: () => [{ x: 0, y: 40, width: 128, height: 16, bitmap: new Uint8Array(256) }]
  };
  const display = ZilyOledDisplay.create(bridge, { renderer });
  const harness = createHarness({ display });
  harness.spectrum.start();
  await settle();
  await settle();
  harness.spectrum.stop();
  assert.deepEqual(requests.map(request => names[request.message]),
    ['DISPLAY_BEGIN', 'DISPLAY_DATA', 'DISPLAY_DATA', 'DISPLAY_END']);
  const begin = requests[0].payload;
  assert.deepEqual([...begin.slice(1, 5)], [0, 40, 128, 16]);
  assert.equal(begin[6] | (begin[7] << 8), 256);
  assert.equal(begin[8], 2);
});