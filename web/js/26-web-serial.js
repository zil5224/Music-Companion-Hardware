'use strict';

const ZilyWebSerial = (() => {
  const protocol = typeof module === 'undefined' ? ZilyUartProtocol : require('./25-uart-protocol');
  const { PING, PONG, ECHO, ECHO_REPLY } = protocol.type;
  const names = { [PING]: 'PING', [PONG]: 'PONG', [ECHO]: 'ECHO', [ECHO_REPLY]: 'ECHO_REPLY' };
  const portOptions = { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' };
  const frameIdleMs = 100;
  // 0-9A: unsolicited STM32 -> PC device events. They never carry a pending
  // request's SEQ, so they are dispatched separately from the reply path.
  const eventFirst = 0xC0;
  const eventLast = 0xEF;
  const hex = (value, width) => value.toString(16).toUpperCase().padStart(width, '0');
  const hexBytes = bytes => Array.from(bytes, byte => hex(byte, 2)).join(' ');
  const sameBytes = (left, right) => left.length === right.length && left.every((byte, index) => byte === right[index]);
  const cleanupTimeout = Symbol('cleanup timeout');
  const messages = {
    user: '已断开设备。',
    unplug: '设备已拔出，插回后可手动恢复。',
    'read-error': '串口读取失败，请检查设备。',
    'write-error': '串口写入失败，请检查设备。',
    'open-error': '无法打开串口，请检查设备或端口占用。',
    permission: '串口访问被拒绝，请检查浏览器权限。',
    busy: '另一个标签页正在使用串口。',
    pagehide: '页面已离开，串口已断开。'
  };

  function create(serial, {
    locks, lifecycle, onState = () => {}, onLog = () => {}, onCheck = () => {},
    onEvent = () => {}, timeoutMs = 1000, cleanupTimeoutMs = 1500, typeNames = {}
  } = {}) {
    const hasLocks = typeof locks?.request === 'function';
    const nameOf = value => typeNames[value] || names[value] || 'TYPE 0x' + hex(value, 2);
    let connection;
    let generation = 0;
    let picker;
    let discovery = 0;
    let ports = [];
    let discoveryMessage = '';
    let phase = 'idle';
    let status = '未连接';
    let reason = null;
    let nextSeq = 1;

    function publish() {
      const selectable = !connection;
      onState({
        phase, message: status, reason, generation, hasLocks,
        busy: Boolean(connection?.pending || connection?.writing),
        canSelect: selectable && !picker,
        canRestore: selectable && !picker && ports.length === 1,
        canDisconnect: ['selecting', 'opening', 'ready', 'close-error'].includes(phase),
        devices: ports.map(port => port.getInfo?.() ?? {}),
        discoveryMessage
      });
    }

    function show(nextPhase, message, why = null) {
      phase = nextPhase;
      status = message;
      reason = why;
      publish();
    }

    const current = link => connection?.generation === link.generation;
    const active = link => current(link) && !link.stopReason;

    async function refreshDevices() {
      const revision = ++discovery;
      try {
        const available = typeof serial.getPorts === 'function' ? await serial.getPorts() : [];
        if (revision !== discovery) return;
        ports = available.filter(port => port.connected !== false);
        discoveryMessage = '';
      } catch {
        if (revision !== discovery) return;
        ports = [];
        discoveryMessage = '无法查询已授权设备，可通过浏览器重新选择。';
      }
      publish();
    }

    function finish(link, error) {
      const request = link.pending;
      if (!request) return;
      clearTimeout(request.timer);
      link.pending = null;
      if (error) request.reject(error);
      else request.resolve(request.reply.frame);
      if (active(link)) publish();
    }

    function receive(link, frame) {
      if (!active(link)) return;
      const request = link.pending;
      const deviceEvent = frame.type >= eventFirst && frame.type <= eventLast;
      const seqMatches = request ? frame.seq === request.seq : null;
      const name = nameOf(frame.type);
      // A device event must not overwrite the "waiting for reply" check lines.
      if (!deviceEvent) {
        onCheck({
          crc: '通过 · 0x' + hex(frame.crc, 4),
          seq: request ? (seqMatches ? '匹配 · ' + frame.seq : '不匹配 · 收到 ' + frame.seq + '，等待 ' + request.seq)
            : '无待匹配请求 · ' + frame.seq
        });
      }
      onLog('RX ' + name + ' · SEQ ' + frame.seq + ' · CRC 通过' +
        (deviceEvent ? ' · 设备事件'
          : request ? (seqMatches ? ' · SEQ 匹配' : ' · SEQ 不匹配') : ' · 无待匹配请求') +
        (frame.length ? ' · ' + hexBytes(frame.payload) : ''));
      if (deviceEvent) {
        // Unsolicited 0xC0-0xEF events are dispatched even while a request is
        // outstanding; they neither satisfy nor reject that request.
        try {
          onEvent(frame);
        } catch {
          onLog('设备事件处理异常。');
        }
        return;
      }
      if (!seqMatches || request.reply) return;
      if (frame.type !== request.replyType) {
        onLog('回复类型不匹配 · 等待 ' + nameOf(request.replyType));
        return;
      }
      let error;
      if (request.validate) {
        // validate() returns an Error or null and must not throw; the catch
        // keeps a programming mistake from being reported as a read error.
        try {
          error = request.validate(frame);
        } catch {
          error = new Error('回复校验异常。');
        }
      } else {
        error = sameBytes(frame.payload, request.payload) ? null : new Error('ECHO_REPLY 的载荷与发送字节不一致。');
      }
      request.reply = { frame, error };
      if (!link.writing) finish(link, error);
    }

    function reportFrameError(link, error) {
      if (!active(link)) return;
      if (error.code === 'crc') {
        const detail = '收到 0x' + hex(error.received, 4) + '，应为 0x' + hex(error.expected, 4);
        onCheck({ crc: '失败 · ' + detail, seq: '未匹配 · CRC 无效' });
        onLog('RX CRC 失败 · SEQ ' + error.seq + ' · ' + detail);
        return;
      }
      const reasons = { version: '版本无效', length: '长度超限', payload: 'PING/PONG 载荷无效', partial: '残帧超时，重新查找帧头' };
      onLog('RX ' + reasons[error.code]);
    }

    async function readLoop(link) {
      const reader = link.reader;
      try {
        while (active(link)) {
          const { value, done } = await reader.read();
          if (!active(link)) break;
          if (done) {
            void stop(link, link.port.connected === false ? 'unplug' : 'read-error', '串口读取已结束。');
            break;
          }
          if (!value?.length) continue;
          clearTimeout(link.frameTimer);
          link.parser.push(value);
          if (active(link) && link.parser.pending) {
            link.frameTimer = setTimeout(() => {
              if (active(link)) link.parser.expire();
            }, frameIdleMs);
          }
        }
      } catch {
        if (active(link)) void stop(link, link.port.connected === false ? 'unplug' : 'read-error');
      }
    }

    // Reuse an unresolved operation on retry. Its eventual rejection is always handled.
    async function cleanupStep(link, key, operation) {
      if (!link.steps.has(key)) {
        const task = Promise.resolve().then(operation).then(() => true, error => {
          link.steps.delete(key);
          if (current(link)) onLog('串口清理失败 · ' + key + ' · ' + (error?.name ?? 'Error'));
          return false;
        });
        link.steps.set(key, task);
      }
      let timer;
      try {
        const result = await Promise.race([
          link.steps.get(key),
          new Promise(resolve => { timer = setTimeout(() => resolve(cleanupTimeout), cleanupTimeoutMs); })
        ]);
        if (result === cleanupTimeout) onLog('串口清理超时 · ' + key);
        return result === true;
      } finally {
        clearTimeout(timer);
      }
    }

    async function cleanup(link) {
      if (link.opening && !await cleanupStep(link, '等待端口打开', () => link.opening)) return false;
      if (link.reader) {
        const cancelled = await cleanupStep(link, 'reader.cancel', () => link.reader.cancel());
        // If cancellation failed, releasing the lock can reject and unblock the pending read.
        const joined = cancelled && await cleanupStep(link, '等待读循环结束', () => link.reading);
        if (await cleanupStep(link, 'reader.releaseLock', () => link.reader.releaseLock())) {
          link.reader = null;
          if (!joined) await cleanupStep(link, '等待读循环结束', () => link.reading);
        }
      }
      if (link.writer) {
        await cleanupStep(link, 'writer.abort', () => link.writer.abort());
        if (await cleanupStep(link, 'writer.releaseLock', () => link.writer.releaseLock())) link.writer = null;
      }
      if (link.opened && await cleanupStep(link, 'port.close', async () => {
        try {
          await link.port.close();
        } catch (error) {
          // SerialPort.connected was removed from Chrome, so a lost device can no longer
          // be recognized from it. A close failure of the "already closed / device lost"
          // kind still means nothing can use the port again, so the local handles and the
          // Web Lock must be released; any other failure keeps the lock (P2-2).
          if (error?.name !== 'InvalidStateError' && error?.name !== 'NetworkError') throw error;
          if (current(link)) onLog('串口已由浏览器关闭 · ' + error.name);
        }
      })) link.opened = false;
      // A closed port cannot be used again: drop stale handles so a failed
      // reader.cancel / writer.abort cannot keep the lock held forever.
      if (!link.opened) {
        link.reader = null;
        link.writer = null;
      }
      return !link.opened && !link.reader && !link.writer;
    }

    function stop(link, why, detail) {
      if (!current(link)) return Promise.resolve();
      if (link.closing) return link.closing;
      if (!link.stopReason) {
        link.stopReason = why;
        link.stopMessage = why === 'unplug' ? messages.unplug : detail ?? messages[why];
        clearTimeout(link.frameTimer);
        finish(link, new Error(link.stopMessage));
      }

      link.closing = Promise.resolve().then(async () => {
        try {
          if (!await cleanup(link)) {
            show('close-error', '串口尚未完全释放，请重试断开。', 'close-error');
            return;
          }
          link.port?.removeEventListener?.('disconnect', link.onDisconnect);
          link.releaseLock?.();
          await link.lockTask;
          if (!current(link)) return;
          connection = null;
          const lost = ['unplug', 'read-error', 'write-error'].includes(link.stopReason);
          show(lost ? 'lost' : 'idle', link.stopMessage, link.stopReason);
          onLog(link.stopMessage);
        } catch {
          if (current(link)) show('close-error', '串口清理失败，请重试断开。', 'close-error');
        } finally {
          link.closing = null;
        }
      });
      show('closing', '正在释放串口…', link.stopReason);
      return link.closing;
    }

    function acquire(link) {
      if (!hasLocks) return Promise.resolve(true);
      return new Promise((resolve, reject) => {
        link.lockTask = locks.request('zily-serial', { mode: 'exclusive', ifAvailable: true }, lock => {
          if (!lock || !active(link)) {
            resolve(false);
            return;
          }
          return new Promise(release => {
            link.releaseLock = release;
            resolve(true);
          });
        }).catch(reject);
      });
    }

    async function open(link, port) {
      if (!active(link)) return;
      link.port = port;
      link.onDisconnect = () => { void stop(link, 'unplug'); };
      port.addEventListener('disconnect', link.onDisconnect);
      if (port.connected === false) return stop(link, 'unplug');
      show('opening', '正在打开串口…');
      if (!await acquire(link)) {
        if (active(link)) await stop(link, 'busy');
        return;
      }
      if (!active(link)) return;
      const opening = Promise.resolve().then(() => port.open(portOptions)).then(() => {
        link.opened = true;
      });
      // Cleanup waits for completion, including failed open(), before releasing the lock.
      link.opening = opening.catch(() => {});
      await opening;
      if (!active(link)) return;
      if (port.connected === false) return stop(link, 'unplug');
      link.parser = protocol.createParser(frame => receive(link, frame), error => reportFrameError(link, error));
      link.writer = port.writable.getWriter();
      void link.writer.closed?.catch(() => {
        if (active(link)) void stop(link, port.connected === false ? 'unplug' : 'write-error');
      });
      link.reader = port.readable.getReader();
      link.reading = Promise.resolve().then(() => readLoop(link));
      show('ready', '串口已打开 · 115200 8N1');
      onLog('串口已打开，可以发送 PING 或 ECHO。');
    }

    async function openSelected(link, select) {
      try {
        const port = await select();
        if (active(link)) await open(link, port);
      } catch (error) {
        if (!active(link)) return;
        const denied = error.name === 'SecurityError' || error.name === 'NotAllowedError';
        const cancelled = phase === 'selecting' && error.name === 'NotFoundError';
        const why = cancelled ? 'user' : denied ? 'permission' : 'open-error';
        await stop(link, why, cancelled ? '未选择设备。' : undefined);
      }
    }

    function begin(nextPhase, message, select) {
      if (connection) return connection.connecting;
      const link = { generation: ++generation, steps: new Map() };
      connection = link;
      show(nextPhase, message);
      link.connecting = openSelected(link, select);
      return link.connecting;
    }

    function connect() {
      if (connection) return connection.connecting;
      if (picker) return Promise.resolve();
      return begin('selecting', '请在浏览器选择设备…', async () => {
        // Keep the browser permission prompt on the original click call stack.
        const choosing = serial.requestPort();
        picker = choosing;
        try {
          return await choosing;
        } finally {
          picker = null;
          publish();
          void refreshDevices();
        }
      });
    }

    function restore() {
      if (connection) return connection.connecting;
      if (picker || ports.length !== 1) return Promise.resolve();
      const [selected] = ports;
      return begin('opening', '正在打开已授权设备…', () => selected);
    }

    function request(message, replyType, payload, validate) {
      const link = connection;
      if (phase !== 'ready') return Promise.reject(new Error('请先连接设备。'));
      if (link.pending || link.writing) return Promise.reject(new Error('请等待当前请求结束。'));
      const seq = nextSeq;
      const bytes = protocol.encode(message, seq, payload);
      nextSeq = (nextSeq + 1) & 0xFFFF;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!active(link)) return;
          const error = new Error(nameOf(replyType) + ' 超时 · SEQ ' + seq);
          error.code = 'timeout';
          finish(link, error);
          if (link.writing) void stop(link, 'write-error', '串口写入超时。');
        }, timeoutMs);
        link.pending = { seq, replyType, payload, validate, resolve, reject, timer };
        link.writing = true;
        onCheck({ crc: '等待回复', seq: '等待 · ' + seq });
        publish();
        onLog('TX ' + nameOf(message) + ' · SEQ ' + seq + (payload.length ? ' · ' + hexBytes(payload) : ''));
        void Promise.resolve().then(() => {
          if (active(link)) return link.writer.write(bytes);
        }).then(() => {
          if (!active(link)) return;
          link.writing = false;
          if (link.pending?.reply) finish(link, link.pending.reply.error);
        }, () => {
          if (active(link)) void stop(link, link.port.connected === false ? 'unplug' : 'write-error');
        });
      });
    }

    function onSerialDisconnect(event) {
      const port = event.port ?? event.target;
      if (connection?.port === port && port.connected !== true) void stop(connection, 'unplug');
      void refreshDevices();
    }

    serial.addEventListener?.('connect', refreshDevices);
    serial.addEventListener?.('disconnect', onSerialDisconnect);
    lifecycle?.addEventListener('pagehide', () => {
      ++discovery;
      if (connection) void stop(connection, 'pagehide');
    });
    lifecycle?.addEventListener('pageshow', refreshDevices);
    void refreshDevices();

    return {
      connect,
      restore,
      refreshDevices,
      disconnect: () => connection ? stop(connection, 'user') : Promise.resolve(),
      ping: () => request(PING, PONG, new Uint8Array()),
      echo: payload => request(ECHO, ECHO_REPLY, payload.slice()),
      // Generic request path for the application protocol. The caller supplies
      // the expected reply TYPE and an optional validate(frame) -> Error|null.
      request: (message, replyType, payload, validate) => request(message, replyType, payload, validate)
    };
  }

  return { create, hexBytes };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ZilyWebSerial;
