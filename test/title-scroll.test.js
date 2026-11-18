'use strict';

// 0-8A Phase 3 补充：长歌名滚动模块离线测试（node:test + node:assert/strict）。
// 覆盖：字符数判定（≤4 静态 / >4 滚动）、偏移步进、忙丢帧、标题变化复位、失败重试、
// 启动停止，以及与真实 29 号模块的帧级联调（只发歌名区）。

const test = require('node:test');
const assert = require('node:assert/strict');
const scrollModule = require('../web/js/33-title-scroll');
const ZilyOledDisplay = require('../web/js/29-oled-display');

const settle = () => new Promise(resolve => { setImmediate(resolve); });

function createDisplay() {
  const calls = [];
  let busy = false;
  let failures = 0;
  let gate = null;
  return {
    calls,
    setBusy(value) { busy = value; },
    isBusy: () => busy,
    failNext(count = 1) { failures += count; },
    hold() {
      let release;
      const promise = new Promise(resolve => { release = resolve; });
      gate = { promise, release };
      return { release: () => { gate = null; release(); } };
    },
    async updateTitle(title, offset) {
      calls.push([title, offset]);
      if (gate) {
        const current = gate;
        await current.promise;
      }
      if (failures > 0) {
        failures--;
        throw new Error('模拟滚动发送失败');
      }
    }
  };
}

function createHarness({ display = createDisplay(), title = '你还要我怎样' } = {}) {
  const timers = [];
  const logs = [];
  const harness = { display, timers, logs, title };
  harness.scroller = scrollModule.create({
    display,
    getTitle: () => harness.title,
    onLog: message => logs.push(message),
    setInterval: (callback, ms) => {
      const timer = { callback, ms, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    }
  });
  return harness;
}

test('常量、字符计数与 create 参数校验', () => {
  assert.deepEqual({ ...scrollModule.defaults }, { intervalMs: 250, stepPx: 6, maxChars: 4 });
  assert.equal(scrollModule.charCount('玻璃'), 2);
  assert.equal(scrollModule.charCount('你还要我怎样'), 6);
  assert.equal(scrollModule.charCount('  你还要我怎样  '), 6); // 前后空白不计
  assert.equal(scrollModule.charCount(''), 0);
  assert.equal(scrollModule.charCount('🎵🎶'), 2); // 代理对按字符算
  assert.throws(() => scrollModule.create({}), /updateTitle/);
  assert.throws(() => scrollModule.create({ display: { updateTitle() {} } }), /getTitle/);
});

test('>4 字：立即发 offset 0，随后每拍 +6 px；≤4 字不发', async () => {
  const h = createHarness({ title: '你还要我怎样' });
  h.scroller.start();
  await settle();
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 250);
  assert.deepEqual(h.display.calls, [['你还要我怎样', 0]]);

  await h.scroller.tick();
  await h.scroller.tick();
  assert.deepEqual(h.display.calls, [['你还要我怎样', 0], ['你还要我怎样', 6], ['你还要我怎样', 12]]);

  h.title = '玻璃';
  await h.scroller.tick();
  await h.scroller.tick();
  assert.equal(h.display.calls.length, 3); // 短标题交给静态居中渲染

  h.title = '晴天';
  await h.scroller.tick();
  assert.equal(h.display.calls.length, 3);

  h.scroller.stop();
  assert.equal(h.timers[0].cancelled, true);
  await h.scroller.tick();
  assert.equal(h.display.calls.length, 3);
});

test('恰好 4 字不滚动；5 字开始滚动', async () => {
  const h = createHarness({ title: '富士山下' });
  h.scroller.start();
  await settle();
  assert.equal(h.display.calls.length, 0);

  h.title = '你还要我怎样';
  await h.scroller.tick();
  assert.deepEqual(h.display.calls.at(-1), ['你还要我怎样', 0]);
});

test('标题变化时从 offset 0 重新开始', async () => {
  const h = createHarness({ title: '你还要我怎样' });
  h.scroller.start();
  await settle();
  await h.scroller.tick();
  await h.scroller.tick();
  assert.deepEqual(h.display.calls.map(call => call[1]), [0, 6, 12]);

  h.title = '像我这样的人';
  await h.scroller.tick();
  assert.deepEqual(h.display.calls.at(-1), ['像我这样的人', 0]);
  await h.scroller.tick();
  assert.deepEqual(h.display.calls.at(-1), ['像我这样的人', 6]);
});

test('显示忙时丢帧且不推进 offset；空闲后继续', async () => {
  const h = createHarness({ title: '你还要我怎样' });
  h.scroller.start();
  await settle();
  h.display.setBusy(true);
  await h.scroller.tick();
  await h.scroller.tick();
  assert.equal(h.display.calls.length, 1); // 忙：不排队
  h.display.setBusy(false);
  await h.scroller.tick();
  assert.deepEqual(h.display.calls.at(-1), ['你还要我怎样', 6]); // offset 没被忙帧推进
});

test('发送失败只记一次日志，下一拍重试同一 offset', async () => {
  const display = createDisplay();
  const h = createHarness({ display, title: '你还要我怎样' });
  display.failNext(1);
  h.scroller.start();
  await settle();
  assert.match(h.logs.join('\n'), /歌名滚动失败/);
  assert.deepEqual(display.calls, [['你还要我怎样', 0]]); // 失败帧 offset 未推进

  await h.scroller.tick();
  assert.deepEqual(display.calls.at(-1), ['你还要我怎样', 0]); // 重试同一 offset
  await h.scroller.tick();
  assert.deepEqual(display.calls.at(-1), ['你还要我怎样', 6]);
});

test('单飞：在飞期间的新 tick 被跳过', async () => {
  const display = createDisplay();
  const h = createHarness({ display, title: '你还要我怎样' });
  const hold = display.hold();
  h.scroller.start();
  await settle();
  assert.equal(display.calls.length, 1); // 第一帧被挂起
  const skipped = h.scroller.tick(); // 在飞期间调用，应立刻返回
  await skipped;
  assert.equal(display.calls.length, 1);
  hold.release();
  await settle();
  await h.scroller.tick();
  assert.deepEqual(display.calls.at(-1), ['你还要我怎样', 6]);
});

test('与 29 号模块联调：滚动只发歌名区（128×24 / 384 B / 2 片）', async () => {
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
    renderSpectrum: () => [],
    renderTitleWindow: () => [{ x: 0, y: 0, width: 128, height: 24, bitmap: new Uint8Array(384) }]
  };
  const display = ZilyOledDisplay.create(bridge, { renderer });
  const h = createHarness({ display, title: '你还要我怎样' });
  h.scroller.start();
  await settle();
  await settle();
  h.scroller.stop();
  assert.deepEqual(requests.map(request => request.message),
    [0x40, 0x41, 0x41, 0x42]);
  const begin = requests[0].payload;
  assert.deepEqual([...begin.slice(1, 5)], [0, 0, 128, 24]);
  assert.equal(begin[6] | (begin[7] << 8), 384);
  assert.equal(begin[8], 2);
});