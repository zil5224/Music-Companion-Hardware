'use strict';

// 0-8A OLED 显示协议主机模块（Phase 1）。
// 只负责产出 DISPLAY_BEGIN/DATA/END 载荷并校验 DISPLAY_ACK（0x91）；
// 帧头、CRC 与 SEQ 仍由 25/26 号模块负责，所有请求走
// bridge.request(type, 0x91, payload, validateAck(type))。
// 位图格式：逐行 1bpp、MSB 在最左、1=点亮、0=熄灭、不透明（区域背景必须画 0）。
// 传输模型：单会话停等，一次区域更新 = BEGIN → N×DATA → END；固定分片 240 B。

const ZilyOledDisplay = (() => {
  const type = Object.freeze({ BEGIN: 0x40, DATA: 0x41, END: 0x42, ACK: 0x91 });
  const status = Object.freeze({
    OK: 0x00, UNSUPPORTED: 0x01, BAD_PAYLOAD: 0x02, BAD_SESSION: 0x03,
    BAD_CHUNK: 0x04, BUSY: 0x05, INTERNAL: 0x06, IO_ERROR: 0x07
  });
  const names = Object.freeze({
    [type.BEGIN]: 'DISPLAY_BEGIN',
    [type.DATA]: 'DISPLAY_DATA',
    [type.END]: 'DISPLAY_END',
    [type.ACK]: 'DISPLAY_ACK'
  });
  const statusText = Object.freeze({
    [status.OK]: 'OK',
    [status.UNSUPPORTED]: '设备不支持该显示命令',
    [status.BAD_PAYLOAD]: '显示载荷不符合协议',
    [status.BAD_SESSION]: '显示会话不匹配',
    [status.BAD_CHUNK]: '分片乱序',
    [status.BUSY]: '设备忙',
    [status.INTERNAL]: '设备内部错误',
    [status.IO_ERROR]: '设备 I2C 写入失败'
  });
  // Phase 3 定稿布局（2026-11-16 用户要求加实时频谱、歌名/歌手字体缩小让位；
// 2026-11-16 三次/四次反馈：10 → 16 → 26 柱，再按观感收进两侧留白 → 24 柱；
  // 暂停时频谱保持最后一帧不归零。
  // 歌名 24 / 歌手 16（右侧时间）/ 频谱 16 / 进度 8，四区仍全部 8 像素对齐。
  // 频谱 24 柱、柱宽 3 px、间隔 2 px：24×3 + 23×2 = 118 px，居中后左右各留 5 px，
  // 与歌手行 5 px 内边距对齐，不再顶到屏幕左右边缘。
  const spectrumBars = 24;
  const region = Object.freeze({
    title: Object.freeze({ x: 0, y: 0, width: 128, height: 24 }),     // 歌名，中文大字号（18 px）
    artist: Object.freeze({ x: 0, y: 24, width: 128, height: 16 }),   // 歌手（左）+ 时间（右对齐）
    spectrum: Object.freeze({ x: 0, y: 40, width: 128, height: 16 }), // 实时频谱 10 柱
    progress: Object.freeze({ x: 0, y: 56, width: 128, height: 8 }),  // 整宽进度条（实心条高 2 px）
    full: Object.freeze({ x: 0, y: 0, width: 128, height: 64 })       // 全屏（测试屏/清屏）
  });
  const chunkBytes = 240;  // 固定分片大小
  const maxBytes = 1024;   // 全屏位图上限（128×64 ÷ 8）
  const ackLength = 3;     // DISPLAY_ACK 载荷 [CMD, STATUS, NEXT_CHUNK]
  const busyRetryMs = 30;  // 26 号单通道忙时的退避间隔
  const busyRetryLimit = 10;
  const busyPattern = /请等待当前请求结束/;
  // 测试屏内容：静态中文 + 演示频谱（Phase 3 用于实板看布局与频谱高度）。
  const testState = Object.freeze({
    title: '玻璃', artist: 'Gareth.T', time: '1:23', ratio: 0.5,
    levels: Object.freeze([0.10, 0.20, 0.32, 0.46, 0.62, 0.80, 0.95, 0.78,
      0.60, 0.46, 0.58, 0.74, 0.90, 0.70, 0.52, 0.36, 0.48, 0.64,
      0.82, 0.66, 0.48, 0.34, 0.50, 0.30])
  });

  function statusName(code) {
    if (!Number.isInteger(code)) return '未知应答状态';
    return statusText[code] ||
      '未知应答状态 0x' + code.toString(16).toUpperCase().padStart(2, '0');
  }

  function checkByte(value, label) {
    if (!Number.isInteger(value) || value < 0 || value > 0xFF) {
      throw new RangeError('OLED 载荷字段 ' + label + ' 非法。');
    }
  }

  // BEGIN 载荷（LEN=9）：[session, x, y, width, height, format=0, totalBytes LE16, totalChunks]
  function encodeBegin({ session, x, y, width, height, totalBytes, totalChunks }) {
    checkByte(session, 'session');
    checkByte(x, 'x');
    checkByte(y, 'y');
    if (!Number.isInteger(width) || width < 1 || width > 128) {
      throw new RangeError('OLED BEGIN 宽度非法（应为 1–128）。');
    }
    if (!Number.isInteger(height) || height < 1 || height > 64) {
      throw new RangeError('OLED BEGIN 高度非法（应为 1–64）。');
    }
    if (x + width > 128) throw new RangeError('OLED BEGIN 区域超出屏幕右边界（x+width ≤ 128）。');
    if (y + height > 64) throw new RangeError('OLED BEGIN 区域超出屏幕下边界（y+height ≤ 64）。');
    const expectedBytes = Math.ceil(width / 8) * height;
    if (!Number.isInteger(totalBytes) || totalBytes !== expectedBytes || totalBytes > maxBytes) {
      throw new RangeError('OLED BEGIN 位图字节数应为 ' + expectedBytes + '，且不超过 ' + maxBytes + '。');
    }
    const expectedChunks = Math.ceil(totalBytes / chunkBytes);
    if (totalChunks !== expectedChunks) {
      throw new RangeError('OLED BEGIN 分片数应为 ' + expectedChunks + '。');
    }
    const payload = new Uint8Array(9);
    const view = new DataView(payload.buffer);
    payload.set([session, x, y, width, height, 0]); // format 恒 0：1bpp 行优先、MSB 在左
    view.setUint16(6, totalBytes, true);
    payload[8] = totalChunks;
    return payload;
  }

  // DATA 载荷：[session, chunk, offset LE16, ...data]；单片最多 240 B。
  function encodeData({ session, chunk, offset, data }) {
    checkByte(session, 'session');
    checkByte(chunk, 'chunk');
    if (!Number.isInteger(offset) || offset < 0 || offset > 0xFFFF) {
      throw new RangeError('OLED DATA offset 非法。');
    }
    if (!(data instanceof Uint8Array) || data.length > chunkBytes) {
      throw new RangeError('OLED DATA 数据非法（单片最多 ' + chunkBytes + ' B）。');
    }
    const payload = new Uint8Array(4 + data.length);
    const view = new DataView(payload.buffer);
    payload[0] = session;
    payload[1] = chunk;
    view.setUint16(2, offset, true);
    payload.set(data, 4);
    return payload;
  }

  // END 载荷（LEN=2）：[session, flags]；V1 固定 flags=1（bit0=立即 FlushRegion）。
  function encodeEnd({ session, flags = 1 }) {
    checkByte(session, 'session');
    checkByte(flags, 'flags');
    return Uint8Array.of(session, flags);
  }

  // 校验 DISPLAY_ACK：载荷长度必须为 3、CMD 回显匹配、STATUS=OK。
  // BAD_CHUNK 也算错误，消息里带设备期望的分片号（NEXT_CHUNK）。
  // 返回 Error 表示拒绝、null 表示通过；本函数不得 throw（26 号在接收路径内联调用）。
  function validateAck(command) {
    return frame => {
      try {
        const payload = frame?.payload;
        if (!payload || payload.length !== ackLength) {
          return new Error('DISPLAY_ACK 长度非法（应为 ' + ackLength + ' B）。');
        }
        if (payload[0] !== command) {
          return new Error('DISPLAY_ACK 命令回显不匹配。');
        }
        const code = payload[1];
        if (code === status.OK) return null;
        const error = new Error(code === status.BAD_CHUNK
          ? 'DISPLAY_ACK 分片乱序 · 设备期望分片 ' + payload[2] + '。'
          : 'DISPLAY_ACK ' + statusName(code) + '。');
        error.status = code; // 供 END 的 INTERNAL/IO_ERROR 重发判断使用
        return error;
      } catch {
        return new Error('DISPLAY_ACK 校验异常。');
      }
    };
  }

  // 读取 ACK 的 NEXT_CHUNK；帧不合法时返回 null，不 throw。
  function parseNextChunk(frame) {
    try {
      const payload = frame?.payload;
      if (!payload || payload.length < ackLength) return null;
      return Number.isInteger(payload[2]) ? payload[2] : null;
    } catch {
      return null;
    }
  }

  // 把 RGBA 像素（Canvas getImageData）按亮度阈值 128 二值化成 1bpp 行优先位图。
  // 行跨度 = ceil(width/8)，MSB 在最左；alpha 按黑色背景合成（不透明要求）。
  function pack1bpp(imageData) {
    const width = imageData?.width;
    const height = imageData?.height;
    const data = imageData?.data;
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
      throw new RangeError('OLED 位图打包：图像尺寸非法。');
    }
    if (!data || data.length < width * height * 4) {
      throw new RangeError('OLED 位图打包：像素数据长度不足。');
    }
    const stride = Math.ceil(width / 8);
    const bitmap = new Uint8Array(stride * height);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const pixel = (row * width + col) * 4;
        const alpha = data[pixel + 3] / 255;
        const luminance = (0.299 * data[pixel] + 0.587 * data[pixel + 1] + 0.114 * data[pixel + 2]) * alpha;
        if (luminance >= 128) bitmap[row * stride + (col >> 3)] |= 0x80 >> (col & 7);
      }
    }
    return bitmap;
  }

  // 秒 → m:ss（时间只出现在歌手行右侧）。
  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  }

  // 默认 Canvas 渲染器（黑底白字），仅在浏览器环境可用；Node 测试请注入 renderer。
  function createCanvasRenderer() {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      throw new Error('当前环境没有 canvas，无法渲染 OLED 内容，请为 create() 注入 renderer。');
    }
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // 2026-11-16 实板反馈：18 px bold 中文在 1bpp 下笔画会“粘”在一起 → 歌名改 22 px 常规体（不加粗）。
    const titleFont = '22px "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';
    // 歌手/时间实板反馈偏小 → 歌手 14 px、时间 12 px（行高 16 px）。
    const artistFont = '14px "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';
    const timeFont = '12px Consolas, "Courier New", monospace';

    function clearArea(area) {
      ctx.fillStyle = '#000';
      ctx.fillRect(area.x, area.y, area.width, area.height);
    }

    function capture(area) {
      return {
        x: area.x, y: area.y, width: area.width, height: area.height,
        bitmap: pack1bpp(ctx.getImageData(area.x, area.y, area.width, area.height))
      };
    }

    // 过长文本截断加省略号（≤4 字静态显示；>4 字由 33 号滚动模块改为窗口滚动）。
    function fit(text, font, maxWidth) {
      ctx.font = font;
      if (ctx.measureText(text).width <= maxWidth) return text;
      let out = text;
      while (out.length > 1 && ctx.measureText(out + '…').width > maxWidth) out = out.slice(0, -1);
      return out + '…';
    }

    function drawTitle(state) {
      const area = region.title;
      clearArea(area);
      ctx.fillStyle = '#fff';
      ctx.font = titleFont;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(fit(state.title ?? '', titleFont, area.width - 4),
        area.x + area.width / 2, area.y + area.height / 2);
    }

    // 长歌名滚动窗口：按 offset 左移，文字尾部离开后从右侧接上下一份（32 px 间隔），
    // 渲染器内部对 (文字宽 + 间隔) 取模，调用方只需一直累加 offset。
    function drawTitleWindow(state) {
      const area = region.title;
      clearArea(area);
      const title = String(state.title ?? '');
      if (!title) return;
      ctx.fillStyle = '#fff';
      ctx.font = titleFont;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const middle = area.y + area.height / 2;
      const width = ctx.measureText(title).width;
      const gap = 32;
      const cycle = width + gap;
      const rawOffset = Math.max(0, Math.round(Number(state.titleOffset) || 0));
      const offset = cycle > 0 ? rawOffset % cycle : 0;
      const startX = area.x - offset;
      ctx.fillText(title, startX, middle);
      if (startX + width < area.x + area.width) {
        ctx.fillText(title, startX + cycle, middle);
      }
    }

    function drawArtist(state) {
      const area = region.artist;
      clearArea(area);
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      const middle = area.y + area.height / 2;
      // 左右各 5 px 内边距：与频谱区居中的 24 柱（两侧各 5 px 留白）对齐。
      const inset = 5;
      let timeWidth = 0;
      if (state.time) {
        ctx.font = timeFont;
        ctx.textAlign = 'right';
        timeWidth = ctx.measureText(state.time).width;
        ctx.fillText(state.time, area.x + area.width - inset, middle);
      }
      ctx.font = artistFont;
      ctx.textAlign = 'left';
      ctx.fillText(fit(state.artist ?? '', artistFont, area.width - timeWidth - inset * 2 - 4),
        area.x + inset, middle);
    }

    // 实时频谱：竖条按数量自动算宽并居中（24 柱 → 柱宽 3、间隔 2，总宽 118，两侧各 5 px 留白；
    // 26 柱 → 3/2/128 铺满）。
    function drawSpectrum(state) {
      const area = region.spectrum;
      clearArea(area);
      const levels = Array.isArray(state.levels) ? state.levels : [];
      const count = levels.length;
      if (!count) return;
      const gap = 2;
      const barWidth = Math.floor((area.width - gap * (count - 1)) / count);
      if (barWidth < 1) return;
      const used = barWidth * count + gap * (count - 1);
      const offsetX = Math.floor((area.width - used) / 2);
      const baseY = area.y + area.height;
      ctx.fillStyle = '#fff';
      for (let i = 0; i < count; i++) {
        const level = Math.min(1, Math.max(0, Number(levels[i]) || 0));
        const barHeight = Math.round(level * area.height);
        if (barHeight <= 0) continue;
        ctx.fillRect(area.x + offsetX + i * (barWidth + gap), baseY - barHeight, barWidth, barHeight);
      }
    }

    function drawProgress(state) {
      const area = region.progress;
      clearArea(area);
      const ratio = Math.min(1, Math.max(0, Number(state.ratio) || 0));
      ctx.fillStyle = '#fff';
      // 区域 8 px 高，上下各留 3 px；实心白条 2 px（更细的进度线，高度全让给歌名/歌手）。
      ctx.fillRect(area.x, area.y + 3, Math.round(area.width * ratio), area.height - 6);
    }

    return {
      // 测试屏 = 全屏一张位图（歌名 0–24、歌手 24–40、频谱 40–56、进度条 56–64 一次画完）。
      renderTestScreen(state) {
        drawTitle(state);
        drawArtist(state);
        drawSpectrum(state);
        drawProgress(state);
        return [capture(region.full)];
      },
      renderSong(state) {
        drawTitle(state);
        drawArtist(state);
        return [capture(region.title), capture(region.artist)];
      },
      renderTitleWindow(state) {
        drawTitleWindow(state);
        return [capture(region.title)];
      },
      renderProgress(state) {
        drawArtist(state);
        drawProgress(state);
        return [capture(region.progress), capture(region.artist)];
      },
      renderSpectrum(state) {
        drawSpectrum(state);
        return [capture(region.spectrum)];
      }
    };
  }

  function create(bridge, { onLog = () => {}, onBusyChange = () => {}, renderer = null } = {}) {
    const delay = ms => new Promise(resolve => { setTimeout(resolve, ms); });
    // 当前显示内容状态，传给渲染器：{ title, titleOffset, artist, time, ratio, levels }。
    const state = { title: '', titleOffset: 0, artist: '', time: '', ratio: 0, levels: new Array(spectrumBars).fill(0) };
    let activeRenderer = renderer;
    let session = 0;     // 会话号：每次区域传输前 +1（mod 256）
    let queue = [];      // 尚未开始的传输
    let active = null;   // 正在发送的传输（不被新更新中断）
    let busy = false;
    let pumping = false;

    function log(message) {
      try { onLog(message); } catch { /* 回调异常不影响传输 */ }
    }

    function useRenderer() {
      if (!activeRenderer) activeRenderer = createCanvasRenderer();
      return activeRenderer;
    }

    function updateBusy() {
      const next = Boolean(active) || queue.length > 0;
      if (next === busy) return;
      busy = next;
      try { onBusyChange(busy); } catch { /* 回调异常不影响传输 */ }
    }

    function settle(batch, error) {
      if (batch.settled) return;
      batch.settled = true;
      if (error) batch.reject(error);
      else batch.resolve();
    }

    // 带忙退避的单通道请求：26 号在已有请求在飞时 reject「请等待当前请求结束」，
    // 这里等 30 ms 后重试同一请求，最多 10 次，不直接失败。
    async function sendRequest(message, payload, validate) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await bridge.request(message, type.ACK, payload, validate);
        } catch (error) {
          if (attempt < busyRetryLimit && busyPattern.test(error?.message ?? '')) {
            await delay(busyRetryMs);
            continue;
          }
          throw error;
        }
      }
    }

    // 分片失败（超时或 NACK）→ 用相同 session/chunk/offset 重发一次；仍失败抛出，放弃本次更新。
    async function sendChunk(sessionId, chunk, offset, data) {
      const payload = encodeData({ session: sessionId, chunk, offset, data });
      try {
        return await sendRequest(type.DATA, payload, validateAck(type.DATA));
      } catch (error) {
        log('OLED 分片 ' + chunk + ' 失败 · ' + (error?.message ?? '未知错误') + ' · 相同分片重发一次');
        return sendRequest(type.DATA, payload, validateAck(type.DATA));
      }
    }

    // END 收到 INTERNAL/IO_ERROR 时允许重发 END 一次（固件侧重绘+重刷是幂等的）。
    async function sendEnd(sessionId) {
      const payload = encodeEnd({ session: sessionId });
      try {
        return await sendRequest(type.END, payload, validateAck(type.END));
      } catch (error) {
        if (error?.status === status.INTERNAL || error?.status === status.IO_ERROR) {
          log('OLED END ' + statusName(error.status) + ' · 重发一次');
          return sendRequest(type.END, payload, validateAck(type.END));
        }
        throw error;
      }
    }

    // 一次区域传输 = BEGIN → N×DATA → END，逐分片停等。
    async function sendTransfer(item) {
      const { x, y, width, height, bitmap, label } = item;
      session = (session + 1) & 0xFF;
      const totalBytes = bitmap.length;
      const totalChunks = Math.ceil(totalBytes / chunkBytes);
      await sendRequest(type.BEGIN,
        encodeBegin({ session, x, y, width, height, totalBytes, totalChunks }),
        validateAck(type.BEGIN));
      for (let chunk = 0; chunk < totalChunks; chunk++) {
        const offset = chunk * chunkBytes;
        const data = bitmap.subarray(offset, offset + Math.min(chunkBytes, totalBytes - offset));
        await sendChunk(session, chunk, offset, data);
      }
      await sendEnd(session);
      log('OLED ' + label + '已刷新 · 区域 (' + x + ',' + y + ') ' + width + '×' + height +
        ' · ' + totalBytes + ' B · ' + totalChunks + ' 片');
    }

    function finishTransfer(item, error) {
      const batch = item.batch;
      batch.pending--;
      if (error) {
        // 放弃本次更新剩余的区域；队列中其它批次的更新不受影响。
        queue = queue.filter(entry => entry.batch !== batch);
        settle(batch, error);
        return;
      }
      if (batch.pending <= 0) settle(batch, null);
    }

    // 新更新覆盖尚未开始的旧更新（最新内容优先）；正在发送的传输不中断。
    function dropQueued() {
      if (!queue.length) return;
      log('OLED 显示：新更新覆盖 ' + queue.length + ' 个尚未开始的旧更新（最新内容优先）。');
      const dropped = queue;
      queue = [];
      for (const item of dropped) {
        item.batch.pending--;
        if (item.batch.pending <= 0) settle(item.batch, null);
      }
    }

    async function pump() {
      if (pumping) return;
      pumping = true;
      try {
        while (queue.length) {
          active = queue.shift();
          updateBusy();
          let failure = null;
          try {
            await sendTransfer(active);
          } catch (error) {
            failure = error instanceof Error ? error : new Error('OLED 更新失败。');
            log('OLED 更新失败，放弃本次更新并保留旧画面 · ' + failure.message);
          }
          const item = active;
          active = null;
          finishTransfer(item, failure);
          updateBusy();
        }
      } finally {
        active = null;
        pumping = false;
        updateBusy();
      }
    }

    function enqueue(regions, label) {
      const list = Array.isArray(regions) ? regions.filter(Boolean) : [];
      if (!list.length) {
        log('OLED 显示：' + label + '没有可发送的区域。');
        return Promise.resolve();
      }
      dropQueued();
      const batch = { pending: list.length, settled: false, resolve: null, reject: null };
      const promise = new Promise((resolve, reject) => {
        batch.resolve = resolve;
        batch.reject = reject;
      });
      for (const area of list) {
        queue.push({
          batch, label,
          x: area.x, y: area.y, width: area.width, height: area.height, bitmap: area.bitmap
        });
      }
      updateBusy();
      void pump();
      return promise;
    }

    // Phase 1 静态中文测试屏：全屏一张位图（0,0,128,64,1024 B,5 片）。
    async function showTestScreen() {
      return enqueue(useRenderer().renderTestScreen(testState), '静态测试屏');
    }

    async function updateRegion(x, y, width, height, bitmap) {
      if (!(bitmap instanceof Uint8Array)) throw new Error('OLED 位图必须是 Uint8Array。');
      return enqueue([{ x, y, width, height, bitmap }], '区域更新');
    }

    // 歌名 + 歌手（含时间行）两个区域。
    async function updateSong(title, artist) {
      state.title = String(title ?? '');
      state.titleOffset = 0;
      state.artist = String(artist ?? '');
      return enqueue(useRenderer().renderSong(state), '歌曲信息');
    }

    // 长歌名滚动：只发歌名区（128×24 / 384 B / 2 片）；offset 由 33 号模块累加，
    // 渲染器内部按 (文字宽 + 32 px 间隔) 取模，循环无缝。
    async function updateTitle(title, offset) {
      state.title = String(title ?? '');
      state.titleOffset = Math.max(0, Math.round(Number(offset) || 0));
      return enqueue(useRenderer().renderTitleWindow(state), '歌名滚动');
    }

    // 进度条 + 歌手行（时间在同一行右侧）两个区域。
    async function updateProgress(current, total) {
      const position = Number(current);
      const duration = Number(total);
      state.ratio = Number.isFinite(position) && Number.isFinite(duration) && duration > 0
        ? Math.min(1, Math.max(0, position / duration))
        : 0;
      state.time = formatTime(Number.isFinite(position) ? Math.max(0, position) : 0);
      return enqueue(useRenderer().renderProgress(state), '进度');
    }

    // 实时频谱：只发频谱区域（128×16 = 256 B，2 片）；等级数组会被裁剪/归一化到 10 个 0–1 值。
    async function updateSpectrum(levels) {
      const list = Array.from(levels ?? []);
      for (let i = 0; i < spectrumBars; i++) {
        const value = Number(list[i]);
        state.levels[i] = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
      }
      return enqueue(useRenderer().renderSpectrum(state), '频谱');
    }

    // 全屏清屏：全黑位图（不透明格式，全 0 即熄灭）。
    async function clear() {
      return enqueue([{ x: 0, y: 0, width: 128, height: 64, bitmap: new Uint8Array(maxBytes) }], '全屏清屏');
    }

    return {
      showTestScreen,
      updateRegion,
      updateSong,
      updateTitle,
      updateProgress,
      updateSpectrum,
      clear,
      isBusy: () => busy
    };
  }

  return {
    type, status, names, statusName, region,
    chunkBytes, maxBytes, ackLength, spectrumBars,
    encodeBegin, encodeData, encodeEnd,
    validateAck, parseNextChunk, pack1bpp,
    create
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ZilyOledDisplay;
