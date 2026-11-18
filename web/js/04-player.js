// ═══════════════════════════════════════════════════════════════
//  ONLINE MUSIC SYSTEM — 网易云音乐 API（免登录 · 免会员）
// ═══════════════════════════════════════════════════════════════
let playing=false, currentSong=null, curLyric=-1, loadingSong=false;
const playHistory=[];
let historyIdx=-1;

const MAX_FALLBACK_DEPTH = 2; // 原唱找不到时，最多自动换歌的次数
let recentPlayedTitles = []; // 近期已播放歌名（用于去重，存最近 20 首）

function getRecentPlayedList(){
  return recentPlayedTitles.slice(-20).join('、');
}

function rememberRecentPlayed(title, artist){
  const item = (title || '').trim() + (artist ? ' by ' + artist.trim() : '');
  if(!item.trim()) return;
  recentPlayedTitles.push(item);
  if(recentPlayedTitles.length > 20) recentPlayedTitles = recentPlayedTitles.slice(-20);
}

const audio=document.getElementById('audioEl');
audio.crossOrigin='anonymous';

const iconPlay=document.getElementById('iconPlay');
const iconPause=document.getElementById('iconPause');
const songTitle=document.getElementById('songTitle');
const songArtist=document.getElementById('songArtist');
const progFill=document.getElementById('progressFill');
const progDot=document.getElementById('progressDot');
const progTrack=document.getElementById('progressTrack');
const timeCur=document.getElementById('timeCurrent');
const timeDur=document.getElementById('timeDuration');
const lyricsContent=document.getElementById('lyricsContent');
const chatMsgs=document.getElementById('chatMessages');
const chatInput=document.getElementById('chatInput');

function escHTML(s){ const m={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}; return s.replace(/[&<>"']/g,c=>m[c]); }
function fmtTime(s){ if(isNaN(s)||!isFinite(s))return'00:00'; const m=Math.floor(s/60),sec=Math.floor(s%60); return String(m).padStart(2,'0')+':'+String(sec).padStart(2,'0'); }

// ── LRC 歌词解析器（网易云标准 LRC 格式）──
function parseLRC(lrcText){
  if(!lrcText) return [];
  const lines=[], re=/\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/g;
  let m;
  while((m=re.exec(lrcText))!==null){
    const min=parseInt(m[1]), sec=parseInt(m[2]);
    let ms=parseInt(m[3]); if(m[3].length===2) ms*=10;
    const t=min*60+sec+ms/1000, l=m[4].trim();
    if(l) lines.push({t,l});
  }
  lines.sort((a,b)=>a.t-b.t);
  return lines;
}

// ── 渲染歌词到面板 ──
function renderLyrics(lyrics){
  if(!lyrics||lyrics.length===0){
    lyricsContent.innerHTML='<div class="lyric-line" style="color:rgba(255,255,255,0.15)">♪ 暂无歌词</div>';
    curLyric=-1; return;
  }
  lyricsContent.innerHTML=lyrics.map((ln,i)=>
    '<div class="lyric-line" data-idx="'+i+'" data-t="'+ln.t+'">'+escHTML(ln.l)+'</div>'
  ).join('');
  curLyric=-1;
}

// ── 根据当前播放时间高亮歌词 ──
function updateLyrics(ct){
  if(!currentSong||!currentSong.lyrics||currentSong.lyrics.length===0) return;
  const lyrics=currentSong.lyrics;
  let idx=-1;
  for(let i=lyrics.length-1;i>=0;i--){ if(ct>=lyrics[i].t){ idx=i; break; } }
  if(idx===curLyric) return;
  curLyric=idx;
  const lines=lyricsContent.querySelectorAll('.lyric-line');
  lines.forEach((ln,i)=>{
    ln.classList.remove('active','past');
    if(i===idx){
      ln.classList.add('active');
      const box = document.getElementById('lyricsBox');
      if (box.clientHeight) {
        const line = ln.getBoundingClientRect();
        const viewport = box.getBoundingClientRect();
        if (line.top < viewport.top || line.bottom > viewport.bottom) {
          box.scrollTop += line.top - viewport.top - (box.clientHeight - line.height) / 2;
        }
      }
    }
    else if(i<idx) ln.classList.add('past');
  });
}

// ── 更新播放器 UI ──
const songCover = document.getElementById('songCover');
songCover.addEventListener('load', () => { songCover.hidden = false; });
songCover.addEventListener('error', () => { songCover.hidden = true; });

function updatePlayerUI(song){
  songCover.hidden = true;
  if (song.cover) {
    songCover.src = song.cover.replace(/^http:\/\//i, 'https://');
  } else {
    songCover.removeAttribute('src');
  }
  songTitle.textContent=song.name; songArtist.textContent=song.artist;
  document.title=song.name+' · Music Companion';
  progFill.style.width='0%'; if(progDot)progDot.style.left='0%';
  timeCur.textContent='00:00'; timeDur.textContent='00:00';
  renderLyrics(song.lyrics);
  visPeaks.fill(0);
  curLyric=-1;
  currentSong=song;
  updateHeartIcon();
}

// ── 从 tag 中智能提取歌手名（格式："歌名 歌手名" 或 "歌名"）──
function extractArtistFromTag(tag){
  const t = tag.trim();
  const parts = t.split(/\s+/);
  // 如果只有一个词，没有歌手信息
  if(parts.length <= 1) return {keyword: t, artist: null};
  // 尝试把最后一个词作为歌手名（中文名通常 2-3 字，英文名如 G.E.M.）
  const lastPart = parts[parts.length-1];
  // 常见情绪标签关键词 → 最后一个词不是歌手，而是情绪描述
  const emotionWords = ['放松','安静','舒缓','治愈','忧郁','难过','伤感','宣泄','疲惫','开心','快乐','思念','孤独','专注','思考','温暖','浪漫','民谣','纯音乐','钢琴曲','轻音乐','歌曲','情歌','音乐','古典','后摇','摇滚','电子','流行','古风','爵士'];
  if(emotionWords.some(w => lastPart.includes(w))){
    return {keyword: t, artist: null};
  }
  // 常见歌手姓氏 + 名字模式（如：周杰伦、薛之谦、林俊杰、田馥甄、鲸鱼马戏团、万能青年旅店）
  // 最后一个词包含常见中文名特征 → 作为歌手名
  if(lastPart.length >= 2 && lastPart.length <= 12){
    return {keyword: t, artist: lastPart};
  }
  // 尝试最后两个词合并（如 "万能 青年旅店" → 最后一个词是"青年旅店"不够，需要检查）
  if(parts.length >= 2){
    const lastTwo = parts.slice(-2).join('');
    if(lastTwo.length >= 4 && lastTwo.length <= 12){
      return {keyword: t, artist: lastTwo};
    }
  }
  return {keyword: t, artist: null};
}

// ── 核心：网易云在线搜索 + 播放（歌手二次精准强匹配 · 黑胶 Cookie）──
async function playOnlineMusic(songName, artistName = null, pushHistory = true, fallbackDepth = 0, trackId = null, dailyReplay = null, queueSignal = null){
  if (loadingSong || (dailyReplay && !/^\d+$/.test(trackId))) {
    return queueSignal ? { ok: false, outcome: 'no-source' } : false;
  }
  if (!queueSignal) {
    if (typeof playbackQueue !== 'undefined') playbackQueue.leave();
    loadingSong = true;
  }
  songName = (songName || '').trim();
  if(artistName) artistName = artistName.trim();
  const expectedArtist = artistName || '';

  // 读取本地登录态 cookie，确保请求以黑胶会员身份发出
  let myCookie = '';
  try { myCookie = localStorage.getItem('netease_cookie') || ''; } catch {}
  const requestOptions = myCookie ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookie: myCookie })
  } : undefined;
  const fetchTrack = (url, options) => fetch(url, queueSignal ? { ...options, signal: queueSignal } : options);
  const tsParam = '&timestamp=' + Date.now();

  let phase = '';
  try {
    queueSignal?.throwIfAborted();
    // 今日推荐和队列已保存曲库 ID，无需再次依赖搜索排名。
    let songs;
    if (dailyReplay) {
      const id = Number(trackId);
      songs = [{
        id: Number.isSafeInteger(id) ? id : trackId,
        name: songName,
        ar: [{ name: expectedArtist }],
        al: { picUrl: dailyReplay.cover || '' }
      }];
    } else {
      phase = '搜索';
      const searchPath = '/cloudsearch?keywords=' + encodeURIComponent(songName) + '&limit=12';
      const searchUrl = NE_API + searchPath + tsParam;
      let searchResp;
      try {
        searchResp = await fetch(searchUrl, requestOptions);
      } catch(fetchErr){
        throw new Error('[搜索阶段] fetch 失败，请确认网易云 API 服务已启动（npm start）');
      }
      if(!searchResp.ok){
        throw new Error('[搜索阶段] API 返回 HTTP ' + searchResp.status);
      }
      const searchData = await searchResp.json();
      songs = (searchData.result && searchData.result.songs) ? searchData.result.songs : [];
      if(songs.length === 0){
        addAIMsg('未找到歌曲「'+escHTML(songName)+'」，试试其他关键词吧');
        loadingSong = false; return false;
      }
    }

    // 第二步：遍历前 5 首 → 歌手二次精准强匹配
    phase = '获取播放链接';
    let songUrl = null, songInfo = null;
    const topSongs = trackId === null ? songs.slice(0, 8) : songs.filter(item => String(item.id) === trackId);

    // 先尝试歌手精准匹配（如果有预期歌手）
    if(expectedArtist && trackId === null){
      for(const item of topSongs){
        if(!item.id) continue;
        const itemArtists = (item.artists || item.ar || []).map(a => (a.name || '').trim()).filter(Boolean);
        const artistFlat = itemArtists.join(' ').toLowerCase();
        const expectedLower = expectedArtist.toLowerCase();
        // 判定：搜索结果中任一歌手名包含预期歌手名，或预期歌手名包含搜索结果歌手名
        const isMatch = itemArtists.some(aName =>
          aName.toLowerCase().includes(expectedLower) || expectedLower.includes(aName.toLowerCase())
        ) || artistFlat.includes(expectedLower);

        if(isMatch){
          try {
            const urlResp = await fetch(NE_API + '/song/url?id=' + item.id + tsParam, requestOptions);
            if(!urlResp.ok) continue;
            const urlData = await urlResp.json();
            if(urlData.data && urlData.data[0] && urlData.data[0].url){
              songUrl = urlData.data[0].url;
              songInfo = item;
              console.log('[MATCH] 歌手精准匹配成功：「'+item.name+'」by '+itemArtists.join('/')+' ← 预期：'+expectedArtist);
              break;
            }
          } catch(e){ continue; }
        }
      }

      // 歌手匹配失败 → 拦截，不播放翻唱
      if(!songUrl || !songInfo){
        // 降级替代最多尝试 MAX_FALLBACK_DEPTH 次，避免无限递归
        if(fallbackDepth >= MAX_FALLBACK_DEPTH){
          addAIMsg('连续几首都没有找到可播放的原唱，先停一下，换个说法再试试吧');
          loadingSong = false; return false;
        }
        addAIMsg('暂时找不到《' + escHTML(songName) + '》的可播版本，先换一首。');
        loadingSong = false;
        // 触发降级替代：随机从安全感池中选一首
        const fallbackPool = ['晴天 周杰伦','好久不见 陈奕迅','遇见 孙燕姿','演员 薛之谦','小幸运 田馥甄','七里香 周杰伦'];
        const fallback = fallbackPool[Math.floor(Math.random() * fallbackPool.length)];
        const {keyword: fbK, artist: fbA} = extractArtistFromTag(fallback);
        return await playOnlineMusic(fbK, fbA, pushHistory, fallbackDepth + 1);
      }
    } else {
      // 无指定歌手时选择可播候选；今日推荐只请求已保存的同一 ID。
      for (const item of topSongs) {
        if (!item.id) continue;
        const path = NE_API + '/song/url?id=' + item.id + tsParam;
        const attempts = dailyReplay && requestOptions ? [requestOptions, undefined] : [requestOptions];
        for (const options of attempts) {
          try {
            const response = await fetchTrack(path, options);
            if (!response.ok) continue;
            const track = (await response.json()).data?.[0];
            if (!track?.url || (dailyReplay && track.id != null && String(track.id) !== trackId)) continue;
            songUrl = track.url;
            songInfo = item;
            break;
          } catch {
            queueSignal?.throwIfAborted();
          }
        }
        if (songInfo) break;
      }
    }

    if(!songUrl || !songInfo){
      if (queueSignal) return { ok: false, outcome: 'no-source' };
      if (!dailyReplay) addAIMsg('歌曲「'+escHTML(songName)+'」暂无可用音源（可能已下架）');
      loadingSong = false; return false;
    }

    // 第三步：拉取 LRC 歌词
    phase = '拉取歌词';
    let lyrics = [];
    try {
      const lrcResp = await fetchTrack(NE_API + '/lyric?id=' + songInfo.id + tsParam, requestOptions);
      if(lrcResp.ok){
        const lrcData = await lrcResp.json();
        if(lrcData.lrc && lrcData.lrc.lyric){
          lyrics = parseLRC(lrcData.lrc.lyric);
        }
      }
    } catch(e){
      // 歌词获取失败不阻断播放
    }

    // 第四步：构建歌曲对象
    const artist = (songInfo.artists || songInfo.ar || []).map(a => (a.name || '').replace(/-+$/,'').trim()).filter(Boolean).join('/') || '未知歌手';
    const cover = (songInfo.al && songInfo.al.picUrl) ? songInfo.al.picUrl : ((songInfo.album && songInfo.album.picUrl) ? songInfo.album.picUrl : '');
    const song = {
      id: songInfo.id,
      name: songInfo.name,
      artist,
      cover,
      url: songUrl,
      lyrics,
      searchKeyword: songName,
      ...(dailyReplay?.verified ? { verifiedMusic: true } : {})
    };

    const record = () => {
      if (pushHistory) {
        if (historyIdx < playHistory.length - 1) playHistory.splice(historyIdx + 1);
        playHistory.push(song);
        historyIdx = playHistory.length - 1;
      }
      rememberRecentPlayed(song.name, song.artist);
    };
    if (queueSignal) {
      queueSignal.throwIfAborted();
      return await playQueuedAudio(song, queueSignal, record);
    }
    record();

    // 第六步：更新 UI 并播放
    updatePlayerUI(song);
    audio.src = song.url;
    audio.load();
    const wasPlaying = playing;
    const playback = wasPlaying ? audio.play() : togglePlay();
    if (dailyReplay?.verified) {
      const started = await Promise.resolve(playback).catch(() => false);
      loadingSong = false;
      return started !== false && !audio.paused;
    }
    if (wasPlaying) playback.catch(() => {});
    loadingSong = false;
    return true;
  } catch(e){
    if (queueSignal) return { ok: false, outcome: 'no-source' };
    console.warn('网易云 ' + phase + ' 失败', e);
    if (!dailyReplay) addAIMsg('暂时没能加载这首歌，可以稍后再试。');
    loadingSong = false;
    return false;
  }
}

// ── AI 自动推荐下一首（高级导听 · 无缝无限流）──
async function requestNextRecommendation(previousSong){
  if (!previousSong) return;
  const container = addAIMsg('');
  const intent = { type: 'similar', currentId: previousSong.id };
  let complete = false;
  try {
    const fullText = await callAIStream('接着放一首风格相近、近期没播过的歌。', partial => {
      setAIMessageText(container, stripPlaybackClosing(getVisibleStreamText(partial), true));
    }, intent, undefined, () => { complete = true; });
    const result = complete
      ? await applyMusicReply(fullText, intent, false)
      : '这轮推荐未完整结束，可以稍后再试。';
    setAIMessageText(container, result);
  } catch {
    setAIMessageText(container, '暂时没能找到下一首，可以稍后再试。');
  }
}

// ── 上一首 / 下一首（基于播放历史 + AI 自动无限流）──
let recommendingNext = false;
async function nextSong(){
  if (typeof playbackQueue !== 'undefined' && playbackQueue.state.status !== 'idle') return playbackQueue.next();
  if(loadingSong || recommendingNext || playHistory.length===0) return;
  if(historyIdx<playHistory.length-1){
    historyIdx++;
    const song=playHistory[historyIdx];
    updatePlayerUI(song);
    const wasPlaying = playing;
    audio.src=song.url; audio.load();
    if(wasPlaying) audio.play().catch(()=>{});
  } else if(currentSong){
    // 历史耗尽 → 请求 DeepSeek 做大众/小众混编推荐
    recommendingNext = true;
    try { await requestNextRecommendation(currentSong); }
    finally { recommendingNext = false; }
  }
}
async function prevSong(){
  if(loadingSong || recommendingNext) return;
  if(historyIdx>0){
    if (typeof playbackQueue !== 'undefined') playbackQueue.leave();
    historyIdx--;
    const song=playHistory[historyIdx];
    updatePlayerUI(song);
    const wasPlaying = playing;
    audio.src=song.url; audio.load();
    if(wasPlaying) audio.play().catch(()=>{});
  }
}

// ── 情绪标签 → 搜索关键词映射 ──
const TAG_KEYWORD_MAP={
  '放松':'舒缓钢琴曲','安静':'安静纯音乐','舒缓':'治愈系钢琴曲',
  '平静':'宁静冥想音乐','治愈':'温暖治愈歌曲','温暖':'温暖民谣',
  '柔和':'柔和轻音乐','冥想':'冥想瑜伽音乐','轻松':'轻松愉快的歌',
  '忧郁':'薛之谦','难过':'伤感歌曲','伤感':'林俊杰 慢歌',
  '低落':'深情歌曲','悲伤':'大提琴 纯音乐','思念':'思念 情歌',
  '孤独':'孤独 民谣','emo':'治愈系','心碎':'疗伤情歌',
  '宣泄':'摇滚 热血','疲惫':'放松解压音乐','烦躁':'纯音乐 白噪音',
  '累':'放松解压轻音乐','压力':'减压放松','愤怒':'重金属',
  '焦虑':'平静舒缓纯音乐','思考':'专注学习轻音乐','专注':'学习专注音乐',
  '独处':'独处安静','开心':'欢快歌曲','快乐':'快乐流行歌曲',
  '兴奋':'电子舞曲','幸福':'甜蜜浪漫情歌','喜悦':'喜庆欢快',
  '甜蜜':'甜蜜情歌','激动':'热血动漫OST','嗨':'派对电子音乐',
};

function resolveTagToKeyword(tag){
  const t=tag.trim();
  for(const [k,v] of Object.entries(TAG_KEYWORD_MAP)){
    if(t.includes(k)) return v;
  }
  return t;
}

async function execTagSwitch(tag, dailyRecommendation = false){
  if (tag?.id) {
    if (!/^\d{1,20}$/.test(tag.id)) return false;
    const loaded = await playOnlineMusic(tag.song, tag.artist, true, 0, tag.id, { cover: tag.cover, verified: true });
    if (loaded && dailyRecommendation) recordDailyRecommendation(currentSong);
    return loaded;
  }
  const {keyword, artist: expectedArtist} = typeof tag === 'string'
    ? extractArtistFromTag(tag)
    : {keyword: tag.song, artist: tag.artist};
  const keyword2 = typeof tag === 'string' ? resolveTagToKeyword(keyword) : keyword;
  const loaded = await playOnlineMusic(keyword2, expectedArtist, true);
  if (loaded === true && dailyRecommendation && currentSong?.searchKeyword === keyword2 &&
      currentSong.name.trim().toLowerCase() === keyword.trim().toLowerCase()) {
    recordDailyRecommendation(currentSong);
  }
  return loaded;
}
