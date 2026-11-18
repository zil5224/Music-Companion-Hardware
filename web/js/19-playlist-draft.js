'use strict';

const PLAYLIST_SEARCH_CONCURRENCY = 3;
const playlistSearchCache = new Map();
let currentPlaylistPreview = null;

function playlistRequest(text) {
  const input = text.normalize('NFKC').trim();
  if (/^(?:我)?(?:别|不要|不用|不想|不需要|暂时不|先不)/u.test(input)) return null;
  const explicitlyPlaylist = /歌单|playlist/iu.test(input) &&
    /安排|生成|做|组|编|整理|来[一个份张]|给我|推荐|定制|想要|make|create|build/iu.test(input);
  const match = input.match(/(?:共|安排|生成|做|来|给我|推荐|要|控制在)\s*(\d+|[零〇一二两三四五六七八九十百]+)\s*首/u) ||
    input.match(/(?<![前后第])(\d+|[零〇一二两三四五六七八九十百]+)\s*首/u);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const number = match?.[1];
  let count = 6;
  if (number) {
    if (/^\d+$/u.test(number)) count = Number(number);
    else if (number.includes('百')) count = 12;
    else if (number.includes('十')) {
      const [tens, ones] = number.split('十');
      count = (digits[tens] || 1) * 10 + (digits[ones] || 0);
    } else count = digits[number] ?? 6;
  }
  const stagedMusic = /歌曲|听歌|音乐|钢琴曲|华语歌|的歌/u.test(input) &&
    (/(?:前面|前半|开场|前段)[\s\S]*(?:后面|后半|收尾|后段)/u.test(input) ||
      (number && count > 3 && /安排|给我|推荐|整理/u.test(input)));
  if (!explicitlyPlaylist && !stagedMusic) return null;
  const repeat = !/(?:不要|不许|不准|不希望|别|避免|禁止)重复/u.test(input) &&
    /允许重复|可以重复|重复播放|重复加入|重复两次|同一首.{0,12}(?:两次|多次)/u.test(input);
  return { type: 'playlist_draft', count: Math.max(1, Math.min(12, count)), repeat };
}

function parsePlaylistDraft(raw, count) {
  const value = parseMusicEnvelope(raw);
  if (!exactMusicKeys(value, ['action', 'name', 'description', 'scene', 'mood', 'count', 'tracks']) ||
      value.action !== 'playlist_draft' || !Number.isInteger(value.count) ||
      value.count < 1 || value.count > 12 || value.count !== count ||
      !musicField(value.name, 60) || !musicField(value.description, 180) ||
      !musicField(value.scene, 60) || !musicField(value.mood, 60) ||
      !Array.isArray(value.tracks) || value.tracks.length !== value.count ||
      !value.tracks.every(track => exactMusicKeys(track, ['song', 'artist', 'phase', 'reason']) &&
        musicField(track.song) && musicField(track.artist) && musicField(track.phase, 40) &&
        musicField(track.reason, 160))) return null;
  return value;
}

function playlistOptions(matches) {
  const versions = new Map();
  for (const track of matches) {
    // Collapse identical catalog records with the same album credit.
    const key = JSON.stringify([musicKey(track.song), musicKey(track.artist), musicKey(track.album || ''), track.durationMs || null]);
    if (!versions.has(key)) versions.set(key, track);
  }
  return [...versions.values()];
}

async function verifyPlaylistDraft(draft, intent, signal, lookup = verifyMusicTrack, cache = playlistSearchCache) {
  const entries = new Array(draft.tracks.length);
  const inFlight = new Map();
  let index = 0;
  const resolveTrack = track => {
    const key = JSON.stringify([musicKey(track.song), musicKey(track.artist)]);
    const cached = cache.get(key);
    if (cached && Date.now() - cached.checkedAt < 5 * 60_000) return Promise.resolve(cached.options);
    if (!inFlight.has(key)) {
      const request = Promise.resolve().then(() => lookup(track.song, track.artist, signal, { keepVersions: true }))
        .then(matches => {
          signal?.throwIfAborted();
          const options = playlistOptions(matches);
          if (options.length) {
            if (cache.size >= 60) cache.delete(cache.keys().next().value);
            cache.set(key, { checkedAt: Date.now(), options });
          }
          return options;
        });
      inFlight.set(key, request);
    }
    return inFlight.get(key);
  };
  async function verifyNext() {
    while (index < draft.tracks.length) {
      signal?.throwIfAborted();
      const position = index++;
      const suggestion = draft.tracks[position];
      try {
        const options = await resolveTrack(suggestion);
        entries[position] = { suggestion, options, track: options.length === 1 ? options[0] : null,
          status: options.length === 1 ? 'verified' : options.length ? 'ambiguous' : 'missing' };
      } catch {
        signal?.throwIfAborted();
        entries[position] = { suggestion, options: [], track: null, status: 'unavailable' };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PLAYLIST_SEARCH_CONCURRENCY, entries.length) }, verifyNext));
  signal?.throwIfAborted();
  return { name: draft.name, description: draft.description, scene: draft.scene, mood: draft.mood,
    count: draft.count, repeat: intent.repeat, entries };
}

function playlistRows(draft) {
  const ids = new Set();
  return draft.entries.map(entry => {
    if (!entry.track || draft.repeat) return entry;
    if (ids.has(entry.track.id)) return { ...entry, status: 'duplicate' };
    ids.add(entry.track.id);
    return entry;
  });
}

function clearPlaylistPreview() {
  currentPlaylistPreview?.card.remove();
  currentPlaylistPreview = null;
}

function renderPlaylistPreview(container, draft, requestText, reference) {
  clearPlaylistPreview();
  const target = container.querySelector('.msg-ai');
  if (!target) return;
  const card = document.createElement('section');
  card.className = 'playlist-preview';
  const preview = { card, draft };
  currentPlaylistPreview = preview;
  const list = document.createElement('ol');
  const feedback = document.createElement('p');
  feedback.setAttribute('role', 'status');
  const title = document.createElement('h3');
  title.textContent = draft.name;
  const description = document.createElement('p');
  description.textContent = draft.description;
  const context = document.createElement('small');
  context.textContent = draft.scene + ' · ' + draft.mood;
  const controls = document.createElement('div');
  let playingDraft = false;
  controls.className = 'queue-actions';
  const available = () => playlistRows(draft).filter(row => row.status === 'verified').map(row => row.track);
  const append = queueButton('全部加入队列', () => {
    if (currentPlaylistPreview !== preview) return;
    const count = playbackQueue.addMany(available());
    feedback.textContent = '已加入 ' + count + ' 首。';
  });
  const play = queueButton('播放这份歌单', async () => {
    if (currentPlaylistPreview !== preview || playingDraft || play.disabled) return;
    playingDraft = play.disabled = true;
    feedback.textContent = '正在把歌单送入播放队列…';
    try {
      const started = await playbackQueue.playTracks(available());
      if (currentPlaylistPreview === preview) {
        feedback.textContent = started ? playbackQueue.message : '播放器正在切歌，请稍后再试。';
      }
    } finally {
      playingDraft = false;
      if (currentPlaylistPreview === preview) play.disabled = !available().length;
    }
  });
  const regenerate = queueButton('重新生成', () => {
    if (currentPlaylistPreview === preview) void sendMessage(false, requestText, reference);
  });
  controls.append(append, play, regenerate);
  let save;
  let saving = false;
  let saved = false;
  if (typeof playlistLibrary !== 'undefined') {
    const draftId = crypto.randomUUID();
    save = queueButton('保存到我的歌单', async () => {
      if (currentPlaylistPreview !== preview || saving || saved || !available().length) return;
      saving = save.disabled = true;
      try {
        await playlistLibrary.create(playlistDraftSnapshot(draft), draftId);
        saved = true;
        save.textContent = '已保存到我的歌单';
        feedback.textContent = '已保存已核验的曲目。';
      } catch (error) {
        feedback.textContent = error.message;
      } finally {
        saving = false;
        save.disabled = saved || !available().length;
      }
    });
    controls.prepend(save);
  }
  card.append(title, description, context, list, controls, feedback);
  target.append(card);

  function render() {
    const rows = playlistRows(draft);
    const playable = available().length;
    append.disabled = !playable;
    if (save) save.disabled = saving || saved || !playable;
    play.disabled = playingDraft || !playable;
    feedback.textContent = '已核验 ' + playable + ' 首可加入队列，共 ' + rows.length + ' 项。';
    list.replaceChildren(...rows.map((row, index) => {
      const entry = draft.entries[index];
      const li = document.createElement('li');
      li.className = 'queue-entry';
      if (/^https?:\/\//iu.test(row.track?.cover || '')) {
        const cover = document.createElement('img');
        cover.src = row.track.cover;
        cover.loading = 'lazy';
        cover.referrerPolicy = 'no-referrer';
        cover.alt = '';
        li.append(cover);
      } else {
        const placeholder = document.createElement('span');
        placeholder.className = 'queue-cover-placeholder';
        placeholder.setAttribute('aria-hidden', 'true');
        placeholder.textContent = '♫';
        li.append(placeholder);
      }
      const song = document.createElement('p');
      song.textContent = (index + 1) + '. 《' + (row.track?.song || row.suggestion.song) + '》· ' + (row.track?.artist || row.suggestion.artist);
      const detail = document.createElement('small');
      const labels = { verified: '已核验', ambiguous: '待选择版本', missing: '找不到匹配歌曲', unavailable: '曲库请求失败', duplicate: '与前项重复' };
      detail.textContent = row.suggestion.phase + ' · ' + labels[row.status] + ' · ' + row.suggestion.reason;
      li.append(song, detail);
      if (row.options.length > 1) {
        const select = document.createElement('select');
        select.setAttribute('aria-label', '选择《' + row.suggestion.song + '》的版本');
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = '选择曲库版本';
        select.append(blank);
        for (const option of row.options) {
          const element = document.createElement('option');
          element.value = option.id;
          element.textContent = option.artist + ' · ' + (option.album || '曲库版本 ' + option.id) +
            (option.durationMs ? ' · ' + Math.round(option.durationMs / 1000) + ' 秒' : '');
          select.append(element);
        }
        select.value = row.track?.id || '';
        select.addEventListener('change', () => {
          entry.track = entry.options.find(option => option.id === select.value) || null;
          entry.status = entry.track ? 'verified' : 'ambiguous';
          render();
        });
        li.append(select);
      }
      const actions = document.createElement('div');
      actions.className = 'queue-actions';
      if (row.status === 'verified') {
        actions.append(queueButton('加入队列', () => {
          if (currentPlaylistPreview === preview) addQueueTrack(row.track, feedback);
        }));
      }
      actions.append(queueButton('删除', () => {
        if (currentPlaylistPreview !== preview) return;
        draft.entries.splice(index, 1);
        render();
      }, { label: '从歌单删除《' + row.suggestion.song + '》' }));
      li.append(actions);
      return li;
    }));
  }
  render();
}
