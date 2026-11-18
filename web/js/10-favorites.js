// ═══════════════════════════════════════════════════════════════
//  本地红心收藏夹（LocalStorage · 刷新/重启不丢失）
// ═══════════════════════════════════════════════════════════════
const FAV_KEY = 'healed_songs';
const favoriteLockName = FAV_KEY;
let favSongs = [];
const btnHeart = document.getElementById('btnHeart');
const favDrawer = document.getElementById('favDrawer');
const favList = document.getElementById('favList');
const favoriteStatus = document.getElementById('favoritePlaybackStatus');
const favoriteWriteStatus = document.getElementById('favoriteWriteStatus');

function validFavorite(song) {
  return song && (typeof song.id === 'string' || Number.isSafeInteger(song.id)) &&
    /^[1-9]\d{0,19}$/.test(String(song.id)) &&
    typeof song.name === 'string' && song.name.trim() &&
    typeof song.artist === 'string' && song.artist.trim() &&
    (song.cover === undefined || typeof song.cover === 'string') &&
    (song.searchKeyword === undefined || typeof song.searchKeyword === 'string');
}

function readFavorites() {
  const raw = localStorage.getItem(FAV_KEY);
  if (raw === null) return [];
  let songs;
  try { songs = JSON.parse(raw); } catch {}
  if (!Array.isArray(songs) || !songs.every(validFavorite)) {
    throw new Error('收藏数据损坏，已保留原记录。');
  }
  const ids = new Set();
  return songs.filter(song => {
    const id = String(song.id);
    if (ids.has(id)) return false;
    ids.add(id);
    return true;
  });
}

function showFavoriteWriteStatus(message = '') {
  favoriteWriteStatus.textContent = message;
  favoriteWriteStatus.hidden = !message;
}

function applyFavorites(songs) {
  favSongs = songs;
  renderFavoritesList();
  updateHeartIcon();
}

function loadFavorites() {
  try {
    applyFavorites(readFavorites());
    showFavoriteWriteStatus();
  } catch (error) {
    showFavoriteWriteStatus(error.message || '浏览器无法读取收藏。');
  }
}

function isFavorited(songId) {
  return favSongs.some(song => String(song.id) === String(songId));
}

async function toggleFavorite(desired) {
  if (!currentSong) return false;
  const { id, name, artist, cover, searchKeyword } = currentSong;
  // Capture what the visible button meant. Concurrent adds must not toggle a song off.
  const adding = desired ?? !isFavorited(id);
  const track = { id, name, artist, cover, searchKeyword: searchKeyword || name };
  try {
    if (adding && !validFavorite(track)) throw new Error('曲目信息不完整，无法收藏。');
    return await ZilyStorage.withWrite(favoriteLockName, () => {
      const songs = readFavorites();
      const exists = songs.some(song => String(song.id) === String(id));
      if (exists !== adding) {
        const next = adding ? [...songs, track] : songs.filter(song => String(song.id) !== String(id));
        localStorage.setItem(FAV_KEY, JSON.stringify(next));
        applyFavorites(next);
        if (adding) triggerBearBoost();
      } else {
        applyFavorites(songs);
      }
      showFavoriteWriteStatus();
      return true;
    });
  } catch (error) {
    showFavoriteWriteStatus(error.name === 'QuotaExceededError'
      ? '收藏更改未保存，浏览器存储空间不足。'
      : '收藏更改未保存。' + (error.message || '浏览器存储不可用。'));
    return false;
  }
}

globalThis.addEventListener?.('storage', event => {
  if (event.key === FAV_KEY || event.key === null) loadFavorites();
});

function updateHeartIcon(){
  const loved = Boolean(currentSong && isFavorited(currentSong.id));
  const label = loved ? '取消收藏' : '收藏歌曲';
  btnHeart.classList.toggle('loved', loved);
  btnHeart.setAttribute('aria-pressed', String(loved));
  btnHeart.setAttribute('aria-label', label);
  btnHeart.title = label;
}

function toggleFavDrawer(){
  favoriteStatus.hidden = true;
  favDrawer.togglePopover();
}

function renderFavoritesList(){
  if(favSongs.length === 0){
    favList.innerHTML = '<div class="text-[11px] text-gray-600 font-tech py-3 text-center tracking-wider">还没有收藏歌曲，点击播放器的爱心收藏歌曲</div>';
    return;
  }
  favList.innerHTML = favSongs.map((s, i) => `
    <div class="queue-source-row">
    <button type="button" class="fav-item flex items-center gap-3 px-2 py-2.5" onclick="playFavorite(${i})" title="点击播放：${escHTML(s.name)} — ${escHTML(s.artist)}">
      <span style="font-size:12px">❤️</span>
      <div class="flex-1 min-w-0">
        <p class="text-xs text-gray-200 truncate font-tech tracking-wider">${escHTML(s.name)}</p>
        <p class="text-[10px] text-gray-500 truncate">${escHTML(s.artist)}</p>
      </div>
      <span class="text-[10px] text-gray-600 font-tech" aria-hidden="true">▶</span>
    </button>
    <button type="button" class="mood-chip" onclick="addQueueTrack(favSongs[${i}], document.getElementById('queueFavoriteStatus'))" aria-label="把${escHTML(s.name)}加入队列">加入队列</button>
    </div>
  `).join('');
}

async function playFavorite(index){
  const song = favSongs[index];
  if(!song || enqueueClickedTrack(song, favoriteStatus)) return;
  if (loadingSong || recommendingNext) return;
  favoriteStatus.hidden = false;
  favoriteStatus.textContent = '正在获取音源…';
  try {
    audio.volume = 1.0;
    const loaded = await playOnlineMusic(song.name, song.artist, true, 0, String(song.id));
    if (loaded) {
      favoriteStatus.hidden = true;
      if (favDrawer.matches(':popover-open')) favDrawer.hidePopover();
    } else {
      favoriteStatus.textContent = '这首歌暂时没有可用音源，可以检查网易云登录状态后再试。';
    }
  } catch {
    favoriteStatus.textContent = '暂时无法播放，请稍后再试。';
  }
}

// ═══════════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════════
setPlaying(false); resizeVis(); startBearAnim(); loadFavorites(); updateLoginStatusUI();
