'use strict';

const PLAYLIST_LIBRARY_KEY = 'zily.playlists.v1';
const PLAYLIST_TRACK_LIMIT = 200;

function playlistText(value, limit, required = false) {
  if (typeof value !== 'string' || value.trim().length > limit || (required && !value.trim())) {
    throw new Error('请检查歌单字段是否为空或过长。');
  }
  return value.trim();
}

function playlistCover(value) {
  if (typeof value !== 'string' || !value || value.length > 1000) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

function playlistStoredTrack(track) {
  if (!track || track.provider !== 'netease' || typeof track.id !== 'string' || !/^[1-9]\d{0,19}$/u.test(track.id)) {
    throw new Error('只能添加已核验的网易云歌曲。');
  }
  return { provider: 'netease', id: track.id, title: playlistText(track.title, 100, true),
    artist: playlistText(track.artist, 100, true), coverUrl: playlistCover(track.coverUrl),
    phase: playlistText(track.phase ?? '', 40), reason: playlistText(track.reason ?? '', 160) };
}

function playlistCatalogTrack(track, suggestion = {}) {
  return playlistStoredTrack({ provider: 'netease', id: track.id, title: track.song, artist: track.artist,
    coverUrl: track.cover, phase: suggestion.phase, reason: suggestion.reason });
}

function playlistDraftSnapshot(draft) {
  return { name: draft.name, description: draft.description, categoryId: null,
    tracks: playlistRows(draft).filter(row => row.status === 'verified')
      .map(row => playlistCatalogTrack(row.track, row.suggestion)) };
}

function playlistQueueTracks(tracks) {
  return tracks.map(({ id, title, artist, coverUrl }) => ({ id, song: title, artist, cover: coverUrl }));
}

function playlistReference(playlist) {
  const { name, description, tracks } = playlist;
  const selected = tracks.length <= 12 ? tracks : Array.from({ length: 12 }, (_, i) =>
    tracks[Math.round(i * (tracks.length - 1) / 11)]);
  return { name, description, tracks: selected.map(({ title, artist, phase }) => ({ song: title, artist, phase })) };
}

function playlistReferenceIntent(text, readLibrary) {
  const command = text.trim().replace(/^(?:请|帮我|给我|麻烦你)\s*/u, '');
  if (/^(?:我)?(?:别|不要|不用|不想|不需要|暂时不|先不)/u.test(command)) return null;
  if (!/生成|重新做|换一批|再做|再来|做一份|安排|组一份|推荐/u.test(command)) return null;
  const match = command.match(/(?:参照|参考|按照|根据|按(?!排))\s*(?:(我(?:已有|已保存|保存)的|我的|(?:已保存|已有)的?)\s*)?(?:(歌单)\s*)?(?:《([^》]+)》|「([^」]+)」|“([^”]+)”|([^，。！？,!?]+))/u);
  if (!match) return null;
  const quoted = match[3] || match[4] || match[5];
  const subject = (quoted || match[6]).trim();
  const tail = command.slice(match.index + match[0].length);
  const namedLibrary = Boolean(match[2] || (match[1] && (quoted || /歌单/u.test(subject))) ||
    /^\s*(?:这份)?歌单/u.test(tail) || /^(?:这|那|某)(?:一)?(?:份|张|个)?歌单/u.test(subject));
  if (!namedLibrary && !/歌单/u.test(command)) return null;
  if (!subject || /^(?:这|那|某)(?:一)?(?:份|张|个)?(?:歌单|一份歌单)?(?:的.*)?$/u.test(subject)) {
    return { error: '请在「我的歌单」打开要参考的歌单，点击「参考这份歌单生成」，或在聊天中写出歌单名称。' };
  }
  let candidates;
  try {
    candidates = readLibrary().playlists.filter(playlist => quoted
      ? namedLibrary && playlist.name === subject
      : subject === playlist.name + '歌单' ||
        (namedLibrary && (subject === playlist.name ||
          ['歌单', '的歌单', '的情绪', '的风格', '的音乐', '再生成', '重新生成', '生成', '换一批'].some(
            suffix => subject.startsWith(playlist.name + suffix)))));
  } catch (error) {
    return namedLibrary ? { error: error.message } : null;
  }
  if (!candidates.length && !namedLibrary) return null;
  if (candidates.length !== 1) {
    return { error: candidates.length ? '有多份同名或名称相近的歌单，请从「我的歌单」打开指定歌单后生成。'
      : '没有找到指定的本地歌单，请检查名称，或从「我的歌单」打开后生成。' };
  }
  return { reference: playlistReference(candidates[0]) };
}

function createPlaylistLibrary(storage, lock, makeId = () => crypto.randomUUID(), now = () => new Date().toISOString()) {
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
  const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
  const revision = value => Number.isSafeInteger(value) && value >= 1;
  const categoryKey = name => name.trim().toLowerCase();
  const conflict = () => Object.assign(new Error('这项内容已在其他操作中更新，请检查最新版本。'), { code: 'revision_conflict' });

  function read() {
    let raw;
    try { raw = storage.getItem(PLAYLIST_LIBRARY_KEY); }
    catch { throw new Error('浏览器无法读取本地歌单。'); }
    if (raw === null) return { schemaVersion: 1, playlists: [], categories: [] };
    try {
      const data = JSON.parse(raw);
      if (data?.schemaVersion !== 1 || !Array.isArray(data.playlists) || !Array.isArray(data.categories)) throw Error();
      const categoryIds = new Set();
      const names = new Set();
      for (const category of data.categories) {
        const name = playlistText(category.name, 60, true);
        if (typeof category.id !== 'string' || !uuid.test(category.id) || !revision(category.revision) ||
            categoryIds.has(category.id) || names.has(categoryKey(name))) throw Error();
        categoryIds.add(category.id);
        names.add(categoryKey(name));
      }
      const ids = new Set();
      for (const playlist of data.playlists) {
        if (typeof playlist.id !== 'string' || !uuid.test(playlist.id) || ids.has(playlist.id) ||
            !revision(playlist.revision) || !stamp(playlist.createdAt) || !stamp(playlist.updatedAt) ||
            (playlist.categoryId !== null && !categoryIds.has(playlist.categoryId))) throw Error();
        ids.add(playlist.id);
        playlistText(playlist.name, 60, true);
        playlistText(playlist.description, 500);
        if (!Array.isArray(playlist.tracks) || playlist.tracks.length > PLAYLIST_TRACK_LIMIT) throw Error();
        for (const track of playlist.tracks) {
          const checked = playlistStoredTrack(track);
          if (track.coverUrl !== checked.coverUrl || typeof track.phase !== 'string' || typeof track.reason !== 'string' ||
              Object.keys(track).some(key => !Object.hasOwn(checked, key))) throw Error();
        }
      }
      return data;
    } catch {
      throw new Error('本地歌单数据损坏或版本不支持，已保留原数据。');
    }
  }

  async function write(change) {
    if (!lock) throw new Error('当前浏览器无法安全写入歌单，请使用支持 Web Locks 的浏览器。');
    return lock(PLAYLIST_LIBRARY_KEY, () => {
      const data = read();
      const result = change(data);
      if (result === null) return null;
      try { storage.setItem(PLAYLIST_LIBRARY_KEY, JSON.stringify(data)); }
      catch { throw new Error('本地歌单未能保存，原有数据已保留。'); }
      return result;
    });
  }

  function dataFor(input, data) {
    if (data && input.categoryId !== null && !data.categories.some(category => category.id === input.categoryId)) throw conflict();
    if (!Array.isArray(input.tracks) || input.tracks.length > PLAYLIST_TRACK_LIMIT) {
      throw new Error('一份歌单最多保存 ' + PLAYLIST_TRACK_LIMIT + ' 首。');
    }
    return { name: playlistText(input.name, 60, true), description: playlistText(input.description, 500),
      categoryId: input.categoryId, tracks: input.tracks.map(playlistStoredTrack) };
  }

  function find(items, id, expectedRevision) {
    const item = items.find(entry => entry.id === id);
    if (!item || item.revision !== expectedRevision) throw conflict();
    return item;
  }

  async function create(input, id = makeId()) {
    const snapshot = dataFor(input);
    return write(data => {
      if (typeof id !== 'string' || !uuid.test(id)) throw new Error('歌单编号无效。');
      if (data.playlists.some(playlist => playlist.id === id)) return null;
      const time = now();
      const playlist = { id, revision: 1, createdAt: time, updatedAt: time, ...dataFor(snapshot, data) };
      data.playlists.push(playlist);
      return playlist;
    });
  }

  async function update(id, expectedRevision, input) {
    const snapshot = dataFor(input);
    return write(data => {
      const playlist = find(data.playlists, id, expectedRevision);
      Object.assign(playlist, dataFor(snapshot, data), { revision: playlist.revision + 1, updatedAt: now() });
      return playlist;
    });
  }

  function remove(id, expectedRevision) {
    return write(data => {
      const playlist = find(data.playlists, id, expectedRevision);
      data.playlists.splice(data.playlists.indexOf(playlist), 1);
      return playlist;
    });
  }

  function saveCategory(name, id, expectedRevision) {
    return write(data => {
      name = playlistText(name, 60, true);
      const category = id ? find(data.categories, id, expectedRevision) : { id: makeId(), revision: 0 };
      if (data.categories.some(item => item !== category && categoryKey(item.name) === categoryKey(name))) {
        throw new Error('已有同名分类。');
      }
      if (!id) data.categories.push(category);
      category.name = name;
      category.revision++;
      return category;
    });
  }

  function removeCategory(id, expectedRevision) {
    return write(data => {
      const category = find(data.categories, id, expectedRevision);
      data.categories.splice(data.categories.indexOf(category), 1);
      const time = now();
      for (const playlist of data.playlists) {
        if (playlist.categoryId !== id) continue;
        playlist.categoryId = null;
        playlist.revision++;
        playlist.updatedAt = time;
      }
      return category;
    });
  }

  return { read, create, update, remove, saveCategory, removeCategory };
}

const playlistLibrary = createPlaylistLibrary(
  { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) },
  typeof navigator !== 'undefined' && navigator.locks ? (name, task) => ZilyStorage.withWrite(name, task) : null
);
