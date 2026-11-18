'use strict';

const musicControls = new Set(['pause', 'resume', 'next', 'previous', 'favorite', 'replay']);
let lastVerifiedRecommendation = null;

function bindMusicRecommendation(message) {
  if (lastVerifiedRecommendation && !lastVerifiedRecommendation.message &&
      lastVerifiedRecommendation.text === message?.content) lastVerifiedRecommendation.message = message;
}

function musicPlayerContext(intent) {
  const track = song => ({ song: song.name, artist: song.artist });
  const context = intent === 'playlist_draft' ? {} : { current: currentSong ? track(currentSong) : null, playing: !audio.paused };
  if (intent === 'recommend' || intent === 'play' || intent === 'similar' || intent === 'playlist_draft') {
    context.recent = playHistory.slice(-3).map(track);
    context.favorites = favSongs.slice(-3).map(track);
  }
  return context;
}

function exactMusicKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function musicField(value, limit = 100) {
  return typeof value === 'string' && value.trim() && value.length <= limit &&
    !/[\x00-\x1f<>]|https?:\/\/|javascript:/iu.test(value);
}

function parseMusicEnvelope(raw) {
  const match = /^([\s\S]*?)\[JSON_START\]\s*(\{[\s\S]*\})\s*\[JSON_END\]\s*$/u.exec(raw);
  if (!match || /\[JSON_(?:START|END)\]/u.test(match[1])) return null;
  try { return JSON.parse(match[2]); } catch { return null; }
}

function parseMusicAction(raw) {
  let data = parseMusicEnvelope(raw);
  if (!data || typeof data !== 'object') return null;
  if (musicControls.has(data.action) && exactMusicKeys(data, ['action'])) return data;
  if (exactMusicKeys(data, ['song', 'artist']) || exactMusicKeys(data, ['title', 'artist'])) {
    data = { action: 'play', song: data.song ?? data.title, artist: data.artist };
  }
  if (data.action === 'play' && exactMusicKeys(data, ['action', 'song', 'artist']) &&
      musicField(data.song) && (data.artist === '' || musicField(data.artist))) return data;
  if (data.action === 'recommend' && exactMusicKeys(data, ['action', 'tracks']) &&
      Array.isArray(data.tracks) && data.tracks.length >= 1 && data.tracks.length <= 3 &&
      data.tracks.every(track => exactMusicKeys(track, ['song', 'artist', 'reason']) &&
        musicField(track.song) && musicField(track.artist) && musicField(track.reason, 160))) return data;
  return null;
}

const musicKey = text => text.normalize('NFKC').trim().toLowerCase();

function catalogAliases(record, ...fields) {
  return fields.flatMap(field => Array.isArray(record[field]) ? record[field].filter(value => musicField(value)) : []);
}

function artistMatches(person, expected) {
  const name = musicKey(person.name);
  const aliases = catalogAliases(person, 'alias', 'tns').map(musicKey);
  return name === expected || aliases.includes(expected) ||
    aliases.some(alias => name === expected + alias || name === alias + expected);
}

async function verifyMusicTrack(song, artist, signal, { keepVersions = false } = {}) {
  const keywords = artist ? song + ' ' + artist : song;
  const timeout = AbortSignal.timeout(10000);
  const response = await fetch(NE_API + '/cloudsearch?limit=20&keywords=' + encodeURIComponent(keywords), {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error('catalog-unavailable');
  const results = (await response.json()).result?.songs;
  if (!Array.isArray(results)) return [];
  const found = new Map();
  for (const row of results) {
    if (!row || !musicField(row.name) || ![row.name, ...catalogAliases(row, 'tns')].some(name => musicKey(name) === musicKey(song))) continue;
    if (typeof row.id !== 'string' && !Number.isSafeInteger(row.id)) continue;
    const id = String(row.id);
    if (!/^\d{1,20}$/u.test(id)) continue;
    const credits = row.ar || row.artists;
    if (!Array.isArray(credits)) continue;
    const artists = credits.filter(person => musicField(person?.name));
    const credit = artists.map(person => person.name).join('/');
    if (!credit || (artist && !artists.some(person => artistMatches(person, musicKey(artist))) &&
        musicKey(credit) !== musicKey(artist))) continue;
    const key = keepVersions ? id : musicKey(credit);
    if (!found.has(key)) {
      const track = { id, song: row.name, artist: credit, cover: row.al?.picUrl || row.album?.picUrl };
      const album = row.al?.name || row.album?.name;
      if (keepVersions) {
        if (musicField(album)) track.album = album;
        if (Number.isFinite(row.dt) && row.dt > 0) track.durationMs = row.dt;
      }
      found.set(key, track);
    }
  }
  return [...found.values()];
}

let pendingQueueNext = null;

async function queueNextTrack(intent, signal) {
  let release;
  const task = {
    song: currentSong && !audio.ended ? currentSong : null,
    done: new Promise(resolve => { release = resolve; })
  };
  pendingQueueNext = task;
  try {
    let tracks = await verifyMusicTrack(intent.title, intent.artist, signal);
    if (!tracks.length && intent.fallbackTitle) {
      tracks = await verifyMusicTrack(intent.fallbackTitle, '', signal);
    }
    signal.throwIfAborted();
    if (!tracks.length) return '网易云没有找到匹配的歌曲，请确认歌名和歌手。';
    if (tracks.length > 1) return '找到多个同名版本，请带上歌手再说一次。';
    const [track] = tracks;
    const followCurrent = Boolean(currentSong && (!audio.ended || currentSong === task.song));
    if (!playbackQueue.insertNext(track, followCurrent)) return '这首歌没有可用的曲库 ID，暂时无法加入队列。';
    const title = '《' + track.song + '》· ' + track.artist;
    return followCurrent ? '已安排下一首：' + title + '。当前歌曲播完后接着播放。'
      : '已把' + title + '放到队列最前面，可以在播放队列里开始播放。';
  } catch {
    return signal.aborted ? '' : '暂时无法核对网易云曲库，可以稍后再试。';
  } finally {
    if (pendingQueueNext === task) pendingQueueNext = null;
    release();
  }
}

async function applyMusicReply(raw, intent, dailyRecommendation, signal, status = () => {}) {
  if (intent === true) intent = { type: 'play' };
  const prose = stripPlaybackClosing(getVisibleStreamText(raw), true).trim();
  if (intent.type === 'discuss') return prose;
  if (signal?.aborted) return prose;
  const directive = parseMusicAction(raw);
  const expected = intent.type === 'similar' ? 'play' : intent.type;
  const previous = chatContext.at(-1);
  const priorTracks = previous?.role === 'assistant' && previous.content === lastVerifiedRecommendation?.text &&
    previous === lastVerifiedRecommendation.message ? lastVerifiedRecommendation.tracks : [];
  if (intent.confirmation && priorTracks.length) {
    const selected = intent.selection ? priorTracks[intent.selection - 1] : priorTracks.length === 1 ? priorTracks[0] : null;
    if (!selected) return '你想放哪一首？可以说「放第一首」。';
    if (!directive || directive.action !== 'play') return '这轮没有收到完整的播放指令，可以再说一次。';
    return playVerifiedMusic(selected, dailyRecommendation, signal, status, directive, prose);
  }
  if (intent.confirmation && intent.selection) return '上一轮没有可用的对应推荐，可以直接告诉我歌名。';
  if (!directive || directive.action !== expected) {
    if (musicControls.has(expected)) return '这轮没有收到完整的播放器指令，可以再说一次。';
    return '这轮没有收到可核验的歌曲。可以再试一次，或告诉我歌名和歌手。';
  }
  if ((musicControls.has(expected) || intent.type === 'similar') &&
      Object.hasOwn(intent, 'currentId') && intent.currentId !== (currentSong?.id ?? null)) {
    return '当前歌曲已经换了，请重新确认你要操作的歌曲。';
  }
  if (musicControls.has(expected)) return controlMusicPlayer(expected, signal, status);

  status(expected === 'play' ? withPlaybackStatus(prose, '正在网易云核对歌曲…') : '正在网易云核对歌曲…');
  try {
    if (expected === 'recommend') {
      const groups = await Promise.allSettled(directive.tracks.map(async item => {
        const [track] = await verifyMusicTrack(item.song, item.artist, signal);
        return track ? { ...track, reason: item.reason } : null;
      }));
      const found = groups.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
      const tracks = [...new Map(found.map(track => [track.id, track])).values()];
      if (signal?.aborted) return '';
      if (!tracks.length) {
        return groups.some(result => result.status === 'rejected') ? '暂时无法核对网易云曲库，可以稍后再试。'
          : '网易云没有核对到这些歌曲。你可以给我一个歌手或换个风格。';
      }
      const text = tracks.map((track, i) => (i + 1) + '. 《' + track.song + '》· ' + track.artist + ' — ' + track.reason).join('\n');
      const reply = text + '\n想听哪首，可以说「放第一首」。';
      lastVerifiedRecommendation = { text: reply, tracks };
      return reply;
    }
    if (intent.title && musicKey(intent.title) !== musicKey(directive.song)) {
      return '这轮给出的歌名和你点的歌不同，请再确认歌名和歌手。';
    }
    const tracks = await verifyMusicTrack(intent.title || directive.song,
      intent.artist || (intent.title ? '' : directive.artist), signal);
    if (signal?.aborted) return '';
    if (!tracks.length) return '网易云没有找到这首歌的匹配版本，请确认歌名和歌手。';
    if (tracks.length > 1) {
      const options = tracks.slice(0, 3);
      const text = '找到几个同名版本，请选一个：\n' + options.map((track, i) =>
        (i + 1) + '. 《' + track.song + '》· ' + track.artist).join('\n');
      lastVerifiedRecommendation = { text, tracks: options };
      return text;
    }
    if (intent.type === 'similar' && String(currentSong?.id) === tracks[0].id) {
      return '这次找到的还是当前这首，可以换个风格再试。';
    }
    return playVerifiedMusic(tracks[0], dailyRecommendation, signal, status, directive, prose);
  } catch {
    return signal?.aborted ? '' : '暂时无法核对网易云曲库，可以稍后再试。';
  }
}

function withPlaybackStatus(introduction, message) {
  return introduction && introduction !== message ? introduction + '\n\n' + message : message;
}

async function playVerifiedMusic(track, dailyRecommendation, signal, status, directive, prose) {
  if (signal?.aborted) return '';
  const matches = musicKey(track.song) === musicKey(directive.song) &&
    (!directive.artist || musicKey(track.artist) === musicKey(directive.artist));
  const introduction = matches ? prose : '';
  status(withPlaybackStatus(introduction, '正在加载《' + track.song + '》…'));
  const started = await execTagSwitch(track, dailyRecommendation);
  if (!started) return '找到了《' + track.song + '》，但这个版本暂时无法播放。';
  return introduction || '正在播放《' + track.song + '》· ' + track.artist;
}

async function controlMusicPlayer(action, signal, status) {
  if (signal?.aborted) return '';
  if (!currentSong || loadingSong || recommendingNext) return '播放器暂时没有可操作的歌曲。';
  if (action === 'favorite') {
    if (isFavorited(currentSong.id)) return '《' + currentSong.name + '》已经在收藏里。';
    const song = currentSong;
    const persisted = await toggleFavorite(true);
    if (persisted === false) return '收藏更改未保存。';
    return isFavorited(song.id) ? '已收藏《' + song.name + '》。' : '这次收藏没有成功。';
  }
  if (action === 'pause') {
    audio.pause();
    return audio.paused ? '已暂停。' : '这次没能暂停。';
  }
  if (action === 'resume' || action === 'replay') {
    if (action === 'replay') audio.currentTime = 0;
    if (audio.paused && !await togglePlay()) return '音频暂时无法开始播放。';
    return action === 'replay' ? '已从头播放《' + currentSong.name + '》。' : '已继续播放。';
  }
  const previous = currentSong.id;
  const queueEntry = typeof playbackQueue !== 'undefined' ? playbackQueue.state.currentEntryId : null;
  if (action === 'next') {
    status('正在准备下一首…');
    await nextSong();
  } else await prevSong();
  const queueMoved = typeof playbackQueue !== 'undefined' && playbackQueue.state.currentEntryId &&
    playbackQueue.state.currentEntryId !== queueEntry;
  return previous === currentSong?.id && !queueMoved ? '目前没有可切换的歌曲。'
    : '已切换到《' + currentSong.name + '》' + (audio.paused ? '，目前是暂停状态。' : '。');
}
