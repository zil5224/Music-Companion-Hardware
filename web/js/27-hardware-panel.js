'use strict';

(() => {
  const panel = document.getElementById('hardwarePanel');
  const status = panel.querySelector('#hardwareStatus');
  const crc = panel.querySelector('#hardwareCrc');
  const seq = panel.querySelector('#hardwareSeq');
  const history = panel.querySelector('#hardwareLog');
  const connect = panel.querySelector('#hardwareConnect');
  const restore = panel.querySelector('#hardwareRestore');
  const devices = panel.querySelector('#hardwareDevices');
  const lockStatus = panel.querySelector('#hardwareLockStatus');
  const disconnect = panel.querySelector('#hardwareDisconnect');
  const ping = panel.querySelector('#hardwarePing');
  const echo = panel.querySelector('#hardwareEcho');
  const deviceStateLine = panel.querySelector('#hardwareDeviceState');
  const inputStatus = panel.querySelector('#hardwareInputStatus');
  const pause = panel.querySelector('#hardwarePause');
  const resume = panel.querySelector('#hardwareResume');
  const next = panel.querySelector('#hardwareNext');
  const favoriteOn = panel.querySelector('#hardwareFavoriteOn');
  const favoriteOff = panel.querySelector('#hardwareFavoriteOff');
  const oledStatus = panel.querySelector('#hardwareOledStatus');
  const oledTest = panel.querySelector('#hardwareOledTest');
  const oledFollow = panel.querySelector('#hardwareOledFollow');
  const echoBytes = Uint8Array.of(0x00, 0x01, 0x7F, 0x80, 0xFE, 0xFF);
  const app = ZilyAppProtocol;
  const commandButtons = [pause, resume, next, favoriteOn, favoriteOff];
  const mirror = { playing: null, favorited: null };
  let deviceEvents = null;    // 0-9A 设备事件分发器（bridge 创建后接线）
  // 连按 KEY1 时只允许最新一次回写落地：每次动作领取单调代号，旧代号在发请求前丢弃。
  let playbackMirrorToken = 0;
  let readyPhase = false;    // 串口已就绪（不含单通道忙），用于跟随播放与按钮可用态
  let followEnabled = true;  // 用户是否希望跟随播放（连接后自动开始）
  let syncing = false;       // 观察器/频谱当前是否在跑
  let lastDisplay = null;    // 观察器最近一次成功推送的内容
  let testNote = '';         // 静态测试屏结果，暂停跟随时显示
  // Phase 3：频谱约 8 Hz 刷新，单通道会长期被占用；应用命令不再因 OLED 忙而禁用，
  // 改为对「请等待当前请求结束」做 30 ms 退避重试，避免按钮每秒闪 8 次。
  const busyPattern = /请等待当前请求结束/;
  const busyRetryMs = 30;
  const busyRetryLimit = 20;

  if (!globalThis.isSecureContext || !navigator.serial?.requestPort) {
    status.textContent = 'Web Serial 不可用。请用支持的桌面 Chrome 或 Edge 打开 Zily 的本机地址。';
    return;
  }

  function log(message) {
    const item = document.createElement('li');
    item.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '  ' + message;
    history.prepend(item);
    if (history.children.length > 24) history.lastElementChild.remove();
  }

  function renderState() {
    const playing = mirror.playing === null ? '未知' : mirror.playing ? '播放中' : '已暂停';
    const favorited = mirror.favorited === null ? '未知' : mirror.favorited ? '已收藏' : '未收藏';
    deviceStateLine.textContent = '设备状态：' + playing + ' · ' + favorited;
  }

  function resetState() {
    mirror.playing = null;
    mirror.favorited = null;
    renderState();
  }

  // 0-8A Phase 2：OLED 显示状态行。跟随播放时显示当前歌名/歌手/时间；
  // 暂停跟随时显示最近一次静态测试屏结果。显示传输期间只联动按钮，不改状态文字，
  // 避免每秒一次的进度更新让状态行闪「正在发送…」。
  function formatClock(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  }

  function displaySummary() {
    if (!lastDisplay) return '';
    const title = lastDisplay.title || '（无歌名）';
    const artist = lastDisplay.artist || '（未知歌手）';
    let summary = title + ' / ' + artist;
    if (lastDisplay.kind === 'progress') {
      summary += ' · ' + formatClock(lastDisplay.current) + ' / ' + formatClock(lastDisplay.total);
    }
    return summary;
  }

  function renderOledStatus() {
    if (!readyPhase) {
      oledStatus.textContent = '未连接';
      return;
    }
    if (syncing) {
      const summary = displaySummary();
      oledStatus.textContent = summary ? '跟随播放中 · ' + summary : '跟随播放中…';
      return;
    }
    oledStatus.textContent = testNote || (followEnabled ? '等待播放器状态…' : '已暂停跟随播放');
  }

  // OLED 传输期间不再禁用应用命令按钮：Phase 3 频谱约 8 Hz 刷新会把单通道占掉相当一部分
// 时间，禁用会让按钮高频闪烁。这里统一对 26 号的「请等待当前请求结束」做 30 ms 退避
// 重试（最多 20 次 ≈ 600 ms），命令自己等一个传输间隙再发。
  async function withBusyRetry(action) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await action();
      } catch (error) {
        if (attempt >= busyRetryLimit || !busyPattern.test(error?.message ?? '')) throw error;
        await new Promise(resolve => setTimeout(resolve, busyRetryMs));
      }
    }
  }

  function refreshButtons() {
    ping.disabled = echo.disabled = !readyPhase;
    for (const button of commandButtons) button.disabled = !readyPhase;
    oledTest.disabled = !readyPhase;
    oledFollow.disabled = !readyPhase;
    oledFollow.textContent = followEnabled ? '暂停跟随' : '恢复跟随';
  }

  // Only a STATUS=OK ACK updates the mirror, and only the state bit affected by
  // that command. NEXT carries no state change; a NACK never updates the UI.
  function applyAck(command, flags) {
    if (command === app.type.NEXT || flags === null) return '';
    const decoded = app.decodeState(flags);
    if (!decoded) return '';
    if (command === app.type.FAVORITE) {
      mirror.favorited = decoded.favorited;
    } else {
      mirror.playing = decoded.playing;
      if (command === app.type.PAUSE && decoded.playing) log('协议告警：PAUSE 后设备仍报告播放中。');
      if (command === app.type.RESUME && !decoded.playing) log('协议告警：RESUME 后设备仍报告已暂停。');
    }
    renderState();
    return 'STATE 0x' + flags.toString(16).toUpperCase().padStart(2, '0');
  }

  let currentGeneration = 0;
  const bridge = ZilyWebSerial.create(navigator.serial, {
    locks: navigator.locks,
    lifecycle: window,
    typeNames: { ...app.names, ...ZilyOledDisplay.names, ...ZilyDeviceEvents.names },
    onState({ phase, message, generation, canSelect, canRestore, canDisconnect,
      devices: available, discoveryMessage, hasLocks }) {
      if (currentGeneration !== generation) {
        crc.textContent = seq.textContent = '—';
        resetState();
      } else if (phase !== 'ready') {
        resetState();
      }
      currentGeneration = generation;
      status.textContent = message;
      connect.disabled = !canSelect;
      restore.disabled = !canRestore;
      disconnect.disabled = !canDisconnect;
      const becameReady = phase === 'ready' && !readyPhase;
      readyPhase = phase === 'ready';
      if (phase !== 'ready' || becameReady) renderInputStatus('');
      syncObserver();
      const device = available[0];
      let deviceDescription = '1 个已授权设备可恢复。';
      if (device?.usbVendorId != null && device?.usbProductId != null) {
        const id = value => value.toString(16).toUpperCase().padStart(4, '0');
        deviceDescription = '已授权设备 · USB ' + id(device.usbVendorId) + ':' + id(device.usbProductId);
      }
      devices.textContent = discoveryMessage || (available.length > 1
        ? '发现 ' + available.length + ' 个已授权设备，请通过“连接设备”重新选择。'
        : available.length === 1 ? deviceDescription : '当前没有可用的已授权设备。');
      lockStatus.hidden = hasLocks;
    },
    onLog: log,
    onCheck(check) {
      crc.textContent = check.crc;
      seq.textContent = check.seq;
    },
    onEvent(frame) {
      if (!deviceEvents) return;
      // 0-9A：事件动作本身在 deviceActions 里执行；这里只更新面板状态行。
      const result = deviceEvents.handle(frame);
      if (result && result.label) {
        renderInputStatus(result.label + (result.detail ? ' · ' + result.detail : ''));
      }
    }
  });

  // 0-8A Phase 1：OLED 静态测试屏。Phase 3 起显示更新频繁，按钮不再按 OLED 忙禁用。
  const oled = ZilyOledDisplay.create(bridge, {
    onLog: log
  });

  // 0-8A Phase 2：播放器观察器。只读播放器 DOM/<audio> 公开状态，不改播放器核心；
  // 歌名/歌手变化即时推送，进度每秒一次，暂停后只推一次冻结画面。
  // 26 号在 create() 里会异步发布一次初始状态；观察器稍后才创建，因此 syncObserver
  // 里对 observer 做了空值保护，避免初始 onState 早于创建时抛错。
  let observer = null;
  observer = ZilyPlayerObserver.create({
    display: oled,
    getSnapshot: () => ZilyPlayerObserver.readPlayerSnapshot(document),
    isReady: () => readyPhase,
    onLog: log,
    onUpdate(update) {
      // 暂停跟随（例如「测试 OLED」）后，观察器在飞更新可能还会成功回调；
      // 此时忽略，避免把静止测试屏的状态行/提示改回播放文案。
      if (!syncing) return;
      lastDisplay = update;
      testNote = '';
      renderOledStatus();
    }
  });

  // 0-8A Phase 3：实时频谱。数据来自 06-audio.js 的 AnalyserNode；播放中才发，
  // 暂停/无歌时只归零一帧；显示忙时丢帧，不排队拖住文本更新与应用命令。
  const spectrum = ZilyOledSpectrum.create({
    display: oled,
    getLevels: () => ZilyOledSpectrum.readAnalyserLevels(analyserRef()),
    isPlaying: () => {
      const audioEl = document.getElementById('audioEl');
      return Boolean(audioEl) && !audioEl.paused && !audioEl.ended &&
        Boolean(audioEl.currentSrc || audioEl.src);
    },
    onLog: log
  });

  // 0-9A 实体输入：动作全部复用页面现有公开入口（播放器按钮、收藏模块、<audio> 音量），
  // 不侵入播放器、AI、网易云核心模块。事件帧本身无 ACK；动作成功后用 0-7A
  // PAUSE/RESUME/FAVORITE 把 MCU 镜像状态回写（与面板按钮同一条 ACK 校验路径）。
  function audioElement() {
    return document.getElementById('audioEl');
  }

  function hasLoadedAudio(audioEl) {
    return Boolean(audioEl) && Boolean(audioEl.currentSrc || audioEl.src);
  }

  function formatVolumeState() {
    const audioEl = audioElement();
    if (!audioEl) return '音量未知';
    return '音量 ' + Math.round(audioEl.volume * 100) + '%' + (audioEl.muted ? ' · 已静音' : '');
  }

  function renderInputStatus(label) {
    if (!readyPhase) {
      inputStatus.textContent = '设备输入：未连接';
      return;
    }
    inputStatus.textContent = (label ? label + ' · ' : '') + formatVolumeState();
  }

  // 播放/暂停动作后按 <audio> 的真实状态回写，等 150 ms 让 play()/pause() 生效。
  // 连按时旧定时器与旧 busy 重试都可能还在飞：用单调代号保证只有最新一次能发出去，
  // 否则 OLED 忙时旧 PAUSE 可能在新 RESUME 之后落地，MCU 镜像与页面相反。
  function syncPlayingMirror() {
    const audioEl = audioElement();
    if (!hasLoadedAudio(audioEl)) return;
    const token = ++playbackMirrorToken;
    window.setTimeout(() => {
      if (!readyPhase || token !== playbackMirrorToken) return;
      const playingNow = !audioEl.paused && !audioEl.ended;
      void sendPlaybackMirror(token, playingNow ? app.type.RESUME : app.type.PAUSE,
        playingNow ? 'RESUME（设备按键回写）' : 'PAUSE（设备按键回写）');
    }, 150);
  }

  async function sendPlaybackMirror(token, command, label) {
    try {
      const frame = await withBusyRetry(() => {
        // 每次真正抢单通道前再检查一次代号：更新的按键已经产生时，旧回写立即放弃。
        if (token !== playbackMirrorToken) {
          const stale = new Error('过期回写已丢弃。');
          stale.code = 'stale-mirror';
          throw stale;
        }
        return bridge.request(command, app.type.ACK, new Uint8Array(), app.validateAck(command));
      });
      if (token !== playbackMirrorToken) return;
      const detail = applyAck(command, app.parseState(frame));
      log(label + ' · ACK OK' + (detail ? ' · ' + detail : ''));
    } catch (error) {
      if (error?.code === 'stale-mirror') return;
      if (token !== playbackMirrorToken) return;
      if (error?.code === 'timeout') resetState();
      if (crc.textContent === '等待回复') crc.textContent = '未收到可校验的回复';
      if (seq.textContent.startsWith('等待')) seq.textContent = '未匹配';
      log(error?.message || '设备按键回写失败。');
    }
  }

  const deviceActions = {
    playPause() {
      const audioEl = audioElement();
      if (!hasLoadedAudio(audioEl)) return '当前没有歌曲';
      if (typeof togglePlay !== 'function') return '播放器未就绪';
      void togglePlay();
      syncPlayingMirror();
      return '已切换播放/暂停';
    },
    next() {
      if (typeof nextSong !== 'function') return '播放器未就绪';
      void nextSong();
      return '已请求下一首';
    },
    adjustVolume(delta) {
      const audioEl = audioElement();
      if (!audioEl) return '无音频元素';
      const next = ZilyDeviceEvents.stepVolume(audioEl.volume, delta);
      audioEl.volume = next;
      if (audioEl.muted) audioEl.muted = false; // 旋转优先恢复声音
      return '音量 ' + Math.round(next * 100) + '%';
    }
  };

  deviceEvents = ZilyDeviceEvents.create({
    onLog: log,
    actions: deviceActions
  });

  // 0-8A Phase 3 补充：长歌名滚动。>4 字才滚动，只刷歌名区；≤4 字保持静态居中。
  const titleScroll = ZilyTitleScroll.create({
    display: oled,
    getTitle: () => document.getElementById('songTitle')?.textContent ?? '',
    isReady: () => readyPhase,
    onLog: log
  });

  // 06-audio.js 的 `analyser` 是全局 let（首次播放时创建）；这里只读，不修改音频链路。
  function analyserRef() {
    try {
      return typeof analyser === 'undefined' ? null : analyser;
    } catch {
      return null;
    }
  }

  // 连接就绪后自动跟随播放；断开或用户暂停跟随时停止观察器与频谱。
  function syncObserver() {
    if (!observer) return;
    const should = readyPhase && followEnabled;
    if (!readyPhase) testNote = ''; // 断开后不保留上一次测试屏结果
    if (should !== syncing) {
      syncing = should;
      if (should) {
        lastDisplay = null;
        testNote = '';
        observer.start();
        spectrum.start();
        titleScroll.start();
      } else {
        observer.stop();
        spectrum.stop();
        titleScroll.stop();
      }
    }
    refreshButtons();
    renderOledStatus();
  }

  resetState();
  renderOledStatus();

  async function send(action, result) {
    const generation = currentGeneration;
    try {
      await action();
      if (generation === currentGeneration) log(typeof result === 'function' ? result() : result);
    } catch (error) {
      if (generation !== currentGeneration) return;
      if (error.code === 'timeout') resetState();
      if (crc.textContent === '等待回复') crc.textContent = '未收到可校验的回复';
      if (seq.textContent.startsWith('等待')) seq.textContent = '未匹配';
      log(error.message);
    }
  }

  function sendCommand(command, payload, label) {
    let detail = '';
    return send(async () => {
      const frame = await withBusyRetry(() =>
        bridge.request(command, app.type.ACK, payload, app.validateAck(command)));
      detail = applyAck(command, app.parseState(frame));
    }, () => label + ' · ACK OK' + (detail ? ' · ' + detail : ''));
  }

  connect.addEventListener('click', () => { void bridge.connect(); });
  restore.addEventListener('click', () => { void bridge.restore(); });
  disconnect.addEventListener('click', () => { void bridge.disconnect(); });
  ping.addEventListener('click', () => {
    void send(() => withBusyRetry(() => bridge.ping()), 'PING/PONG 往返通过。');
  });
  echo.addEventListener('click', () => {
    void send(() => withBusyRetry(() => bridge.echo(echoBytes)),
      'ECHO 逐字节一致 · ' + ZilyWebSerial.hexBytes(echoBytes));
  });
  pause.addEventListener('click', () => {
    void sendCommand(app.type.PAUSE, new Uint8Array(), 'PAUSE');
  });
  resume.addEventListener('click', () => {
    void sendCommand(app.type.RESUME, new Uint8Array(), 'RESUME');
  });
  next.addEventListener('click', () => {
    void sendCommand(app.type.NEXT, new Uint8Array(), 'NEXT');
  });
  favoriteOn.addEventListener('click', () => {
    void sendCommand(app.type.FAVORITE, Uint8Array.of(1), 'FAVORITE=1');
  });
  favoriteOff.addEventListener('click', () => {
    void sendCommand(app.type.FAVORITE, Uint8Array.of(0), 'FAVORITE=0');
  });
  oledTest.addEventListener('click', () => {
    // 静态测试屏要能停留在屏幕上：先暂停跟随播放，否则 1 s 内会被进度更新覆盖。
    if (syncing) {
      followEnabled = false;
      syncObserver();
      log('已暂停跟随播放，静态测试屏将保持显示；点「恢复跟随」回到播放状态。');
    }
    testNote = '正在发送测试屏…';
    renderOledStatus();
    oled.showTestScreen().then(() => {
      testNote = '测试屏已发送（全屏 1024 B）';
      renderOledStatus();
      log('OLED 测试屏发送成功 · 全屏 1024 B · 5 片。');
    }).catch(error => {
      testNote = error?.message || 'OLED 测试屏发送失败。';
      renderOledStatus();
    });
  });
  oledFollow.addEventListener('click', () => {
    followEnabled = !followEnabled;
    if (followEnabled) testNote = '';
    syncObserver();
    log(followEnabled ? '已恢复跟随播放。' : '已暂停跟随播放（OLED 保持当前画面）。');
  });
})();