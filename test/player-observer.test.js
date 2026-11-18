'use strict';

// 0-8A Phase 2 播放器观察器离线测试（node:test + node:assert/strict）。
// 覆盖：DOM 快照读取、启动/停止、切歌即时推送、进度 1 s 节流、暂停/恢复、
// 暂停中拖动、更新合并（单飞 + 最新值）、失败冷却重试、异常隔离，
// 以及与真实 29 号 ZilyOledDisplay 的协议级联调（假 bridge，不碰真实串口）。

const test = require('node:test');
const assert = require('node:assert/strict');
const observerModule = require('../web/js/30-player-observer');
const ZilyOledDisplay = require('../web/js/29-oled-display');

const settle = () => new Promise(resolve => { setImmediate(resolve); });
const names = ZilyOledDisplay.names;

// 假显示模块：记录 updateSong/updateProgress 调用，可注入挂起、失败与并发观测。
function createDisplay() {
  const songCalls = [];
  const progressCalls = [];
  let active = 0;
  let maxActive = 0;
  let songGate = null;
  let songFailures = 0;
  let progressFailures = 0;
  return {
    songCalls,
    progressCalls,
    get maxActive() { return maxActive; },
    holdSong() {
      let release;
      const promise = new Promise(resolve => { release = resolve; });
      songGate = { promise, release };
      return { release: () => { songGate = null; release(); } };
    },
    failNextSong(count = 1) { songFailures += count; },
    failNextProgress(count = 1) { progressFailures += count; },
    async updateSong(title, artist) {
      songCalls.push([title, artist]);
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        if (songGate) {
          const gate = songGate;
          await gate.promise;
        }
        if (songFailures > 0) {
          songFailures--;
          throw new Error('模拟歌名/歌手发送失败');
        }
      } finally {
        active--;
      }
    },
    async updateProgress(current, total) {
      progressCalls.push([current, total]);
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        if (progressFailures > 0) {
          progressFailures--;
          throw new Error('模拟进度发送失败');
        }
      } finally {
        active--;
      }
    }
  };
}

// 假定时器：只记录回调与周期，由测试手动调用 observer.poll()，避免真实等待。
function createHarness({ display = createDisplay(), snapshot = null } = {}) {
  let nowMs = 0;
  let ready = true;
  const timers = [];
  const logs = [];
  const updates = [];
  const harness = {
    display,
    timers,
    logs,
    updates,
    snapshot: snapshot || {
      title: '玻璃', artist: 'Gareth.T', playing: true, currentTime: 0, duration: 200
    },
    advance(ms) { nowMs += ms; },
    setNow(ms) { nowMs = ms; },
    get now() { return nowMs; },
    setReady(value) { ready = value; },
    get readyFlag() { return ready; }
  };
  harness.observer = observerModule.create({
    display,
    getSnapshot: () => harness.snapshot,
    isReady: () => ready,
    onLog: message => logs.push(message),
    onUpdate: update => updates.push(update),
    now: () => nowMs,
    setInterval: (callback, ms) => {
      const timer = { callback, ms, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    }
  });
  return harness;
}

async function begin(harness) {
  const started = harness.observer.start();
  await settle();
  return started;
}

test('模块常量与 create 参数校验', () => {
  assert.deepEqual({ ...observerModule.defaults }, {
    pollIntervalMs: 250, progressIntervalMs: 1000, retryDelayMs: 1000
  });
  assert.equal(typeof observerModule.create, 'function');
  assert.equal(typeof observerModule.readPlayerSnapshot, 'function');
  assert.throws(() => observerModule.create({}), /display\.updateSong/);
  assert.throws(() => observerModule.create({ display: { updateSong() {} }, getSnapshot() {} }), /updateProgress/);
  assert.throws(() => observerModule.create({ display: { updateSong() {}, updateProgress() {} } }), /getSnapshot/);
});

test('readPlayerSnapshot 只读 DOM/<audio>：歌名/歌手/播放态/进度/时长归一化', () => {
  const elements = {
    songTitle: { textContent: '  玻璃  ' },
    songArtist: { textContent: 'Gareth.T\n' },
    audioEl: {
      paused: false, ended: false, currentSrc: 'https://m.example/song.mp3',
      currentTime: 12.7, duration: 200.4
    }
  };
  const doc = { getElementById: id => elements[id] || null };
  assert.deepEqual(observerModule.readPlayerSnapshot(doc), {
    title: '玻璃', artist: 'Gareth.T', playing: true, currentTime: 12.7, duration: 200.4
  });

  elements.audioEl.paused = true;
  assert.equal(observerModule.readPlayerSnapshot(doc).playing, false);

  elements.audioEl.paused = false;
  elements.audioEl.currentSrc = '';
  elements.audioEl.src = '';
  assert.equal(observerModule.readPlayerSnapshot(doc).playing, false); // 没有音源不算播放

  elements.audioEl.src = 'https://m.example/song.mp3';
  elements.audioEl.duration = Number.NaN;      // 元数据未加载
  elements.audioEl.currentTime = Number.NaN;
  assert.deepEqual(observerModule.readPlayerSnapshot(doc), {
    title: '玻璃', artist: 'Gareth.T', playing: true, currentTime: 0, duration: null
  });

  elements.audioEl.duration = 0;
  assert.equal(observerModule.readPlayerSnapshot(doc).duration, null); // 0/Infinity 都视为未知

  assert.equal(observerModule.readPlayerSnapshot({ getElementById: () => null }), null); // 没有 <audio>
  assert.equal(observerModule.readPlayerSnapshot(null), null);
  assert.equal(observerModule.readPlayerSnapshot({}), null);
});

test('启动后立即同步歌名/歌手与进度；重复 start 无效，stop 取消定时器', async () => {
  const h = createHarness();
  assert.equal(await begin(h), true);
  assert.equal(h.observer.isRunning(), true);
  assert.equal(h.observer.start(), false); // 已在运行
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 250);
  assert.deepEqual(h.display.songCalls, [['玻璃', 'Gareth.T']]);
  assert.deepEqual(h.display.progressCalls, [[0, 200]]);
  assert.equal(h.display.maxActive, 1);
  assert.match(h.logs[0], /跟随播放已启动/);
  assert.deepEqual(h.updates.map(update => update.kind), ['song', 'progress']);
  assert.equal(h.updates[0].title, '玻璃');

  assert.equal(h.observer.stop(), true);
  assert.equal(h.timers[0].cancelled, true);
  assert.equal(h.observer.isRunning(), false);
  assert.equal(h.observer.stop(), false);
});

test('未 start 时 poll 不推送', async () => {
  const h = createHarness();
  await h.observer.poll();
  assert.deepEqual(h.display.songCalls, []);
  assert.deepEqual(h.display.progressCalls, []);
});

test('进度每秒一次：未到 1 s 或同一整秒不重复推送', async () => {
  const h = createHarness();
  await begin(h); // t=0 推 [0,200]
  assert.equal(h.display.progressCalls.length, 1);

  h.advance(250);
  h.snapshot.currentTime = 0.25;
  await h.observer.poll();
  assert.equal(h.display.progressCalls.length, 1); // 距上次不足 1 s

  h.advance(750); // t=1000
  h.snapshot.currentTime = 1;
  await h.observer.poll();
  assert.deepEqual(h.display.progressCalls.at(-1), [1, 200]);
  assert.equal(h.display.progressCalls.length, 2);

  await h.observer.poll(); // 同一整秒
  assert.equal(h.display.progressCalls.length, 2);

  h.advance(500); // t=1500，整秒没变
  h.snapshot.currentTime = 1.5;
  await h.observer.poll();
  assert.equal(h.display.progressCalls.length, 2);

  h.advance(500); // t=2000，整秒 +1 且满 1 s
  h.snapshot.currentTime = 2;
  await h.observer.poll();
  assert.deepEqual(h.display.progressCalls.at(-1), [2, 200]);
  assert.equal(h.display.progressCalls.length, 3);
  assert.equal(h.display.songCalls.length, 1); // 歌名没变不重发
});

test('切歌在下一个轮询周期立即推送歌名/歌手，并顺带复位时间与进度', async () => {
  const h = createHarness();
  await begin(h);
  h.advance(300); // 距上次进度不足 1 s，但切歌不受节流限制
  h.snapshot = { title: '新歌', artist: '新歌手', playing: true, currentTime: 0, duration: 180 };
  await h.observer.poll();
  assert.deepEqual(h.display.songCalls, [
    ['玻璃', 'Gareth.T'],
    ['新歌', '新歌手']
  ]);
  assert.deepEqual(h.display.progressCalls, [[0, 200], [0, 180]]);
  assert.deepEqual(h.updates.at(-1).kind, 'progress');

  // 同一首歌继续播放：不重发歌名，进度仍按 1 s 节奏。
  h.advance(250);
  h.snapshot.currentTime = 0.25;
  await h.observer.poll();
  assert.equal(h.display.songCalls.length, 2);
  h.advance(750);
  h.snapshot.currentTime = 1;
  await h.observer.poll();
  assert.deepEqual(h.display.progressCalls.at(-1), [1, 180]);
});

test('暂停只推一次冻结进度，恢复播放再继续；暂停中拖动进度补推一次', async () => {
  const h = createHarness();
  await begin(h); // t=0 [0,200]

  h.advance(250);
  h.snapshot.playing = false;
  h.snapshot.currentTime = 0.5;
  await h.observer.poll(); // 暂停瞬间推一次
  assert.deepEqual(h.display.progressCalls.at(-1), [0.5, 200]);
  assert.equal(h.display.progressCalls.length, 2);

  h.advance(250);
  await h.observer.poll(); // 暂停且时间没变，不重复
  assert.equal(h.display.progressCalls.length, 2);
  h.advance(1000);
  await h.observer.poll();
  assert.equal(h.display.progressCalls.length, 2);

  h.advance(250); // t=1750，暂停中拖动到 100 s
  h.snapshot.currentTime = 100;
  await h.observer.poll();
  assert.deepEqual(h.display.progressCalls.at(-1), [100, 200]);
  assert.equal(h.display.progressCalls.length, 3);
  h.advance(250);
  await h.observer.poll();
  assert.equal(h.display.progressCalls.length, 3); // 拖动后不重复

  h.advance(250); // t=2000，恢复播放立即推一次
  h.snapshot.playing = true;
  h.snapshot.currentTime = 100;
  await h.observer.poll();
  assert.equal(h.display.progressCalls.length, 4);

  h.advance(1000); // t=3000，恢复 1 s 节奏
  h.snapshot.currentTime = 101;
  await h.observer.poll();
  assert.deepEqual(h.display.progressCalls.at(-1), [101, 200]);
  assert.equal(h.display.progressCalls.length, 5);
});

test('更新合并：慢更新在飞时只保留最新歌名，结束后一次补齐', async () => {
  const display = createDisplay();
  const hold = display.holdSong(); // 卡住第一次 updateSong
  const h = createHarness({ display });
  h.observer.start();
  await settle();
  assert.deepEqual(display.songCalls, [['玻璃', 'Gareth.T']]);
  assert.equal(display.progressCalls.length, 0); // 歌名未完成前不推进度

  h.snapshot = { ...h.snapshot, title: 'A' };
  await h.observer.poll();
  h.snapshot = { ...h.snapshot, title: 'B' };
  await h.observer.poll();
  assert.equal(display.songCalls.length, 1); // 在飞期间不再开新更新

  hold.release();
  await settle();
  assert.deepEqual(display.songCalls.map(call => call[0]), ['玻璃', 'B']); // A 被合并掉
  assert.equal(display.progressCalls.length, 1);
  assert.deepEqual(display.progressCalls[0], [0, 200]);
  assert.equal(display.maxActive, 1); // 任何时刻最多一个显示更新在飞
  assert.equal(h.observer.isRunning(), true);
});

test('显示失败只记日志，冷却后重试同一首歌；冷却期间不刷屏', async () => {
  const display = createDisplay();
  display.failNextSong(1);
  const h = createHarness({ display });
  await begin(h);
  assert.deepEqual(display.songCalls, [['玻璃', 'Gareth.T']]);
  assert.deepEqual(display.progressCalls, []); // 歌名失败时不推旧歌手/时间的进度
  assert.match(h.logs.join('\n'), /歌名\/歌手更新失败/);

  h.advance(500); // 冷却中
  await h.observer.poll();
  assert.equal(display.songCalls.length, 1);

  h.advance(500); // t=1000 冷却结束，重试成功并补进度
  await h.observer.poll();
  assert.deepEqual(display.songCalls, [['玻璃', 'Gareth.T'], ['玻璃', 'Gareth.T']]);
  assert.deepEqual(display.progressCalls, [[0, 200]]);
});

test('进度发送失败不抛出，下一次轮询自动补推', async () => {
  const display = createDisplay();
  display.failNextProgress(1);
  const h = createHarness({ display });
  await begin(h);
  assert.deepEqual(display.progressCalls, [[0, 200]]); // 第一次失败
  assert.match(h.logs.join('\n'), /进度更新失败/);

  h.advance(1000);
  h.snapshot.currentTime = 1;
  await h.observer.poll(); // 冷却结束 + 整秒变化，自动补推
  assert.deepEqual(display.progressCalls.at(-1), [1, 200]);
  assert.equal(display.progressCalls.length, 2);
});

test('进度失败冷却只拦进度：期间切歌仍在下一个轮询周期推送', async () => {
  const display = createDisplay();
  display.failNextProgress(1);
  const h = createHarness({ display });
  await begin(h); // t=0：歌名成功，进度失败 → 进度冷却到 t=1000
  assert.deepEqual(display.progressCalls, [[0, 200]]);

  h.advance(250);
  h.snapshot = { title: '新歌', artist: '新歌手', playing: true, currentTime: 0, duration: 180 };
  await h.observer.poll();
  // 切歌不受进度冷却影响，立即推送；进度仍等自己的冷却。
  assert.deepEqual(display.songCalls, [['玻璃', 'Gareth.T'], ['新歌', '新歌手']]);
  assert.equal(display.progressCalls.length, 1);

  h.advance(750); // t=1000 进度冷却结束
  await h.observer.poll();
  assert.deepEqual(display.progressCalls.at(-1), [0, 180]);
  assert.equal(display.progressCalls.length, 2);
});

test('快照异常/为 null 时跳过本轮，不影响后续推送', async () => {
  const h = createHarness();
  await begin(h);
  const before = h.display.progressCalls.length;
  h.snapshot = null;
  await h.observer.poll();
  assert.equal(h.display.progressCalls.length, before);
  h.snapshot = { title: '玻璃', artist: 'Gareth.T', playing: true, currentTime: 1, duration: 200 };
  h.advance(1000);
  await h.observer.poll();
  assert.equal(h.display.progressCalls.at(-1)[0], 1);
});

test('getSnapshot 抛异常被隔离并记日志', async () => {
  const display = createDisplay();
  const logs = [];
  const observer = observerModule.create({
    display,
    getSnapshot: () => { throw new Error('读取爆炸'); },
    onLog: message => logs.push(message),
    now: () => 0,
    setInterval: () => () => {}
  });
  observer.start();
  await settle();
  assert.deepEqual(display.songCalls, []);
  assert.match(logs.join('\n'), /读取状态失败 · 读取爆炸/);
});

test('isReady=false 时不推送；stop/start 会重置并重新同步（重连场景）', async () => {
  const h = createHarness();
  h.setReady(false);
  await begin(h);
  assert.deepEqual(h.display.songCalls, []);
  assert.deepEqual(h.display.progressCalls, []);

  h.setReady(true);
  h.advance(250);
  await h.observer.poll();
  assert.deepEqual(h.display.songCalls, [['玻璃', 'Gareth.T']]);
  assert.equal(h.display.progressCalls.length, 1);

  h.observer.stop();
  h.advance(2000);
  await h.observer.poll();
  assert.equal(h.display.progressCalls.length, 1); // 已停止

  await begin(h); // 重新连接：resetTracking 后完整重发一次
  assert.deepEqual(h.display.songCalls, [['玻璃', 'Gareth.T'], ['玻璃', 'Gareth.T']]);
  assert.deepEqual(h.display.progressCalls, [[0, 200], [0, 200]]);
});

test('stop 期间的轮询不再推送；在飞更新结束后不会继续发送排队内容', async () => {
  const display = createDisplay();
  const hold = display.holdSong();
  const h = createHarness({ display });
  h.observer.start();
  await settle();
  assert.deepEqual(display.songCalls, [['玻璃', 'Gareth.T']]); // 第一次被挂起
  h.snapshot = { ...h.snapshot, title: '暂停时改的歌' };
  await h.observer.poll(); // 记下待发歌名
  h.observer.stop();
  hold.release();
  await settle();
  assert.equal(display.songCalls.length, 1); // stop 后不再发 pending 歌名
});

test('stop 后在飞的显示更新成功也不再回报/记「已更新」日志', async () => {
  const display = createDisplay();
  const hold = display.holdSong();
  const h = createHarness({ display });
  h.observer.start(); // 第一次 updateSong 被挂起
  await settle();
  assert.deepEqual(display.songCalls, [['玻璃', 'Gareth.T']]);
  h.observer.stop();
  hold.release();
  await settle();
  assert.equal(h.updates.length, 0);
  assert.equal(h.logs.some(text => /歌名\/歌手已更新/.test(text)), false);
});

test('在飞更新期间 stop→start 快速重连：不卡死，恢复后按 1 s 节奏继续', async () => {
  const display = createDisplay();
  const hold = display.holdSong();
  const h = createHarness({ display });
  h.observer.start();
  await settle();
  assert.equal(display.songCalls.length, 1);
  h.observer.stop();
  assert.equal(h.observer.start(), true); // 新 start 重置 tracking 并立即轮询
  await settle(); // 旧更新仍在飞，新轮询只记 pending
  hold.release();
  await settle();
  await settle();
  assert.equal(h.observer.isRunning(), true);
  const progressBefore = display.progressCalls.length;
  h.advance(1000);
  h.snapshot.currentTime = 1;
  await h.observer.poll();
  assert.deepEqual(display.progressCalls.at(-1), [1, 200]);
  assert.equal(display.progressCalls.length, progressBefore + 1);
});

test('歌名/歌手空值与数字会被归一化成字符串', async () => {
  const display = createDisplay();
  const h = createHarness({
    display,
    snapshot: { title: null, artist: 123, playing: true, currentTime: 0, duration: 200 }
  });
  await begin(h);
  assert.deepEqual(display.songCalls, [['', '123']]);
});

test('时长未知时进度按 total=0 推送，加载出时长后恢复正常比例', async () => {
  const display = createDisplay();
  const h = createHarness({
    display,
    snapshot: { title: '玻璃', artist: 'Gareth.T', playing: true, currentTime: 0, duration: null }
  });
  await begin(h);
  assert.deepEqual(display.progressCalls, [[0, 0]]);
  h.advance(1000);
  h.snapshot.currentTime = 1;
  h.snapshot.duration = 200;
  await h.observer.poll();
  assert.deepEqual(display.progressCalls.at(-1), [1, 200]);
});

test('暂停且时长未知时，元数据到达后补推一次进度', async () => {
  const display = createDisplay();
  const h = createHarness({
    display,
    snapshot: { title: '玻璃', artist: 'Gareth.T', playing: false, currentTime: 5, duration: null }
  });
  await begin(h);
  assert.deepEqual(display.progressCalls, [[5, 0]]);
  h.advance(1000);
  h.snapshot.duration = 200;
  await h.observer.poll();
  assert.deepEqual(display.progressCalls.at(-1), [5, 200]);
  assert.equal(display.progressCalls.length, 2);
});

// ── 与真实 29 号 OLED 显示模块的协议级联调 ────────────────────────────────

function createFakeBridge() {
  const requests = [];
  return {
    requests,
    request(message, replyType, payload, validate) {
      assert.equal(replyType, ZilyOledDisplay.type.ACK);
      requests.push({ message, payload: Uint8Array.from(payload) });
      const frame = {
        type: ZilyOledDisplay.type.ACK, seq: requests.length, length: 3,
        payload: Uint8Array.of(message, ZilyOledDisplay.status.OK, 0)
      };
      const error = validate ? validate(frame) : null;
      if (error) return Promise.reject(error);
      return Promise.resolve(frame);
    }
  };
}

const renderer = {
  renderTestScreen: () => [],
  renderSong: () => [
    { x: 0, y: 0, width: 128, height: 32, bitmap: new Uint8Array(512) },
    { x: 0, y: 32, width: 128, height: 24, bitmap: new Uint8Array(384) }
  ],
  renderProgress: () => [
    { x: 0, y: 56, width: 128, height: 8, bitmap: new Uint8Array(128) },
    { x: 0, y: 32, width: 128, height: 24, bitmap: new Uint8Array(384) }
  ]
};

test('与 29 号模块联调：观察器一次轮询产生歌名两区 + 进度两区的完整链路', async () => {
  const bridge = createFakeBridge();
  const display = ZilyOledDisplay.create(bridge, { renderer });
  const h = createHarness({ display });
  await begin(h);

  assert.deepEqual(bridge.requests.map(request => names[request.message]), [
    'DISPLAY_BEGIN', 'DISPLAY_DATA', 'DISPLAY_DATA', 'DISPLAY_DATA', 'DISPLAY_END', // 歌名 512 B / 3 片
    'DISPLAY_BEGIN', 'DISPLAY_DATA', 'DISPLAY_DATA', 'DISPLAY_END',                // 歌手 384 B / 2 片
    'DISPLAY_BEGIN', 'DISPLAY_DATA', 'DISPLAY_END',                                // 进度 128 B / 1 片
    'DISPLAY_BEGIN', 'DISPLAY_DATA', 'DISPLAY_DATA', 'DISPLAY_END'                 // 歌手（时间行）
  ]);
  const begins = bridge.requests
    .filter(request => request.message === ZilyOledDisplay.type.BEGIN)
    .map(request => [...request.payload.slice(1, 5)]);
  assert.deepEqual(begins, [
    [0, 0, 128, 32], [0, 32, 128, 24], [0, 56, 128, 8], [0, 32, 128, 24]
  ]);
  assert.equal(display.isBusy(), false);

  // 下一次进度轮询走同一链路：进度区 + 歌手区。
  const seen = bridge.requests.length;
  h.advance(1000);
  h.snapshot.currentTime = 1;
  await h.observer.poll();
  assert.deepEqual(bridge.requests.slice(seen).map(request => names[request.message]), [
    'DISPLAY_BEGIN', 'DISPLAY_DATA', 'DISPLAY_END',
    'DISPLAY_BEGIN', 'DISPLAY_DATA', 'DISPLAY_DATA', 'DISPLAY_END'
  ]);
});