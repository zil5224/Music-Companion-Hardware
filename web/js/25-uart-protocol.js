'use strict';

const ZilyUartProtocol = (() => {
  const type = Object.freeze({ PING: 0x01, PONG: 0x02, ECHO: 0x03, ECHO_REPLY: 0x04 });
  const first = 0xA5;
  const second = 0x5A;
  const version = 0x01;
  const headerSize = 8;
  const maxPayload = 256;
  const overhead = headerSize + 2;

  // CRC-16/CCITT-FALSE, from VER through the end of the payload.
  function crc16(bytes) {
    let crc = 0xFFFF;
    for (const byte of bytes) {
      crc ^= byte << 8;
      for (let bit = 0; bit < 8; bit++) {
        crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xFFFF;
      }
    }
    return crc;
  }

  const requiresEmptyPayload = message => message === type.PING || message === type.PONG;

  function encode(message, seq, payload = new Uint8Array()) {
    if (!Number.isInteger(message) || message < 0 || message > 0xFF ||
        !Number.isInteger(seq) || seq < 0 || seq > 0xFFFF) {
      throw new RangeError('无效的 TYPE 或 SEQ。');
    }
    if (!(payload instanceof Uint8Array) || payload.length > maxPayload ||
        (requiresEmptyPayload(message) && payload.length !== 0)) {
      throw new RangeError('无效的载荷。');
    }
    const bytes = new Uint8Array(overhead + payload.length);
    const view = new DataView(bytes.buffer);
    bytes.set([first, second, version, message]);
    view.setUint16(4, seq, true);
    view.setUint16(6, payload.length, true);
    bytes.set(payload, headerSize);
    const crcOffset = headerSize + payload.length;
    view.setUint16(crcOffset, crc16(bytes.subarray(2, crcOffset)), true);
    return bytes;
  }

  function createParser(onFrame, onError = () => {}) {
    const buffer = new Uint8Array(overhead + maxPayload);
    const view = new DataView(buffer.buffer);
    let size = 0;

    function scan(expired) {
      let start = 0;
      while (start < size) {
        if (buffer[start] !== first || (start + 1 < size && buffer[start + 1] !== second)) {
          start++;
          continue;
        }
        const remaining = size - start;
        if (remaining >= 3 && buffer[start + 2] !== version) {
          onError({ code: 'version' });
          start++;
          continue;
        }
        const length = remaining >= headerSize ? view.getUint16(start + 6, true) : 0;
        if (length > maxPayload) {
          onError({ code: 'length' });
          start++;
          continue;
        }
        if (remaining < overhead + length) {
          if (!expired) break;
          start++;
          continue;
        }
        const message = buffer[start + 3];
        const seq = view.getUint16(start + 4, true);
        const crcOffset = start + headerSize + length;
        const received = view.getUint16(crcOffset, true);
        const expected = crc16(buffer.subarray(start + 2, crcOffset));
        if (received !== expected) {
          onError({ code: 'crc', seq, received, expected });
          start++;
          continue;
        }
        if (requiresEmptyPayload(message) && length !== 0) {
          onError({ code: 'payload', seq });
        } else {
          onFrame({
            type: message, seq, crc: received, length,
            payload: buffer.slice(start + headerSize, crcOffset)
          });
        }
        // A valid frame can contain the full SOF or another frame in its payload.
        start += overhead + length;
      }
      if (start > 0) {
        buffer.copyWithin(0, start, size);
        size -= start;
      }
    }

    return {
      get pending() { return size !== 0; },
      push(bytes) {
        for (const byte of bytes) {
          buffer[size++] = byte;
          scan(false);
        }
      },
      expire() {
        if (!size) return;
        onError({ code: 'partial' });
        scan(true);
      }
    };
  }

  return { type, maxPayload, crc16, encode, createParser };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ZilyUartProtocol;
