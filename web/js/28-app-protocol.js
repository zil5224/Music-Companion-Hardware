'use strict';

const ZilyAppProtocol = (() => {
  const type = Object.freeze({
    PAUSE: 0x10, RESUME: 0x11, NEXT: 0x12, FAVORITE: 0x13, ACK: 0x90
  });
  const status = Object.freeze({
    OK: 0x00, UNSUPPORTED: 0x01, BAD_PAYLOAD: 0x02,
    BAD_STATE: 0x03, BUSY: 0x04, INTERNAL: 0x05
  });
  const state = Object.freeze({ PLAYING: 0x01, FAVORITED: 0x02 });
  const names = Object.freeze({
    [type.PAUSE]: 'PAUSE',
    [type.RESUME]: 'RESUME',
    [type.NEXT]: 'NEXT',
    [type.FAVORITE]: 'FAVORITE',
    [type.ACK]: 'APP_ACK'
  });
  const statusText = Object.freeze({
    [status.OK]: 'OK',
    [status.UNSUPPORTED]: '设备不支持该命令',
    [status.BAD_PAYLOAD]: '命令载荷不符合协议',
    [status.BAD_STATE]: '设备当前状态不允许',
    [status.BUSY]: '设备忙',
    [status.INTERNAL]: '设备内部错误'
  });
  const ackLength = 3;
  const maxAckLength = 8;

  function statusName(code) {
    if (!Number.isInteger(code)) return '未知应答状态';
    return statusText[code] ||
      '未知应答状态 0x' + code.toString(16).toUpperCase().padStart(2, '0');
  }

  // Returns an Error to reject the request, or null when the ACK is valid.
  // This function must never throw: the serial receive path calls it inline.
  function validateAck(command) {
    return frame => {
      try {
        if (!frame || !frame.payload || frame.length < ackLength || frame.length > maxAckLength) {
          return new Error('APP_ACK 长度非法。');
        }
        if (frame.payload[0] !== command) {
          return new Error('APP_ACK 命令回显不匹配。');
        }
        const code = frame.payload[1];
        if (code !== status.OK) {
          return new Error('APP_ACK ' + statusName(code) + '。');
        }
        return null;
      } catch {
        return new Error('APP_ACK 校验异常。');
      }
    };
  }

  function parseState(frame) {
    if (!frame || frame.length < ackLength) return null;
    return frame.payload[2];
  }

  function decodeState(value) {
    if (!Number.isInteger(value)) return null;
    return {
      playing: (value & state.PLAYING) !== 0,
      favorited: (value & state.FAVORITED) !== 0
    };
  }

  return { type, status, state, names, ackLength, maxAckLength, statusName, validateAck, parseState, decodeState };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ZilyAppProtocol;