'use strict';

// 0-9A 旋转编码器事件（STM32 → 网页，无 ACK）。
// 帧来自 26 号串口层：TYPE 0xC0 KEY_EVENT [keyId, action]、TYPE 0xC1 ENCODER_EVENT [int8 delta]。
// 0-9A 只保留编码器：keyId=3（旋钮按下）；action 0=单击、2=双击（1 长按保留不用）。
// 本模块只做「解析 + 映射 + 调用注入的动作」，不直接碰串口/播放器，便于 Node 离线测试。
const ZilyDeviceEvents = (() => {
  const type = Object.freeze({ KEY_EVENT: 0xC0, ENCODER_EVENT: 0xC1 });
  const keyId = Object.freeze({ ENCODER_PUSH: 3 });
  const action = Object.freeze({ SINGLE: 0, LONG: 1, DOUBLE: 2 });
  const eventFirst = 0xC0;
  const eventLast = 0xEF;
  const names = Object.freeze({
    [type.KEY_EVENT]: 'KEY_EVENT',
    [type.ENCODER_EVENT]: 'ENCODER_EVENT'
  });
  const keyNames = Object.freeze({ 3: '编码器按下' });
  const actionNames = Object.freeze({ 0: '单击', 1: '长按', 2: '双击' });
  const volumeStep = 0.05;
  const volumeStepPercent = 5;
  const minDelta = -127;
  const maxDelta = 127;

  const isEventType = value => Number.isInteger(value) && value >= eventFirst && value <= eventLast;

  // 返回 null（不是本模块的事件）、{ error }（长度/取值非法）或解析结果。
  // 该函数必须不抛异常：它由串口接收路径内联调用。
  function parse(frame) {
    if (!frame || !isEventType(frame.type)) return null;
    const payload = frame.payload;
    if (!(payload instanceof Uint8Array)) return { type: frame.type, error: '事件载荷不是字节数组' };
    const length = Number.isInteger(frame.length) ? frame.length : payload.length;
    try {
      if (frame.type === type.KEY_EVENT) {
        if (length !== 2 || payload.length !== 2) {
          return { type: frame.type, error: 'KEY_EVENT 长度应为 2，收到 ' + length };
        }
        const id = payload[0];
        const act = payload[1];
        if (!Object.hasOwn(keyNames, id)) {
          return { type: frame.type, error: 'KEY_EVENT keyId 非法：' + id };
        }
        if (act !== action.SINGLE && act !== action.DOUBLE) {
          return { type: frame.type, error: 'KEY_EVENT action 非法：' + act };
        }
        return { kind: 'key', type: frame.type, keyId: id, action: act };
      }
      if (frame.type === type.ENCODER_EVENT) {
        if (length !== 1 || payload.length !== 1) {
          return { type: frame.type, error: 'ENCODER_EVENT 长度应为 1，收到 ' + length };
        }
        const raw = payload[0];
        const delta = raw > 127 ? raw - 256 : raw;
        // 固件把绝对值钳在 127，因此 0 与 -128 都不该出现在线上。
        if (delta === 0 || delta < minDelta || delta > maxDelta) {
          return { type: frame.type, error: 'ENCODER_EVENT delta 非法：' + delta };
        }
        return { kind: 'encoder', type: frame.type, delta };
      }
      return null;
    } catch {
      return { type: frame.type, error: '事件解析异常' };
    }
  }

  // 每档音量 ±5%，按整数百分比计算避免浮点漂移；结果始终落在 0..1。
  function stepVolume(current, delta) {
    const steps = Number.isFinite(delta) ? Math.trunc(delta) : 0;
    const percent = Math.round((Number.isFinite(current) ? current : 0) * 100);
    const next = Math.min(100, Math.max(0, percent + steps * volumeStepPercent));
    return next / 100;
  }

  // actions 由 27 号面板注入：playPause / next / adjustVolume。
  // 动作返回字符串时作为日志与面板状态行的细节；返回值不会被 await，动作自己负责异步收尾。
  function create({ onLog = () => {}, actions = {} } = {}) {
    const emit = message => onLog('设备输入 · ' + message);

    function run(actionKey, label, argument) {
      const handler = actions[actionKey];
      if (typeof handler !== 'function') {
        emit(label + ' · 未接线');
        return { label, applied: false, detail: '' };
      }
      let detail;
      try {
        detail = handler(argument);
      } catch (error) {
        emit(label + ' 执行异常 · ' + (error?.message || '未知错误'));
        return { label, applied: false, detail: '', error: true };
      }
      const text = typeof detail === 'string' ? detail : '';
      emit(label + (text ? ' · ' + text : ''));
      return { label, applied: true, detail: text };
    }

    function handle(frame) {
      const event = parse(frame);
      if (!event) return null;
      if (event.error) {
        emit(event.error);
        return { label: event.error, applied: false, error: true };
      }
      if (event.kind === 'key') {
        const label = keyNames[event.keyId] + ' ' + actionNames[event.action];
        if (event.action === action.SINGLE) {
          return run('playPause', label + ' → 暂停/继续');
        }
        if (event.action === action.DOUBLE) {
          return run('next', label + ' → 下一首');
        }
        emit(label + ' · 该组合未定义，忽略');
        return { label, applied: false, detail: '' };
      }
      const sign = event.delta > 0 ? '+' : '';
      return run('adjustVolume', '编码器 ' + sign + event.delta + ' 档 → 音量', event.delta);
    }

    return { handle };
  }

  return {
    type, keyId, action, names, keyNames, actionNames,
    eventFirst, eventLast, volumeStep, isEventType, parse, stepVolume, create
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ZilyDeviceEvents;