'use strict';

// 0-8A OLED 显示协议主机模块离线测试（node:test + node:assert/strict）。
// 覆盖：文档第 14 节示例帧逐字节一致、ACK 校验、1bpp 打包、
// create() 的停等分片/重传/串行化/忙退避/清屏，全部使用假 bridge，不碰真实串口。

const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../web/js/25-uart-protocol');
const oled = require('../web/js/29-oled-display');

const bytes = (...values) => Uint8Array.of(...values);
const hex = data => Array.from(data, byte => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ');
const white = [255, 255, 255, 255];
const black = [0, 0, 0, 255];
// 文档第 14 节 DATA 示例中的 16×8 已知图案（偶数行全亮、奇数行全灭）。
const pattern16x8 = bytes(0xFF, 0xFF, 0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00,
  0xFF, 0xFF, 0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00);

function imageData(width, height, pixel) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const index = (row * width + col) * 4;
      const [r, g, b, a] = pixel(col, row);
      data[index] = r; data[index + 1] = g; data[index + 2] = b; data[index + 3] = a;
    }
  }
  return { width, height, data };
}

const ackFrame = (cmd, statusValue, next, payloadLength = 3) => ({
  type: oled.type.ACK, seq: 1, length: payloadLength,
  payload: payloadLength === 3 ? bytes(cmd, statusValue, next) : bytes(cmd, statusValue)
});

// 假 bridge：模拟 26 号单通道 request(type, 0x91, payload, validate)，
// handler 返回 { status, next } 构造 ACK 帧并跑一遍 validate；也可以直接 throw。
function createFakeBridge(handler) {
  const requests = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let seq = 1;
  return {
    requests,
    get maxInFlight() { return maxInFlight; },
    request(message, replyType, payload, validate) {
      assert.equal(replyType, oled.type.ACK);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const index = requests.length;
      requests.push({ message, payload: Uint8Array.from(payload) });
      return Promise.resolve()
        .then(() => handler(message, payload, index))
        .then(result => {
          const frame = {
            type: oled.type.ACK, seq: seq++, length: 3,
            payload: bytes(message, result?.status ?? 0, result?.next ?? 0)
          };
          const error = validate ? validate(frame) : null;
          if (error) throw error;
          return frame;
        })
        .finally(() => { inFlight--; });
    }
  };
}

const okBridge = () => createFakeBridge(() => ({ status: oled.status.OK }));
const messagesOf = bridge => bridge.requests.map(entry => entry.message);
const dataRequests = bridge => bridge.requests.filter(entry => entry.message === oled.type.DATA);
const beginRequests = bridge => bridge.requests.filter(entry => entry.message === oled.type.BEGIN);

test('BEGIN/DATA/END 编码与协议文档第 14 节示例帧逐字节一致', () => {
  const begin = protocol.encode(oled.type.BEGIN, 1,
    oled.encodeBegin({ session: 7, x: 0, y: 56, width: 16, height: 8, totalBytes: 16, totalChunks: 1 }));
  assert.equal(hex(begin), 'A5 5A 01 40 01 00 09 00 07 00 38 10 08 00 10 00 01 44 C4');

  const data = protocol.encode(oled.type.DATA, 2,
    oled.encodeData({ session: 7, chunk: 0, offset: 0, data: pattern16x8 }));
  assert.equal(hex(data),
    'A5 5A 01 41 02 00 14 00 07 00 00 00 FF FF 00 00 FF FF 00 00 FF FF 00 00 FF FF 00 00 9E 11');

  const end = protocol.encode(oled.type.END, 3, oled.encodeEnd({ session: 7 }));
  assert.equal(hex(end), 'A5 5A 01 42 03 00 02 00 07 01 DC 61');
});

test('协议常量、名称与定稿布局符合 0-8A 设计', () => {
  assert.deepEqual({ ...oled.type }, { BEGIN: 0x40, DATA: 0x41, END: 0x42, ACK: 0x91 });
  assert.deepEqual({ ...oled.status }, {
    OK: 0, UNSUPPORTED: 1, BAD_PAYLOAD: 2, BAD_SESSION: 3,
    BAD_CHUNK: 4, BUSY: 5, INTERNAL: 6, IO_ERROR: 7
  });
  assert.equal(Object.isFrozen(oled.type), true);
  assert.equal(Object.isFrozen(oled.status), true);
  assert.equal(oled.chunkBytes, 240);
  assert.equal(oled.maxBytes, 1024);
  assert.equal(oled.ackLength, 3);
  assert.equal(oled.spectrumBars, 24);
  assert.equal(oled.names[oled.type.BEGIN], 'DISPLAY_BEGIN');
  assert.equal(oled.names[oled.type.DATA], 'DISPLAY_DATA');
  assert.equal(oled.names[oled.type.END], 'DISPLAY_END');
  assert.equal(oled.names[oled.type.ACK], 'DISPLAY_ACK');
  assert.deepEqual({ ...oled.region.title }, { x: 0, y: 0, width: 128, height: 24 });
  assert.deepEqual({ ...oled.region.artist }, { x: 0, y: 24, width: 128, height: 16 });
  assert.deepEqual({ ...oled.region.spectrum }, { x: 0, y: 40, width: 128, height: 16 });
  assert.deepEqual({ ...oled.region.progress }, { x: 0, y: 56, width: 128, height: 8 });
  assert.deepEqual({ ...oled.region.full }, { x: 0, y: 0, width: 128, height: 64 });
  // 四个发送区域 + 全屏都按 8 像素边界对齐。
  for (const area of Object.values(oled.region)) {
    assert.equal(area.x % 8, 0);
    assert.equal(area.y % 8, 0);
    assert.equal(area.width % 8, 0);
    assert.equal(area.height % 8, 0);
  }
  assert.equal(oled.statusName(oled.status.OK), 'OK');
  assert.match(oled.statusName(oled.status.BAD_CHUNK), /分片乱序/);
  assert.match(oled.statusName(oled.status.IO_ERROR), /I2C/);
  assert.match(oled.statusName(0x7F), /0x7F/);
  assert.match(oled.statusName(undefined), /未知/);
});

test('encodeBegin 拒绝协议范围外的几何参数', () => {
  const base = { session: 1, x: 0, y: 56, width: 16, height: 8, totalBytes: 16, totalChunks: 1 };
  assert.deepEqual(oled.encodeBegin(base), bytes(1, 0, 56, 16, 8, 0, 16, 0, 1));
  assert.throws(() => oled.encodeBegin({ ...base, x: 120 }), RangeError);  // x+width>128
  assert.throws(() => oled.encodeBegin({ ...base, y: 60 }), RangeError);  // y+height>64
  assert.throws(() => oled.encodeBegin({ ...base, width: 0 }), RangeError);
  assert.throws(() => oled.encodeBegin({ ...base, height: 0 }), RangeError);
  assert.throws(() => oled.encodeBegin({ ...base, totalBytes: 8 }), RangeError);   // 与几何不匹配
  assert.throws(() => oled.encodeBegin({ ...base, totalChunks: 2 }), RangeError);  // 分片数不匹配
  assert.throws(() => oled.encodeBegin({ ...base, session: 256 }), RangeError);
  // 全屏合法：1024 B → 5 片。
  const full = oled.encodeBegin({ session: 2, x: 0, y: 0, width: 128, height: 64, totalBytes: 1024, totalChunks: 5 });
  assert.equal(full.length, 9);
  assert.equal(full[5], 0); // format 恒 0
  assert.equal(full[6] | (full[7] << 8), 1024);
  assert.equal(full[8], 5);
});

test('encodeData / encodeEnd 载荷逐字节正确并拒绝非法输入', () => {
  const payload = oled.encodeData({ session: 7, chunk: 2, offset: 480, data: bytes(1, 2, 3) });
  assert.deepEqual(payload, bytes(7, 2, 0xE0, 0x01, 1, 2, 3)); // offset 480 = LE 0x01E0
  assert.equal(payload.length, 4 + 3);
  assert.throws(() => oled.encodeData({ session: 1, chunk: 0, offset: 0, data: new Uint8Array(241) }), RangeError);
  assert.throws(() => oled.encodeData({ session: 1, chunk: 256, offset: 0, data: new Uint8Array(1) }), RangeError);
  assert.throws(() => oled.encodeData({ session: 1, chunk: 0, offset: -1, data: new Uint8Array(1) }), RangeError);
  assert.throws(() => oled.encodeData({ session: 1, chunk: 0, offset: 0, data: [1, 2] }), RangeError);
  assert.deepEqual(oled.encodeEnd({ session: 7 }), bytes(7, 1));          // flags 默认 1
  assert.deepEqual(oled.encodeEnd({ session: 7, flags: 0 }), bytes(7, 0));
  assert.throws(() => oled.encodeEnd({ session: 7, flags: 256 }), RangeError);
});

test('validateAck 接受 OK、拒绝全部失败形态且不 throw', () => {
  assert.equal(oled.validateAck(oled.type.DATA)(ackFrame(0x41, oled.status.OK, 3)), null);

  const badChunk = oled.validateAck(oled.type.DATA)(ackFrame(0x41, oled.status.BAD_CHUNK, 2));
  assert.ok(badChunk instanceof Error);
  assert.equal(badChunk.status, oled.status.BAD_CHUNK);
  assert.match(badChunk.message, /期望分片 2/); // 错误消息带期望分片号

  const badSession = oled.validateAck(oled.type.BEGIN)(ackFrame(0x40, oled.status.BAD_SESSION, 0));
  assert.ok(badSession instanceof Error);
  assert.equal(badSession.status, oled.status.BAD_SESSION);

  const ioError = oled.validateAck(oled.type.END)(ackFrame(0x42, oled.status.IO_ERROR, 0));
  assert.ok(ioError instanceof Error);
  assert.equal(ioError.status, oled.status.IO_ERROR);

  const internal = oled.validateAck(oled.type.END)(ackFrame(0x42, oled.status.INTERNAL, 0));
  assert.equal(internal.status, oled.status.INTERNAL);

  assert.match(oled.validateAck(oled.type.DATA)(ackFrame(0x40, oled.status.OK, 0)).message, /命令回显不匹配/);
  assert.match(oled.validateAck(oled.type.DATA)(ackFrame(0x41, oled.status.OK, 0, 2)).message, /长度非法/);
  const longFrame = { type: oled.type.ACK, seq: 1, length: 4, payload: bytes(0x41, 0, 1, 0) };
  assert.match(oled.validateAck(oled.type.DATA)(longFrame).message, /长度非法/);

  for (const frame of [null, undefined, {}, { length: 3 }, { payload: null }, { payload: bytes(1, 2) }]) {
    let result;
    assert.doesNotThrow(() => { result = oled.validateAck(oled.type.DATA)(frame); });
    assert.ok(result instanceof Error);
  }
});

test('parseNextChunk 读取 NEXT_CHUNK 并对非法帧返回 null', () => {
  assert.equal(oled.parseNextChunk(ackFrame(0x41, oled.status.BAD_CHUNK, 2)), 2);
  assert.equal(oled.parseNextChunk(ackFrame(0x41, oled.status.OK, 0)), 0);
  assert.equal(oled.parseNextChunk(null), null);
  assert.equal(oled.parseNextChunk({ payload: bytes(1, 2) }), null);
});

test('pack1bpp 打包 16×8 已知图案（MSB 在左、行跨度 2 B）', () => {
  const image = imageData(16, 8, (col, row) => (row % 2 === 0 ? white : black));
  assert.deepEqual(oled.pack1bpp(image), pattern16x8);
});

test('pack1bpp 支持非 8 倍数宽度、亮度阈值与总字节数', () => {
  // 5×2：行跨度 ceil(5/8)=1，总字节 2。第 0 行亮点 0/1/4 → 0b11001000=0xC8；第 1 行亮点 1/2/3 → 0b01110000=0x70。
  const image = imageData(5, 2, (col, row) => {
    const on = row === 0 ? [0, 1, 4].includes(col) : [1, 2, 3].includes(col);
    return on ? white : black;
  });
  const packed = oled.pack1bpp(image);
  assert.equal(packed.length, 2);
  assert.deepEqual(packed, bytes(0xC8, 0x70));
  // 阈值 128：亮度 ≥128 点亮、<128 熄灭（用 130/126 避开浮点边界）。
  const threshold = oled.pack1bpp(imageData(2, 1, col => (col === 0 ? [130, 130, 130, 255] : [126, 126, 126, 255])));
  assert.deepEqual(threshold, bytes(0b10000000));
  // 全屏总字节 = 128/8 × 64 = 1024。
  assert.equal(oled.pack1bpp(imageData(128, 64, () => black)).length, 1024);
  assert.throws(() => oled.pack1bpp({ width: 0, height: 8, data: new Uint8ClampedArray(0) }), RangeError);
  assert.throws(() => oled.pack1bpp({ width: 8, height: 8, data: new Uint8ClampedArray(10) }), RangeError);
});

test('全屏更新按 BEGIN→5×DATA→END 停等发送，offset 与末片长度正确', async () => {
  const bridge = okBridge();
  const display = oled.create(bridge, {});
  const bitmap = new Uint8Array(1024);
  for (let i = 0; i < bitmap.length; i++) bitmap[i] = i & 0xFF;
  await display.updateRegion(0, 0, 128, 64, bitmap);

  assert.deepEqual(messagesOf(bridge), [0x40, 0x41, 0x41, 0x41, 0x41, 0x41, 0x42]);

  const begin = bridge.requests[0].payload;
  assert.equal(begin.length, 9);
  assert.equal(begin[0], 1); // 首次更新 session=1
  assert.deepEqual(begin.subarray(1, 6), bytes(0, 0, 128, 64, 0));
  assert.equal(begin[6] | (begin[7] << 8), 1024);
  assert.equal(begin[8], 5);

  const offsets = [];
  for (let chunk = 0; chunk < 5; chunk++) {
    const payload = bridge.requests[1 + chunk].payload;
    assert.equal(payload[0], 1);          // 同一 session
    assert.equal(payload[1], chunk);      // 0 基分片号
    const offset = payload[2] | (payload[3] << 8);
    offsets.push(offset);
    assert.equal(offset, chunk * 240);
    const expectedLength = Math.min(240, 1024 - offset);
    assert.equal(payload.length, 4 + expectedLength);
    assert.deepEqual(payload.subarray(4), bitmap.subarray(offset, offset + expectedLength));
  }
  assert.deepEqual(offsets, [0, 240, 480, 720, 960]);
  assert.equal(bridge.requests[5].payload.length, 4 + 64); // 最后一片 64 B

  const end = bridge.requests[6].payload;
  assert.deepEqual(end, bytes(1, 1)); // 同一 session、flags=1
});

test('分片 NACK 后用相同 session/chunk/offset 自动重发一次并成功', async () => {
  let dataAttempts = 0;
  const bridge = createFakeBridge(message => {
    if (message === oled.type.DATA) {
      dataAttempts++;
      if (dataAttempts === 1) return { status: oled.status.BAD_CHUNK, next: 0 };
    }
    return { status: oled.status.OK };
  });
  const logs = [];
  const display = oled.create(bridge, { onLog: text => logs.push(text) });
  await display.updateRegion(0, 0, 16, 8, new Uint8Array(16));
  assert.equal(dataAttempts, 2);
  const sent = dataRequests(bridge);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].payload, sent[0].payload); // 重发载荷逐字节相同
  assert.ok(logs.some(text => /重发一次/.test(text)));
  assert.deepEqual(messagesOf(bridge), [0x40, 0x41, 0x41, 0x42]); // END 只发一次
});

test('分片连续两次失败则放弃本次更新，后续更新仍能正常发送', async () => {
  let failData = true;
  const bridge = createFakeBridge(message => {
    if (message === oled.type.DATA && failData) return { status: oled.status.BAD_CHUNK, next: 0 };
    return { status: oled.status.OK };
  });
  const logs = [];
  const display = oled.create(bridge, { onLog: text => logs.push(text) });
  await assert.rejects(display.updateRegion(0, 0, 16, 8, new Uint8Array(16)), /分片乱序/);
  assert.ok(logs.some(text => /放弃本次更新并保留旧画面/.test(text)));
  assert.equal(dataRequests(bridge).length, 2); // 只重发一次

  failData = false;
  const before = bridge.requests.length;
  await display.updateRegion(0, 0, 16, 8, new Uint8Array(16));
  const after = bridge.requests.slice(before);
  assert.deepEqual(after.map(entry => entry.message), [0x40, 0x41, 0x42]);
  assert.equal(after[0].payload[0], 2); // 新一次更新 session 递增
  assert.equal(bridge.requests[0].payload[0], 1);
});

test('END 收到 IO_ERROR 重发一次恢复；BAD_PAYLOAD 不重发直接失败', async () => {
  let endAttempts = 0;
  const bridge = createFakeBridge(message => {
    if (message === oled.type.END) {
      endAttempts++;
      if (endAttempts === 1) return { status: oled.status.IO_ERROR };
    }
    return { status: oled.status.OK };
  });
  const logs = [];
  const display = oled.create(bridge, { onLog: text => logs.push(text) });
  await display.updateRegion(0, 0, 8, 8, new Uint8Array(8));
  assert.equal(endAttempts, 2);
  assert.ok(logs.some(text => /END/.test(text) && /重发一次/.test(text)));

  const strict = createFakeBridge(message =>
    (message === oled.type.END ? { status: oled.status.BAD_PAYLOAD } : { status: oled.status.OK }));
  const display2 = oled.create(strict, {});
  await assert.rejects(display2.updateRegion(0, 0, 8, 8, new Uint8Array(8)), /载荷/);
  assert.equal(strict.requests.filter(entry => entry.message === oled.type.END).length, 1);
});

test('多个更新严格串行，单通道上不交叠', async () => {
  const bridge = createFakeBridge(async () => {
    await new Promise(resolve => setTimeout(resolve, 2));
    return { status: oled.status.OK };
  });
  const display = oled.create(bridge, {});
  const first = display.updateRegion(0, 0, 8, 8, new Uint8Array(8));
  const second = display.updateRegion(0, 8, 8, 8, new Uint8Array(8));
  await Promise.all([first, second]);
  assert.equal(bridge.maxInFlight, 1); // 任何时刻最多 1 个请求在飞
  assert.deepEqual(messagesOf(bridge), [0x40, 0x41, 0x42, 0x40, 0x41, 0x42]);
});

test('新更新覆盖尚未开始的旧更新（最新内容优先），进行中的不中断', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const bridge = createFakeBridge(async () => {
    await gate;
    return { status: oled.status.OK };
  });
  const logs = [];
  const display = oled.create(bridge, { onLog: text => logs.push(text) });
  const first = display.updateRegion(0, 0, 8, 1, Uint8Array.of(1));  // 立即开始并被 gate 卡住
  const second = display.updateRegion(0, 8, 8, 1, Uint8Array.of(2)); // 排队
  const third = display.updateRegion(0, 16, 8, 1, Uint8Array.of(3)); // 覆盖 second
  assert.equal(display.isBusy(), true);
  release();
  await Promise.all([first, second, third]);
  assert.deepEqual(messagesOf(bridge), [0x40, 0x41, 0x42, 0x40, 0x41, 0x42]);
  assert.deepEqual(dataRequests(bridge).map(entry => entry.payload[4]), [1, 3]); // second 从未上线
  assert.ok(logs.some(text => /旧更新/.test(text)));
  assert.equal(display.isBusy(), false);
});

test('单通道忙（请等待当前请求结束）时 30ms 退避自动重试成功', async () => {
  let busyThrown = 0;
  const bridge = createFakeBridge((message, payload, index) => {
    if (index === 0) { // 只有第一条请求模拟单通道忙
      busyThrown++;
      throw new Error('请等待当前请求结束。');
    }
    return { status: oled.status.OK };
  });
  const display = oled.create(bridge, {});
  await display.updateRegion(0, 0, 8, 8, new Uint8Array(8));
  assert.equal(busyThrown, 1);
  assert.deepEqual(messagesOf(bridge), [0x40, 0x40, 0x41, 0x42]); // BEGIN 退避重试后继续完整链路
});

test('忙重试最多 10 次后放弃并 reject', async () => {
  const bridge = createFakeBridge(() => { throw new Error('请等待当前请求结束。'); });
  const display = oled.create(bridge, {});
  await assert.rejects(display.updateRegion(0, 0, 8, 1, new Uint8Array(1)), /请等待当前请求结束/);
  assert.equal(bridge.requests.length, 11); // 首发 1 次 + 重试 10 次
});

test('clear() 发送全黑全屏位图，totalChunks=5', async () => {
  const bridge = okBridge();
  const display = oled.create(bridge, {});
  await display.clear();
  assert.deepEqual(messagesOf(bridge), [0x40, 0x41, 0x41, 0x41, 0x41, 0x41, 0x42]);
  const begin = bridge.requests[0].payload;
  assert.deepEqual(begin.subarray(1, 6), bytes(0, 0, 128, 64, 0));
  assert.equal(begin[6] | (begin[7] << 8), 1024);
  assert.equal(begin[8], 5);
  for (const entry of dataRequests(bridge)) {
    assert.ok(entry.payload.subarray(4).every(byte => byte === 0)); // 位图全 0
  }
  assert.deepEqual(bridge.requests[6].payload.subarray(0, 2), bytes(begin[0], 1));
});

test('showTestScreen 走注入 renderer，busy 状态正确翻转', async () => {
  const calls = [];
  const renderer = {
    renderTestScreen(state) {
      calls.push(state);
      return [{ x: 0, y: 0, width: 128, height: 64, bitmap: new Uint8Array(1024) }];
    },
    renderSong: () => [],
    renderProgress: () => []
  };
  const busyStates = [];
  const bridge = okBridge();
  const display = oled.create(bridge, { onBusyChange: value => busyStates.push(value), renderer });
  const promise = display.showTestScreen();
  assert.equal(display.isBusy(), true);
  assert.deepEqual(busyStates, [true]);
  await promise;
  assert.equal(display.isBusy(), false);
  assert.deepEqual(busyStates, [true, false]);
  assert.deepEqual({ ...calls[0] }, {
    title: '玻璃', artist: 'Gareth.T', time: '1:23', ratio: 0.5,
    levels: [0.10, 0.20, 0.32, 0.46, 0.62, 0.80, 0.95, 0.78,
      0.60, 0.46, 0.58, 0.74, 0.90, 0.70, 0.52, 0.36, 0.48, 0.64,
      0.82, 0.66, 0.48, 0.34, 0.50, 0.30]
  });
  assert.deepEqual(messagesOf(bridge), [0x40, 0x41, 0x41, 0x41, 0x41, 0x41, 0x42]); // 全屏 5 片
});

test('updateSong 发 title+artist 两区域；updateProgress 发 progress+artist 两区域', async () => {
  const songCalls = [];
  const progressCalls = [];
  const renderer = {
    renderTestScreen: () => [],
    renderSong(state) {
      songCalls.push({ ...state });
      return [
        { x: 0, y: 0, width: 128, height: 24, bitmap: new Uint8Array(384) },
        { x: 0, y: 24, width: 128, height: 16, bitmap: new Uint8Array(256) }
      ];
    },
    renderProgress(state) {
      progressCalls.push({ ...state });
      return [
        { x: 0, y: 56, width: 128, height: 8, bitmap: new Uint8Array(128) },
        { x: 0, y: 24, width: 128, height: 16, bitmap: new Uint8Array(256) }
      ];
    }
  };
  const bridge = okBridge();
  const display = oled.create(bridge, { renderer });

  await display.updateSong('玻璃', 'Gareth.T');
  assert.deepEqual(songCalls[0], {
    title: '玻璃', titleOffset: 0, artist: 'Gareth.T', time: '', ratio: 0,
    levels: new Array(24).fill(0)
  });
  let begins = beginRequests(bridge).map(entry => [...entry.payload]);
  assert.equal(begins.length, 2);
  assert.deepEqual(begins[0].slice(1, 5), [0, 0, 128, 24]);  // 歌名区（Phase 3 缩小到 24 px）
  assert.deepEqual(begins[1].slice(1, 5), [0, 24, 128, 16]); // 歌手区（时间在同行右侧）
  assert.equal(begins[0][6] | (begins[0][7] << 8), 384);
  assert.equal(begins[0][8], 2); // 384 B → 2 片
  assert.equal(begins[1][8], 2); // 256 B → 2 片
  assert.notEqual(begins[0][0], begins[1][0]); // 两个区域各自独立 session
  assert.deepEqual(messagesOf(bridge),
    [0x40, 0x41, 0x41, 0x42, 0x40, 0x41, 0x41, 0x42]);

  await display.updateProgress(83, 200);
  assert.equal(progressCalls[0].time, '1:23'); // 83 s → 1:23
  assert.ok(Math.abs(progressCalls[0].ratio - 0.415) < 1e-9);
  begins = beginRequests(bridge).map(entry => [...entry.payload]).slice(2);
  assert.deepEqual(begins[0].slice(1, 5), [0, 56, 128, 8]);  // 进度条区
  assert.deepEqual(begins[1].slice(1, 5), [0, 24, 128, 16]); // 歌手区
  assert.equal(begins[1][8], 2); // 256 B → 2 片
});

test('updateTitle 只发歌名区（128×24 / 384 B / 2 片），offset 归一化为非负整数', async () => {
  const titleCalls = [];
  const renderer = {
    renderTestScreen: () => [],
    renderSong: () => [],
    renderProgress: () => [],
    renderSpectrum: () => [],
    renderTitleWindow(state) {
      titleCalls.push({ ...state });
      return [{ x: 0, y: 0, width: 128, height: 24, bitmap: new Uint8Array(384) }];
    }
  };
  const bridge = okBridge();
  const display = oled.create(bridge, { renderer });

  await display.updateTitle('你还要我怎样', 42.6);
  assert.deepEqual(titleCalls[0], {
    title: '你还要我怎样', titleOffset: 43, artist: '', time: '', ratio: 0,
    levels: new Array(24).fill(0)
  });
  const begin = bridge.requests[0].payload;
  assert.deepEqual([...begin.slice(1, 5)], [0, 0, 128, 24]);
  assert.equal(begin[6] | (begin[7] << 8), 384);
  assert.equal(begin[8], 2);
  assert.deepEqual(messagesOf(bridge), [0x40, 0x41, 0x41, 0x42]);

  await display.updateTitle('你还要我怎样', -5);
  assert.equal(titleCalls[1].titleOffset, 0);
  await display.updateTitle('你还要我怎样', Number.NaN);
  assert.equal(titleCalls[2].titleOffset, 0);
});

test('updateSpectrum 只发频谱区（128×16 / 256 B / 2 片），等级裁剪到 0–1', async () => {
  const spectrumCalls = [];
  const renderer = {
    renderTestScreen: () => [],
    renderSong: () => [],
    renderProgress: () => [],
    renderSpectrum(state) {
      spectrumCalls.push({ ...state, levels: [...state.levels] });
      return [{ x: 0, y: 40, width: 128, height: 16, bitmap: new Uint8Array(256) }];
    }
  };
  const bridge = okBridge();
  const display = oled.create(bridge, { renderer });
  await display.updateSpectrum([0.1, 2, -1, 0.5, Number.NaN, 0.9]);

  assert.deepEqual(spectrumCalls[0].levels, [
    0.1, 1, 0, 0.5, 0, 0.9,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
  ]); // 缺省补 0、越界裁剪、长度固定 24 柱
  const begin = bridge.requests[0].payload;
  assert.deepEqual([...begin.slice(1, 5)], [0, 40, 128, 16]); // 频谱区
  assert.equal(begin[6] | (begin[7] << 8), 256);
  assert.equal(begin[8], 2); // 256 B → 2 片
  assert.deepEqual(messagesOf(bridge), [0x40, 0x41, 0x41, 0x42]);
});

test('updateRegion 拒绝非法几何/位图（中文错误），之后仍可正常发送', async () => {
  const bridge = okBridge();
  const display = oled.create(bridge, {});
  await assert.rejects(display.updateRegion(120, 0, 16, 8, new Uint8Array(16)), /超出/);
  await assert.rejects(display.updateRegion(0, 0, 8, 8, Uint8Array.of(1)), /字节数/);
  await assert.rejects(display.updateRegion(0, 0, 8, 8, [0, 1]), /Uint8Array/);
  assert.equal(bridge.requests.length, 0); // 参数错误不上线
  await display.updateRegion(0, 0, 8, 8, new Uint8Array(8));
  assert.deepEqual(messagesOf(bridge), [0x40, 0x41, 0x42]);
});
