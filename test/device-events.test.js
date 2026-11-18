'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../web/js/25-uart-protocol');
const serial = require('../web/js/26-web-serial');
const events = require('../web/js/32-device-events');

const { KEY_EVENT, ENCODER_EVENT } = events.type;
const bytes = (...values) => Uint8Array.of(...values);
const keyEvent = (id, action) => ({ type: KEY_EVENT, seq: 0, length: 2, payload: bytes(id, action) });
const encoderEvent = raw => ({ type: ENCODER_EVENT, seq: 0, length: 1, payload: bytes(raw & 0xFF) });

function recordActions() {
  const calls = [];
  const actions = {
    playPause: () => { calls.push(['playPause']); return '已切换播放/暂停'; },
    next: () => { calls.push(['next']); return '已请求下一首'; },
    adjustVolume: delta => { calls.push(['adjustVolume', delta]); return '音量 ' + delta; }
  };
  return { calls, actions };
}

test('parse accepts encoder single/double clicks and detents', () => {
  assert.deepEqual(events.parse(keyEvent(3, 0)), { kind: 'key', type: KEY_EVENT, keyId: 3, action: 0 });
  assert.deepEqual(events.parse(keyEvent(3, 2)), { kind: 'key', type: KEY_EVENT, keyId: 3, action: 2 });
  assert.deepEqual(events.parse(encoderEvent(0x01)), { kind: 'encoder', type: ENCODER_EVENT, delta: 1 });
  assert.deepEqual(events.parse(encoderEvent(0xFF)), { kind: 'encoder', type: ENCODER_EVENT, delta: -1 });
  assert.deepEqual(events.parse(encoderEvent(0x7F)), { kind: 'encoder', type: ENCODER_EVENT, delta: 127 });
  assert.deepEqual(events.parse(encoderEvent(0x81)), { kind: 'encoder', type: ENCODER_EVENT, delta: -127 });
});

test('parse rejects removed keys, long press and illegal payloads', () => {
  const badKeyLength = { type: KEY_EVENT, length: 1, payload: bytes(3) };
  assert.match(events.parse(badKeyLength).error, /长度应为 2/);
  // KEY1/KEY2 were removed from 0-9A; only keyId 3 is valid.
  assert.match(events.parse(keyEvent(1, 0)).error, /keyId 非法/);
  assert.match(events.parse(keyEvent(2, 0)).error, /keyId 非法/);
  assert.match(events.parse(keyEvent(0, 0)).error, /keyId 非法/);
  assert.match(events.parse(keyEvent(9, 0)).error, /keyId 非法/);
  // action 1 (long press) is reserved and never emitted.
  assert.match(events.parse(keyEvent(3, 1)).error, /action 非法/);
  assert.match(events.parse(keyEvent(3, 3)).error, /action 非法/);
  const badEncoderLength = { type: ENCODER_EVENT, length: 2, payload: bytes(1, 2) };
  assert.match(events.parse(badEncoderLength).error, /长度应为 1/);
  assert.match(events.parse(encoderEvent(0)).error, /delta 非法/);
  assert.match(events.parse(encoderEvent(0x80)).error, /delta 非法/);
  assert.match(events.parse({ type: KEY_EVENT, payload: '01' }).error, /字节数组/);
  assert.doesNotThrow(() => events.parse(null));
  assert.doesNotThrow(() => events.parse({ type: KEY_EVENT, length: 2 }));
});

test('parse ignores types outside the 0xC0-0xEF device event range', () => {
  for (const type of [0x01, 0x10, 0x42, 0x90, 0x91, 0xBF, 0xC2, 0xF0]) {
    assert.equal(events.parse({ type, length: 2, payload: bytes(3, 0) }), null, 'TYPE 0x' + type.toString(16));
  }
  assert.equal(events.isEventType(0xC0), true);
  assert.equal(events.isEventType(0xEF), true);
  assert.equal(events.isEventType(0xBF), false);
  assert.equal(events.isEventType(0xF0), false);
});

test('parse falls back to payload.length when frame.length is missing', () => {
  assert.deepEqual(events.parse({ type: KEY_EVENT, payload: bytes(3, 2) }),
    { kind: 'key', type: KEY_EVENT, keyId: 3, action: 2 });
  assert.equal(events.parse({ type: ENCODER_EVENT, payload: bytes() }).error.includes('长度应为 1'), true);
});

test('create maps single click to playPause and double click to next', () => {
  const { calls, actions } = recordActions();
  const dispatcher = events.create({ actions });
  assert.equal(dispatcher.handle(keyEvent(3, 0)).applied, true);
  assert.equal(dispatcher.handle(keyEvent(3, 2)).applied, true);
  assert.equal(dispatcher.handle(encoderEvent(0xFF)).applied, true);
  assert.deepEqual(calls, [['playPause'], ['next'], ['adjustVolume', -1]]);
});

test('create reports malformed events and never calls actions', () => {
  const { calls, actions } = recordActions();
  const logs = [];
  const dispatcher = events.create({ actions, onLog: message => logs.push(message) });
  const result = dispatcher.handle(keyEvent(1, 0));
  assert.equal(result.applied, false);
  assert.equal(result.error, true);
  const longPress = dispatcher.handle(keyEvent(3, 1));
  assert.equal(longPress.applied, false);
  assert.equal(longPress.error, true);
  assert.deepEqual(calls, []);
  assert.match(logs.join('\n'), /keyId 非法：1/);
  assert.match(logs.join('\n'), /action 非法：1/);
  assert.equal(dispatcher.handle({ type: 0x90, length: 0, payload: bytes() }), null);
});

test('create isolates a throwing or missing action', () => {
  const logs = [];
  const dispatcher = events.create({
    actions: { next: () => { throw new Error('故意失败'); } },
    onLog: message => logs.push(message)
  });
  const thrown = dispatcher.handle(keyEvent(3, 2));
  assert.equal(thrown.applied, false);
  assert.equal(thrown.error, true);
  const missing = dispatcher.handle(keyEvent(3, 0));
  assert.equal(missing.applied, false);
  assert.match(logs.join('\n'), /执行异常 · 故意失败/);
  assert.match(logs.join('\n'), /未接线/);
});

test('create logs every applied event with its detail', () => {
  const { actions } = recordActions();
  const logs = [];
  const dispatcher = events.create({ actions, onLog: message => logs.push(message) });
  dispatcher.handle(keyEvent(3, 0));
  dispatcher.handle(encoderEvent(3));
  assert.match(logs[0], /^设备输入 · 编码器按下 单击 → 暂停\/继续 · 已切换播放\/暂停$/);
  assert.match(logs[1], /^设备输入 · 编码器 \+3 档 → 音量 · 音量 3$/);
});

test('stepVolume moves by 5% per detent, rounds and clamps', () => {
  assert.equal(events.stepVolume(0.5, 1), 0.55);
  assert.equal(events.stepVolume(0.5, -1), 0.45);
  assert.equal(events.stepVolume(0.5, 0), 0.5);
  assert.equal(events.stepVolume(0.97, 1), 1);
  assert.equal(events.stepVolume(0.03, -1), 0);
  assert.equal(events.stepVolume(0.5, 100), 1);
  assert.equal(events.stepVolume(0.5, -100), 0);
  assert.equal(events.stepVolume(0.924, 1), 0.97);
  assert.equal(events.stepVolume(1, 5), 1);
  assert.equal(events.stepVolume(0, -5), 0);
  assert.equal(events.stepVolume(Number.NaN, 1), 0.05);
  assert.equal(events.stepVolume(0.5, Number.NaN), 0.5);
});

function fixture(t, onWrite, options = {}) {
  const port = new EventTarget();
  const writes = [];
  const logs = [];
  const checks = [];
  const states = [];
  let input;
  const source = new ReadableStream({ start(controller) { input = controller; } });
  const sink = new WritableStream({ write(data) { writes.push(data); return onWrite?.(data, input); } });
  port.readable = source;
  port.writable = sink;
  port.open = async () => {};
  port.close = async () => {};
  const fakeSerial = { async requestPort() { return port; }, async getPorts() { return [port]; } };
  const client = serial.create(fakeSerial, {
    onLog: message => logs.push(message),
    onCheck: check => checks.push(check),
    onState: state => states.push(state),
    typeNames: events.names,
    ...options
  });
  t.after(() => client.disconnect());
  return { client, input, writes, logs, checks, states };
}

test('26 dispatches 0xC0/0xC1 frames to onEvent without touching reply checks', async t => {
  const received = [];
  const f = fixture(t, (data, input) => {
    const frames = [];
    const parser = protocol.createParser(frame => frames.push(frame));
    parser.push(data);
    input.enqueue(protocol.encode(KEY_EVENT, 0, bytes(3, 0)));
    input.enqueue(protocol.encode(protocol.type.PONG, frames[0].seq));
  }, { onEvent: frame => received.push(frame) });
  await f.client.connect();
  const pong = await f.client.ping();
  assert.equal(pong.type, protocol.type.PONG);
  assert.equal(received.length, 1);
  assert.equal(received[0].type, KEY_EVENT);
  assert.deepEqual(received[0].payload, bytes(3, 0));
  // 等待回复 + 匹配回复 = 2；事件帧不得额外写入一条校验行。
  assert.equal(f.checks.length, 2);
  assert.match(f.checks[1].seq, /^匹配/);
  assert.match(f.logs.join('\n'), /RX KEY_EVENT · SEQ 0 · CRC 通过 · 设备事件/);
});

test('events dispatched while a request is pending do not satisfy or reject it', async t => {
  const received = [];
  let injected = false;
  const f = fixture(t, (data, input) => {
    const frames = [];
    const parser = protocol.createParser(frame => frames.push(frame));
    parser.push(data);
    if (!injected) {
      injected = true;
      input.enqueue(protocol.encode(ENCODER_EVENT, 0, bytes(0xFD)));
    }
    input.enqueue(protocol.encode(protocol.type.PONG, frames[0].seq));
  }, { onEvent: frame => received.push(frame) });
  await f.client.connect();
  const pong = await f.client.ping();
  assert.equal(pong.type, protocol.type.PONG);
  assert.deepEqual(received.map(frame => frame.type), [ENCODER_EVENT]);
  assert.deepEqual(received[0].payload, bytes(0xFD));
  assert.ok(f.checks.some(check => /^匹配/.test(check.seq)));
});

test('an integrated dispatcher turns a wire frame into the player action', async t => {
  const { calls, actions } = recordActions();
  const dispatcher = events.create({ actions });
  const f = fixture(t, (data, input) => {
    const frames = [];
    protocol.createParser(frame => frames.push(frame)).push(data);
    input.enqueue(protocol.encode(protocol.type.PONG, frames[0].seq));
  }, { onEvent: frame => dispatcher.handle(frame) });
  await f.client.connect();
  await f.client.ping();
  f.input.enqueue(protocol.encode(ENCODER_EVENT, 0, bytes(0xFE)));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(calls, [['adjustVolume', -2]]);
});

test('26 keeps working when no onEvent handler is supplied', async t => {
  const f = fixture(t, (data, input) => {
    const frames = [];
    protocol.createParser(frame => frames.push(frame)).push(data);
    input.enqueue(protocol.encode(KEY_EVENT, 0, bytes(3, 2)));
    input.enqueue(protocol.encode(protocol.type.PONG, frames[0].seq));
  });
  await f.client.connect();
  const pong = await f.client.ping();
  assert.equal(pong.type, protocol.type.PONG);
  assert.match(f.logs.join('\n'), /设备事件/);
});