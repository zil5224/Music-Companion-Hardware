const preferenceKey = 'zily.companionPreferences';
const companionDefaults = { duration: 25, length: 'short', suggestMusic: false };
function readCompanionPreferences() {
  const saved = JSON.parse(localStorage.getItem(preferenceKey)) || {};
  return { duration: [25, 50].includes(saved.duration) ? saved.duration : companionDefaults.duration,
    length: saved.length === 'long' ? 'long' : companionDefaults.length, suggestMusic: saved.suggestMusic === true };
}
let companionPreferences = { ...companionDefaults };
try { companionPreferences = readCompanionPreferences(); } catch {}
let companionMode = 'listen';

{
  const element = id => document.getElementById(id);
  const duration = element('focusDuration');
  const length = element('replyLength');
  const suggestions = element('musicSuggestions');
  const focusPanel = element('focusPanel');
  const complete = element('focusComplete');
  const startButton = element('startFocus');
  const cancelButton = element('cancelFocus');
  const toggleChat = element('toggleFocusChat');
  toggleChat.onclick = () => {
    const expanded = document.body.classList.toggle('focus-chat-open');
    toggleChat.textContent = expanded ? '收起聊天' : '展开聊天';
    toggleChat.setAttribute('aria-expanded', String(expanded));
  };
  const clock = element('focusTime');
  const focusKey = 'zily.focusSession';
  const goal = element('focusGoal');
  const pauseButton = element('pauseFocus');
  let remaining = 0;
  let deadline = 0;
  let sessionDuration = 0;

  function persistFocus() {
    try {
      if (!sessionDuration) localStorage.removeItem(focusKey);
      else localStorage.setItem(focusKey, JSON.stringify({ deadline, remaining, duration: sessionDuration, goal: goal.value }));
    } catch {}
  }
  let timer = null;

  function syncPreferences() {
    duration.value = String(companionPreferences.duration);
    length.value = companionPreferences.length;
    suggestions.checked = companionPreferences.suggestMusic;
    if (!sessionDuration && complete.hidden) showTime(companionPreferences.duration * 60);
  }
  function preferencesStatus(message = '') {
    const status = element('preferenceWriteStatus');
    status.textContent = message;
    status.hidden = !message;
  }
  async function writePreferences(change) {
    try {
      await ZilyStorage.withWrite(ZilyStorage.preferencesLockName, () => {
        companionPreferences = change();
        preferencesStatus();
      });
    } catch (error) { preferencesStatus('偏好未保存。' + (error.message || '')); }
    syncPreferences();
  }
  function savePreference(key, value) {
    return writePreferences(() => {
      const next = { ...readCompanionPreferences(), [key]: value };
      localStorage.setItem(preferenceKey, JSON.stringify(next));
      return next;
    });
  }
  function showTime(seconds) {
    clock.textContent = [Math.floor(seconds / 60), seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
  }
  function stopFocus(finished = false) {
    document.body.classList.remove('focus-view', 'focus-chat-open');
    toggleChat.hidden = true;
    toggleChat.textContent = '展开聊天';
    toggleChat.setAttribute('aria-expanded', 'false');
    clearInterval(timer);
    timer = null;
    if (finished) {
      element('focusSummary').textContent = '完成 ' + sessionDuration + ' 分钟专注' + (goal.value.trim() ? ' · ' + goal.value.trim() : '') + '。';
    }
    deadline = 0;
    remaining = 0;
    sessionDuration = 0;
    pauseButton.hidden = true;
    goal.disabled = false;
    persistFocus();
    duration.disabled = false;
    startButton.hidden = finished;
    cancelButton.hidden = true;
    complete.hidden = !finished;
    showTime(finished ? 0 : companionPreferences.duration * 60);
  }
  function tick() {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    showTime(left);
    if (!left) {
      stopFocus(true);
      focusPanel.hidden = false;
      element('openFocus').setAttribute('aria-expanded', 'true');
    }
  }
  function showActiveFocus() {
    document.body.classList.add('focus-view');
    focusPanel.hidden = false;
    toggleChat.hidden = false;
    complete.hidden = true;
    startButton.hidden = true;
    cancelButton.hidden = false;
    pauseButton.hidden = false;
    pauseButton.textContent = deadline ? '暂停' : '继续';
    duration.disabled = true;
    duration.value = String(sessionDuration);
    goal.disabled = true;
    if (deadline) {
      timer = setInterval(tick, 250);
      tick();
    } else showTime(Math.ceil(remaining / 1000));
  }
  function startFocus() {
    if (sessionDuration) return;
    sessionDuration = companionPreferences.duration;
    deadline = Date.now() + sessionDuration * 60_000;
    persistFocus();
    showActiveFocus();
  }
  pauseButton.onclick = () => {
    if (deadline) {
      if (deadline <= Date.now()) { tick(); return; }
      remaining = deadline - Date.now();
      deadline = 0;
      clearInterval(timer);
    } else {
      deadline = Date.now() + remaining;
      remaining = 0;
    }
    persistFocus();
    showActiveFocus();
  };
  const stationModes = document.querySelectorAll('[name="stationMode"]');
  function selectCompanion(mode) {
    companionMode = mode;
    for (const radio of stationModes) radio.checked = radio.value === mode;
  }
  function openWorkMode() {
    focusPanel.hidden = false;
    element('openFocus').setAttribute('aria-expanded', 'true');
    for (const radio of stationModes) radio.checked = radio.value === 'work';
  }
  for (const radio of stationModes) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      if (radio.value === 'work') openWorkMode();
      else {
        selectCompanion(radio.value);
        if (!sessionDuration) {
          focusPanel.hidden = true;
          element('openFocus').setAttribute('aria-expanded', 'false');
        }
      }
    });
  }
  element('openTalk').onclick = () => chatInput.focus();
  element('requestMusic').onclick = () => {
    if (chatPending) return;
    sendMessage(true);
  };
  element('openFocus').onclick = () => {
    if (focusPanel.hidden) openWorkMode();
    else {
      focusPanel.hidden = true;
      element('openFocus').setAttribute('aria-expanded', 'false');
      selectCompanion(companionMode);
    }
  };
  startButton.onclick = startFocus;
  cancelButton.onclick = () => stopFocus();
  element('continueFocus').onclick = startFocus;
  element('restFocus').onclick = () => stopFocus();
  element('talkAfterFocus').onclick = () => { stopFocus(); chatInput.focus(); };
  duration.addEventListener('change', () => savePreference('duration', Number(duration.value)));
  length.addEventListener('change', () => savePreference('length', length.value));
  suggestions.addEventListener('change', () => savePreference('suggestMusic', suggestions.checked));
  element('resetPreferences').onclick = () => writePreferences(() => {
    localStorage.removeItem(preferenceKey);
    return { ...companionDefaults };
  });
  globalThis.addEventListener?.('storage', event => {
    if (event.key !== preferenceKey && event.key !== null) return;
    try { companionPreferences = readCompanionPreferences(); syncPreferences(); }
    catch { preferencesStatus('浏览器无法读取陪伴偏好。'); }
  });
  syncPreferences();
  try {
    const saved = JSON.parse(localStorage.getItem(focusKey));
    if (saved && [25, 50].includes(saved.duration) &&
        ((Number.isFinite(saved.deadline) && saved.deadline > 0) ||
        (Number.isFinite(saved.remaining) && saved.remaining > 0))) {
      deadline = saved.deadline || 0;
      remaining = saved.remaining || 0;
      sessionDuration = saved.duration;
      goal.value = typeof saved.goal === 'string' ? saved.goal.slice(0, 100) : '';
      openWorkMode();
      showActiveFocus();
    }
  } catch {}
}
