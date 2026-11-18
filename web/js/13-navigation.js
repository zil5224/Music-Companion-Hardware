{
  const nav = document.getElementById('stationNav');
  const toggle = document.getElementById('navToggle');
  const key = 'zily.navigationCollapsed';

  function showCollapsed(collapsed) {
    nav.classList.toggle('is-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? '展开导航' : '收起导航');
  }

  function readCollapsed() {
    return JSON.parse(localStorage.getItem(key)) === true;
  }
  const saveStatus = document.getElementById('navigationSaveStatus');
  try { showCollapsed(readCollapsed()); } catch {}
  toggle.addEventListener('click', async () => {
    const collapsed = !nav.classList.contains('is-collapsed');
    try {
      await ZilyStorage.withWrite(ZilyStorage.preferencesLockName, () => {
        localStorage.setItem(key, String(collapsed));
        showCollapsed(collapsed);
        saveStatus.hidden = true;
      });
    } catch (error) {
      saveStatus.textContent = '导航设置未保存。' + (error.message || '');
      saveStatus.hidden = false;
    }
  });
  globalThis.addEventListener?.('storage', event => {
    if (event.key === key || event.key === null) {
      try { showCollapsed(readCollapsed()); } catch {}
    }
  });

  const panel = document.getElementById('recentPlaybackList');
  const list = document.getElementById('recentPlaybackItems');
  const empty = document.getElementById('recentPlaybackEmpty');
  const historyKey = 'zily.recentTracks';
  const status = document.getElementById('recentPlaybackStatus');
  let recent = [];
  try {
    const stored = JSON.parse(localStorage.getItem(historyKey));
    if (Array.isArray(stored)) recent = stored.filter(track => track &&
      typeof track.id === 'string' && typeof track.name === 'string' && typeof track.artist === 'string').slice(0, 30);
  } catch {}

  function recordPlayedTrack() {
    if (!currentSong?.id) return;
    const { id, name, artist } = currentSong;
    const track = { id: String(id), name, artist };
    recent = [track, ...recent.filter(item => item.id !== track.id)].slice(0, 30);
    try { localStorage.setItem(historyKey, JSON.stringify(recent)); } catch {}
    if (panel.matches(':popover-open')) renderHistory();
  }

  let replaying = false;
  async function replayTrack(track) {
    if (enqueueClickedTrack(track, status)) return;
    if (replaying || loadingSong || recommendingNext) {
      status.textContent = '正在切歌，请稍后再试。';
      return;
    }
    replaying = true;
    status.textContent = '正在查找「' + track.name + '」的音源…';
    try {
      const loaded = await playOnlineMusic(track.name, track.artist, true, 0, track.id);
      if (loaded) panel.hidePopover();
      status.textContent = loaded ? '' : '这首歌暂时没有可用音源，可以检查网易云登录状态后再试。';
    } catch {
      status.textContent = '暂时无法播放，请稍后再试。';
    } finally {
      replaying = false;
    }
  }

  function renderHistory() {
    empty.hidden = recent.length > 0;
    const rows = recent.map(track => {
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = track.name + ' · ' + track.artist;
      if (track.id === String(currentSong?.id)) {
        button.setAttribute('aria-current', 'true');
        button.textContent += '（当前曲目）';
      }
      button.addEventListener('click', () => void replayTrack(track));
      const entry = document.createElement('div');
      entry.className = 'queue-source-row';
      entry.append(button, queueButton('加入队列', () => {
        const cached = playHistory.find(song => String(song.id) === track.id);
        addQueueTrack({ ...track, cover: cached?.cover }, document.getElementById('queueRecentStatus'));
      }, { label: '把《' + track.name + '》加入队列' }));
      row.append(entry);
      return row;
    });
    list.replaceChildren(...rows);
  }
  panel.addEventListener('beforetoggle', event => {
    if (event.newState === 'open') {
      status.textContent = '';
      document.getElementById('queueRecentStatus').textContent = '';
      renderHistory();
    }
  });
  audio.addEventListener('playing', recordPlayedTrack);
}
