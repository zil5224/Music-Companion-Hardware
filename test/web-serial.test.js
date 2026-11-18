'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../web/js/25-uart-protocol');
const bridge = require('../web/js/26-web-serial');
const app = require('../web/js/28-app-protocol');
const { PING, PONG, ECHO, ECHO_REPLY } = protocol.type;
const bytes = (...values) => Uint8Array.of(...values);
const concat = (...chunks) => Uint8Array.from(Buffer.concat(chunks));
const ping = bytes(0xA5, 0x5A, 1, 1, 1, 0, 0, 0, 0x55, 0x97);
const pong = bytes(0xA5, 0x5A, 1, 2, 1, 0, 0, 0, 0x87, 0x79);
const echoAbc = bytes(0xA5, 0x5A, 1, 3, 2, 0, 3, 0, 0x41, 0x42, 0x43, 0x81, 0x8C);
const replyAbc = bytes(0xA5, 0x5A, 1, 4, 2, 0, 3, 0, 0x41, 0x42, 0x43, 0x99, 0x4B);
const binary = bytes(0x00, 0x01, 0x7F, 0x80, 0xFE, 0xFF);

function collect() {
  const frames = [], errors = [];
  const parser = protocol.createParser(frame => frames.push(frame), error => errors.push(error));
  return { parser, frames, errors };
}

function fixture(t, onWrite, options = {}) {
  const port = new EventTarget();
  const writes = [], logs = [], checks = [], states = [];
  let input, openOptions, choices = 0, closed = 0;
  const source = new ReadableStream({ start(controller) { input = controller; } });
  const sink = new WritableStream({ write(data) {
    writes.push(data);
    return onWrite?.(data, input);
  } });
  port.readable = source;
  port.writable = sink;
  port.open = async config => { openOptions = config; };
  port.close = async () => {
    assert.equal(source.locked, false);
    assert.equal(sink.locked, false);
    closed++;
  };
  const serial = { async requestPort() { choices++; return port; } };
  const client = bridge.create(serial, {
    onLog: message => logs.push(message),
    onCheck: check => checks.push(check),
    onState: state => states.push(state),
    ...options
  });
  t.after(() => client.disconnect());
  return { client, port, input, source, sink, writes, logs, checks, states,
    get openOptions() { return openOptions; },
    get choices() { return choices; },
    get closed() { return closed; }
  };
}

test('CRC16 matches CCITT-FALSE and firmware vectors', () => {
  assert.equal(protocol.crc16(new TextEncoder().encode('123456789')), 0x29B1);
  assert.equal(protocol.crc16(ping.subarray(2, 8)), 0x9755);
  assert.equal(protocol.crc16(replyAbc.subarray(2, -2)), 0x4B99);
});

test('encode matches firmware PING and ECHO vectors', () => {
  assert.deepEqual(protocol.encode(PING, 1), ping);
  assert.deepEqual(protocol.encode(ECHO, 2, bytes(0x41, 0x42, 0x43)), echoAbc);
  const frame = protocol.encode(ECHO, 0x1234, new Uint8Array(256));
  assert.equal(frame.length, 266);
  assert.deepEqual(frame.slice(4, 8), bytes(0x34, 0x12, 0, 1));
  assert.throws(() => protocol.encode(ECHO, 1, new Uint8Array(257)), RangeError);
  assert.throws(() => protocol.encode(PING, 1, binary), RangeError);
});

test('parse firmware PONG vector', () => {
  const { parser, frames, errors } = collect();
  parser.push(pong);
  assert.deepEqual(frames, [{ type: PONG, seq: 1, crc: 0x7987, length: 0, payload: bytes() }]);
  assert.deepEqual(errors, []);
});

test('parse split frames, including every possible split boundary', () => {
  for (let split = 1; split < replyAbc.length; split++) {
    const { parser, frames } = collect();
    parser.push(replyAbc.subarray(0, split));
    assert.equal(parser.pending, true);
    assert.equal(frames.length, 0);
    parser.push(replyAbc.subarray(split));
    assert.equal(parser.pending, false);
    assert.deepEqual(frames[0].payload, bytes(0x41, 0x42, 0x43));
  }
});

test('parse adjacent frames and a maximum frame containing its own SOF', () => {
  const { parser, frames } = collect();
  const payload = Uint8Array.from({ length: 256 }, (_, i) => i);
  payload.set(pong, 1);
  parser.push(concat(pong, protocol.encode(ECHO_REPLY, 0x1234, payload), replyAbc));
  assert.deepEqual(frames.map(frame => frame.seq), [1, 0x1234, 2]);
  assert.deepEqual(frames[1].payload, payload);
});

test('bad CRC is reported and does not consume the following frame', () => {
  const { parser, frames, errors } = collect();
  const bad = pong.slice();
  bad[9] ^= 0x01;
  parser.push(concat(bad, pong));
  assert.deepEqual(errors, [{ code: 'crc', seq: 1, received: 0x7887, expected: 0x7987 }]);
  assert.equal(frames.length, 1);
});

test('ASCII startup text, overlapping SOF, invalid version and oversized length recover', () => {
  const { parser, frames, errors } = collect();
  parser.push(concat(new TextEncoder().encode('ZILY UART1 READY\r\n'),
    bytes(0xA5, 0, 0xA5, 0x5A, 2, 0xA5, 0x5A, 1, 4, 0, 0, 1, 1, 0xA5)));
  parser.push(pong);
  assert.equal(frames.length, 1);
  assert.deepEqual(errors.map(error => error.code), ['version', 'length']);
});

test('expiry recovers a valid frame hidden by a truncated candidate', () => {
  const { parser, frames, errors } = collect();
  parser.push(concat(bytes(0xA5, 0x5A, 1, 4, 0, 0, 0, 1), pong));
  assert.deepEqual(frames, []);
  parser.expire();
  assert.equal(parser.pending, false);
  assert.equal(frames[0].type, PONG);
  assert.deepEqual(errors.map(error => error.code), ['partial']);
});

test('Web Serial requests user-selected port and ECHO preserves non-ASCII bytes', async t => {
  const f = fixture(t, (data, input) => {
    const { parser, frames } = collect();
    parser.push(data);
    const { seq, payload } = frames[0];
    assert.deepEqual(payload, binary);
    const reply = protocol.encode(ECHO_REPLY, seq, payload);
    input.enqueue(reply.subarray(0, 5));
    input.enqueue(reply.subarray(5));
  });
  assert.equal(f.choices, 0);
  await f.client.connect();
  assert.equal(f.choices, 1);
  assert.deepEqual(f.openOptions, { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
  const echoed = await f.client.echo(binary);
  assert.deepEqual(echoed.payload, binary);
  assert.equal(echoed.crc, 0x10EB);
  assert.deepEqual(f.writes, [
    bytes(0xA5, 0x5A, 1, 3, 1, 0, 6, 0, ...binary, 0x56, 0x39)
  ]);
  assert.match(f.checks.at(-1).seq, /^匹配/);
  assert.match(f.checks.at(-1).crc, /^通过/);
  await f.client.disconnect();
  assert.equal(f.closed, 1);
  assert.equal(f.source.locked || f.sink.locked, false);
});

test('SEQ and reply TYPE must match before the next request can write', async t => {
  const f = fixture(t, (_data, input) => {
    input.enqueue(protocol.encode(PONG, 2));
    input.enqueue(protocol.encode(ECHO_REPLY, 1));
    input.enqueue(pong);
  });
  await f.client.connect();
  const result = f.client.ping();
  await assert.rejects(f.client.echo(binary), /等待当前请求/);
  assert.equal((await result).seq, 1);
  assert.deepEqual(f.writes, [ping]);
  assert.ok(f.checks.some(check => check.seq.startsWith('不匹配')));
  assert.ok(f.logs.some(line => line.includes('回复类型不匹配')));
});

test('CRC-corrupted reply does not satisfy PING and a fresh request can succeed after timeout', async t => {
  const f = fixture(t, (data, input) => {
    if (data[4] === 1) {
      const bad = pong.slice();
      bad[9] ^= 1;
      input.enqueue(bad);
    } else {
      input.enqueue(concat(pong, protocol.encode(PONG, 2)));
    }
  }, { timeoutMs: 40 });
  await f.client.connect();
  await assert.rejects(f.client.ping(), /PONG 超时 · SEQ 1/);
  assert.match(f.checks.at(-1).crc, /^失败/);
  assert.equal((await f.client.ping()).seq, 2);
  assert.equal(f.closed, 0);
});

test('ECHO rejects an altered payload even when CRC and SEQ match', async t => {
  const f = fixture(t, (_data, input) => input.enqueue(protocol.encode(ECHO_REPLY, 1, bytes(1))));
  await f.client.connect();
  await assert.rejects(f.client.echo(binary), /载荷与发送字节不一致/);
});

test('a receive error rejects the pending request and releases the port', async t => {
  const f = fixture(t, (_data, input) => input.error(new Error('framing error')));
  await f.client.connect();
  await assert.rejects(f.client.ping(), /串口读取失败/);
  await f.client.disconnect();
  assert.equal(f.closed, 1);
});

test('manual disconnect cancels a pending read and request', async t => {
  const f = fixture(t);
  await f.client.connect();
  const outcome = assert.rejects(f.client.ping(), /已断开设备/);
  await f.client.disconnect();
  await outcome;
  assert.equal(f.closed, 1);
});

test('device unplug closes without automatically requesting another port', async t => {
  const f = fixture(t);
  await f.client.connect();
  const outcome = assert.rejects(f.client.ping(), /设备已拔出/);
  f.port.dispatchEvent(new Event('disconnect'));
  await outcome;
  await f.client.disconnect();
  assert.equal(f.choices, 1);
  assert.equal(f.closed, 1);
});

test('write error rejects the request and releases both locks', async t => {
  const f = fixture(t, () => { throw new Error('write error'); });
  await f.client.connect();
  await assert.rejects(f.client.ping(), /串口写入失败/);
  await f.client.disconnect();
  assert.equal(f.closed, 1);
});

test('a pending write that hits the deadline is aborted before the port is closed', async () => {
  let released, closed;
  const port = new EventTarget();
  port.readable = new ReadableStream();
  port.writable = new WritableStream({
    write(_data, controller) {
      return new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => { released = true; reject(controller.signal.reason); });
      });
    }
  });
  port.open = async () => {};
  port.close = async () => { closed = !port.readable.locked && !port.writable.locked; };
  const client = bridge.create({ requestPort: async () => port }, { timeoutMs: 40 });
  await client.connect();
  await assert.rejects(client.ping(), /PONG 超时/);
  await client.disconnect();
  assert.equal(released, true);
  assert.equal(closed, true);
});

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeLocks() {
  let held = false;
  let releases = 0;
  return {
    get held() { return held; },
    get releases() { return releases; },
    async request(name, options, task) {
      assert.equal(name, 'zily-serial');
      assert.deepEqual(options, { mode: 'exclusive', ifAvailable: true });
      if (held) return task(null);
      held = true;
      try {
        return await task({ name });
      } finally {
        held = false;
        releases++;
      }
    }
  };
}

function managedFixture(t, options = {}) {
  const port = new EventTarget();
  const serial = new EventTarget();
  const lifecycle = new EventTarget();
  const calls = [];
  const states = [];
  const failures = new Map();
  let available = [port];
  let session;
  const locks = options.locks ?? fakeLocks();

  function invoke(step, task) {
    calls.push(step);
    if (failures.has(step)) {
      const error = failures.get(step);
      failures.delete(step);
      throw error;
    }
    return task();
  }

  port.connected = true;
  port.getInfo = () => ({ usbVendorId: 0x1A86, usbProductId: 0x7523 });
  serial.getPorts = async () => available;
  serial.requestPort = async () => invoke('select', () => options.pick ? options.pick() : port);
  port.open = async () => invoke('open', async () => {
    assert.equal(locks.held, true);
    if (options.beforeOpen) await options.beforeOpen();
    const read = deferred();
    session = { read, readerLocked: false, writerLocked: false };
    const stream = session;
    port.readable = { getReader: () => invoke('getReader', () => {
      stream.readerLocked = true;
      return {
        read: () => invoke('read', () => stream.read.promise),
        cancel: () => invoke('cancel', () => { stream.read.resolve({ done: true }); }),
        releaseLock: () => invoke('releaseReader', () => {
          stream.readerLocked = false;
          stream.read.reject(new TypeError('reader released'));
        })
      };
    }) };
    port.writable = { getWriter: () => invoke('getWriter', () => {
      stream.writerLocked = true;
      return {
        write: data => invoke('write', () => options.write?.(data, stream)),
        abort: () => invoke('abort', () => {}),
        releaseLock: () => invoke('releaseWriter', () => { stream.writerLocked = false; })
      };
    }) };
  });
  port.close = async () => invoke('close', () => {
    assert.equal(locks.held, true);
    if (session.readerLocked || session.writerLocked) throw new TypeError('stream still locked');
    port.readable = port.writable = null;
  });

  const client = bridge.create(serial, { lifecycle, locks, onState: state => states.push(state), ...options.bridge });
  t.after(() => client.disconnect());
  return {
    client, port, serial, lifecycle, calls, locks, failures,
    get state() { return states.at(-1); },
    get session() { return session; },
    setAvailable(list) { available = list; },
    event(type, device = port) {
      const event = new Event(type);
      Object.defineProperty(event, 'port', { value: device });
      serial.dispatchEvent(event);
    }
  };
}

test('rapid connect and disconnect calls share their operations', async t => {
  const picker = deferred();
  const f = managedFixture(t, { pick: () => picker.promise });
  const connecting = f.client.connect();
  assert.equal(f.client.connect(), connecting);
  assert.deepEqual(f.calls, ['select']);
  picker.resolve(f.port);
  await connecting;
  assert.equal(f.state.phase, 'ready');
  assert.equal(f.calls.filter(step => step === 'open').length, 1);
  assert.equal(f.calls.filter(step => step === 'read').length, 1);
  const disconnecting = f.client.disconnect();
  assert.equal(f.client.disconnect(), disconnecting);
  await disconnecting;
  assert.deepEqual(f.calls.slice(-5), ['cancel', 'releaseReader', 'abort', 'releaseWriter', 'close']);
  assert.equal(f.state.reason, 'user');
  assert.equal(f.locks.held, false);
});

for (const [step, error, reason] of [
  ['select', new DOMException('cancelled', 'NotFoundError'), 'user'],
  ['select', new DOMException('denied', 'SecurityError'), 'permission'],
  ['open', new DOMException('could not open', 'NetworkError'), 'open-error']
]) {
  test(step + ' failure ' + error.name + ' returns to idle with an independent reason', async t => {
    const f = managedFixture(t);
    f.failures.set(step, error);
    await f.client.connect();
    assert.equal(f.state.phase, 'idle');
    assert.equal(f.state.reason, reason);
    assert.equal(f.locks.held, false);
    assert.equal(f.calls.includes('close'), false);
    await f.client.connect();
    assert.equal(f.state.phase, 'ready');
  });
}

for (const [step, needsRetry] of [
  ['cancel', false], ['releaseReader', true], ['abort', false], ['releaseWriter', true], ['close', true]
]) {
  test('cleanup continues after ' + step + ' failure and retries only unfinished resources', async t => {
    const f = managedFixture(t);
    await f.client.connect();
    f.failures.set(step, new Error('injected cleanup failure'));
    await f.client.disconnect();
    for (const operation of ['cancel', 'releaseReader', 'abort', 'releaseWriter', 'close']) {
      assert.ok(f.calls.includes(operation), operation);
    }
    assert.equal(f.state.phase, needsRetry ? 'close-error' : 'idle');
    assert.equal(f.locks.held, needsRetry);
    if (!needsRetry) return;
    assert.equal(f.state.reason, 'close-error');
    await f.client.connect();
    assert.equal(f.calls.filter(operation => operation === 'open').length, 1);
    await f.client.disconnect();
    assert.equal(f.state.phase, 'idle');
    assert.equal(f.locks.held, false);
    assert.equal(f.calls.filter(operation => operation === 'close').length, 2);
    assert.equal(f.calls.filter(operation => operation === 'cancel').length, 1);
    assert.equal(f.calls.filter(operation => operation === 'abort').length, 1);
    assert.equal(f.calls.filter(operation => operation === 'releaseReader').length, step === 'releaseReader' ? 2 : 1);
    assert.equal(f.calls.filter(operation => operation === 'releaseWriter').length, step === 'releaseWriter' ? 2 : 1);
  });
}

test('partial initialization closes the port and unlocks the acquired writer', async t => {
  const f = managedFixture(t);
  f.failures.set('getReader', new Error('reader unavailable'));
  await f.client.connect();
  assert.equal(f.state.phase, 'idle');
  assert.equal(f.state.reason, 'open-error');
  assert.deepEqual(f.calls.slice(-3), ['abort', 'releaseWriter', 'close']);
  assert.equal(f.locks.held, false);
});

test('one previously authorized device can be opened without a browser prompt', async t => {
  const f = managedFixture(t);
  await f.client.refreshDevices();
  assert.equal(f.state.canRestore, true);
  assert.equal(f.state.devices[0].usbProductId, 0x7523);
  assert.deepEqual(f.calls, []);
  await f.client.restore();
  assert.equal(f.state.phase, 'ready');
  assert.equal(f.calls.includes('select'), false);
});

test('no authorization or ambiguous authorization never guesses a device', async t => {
  const f = managedFixture(t);
  for (const available of [[], [f.port, { getInfo: f.port.getInfo }]]) {
    f.setAvailable(available);
    await f.client.refreshDevices();
    assert.equal(f.state.canRestore, false);
    assert.equal(f.state.devices.length, available.length);
    await f.client.restore();
    assert.deepEqual(f.calls, []);
  }
  await f.client.connect();
  assert.ok(f.calls.includes('select'));
});

test('serial unplug clears the session and discovery, reinsert only refreshes the list', async t => {
  const f = managedFixture(t);
  await f.client.connect();
  const pending = assert.rejects(f.client.ping(), /设备已拔出/);
  f.port.connected = false;
  f.setAvailable([]);
  f.event('disconnect');
  f.port.dispatchEvent(new Event('disconnect'));
  await pending;
  await tick();
  assert.equal(f.state.phase, 'lost');
  assert.equal(f.state.reason, 'unplug');
  assert.equal(f.state.devices.length, 0);
  assert.equal(f.calls.filter(step => step === 'close').length, 1);
  f.port.connected = true;
  f.setAvailable([f.port]);
  f.event('connect');
  await tick();
  assert.equal(f.state.canRestore, true);
  assert.equal(f.calls.filter(step => step === 'open').length, 1);
  await f.client.restore();
  assert.equal(f.state.phase, 'ready');
  assert.equal(f.calls.filter(step => step === 'open').length, 2);
});

test('two tabs share one lock until the first port closes successfully', async t => {
  const locks = fakeLocks();
  const first = managedFixture(t, { locks });
  const second = managedFixture(t, { locks });
  await first.client.connect();
  await second.client.connect();
  assert.equal(second.state.reason, 'busy');
  assert.equal(second.calls.includes('open'), false);
  first.failures.set('close', new Error('port close failed'));
  await first.client.disconnect();
  assert.equal(locks.held, true);
  assert.equal(locks.releases, 0);
  await second.client.connect();
  assert.equal(second.state.reason, 'busy');
  await first.client.disconnect();
  assert.equal(locks.releases, 1);
  await second.client.connect();
  assert.equal(second.state.phase, 'ready');
});

test('pagehide during open defers close and lock release until the open settles', async t => {
  const gate = deferred();
  const f = managedFixture(t, { beforeOpen: () => gate.promise });
  const opening = f.client.connect();
  await tick();
  f.lifecycle.dispatchEvent(new Event('pagehide'));
  assert.equal(f.state.phase, 'closing');
  assert.equal(f.locks.held, true);
  assert.equal(f.calls.includes('close'), false);
  gate.resolve();
  await opening;
  await tick();
  assert.equal(f.state.reason, 'pagehide');
  assert.equal(f.locks.held, false);
  assert.equal(f.calls.includes('read'), false);
  assert.equal(f.calls.filter(step => step === 'close').length, 1);
});

test('pagehide releases a live session and pageshow discovers without opening', async t => {
  const f = managedFixture(t);
  await f.client.connect();
  f.lifecycle.dispatchEvent(new Event('pagehide'));
  await tick();
  assert.equal(f.state.reason, 'pagehide');
  assert.equal(f.locks.held, false);
  f.lifecycle.dispatchEvent(new Event('pageshow'));
  await tick();
  assert.equal(f.state.canRestore, true);
  assert.equal(f.calls.filter(step => step === 'open').length, 1);
});

test('late rejection from a previous writer cannot change the reopened connection', async t => {
  const oldWrite = deferred();
  const f = managedFixture(t, { write: () => oldWrite.promise });
  await f.client.connect();
  const generation = f.state.generation;
  const pending = assert.rejects(f.client.ping(), /已断开/);
  await tick();
  await f.client.disconnect();
  await pending;
  await f.client.restore();
  assert.notEqual(f.state.generation, generation);
  oldWrite.reject(new Error('previous write failed'));
  await tick();
  assert.equal(f.state.phase, 'ready');
  assert.equal(f.state.reason, null);
  assert.equal(f.calls.filter(step => step === 'close').length, 1);
});

test('native read completion with done performs a recoverable close', async t => {
  const f = managedFixture(t);
  await f.client.connect();
  f.session.read.resolve({ done: true });
  await tick();
  assert.equal(f.state.phase, 'lost');
  assert.equal(f.state.reason, 'read-error');
  assert.equal(f.locks.held, false);
  await f.client.restore();
  assert.equal(f.state.phase, 'ready');
});

test('a hung close retains the lock and a retry joins the original operation', async t => {
  const f = managedFixture(t, { bridge: { cleanupTimeoutMs: 25 } });
  const gate = deferred();
  const close = f.port.close;
  f.port.close = async () => { await gate.promise; return close(); };
  await f.client.connect();
  await f.client.disconnect();
  assert.equal(f.state.phase, 'close-error');
  assert.equal(f.locks.held, true);
  const retry = f.client.disconnect();
  gate.resolve();
  await retry;
  assert.equal(f.state.phase, 'idle');
  assert.equal(f.locks.releases, 1);
  assert.equal(f.calls.filter(step => step === 'close').length, 1);
});

test('a cancelled picker cannot open its late selection', async t => {
  const picker = deferred();
  const f = managedFixture(t, { pick: () => picker.promise });
  const selecting = f.client.connect();
  await f.client.disconnect();
  assert.equal(f.state.phase, 'idle');
  assert.equal(f.state.canSelect, false);
  assert.equal(f.state.canRestore, false);
  await f.client.restore();
  picker.resolve(f.port);
  await selecting;
  assert.deepEqual(f.calls, ['select']);
  assert.equal(f.state.canRestore, true);
  await f.client.restore();
  assert.equal(f.state.phase, 'ready');
});

test('a rejected discovery query leaves manual selection available', async t => {
  const f = managedFixture(t);
  f.serial.getPorts = async () => { throw new DOMException('denied', 'SecurityError'); };
  await f.client.refreshDevices();
  assert.equal(f.state.canSelect, true);
  assert.equal(f.state.canRestore, false);
  assert.match(f.state.discoveryMessage, /无法查询/);
  await f.client.connect();
  assert.equal(f.state.phase, 'ready');
});

test('without Web Locks the fallback still opens and releases one port', async t => {
  const f = fixture(t);
  await f.client.connect();
  assert.equal(f.states.at(-1).hasLocks, false);
  assert.equal(f.states.at(-1).phase, 'ready');
  await f.client.disconnect();
  assert.equal(f.closed, 1);
});

test('an idle writer error closes without an in-flight request', async t => {
  const port = new EventTarget();
  port.readable = new ReadableStream();
  let writable;
  port.writable = new WritableStream({ start(controller) { writable = controller; } });
  port.open = async () => {};
  let closes = 0;
  port.close = async () => {
    assert.equal(port.readable.locked, false);
    assert.equal(port.writable.locked, false);
    closes++;
  };
  const states = [];
  const client = bridge.create({ requestPort: async () => port }, { onState: state => states.push(state) });
  t.after(() => client.disconnect());
  await client.connect();
  writable.error(new Error('idle writer failed'));
  await tick();
  assert.equal(states.at(-1).phase, 'lost');
  assert.equal(states.at(-1).reason, 'write-error');
  assert.equal(closes, 1);
});

for (const name of ['InvalidStateError', 'NetworkError']) {
  test('close rejected with ' + name + ' still releases the lock when the device is gone', async t => {
    const f = managedFixture(t);
    await f.client.connect();
    assert.equal(f.state.phase, 'ready');
    // Chrome removed SerialPort.connected: a lost device reports undefined, not false.
    delete f.port.connected;
    f.port.close = async () => { throw new DOMException('port is already closed', name); };
    await f.client.disconnect();
    assert.equal(f.locks.held, false);
    assert.equal(f.state.phase, 'idle');
    assert.equal(f.state.reason, 'user');
    // The released lock lets the same origin open the port again.
    f.port.close = async () => { f.port.readable = f.port.writable = null; };
    await f.client.connect();
    assert.equal(f.state.phase, 'ready');
  });
}

test('an unexpected close failure still keeps the lock and reports close-error', async t => {
  const f = managedFixture(t);
  await f.client.connect();
  delete f.port.connected;
  f.port.close = async () => { throw new Error('unexpected'); };
  await f.client.disconnect();
  assert.equal(f.state.phase, 'close-error');
  assert.equal(f.locks.held, true);
});

const emptyPayload = new Uint8Array();
const appAck = (seq, command, status, state) =>
  protocol.encode(app.type.ACK, seq, bytes(command, status, state));
const appRequest = (command, payload = emptyPayload) =>
  [command, app.type.ACK, payload, app.validateAck(command)];

test('an application PAUSE resolves on a matching APP_ACK and logs its name', async t => {
  const f = fixture(t, (data, input) => {
    const { parser, frames } = collect();
    parser.push(data);
    input.enqueue(appAck(frames[0].seq, app.type.PAUSE, app.status.OK, 0));
  }, { typeNames: app.names });
  await f.client.connect();
  const frame = await f.client.request(...appRequest(app.type.PAUSE));
  assert.deepEqual(frame.payload, bytes(0x10, 0, 0));
  assert.equal(app.parseState(frame), 0);
  assert.deepEqual(f.writes, [bytes(0xA5, 0x5A, 1, 0x10, 1, 0, 0, 0, 0x5E, 0x39)]);
  assert.ok(f.logs.some(line => line.includes('TX PAUSE')));
  assert.ok(f.checks.at(-1).seq.startsWith('匹配'));
});

test('an application NACK rejects with the device status and keeps the port open', async t => {
  const f = fixture(t, (data, input) => {
    const { parser, frames } = collect();
    parser.push(data);
    input.enqueue(appAck(frames[0].seq, app.type.PAUSE, app.status.BAD_PAYLOAD, 1));
  }, { typeNames: app.names });
  await f.client.connect();
  await assert.rejects(f.client.request(...appRequest(app.type.PAUSE)), /命令载荷不符合协议/);
  assert.equal(f.closed, 0);
});

test('an APP_ACK with the wrong command echo rejects the request', async t => {
  const f = fixture(t, (data, input) => {
    const { parser, frames } = collect();
    parser.push(data);
    input.enqueue(appAck(frames[0].seq, app.type.RESUME, app.status.OK, 1));
  }, { typeNames: app.names });
  await f.client.connect();
  await assert.rejects(f.client.request(...appRequest(app.type.PAUSE)), /命令回显不匹配/);
  assert.equal(f.closed, 0);
});

test('an application timeout keeps the port open and the next command can succeed', async t => {
  const f = fixture(t, (data, input) => {
    if (data[4] === 1) return;
    const { parser, frames } = collect();
    parser.push(data);
    input.enqueue(appAck(frames[0].seq, frames[0].type, app.status.OK, 1));
  }, { timeoutMs: 40, typeNames: app.names });
  await f.client.connect();
  await assert.rejects(f.client.request(...appRequest(app.type.PAUSE)), error => {
    assert.equal(error.code, 'timeout');
    assert.match(error.message, /APP_ACK 超时 · SEQ 1/);
    return true;
  });
  const frame = await f.client.request(...appRequest(app.type.RESUME));
  assert.equal(app.parseState(frame), 1);
  assert.equal(f.closed, 0);
});

test('a duplicate APP_ACK is ignored after the first one resolves', async t => {
  let lastAck;
  const f = fixture(t, (data, input) => {
    const { parser, frames } = collect();
    parser.push(data);
    lastAck = appAck(frames[0].seq, frames[0].type, app.status.OK,
      frames[0].type === app.type.RESUME ? 1 : 0);
    input.enqueue(lastAck);
  }, { typeNames: app.names });
  await f.client.connect();
  assert.equal(app.parseState(await f.client.request(...appRequest(app.type.PAUSE))), 0);
  await tick();
  f.input.enqueue(lastAck);
  await tick();
  assert.ok(f.logs.some(line => line.includes('无待匹配请求')));
  assert.equal(app.parseState(await f.client.request(...appRequest(app.type.RESUME))), 1);
});

test('an APP_ACK that arrives before the write settles is still matched', async t => {
  let releaseWrite, input;
  const port = new EventTarget();
  port.readable = new ReadableStream({ start(controller) { input = controller; } });
  port.writable = new WritableStream({
    write() { return new Promise(resolve => { releaseWrite = resolve; }); }
  });
  port.open = async () => {};
  port.close = async () => {};
  const client = bridge.create({ requestPort: async () => port }, { timeoutMs: 200 });
  t.after(() => client.disconnect());
  await client.connect();
  const pending = client.request(...appRequest(app.type.PAUSE));
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 10 && !releaseWrite; i++) await tick();
  assert.ok(releaseWrite);
  input.enqueue(appAck(1, app.type.PAUSE, app.status.OK, 0));
  await tick();
  assert.equal(settled, false);
  releaseWrite();
  assert.equal(app.parseState(await pending), 0);
});

test('FAVORITE carries an explicit state and maps the STATE bits', async t => {
  const f = fixture(t, (data, input) => {
    const { parser, frames } = collect();
    parser.push(data);
    assert.deepEqual(frames[0].payload, bytes(1));
    input.enqueue(appAck(frames[0].seq, app.type.FAVORITE, app.status.OK, 3));
  }, { typeNames: app.names });
  await f.client.connect();
  const frame = await f.client.request(...appRequest(app.type.FAVORITE, bytes(1)));
  assert.equal(app.parseState(frame), 3);
  assert.deepEqual(app.decodeState(app.parseState(frame)), { playing: true, favorited: true });
  assert.deepEqual(f.writes, [bytes(0xA5, 0x5A, 1, 0x13, 1, 0, 1, 0, 1, 0x8B, 0x10)]);
});

test('an unknown APP_ACK status rejects the request', async t => {
  const f = fixture(t, (data, input) => {
    const { parser, frames } = collect();
    parser.push(data);
    input.enqueue(appAck(frames[0].seq, app.type.PAUSE, 0x7F, 0));
  }, { typeNames: app.names });
  await f.client.connect();
  await assert.rejects(f.client.request(...appRequest(app.type.PAUSE)), /未知应答状态 0x7F/);
});

test('a short APP_ACK rejects as a protocol error', async t => {
  const f = fixture(t, (data, input) => {
    const { parser, frames } = collect();
    parser.push(data);
    input.enqueue(protocol.encode(app.type.ACK, frames[0].seq, bytes(0x10, 0)));
  }, { typeNames: app.names });
  await f.client.connect();
  await assert.rejects(f.client.request(...appRequest(app.type.PAUSE)), /APP_ACK 长度非法/);
});

test('a throwing validate callback rejects the request without closing the port', async t => {
  const f = fixture(t, (data, input) => {
    const { parser, frames } = collect();
    parser.push(data);
    input.enqueue(appAck(frames[0].seq, app.type.PAUSE, app.status.OK, 0));
  }, { typeNames: app.names });
  await f.client.connect();
  await assert.rejects(
    f.client.request(app.type.PAUSE, app.type.ACK, emptyPayload, () => { throw new Error('boom'); }),
    /回复校验异常/
  );
  assert.equal(f.closed, 0);
});

test('device events are dispatched without a pending request and add no CRC/SEQ checks', async t => {
  const received = [];
  const f = fixture(t, null, { onEvent: frame => received.push(frame), typeNames: { 0xC0: 'KEY_EVENT' } });
  await f.client.connect();
  f.input.enqueue(protocol.encode(0xC0, 0, bytes(1, 0)));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(received.length, 1);
  assert.equal(received[0].type, 0xC0);
  assert.deepEqual(received[0].payload, bytes(1, 0));
  assert.equal(f.checks.length, 0);
  assert.match(f.logs.join('\n'), /RX KEY_EVENT · SEQ 0 · CRC 通过 · 设备事件/);
});

test('a device event during a pending request neither satisfies nor rejects it', async t => {
  const received = [];
  let injected = false;
  const f = fixture(t, (data, input) => {
    const { parser, frames } = collect();
    parser.push(data);
    if (!injected) {
      injected = true;
      input.enqueue(protocol.encode(0xC0, 0, bytes(1, 0)));
    }
    input.enqueue(protocol.encode(PONG, frames[0].seq));
  }, { onEvent: frame => received.push(frame), typeNames: { 0xC0: 'KEY_EVENT' } });
  await f.client.connect();
  const pong = await f.client.ping();
  assert.equal(pong.type, PONG);
  assert.equal(received.length, 1);
  assert.equal(received[0].type, 0xC0);
  // 等待回复 + 匹配回复；事件帧不得写入校验行。
  assert.equal(f.checks.length, 2);
  assert.match(f.checks[1].seq, /^匹配/);
});
