'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../web/js/28-app-protocol');

const bytes = (...values) => Uint8Array.of(...values);
const ack = (command, status, state, length = 3) => ({
  type: app.type.ACK, seq: 1, length,
  payload: length === 2 ? bytes(command, status) : bytes(command, status, state)
});

test('application TYPE and STATUS values are frozen and non-overlapping', () => {
  assert.deepEqual({ ...app.type }, { PAUSE: 0x10, RESUME: 0x11, NEXT: 0x12, FAVORITE: 0x13, ACK: 0x90 });
  assert.deepEqual({ ...app.status }, { OK: 0, UNSUPPORTED: 1, BAD_PAYLOAD: 2, BAD_STATE: 3, BUSY: 4, INTERNAL: 5 });
  assert.deepEqual({ ...app.state }, { PLAYING: 1, FAVORITED: 2 });
  assert.equal(Object.isFrozen(app.type), true);
  assert.equal(Object.isFrozen(app.status), true);
});

test('names and status text cover every application type', () => {
  assert.equal(app.names[app.type.PAUSE], 'PAUSE');
  assert.equal(app.names[app.type.ACK], 'APP_ACK');
  assert.equal(app.statusName(app.status.OK), 'OK');
  assert.match(app.statusName(app.status.UNSUPPORTED), /不支持/);
  assert.match(app.statusName(app.status.BAD_PAYLOAD), /载荷/);
  assert.match(app.statusName(0x7F), /0x7F/);
  assert.match(app.statusName(undefined), /未知/);
});

test('validateAck accepts a matching OK acknowledgement', () => {
  assert.equal(app.validateAck(app.type.PAUSE)(ack(app.type.PAUSE, app.status.OK, 0)), null);
  assert.equal(app.validateAck(app.type.FAVORITE)(ack(app.type.FAVORITE, app.status.OK, 3)), null);
});

test('validateAck rejects NACK statuses with readable messages', () => {
  for (const code of [app.status.UNSUPPORTED, app.status.BAD_PAYLOAD, app.status.BAD_STATE, app.status.BUSY, app.status.INTERNAL]) {
    const error = app.validateAck(app.type.PAUSE)(ack(app.type.PAUSE, code, 0));
    assert.ok(error instanceof Error);
    assert.match(error.message, /APP_ACK/);
  }
});

test('validateAck rejects a wrong command echo, short ACK and oversized ACK', () => {
  assert.match(app.validateAck(app.type.PAUSE)(ack(app.type.RESUME, app.status.OK, 0)).message, /命令回显不匹配/);
  assert.match(app.validateAck(app.type.PAUSE)(ack(app.type.PAUSE, app.status.OK, 0, 2)).message, /长度非法/);
  const long = { type: app.type.ACK, seq: 1, length: 9, payload: new Uint8Array(9) };
  assert.match(app.validateAck(app.type.PAUSE)(long).message, /长度非法/);
});

test('validateAck returns an Error instead of throwing on malformed frames', () => {
  for (const frame of [null, undefined, {}, { length: 3 }, { length: 3, payload: undefined }]) {
    let result;
    assert.doesNotThrow(() => { result = app.validateAck(app.type.PAUSE)(frame); });
    assert.ok(result instanceof Error);
  }
});

test('validateAck accepts longer ACK payloads and ignores reserved bytes', () => {
  const four = { type: app.type.ACK, seq: 1, length: 4, payload: bytes(app.type.PAUSE, 0, 0, 0xAA) };
  assert.equal(app.validateAck(app.type.PAUSE)(four), null);
  assert.equal(app.parseState(four), 0);
  const eight = {
    type: app.type.ACK, seq: 1, length: 8,
    payload: new Uint8Array([app.type.FAVORITE, 0, 3, 0, 0, 0, 0, 0])
  };
  assert.equal(app.validateAck(app.type.FAVORITE)(eight), null);
  assert.equal(app.parseState(eight), 3);
});

test('parseState and decodeState map PLAYING and FAVORITED bits', () => {
  assert.equal(app.parseState(ack(app.type.PAUSE, app.status.OK, 0)), 0);
  assert.equal(app.parseState(ack(app.type.FAVORITE, app.status.OK, 3)), 3);
  assert.equal(app.parseState(null), null);
  assert.deepEqual(app.decodeState(0), { playing: false, favorited: false });
  assert.deepEqual(app.decodeState(1), { playing: true, favorited: false });
  assert.deepEqual(app.decodeState(2), { playing: false, favorited: true });
  assert.deepEqual(app.decodeState(0xFE), { playing: false, favorited: true });
  assert.equal(app.decodeState(undefined), null);
});