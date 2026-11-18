const dailyStorageKey = 'zily.dailyRadio';
const dailyList = document.getElementById('dailyRecommendations');
const dailyEmpty = document.getElementById('dailyRecommendationsEmpty');
const dailyStatus = document.getElementById('dailyRecommendationStatus');
const moodSelect = document.getElementById('dailyMood');
const moodStatus = document.getElementById('dailyMoodStatus');
const clearMoodButton = document.getElementById('clearDailyMood');
const moods = new Set(Array.from(moodSelect.options, option => option.value));

function localDay() {
  const now = new Date();
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].join('-');
}

let dailyRadio = { day: localDay(), tracks: [], mood: '' };
try {
  const stored = JSON.parse(localStorage.getItem(dailyStorageKey));
  if (stored?.day === dailyRadio.day) {
    if (stored.version === 2 && Array.isArray(stored.tracks)) dailyRadio.tracks = stored.tracks.filter(track =>
      track && typeof track.id === 'string' && typeof track.name === 'string' && typeof track.artist === 'string'
    ).slice(0, 5);
    if (moods.has(stored.mood)) dailyRadio.mood = stored.mood;
  }
} catch {}

function refreshDailyDate() {
  const day = localDay();
  if (dailyRadio.day === day) return;
  dailyRadio = { day, tracks: [], mood: '' };
  renderDailyCards();
}

function saveDailyRadio() {
  try {
    localStorage.setItem(dailyStorageKey, JSON.stringify({ ...dailyRadio, version: 2 }));
    return true;
  } catch { return false; }
}

function renderDailyCards() {
  dailyEmpty.hidden = dailyRadio.tracks.length > 0;
  dailyStatus.hidden = true;
  dailyList.replaceChildren(...dailyRadio.tracks.map(track => {
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    const title = document.createElement('span');
    title.textContent = track.name + ' · ' + track.artist;
    const icon = document.createElement('span');
    icon.className = 'daily-play-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '▶';
    button.setAttribute('aria-label', '播放' + track.name + '，' + track.artist);
    button.append(title, icon);
    button.addEventListener('click', async () => {
      if (enqueueClickedTrack(track, dailyStatus, { showSuccess: false }) || loadingSong || recommendingNext) return;
      dailyStatus.hidden = false;
      dailyStatus.textContent = '正在获取音源…';
      try {
        const ready = await playOnlineMusic(track.name, track.artist, true, 0, track.id, track);
        dailyStatus.hidden = ready === true;
        if (!ready) dailyStatus.textContent = '暂时没能取得这首歌的音源，请稍后重试或检查网易云登录状态。';
      } catch { dailyStatus.textContent = '暂时无法播放，请稍后再试。'; }
    });
    row.append(button);
    return row;
  }));
  moodSelect.value = dailyRadio.mood;
  moodStatus.textContent = dailyRadio.mood ? '今天的心情：' + dailyRadio.mood : '今天还没有记录。';
  clearMoodButton.hidden = !dailyRadio.mood;
}

function recordDailyRecommendation(song) {
  refreshDailyDate();
  const track = { id: String(song.id), name: song.name, artist: song.artist, cover: song.cover };
  dailyRadio.tracks = [track, ...dailyRadio.tracks.filter(item => item.id !== track.id)].slice(0, 5);
  saveDailyRadio();
  renderDailyCards();
}

function setDailyMood(mood) {
  refreshDailyDate();
  dailyRadio.mood = mood;
  const saved = saveDailyRadio();
  renderDailyCards();
  if (!saved) moodStatus.textContent += ' 当前浏览器无法保存，刷新后会丢失。';
}
moodSelect.addEventListener('change', () => setDailyMood(moodSelect.value));
clearMoodButton.addEventListener('click', () => setDailyMood(''));
document.addEventListener('visibilitychange', refreshDailyDate);
setInterval(refreshDailyDate, 60_000);
renderDailyCards();
