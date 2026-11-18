// ═══════════════════════════════════════════════════════════════
//  AUDIO EVENTS
// ═══════════════════════════════════════════════════════════════
let audioCtx=null, analyser=null;
const previewBadge = document.getElementById('previewBadge');

function startAudioPlayback(){
    if(!audioCtx){
      try {
        audioCtx=new(window.AudioContext||window.webkitAudioContext)();
        analyser=audioCtx.createAnalyser();
        analyser.fftSize=256;
        analyser.smoothingTimeConstant=0.7;
        const src=audioCtx.createMediaElementSource(audio);
        src.connect(analyser);
        src.connect(audioCtx.destination);
      } catch(e){ analyser=null; }
    }
    if(audioCtx&&audioCtx.state==='suspended') audioCtx.resume();
    return audio.play();
}

function togglePlay(){
  if (playing) return audio.pause();
  return startAudioPlayback().then(() => true).catch(error => {
    if (error.name !== 'AbortError') addAIMsg('音频未能开始播放，可以点击播放器重试。');
    return false;
  });
}

let queuedAudioAttempt = null;

async function playQueuedAudio(song, signal, record) {
  const previous = { url: currentSong?.url, time: audio.currentTime, playing: !audio.paused };
  const attempt = { committed: false };
  queuedAudioAttempt = attempt;
  let timer;
  let interrupt;
  const stopped = new Promise(resolve => { interrupt = resolve; });
  let restored = false;
  const restore = () => {
    if (restored || attempt.committed || queuedAudioAttempt !== attempt) return;
    restored = true;
    audio.pause();
    if (previous.url) {
      audio.src = previous.url;
      audio.load();
      if (Number.isFinite(previous.time)) {
        try { audio.currentTime = previous.time; } catch {}
      }
      if (previous.playing && !audio.ended) startAudioPlayback().catch(() => {});
    } else {
      audio.removeAttribute('src');
      audio.load();
    }
  };
  const abort = () => {
    audio.removeEventListener('playing', commit, true);
    restore();
    interrupt({ ok: false, outcome: 'cancelled' });
  };
  const failed = () => interrupt({ ok: false, outcome: 'audio-load' });
  const commit = () => {
    if (signal.aborted || queuedAudioAttempt !== attempt || attempt.committed ||
        (audio.currentSrc && audio.currentSrc !== audio.src)) return;
    attempt.committed = true;
    updatePlayerUI(song);
    record();
    timeDur.textContent = fmtTime(audio.duration);
    previewBadge.hidden = !isPreview();
    syncPlaybackPosition();
  };
  signal.addEventListener('abort', abort, { once: true });
  audio.addEventListener('error', failed);
  // Commit before regular playing listeners so recent playback records the new song.
  audio.addEventListener('playing', commit, true);
  try {
    signal.throwIfAborted();
    audio.src = song.url;
    audio.load();
    timer = setTimeout(failed, 12000);
    const playback = startAudioPlayback().then(() => {
      commit();
      return { ok: attempt.committed, outcome: 'browser-play' };
    }, error => ({ ok: false, outcome: audio.error || error.name === 'NotSupportedError' ? 'audio-load' : 'browser-play' }));
    return await Promise.race([playback, stopped]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    audio.removeEventListener('error', failed);
    audio.removeEventListener('playing', commit, true);
    if (queuedAudioAttempt === attempt) {
      restore();
      queuedAudioAttempt = null;
    }
  }
}

function setPlaying(s){
  playing=s;
  document.querySelector('.player-card').classList.toggle('is-playing', s);
  if(s){ iconPlay.classList.add('hidden'); iconPause.classList.remove('hidden'); startVis(); }
  else { iconPlay.classList.remove('hidden'); iconPause.classList.add('hidden'); stopVis(); }
}

audio.addEventListener('loadedmetadata',()=>{
  const dur = audio.duration;
  timeDur.textContent = fmtTime(dur);
  syncPlaybackPosition();
  previewBadge.hidden = !isPreview();
});

function isPreview() {
  return currentSong && ((audio.duration > 0 && audio.duration < 60) || /preview/i.test(currentSong.url || ''));
}

audio.addEventListener('ended', async () => {
  const song = currentSong;
  if (song && audio.ended && typeof pendingQueueNext !== 'undefined' && pendingQueueNext?.song === song) {
    await pendingQueueNext.done;
    if (!audio.ended || currentSong !== song) return;
  }
  if (typeof playbackQueue !== 'undefined' && playbackQueue.state.status !== 'idle') {
    if (audio.ended && !queuedAudioAttempt) playbackQueue.ended(isPreview());
    return;
  }
  if (isPreview()) return;
  nextSong();
});

function renderPlaybackPosition(time){
  const duration = canSeek() ? audio.duration : 0;
  const seconds = Math.max(0, Math.min(duration, Number.isFinite(time) ? time : 0));
  const pct = duration ? seconds / duration * 100 : 0;
  progTrack.setAttribute('aria-disabled', String(!duration));
  progTrack.setAttribute('aria-valuemax', String(Math.ceil(duration)));
  progTrack.setAttribute('aria-valuenow', String(Math.floor(seconds)));
  progTrack.setAttribute('aria-valuetext', duration ? fmtTime(seconds) + '，总时长 ' + fmtTime(duration) : '暂无可跳转的音源');
  progFill.style.width=pct+'%'; if(progDot)progDot.style.left=pct+'%';
  timeCur.textContent=fmtTime(seconds);
  updateLyrics(seconds);
}
function canSeek(){
  return Number.isFinite(audio.duration) && audio.duration > 0;
}
let scrubPointer = null;
function syncPlaybackPosition(){
  if(scrubPointer === null) renderPlaybackPosition(audio.currentTime);
}
audio.addEventListener('timeupdate', syncPlaybackPosition);
audio.addEventListener('seeked', syncPlaybackPosition);
audio.addEventListener('playing',()=>setPlaying(true));
audio.addEventListener('waiting',()=>document.querySelector('.player-card').classList.remove('is-playing'));
audio.addEventListener('play',()=>{ playing=true; iconPlay.classList.add('hidden'); iconPause.classList.remove('hidden'); });
audio.addEventListener('ended',()=>setPlaying(false));
audio.addEventListener('pause',()=>setPlaying(false));
let audioErrorStreak = 0;
const MAX_AUDIO_ERRORS = 3;
audio.addEventListener('error',()=>{
  if (queuedAudioAttempt) return;
  if (typeof playbackQueue !== 'undefined' && playbackQueue.state.status !== 'idle') {
    playbackQueue.audioError();
    return;
  }
  if (currentSong?.verifiedMusic) {
    addAIMsg('这首歌的音源加载失败，可以稍后再试。');
    return;
  }
  // 如果音频错误时当前歌曲是试听片段，不触发切歌
  if(isPreview()){
    console.warn('[PREVIEW] 音频错误但为试听片段，阻断切歌循环');
    return;
  }
  // 连续加载失败达到上限就停下，避免 nextSong → 失败 → nextSong 的无限循环
  audioErrorStreak++;
  if(audioErrorStreak > MAX_AUDIO_ERRORS){
    addAIMsg('[SYS] 连续多首歌加载失败，已暂停自动切歌。请检查网络或网易云 API 是否在运行');
    audioErrorStreak = 0;
    return;
  }
  addAIMsg('[SYS] 音频加载失败，已尝试切换下一首');
  nextSong();
});
audio.addEventListener('playing',()=>{ audioErrorStreak = 0; });
function scrubTime(event){
  const bounds = progTrack.getBoundingClientRect();
  const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  return fraction * audio.duration;
}
function endScrub(){
  const pointer = scrubPointer;
  scrubPointer = null;
  if(pointer !== null && progTrack.hasPointerCapture(pointer)) progTrack.releasePointerCapture(pointer);
  syncPlaybackPosition();
}
function seekPlayback(time){
  audio.currentTime = Math.max(0, Math.min(audio.duration, time));
  renderPlaybackPosition(audio.currentTime);
}
progTrack.addEventListener('keydown', event => {
  if (scrubPointer !== null || !canSeek() || event.altKey || event.ctrlKey || event.metaKey) return;
  let target;
  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowDown': target = audio.currentTime - 5; break;
    case 'ArrowRight':
    case 'ArrowUp': target = audio.currentTime + 5; break;
    case 'Home': target = 0; break;
    case 'End': target = audio.duration; break;
    default: return;
  }
  event.preventDefault();
  seekPlayback(target);
});
progTrack.addEventListener('pointerdown', event => {
  if(scrubPointer !== null || event.button !== 0 || !canSeek() || !progTrack.getBoundingClientRect().width) return;
  scrubPointer = event.pointerId;
  progTrack.setPointerCapture(scrubPointer);
  renderPlaybackPosition(scrubTime(event));
});
progTrack.addEventListener('pointermove', event => {
  if(event.pointerId === scrubPointer && canSeek()) renderPlaybackPosition(scrubTime(event));
});
progTrack.addEventListener('pointerup', event => {
  if(event.pointerId !== scrubPointer) return;
  if(canSeek()) seekPlayback(scrubTime(event));
  endScrub();
});
for(const event of ['pointercancel', 'lostpointercapture']){
  progTrack.addEventListener(event, e => { if(e.pointerId === scrubPointer) endScrub(); });
}
audio.addEventListener('emptied', () => {
  previewBadge.hidden = true;
  document.querySelector('.player-card').classList.remove('is-playing');
  if(scrubPointer !== null) endScrub();
  else syncPlaybackPosition();
});

// ═══════════════════════════════════════════════════════════════
//  VISUALIZER — 48柱细线条 · 舒缓渐变色 · 包络线 · 镜面倒影
// ═══════════════════════════════════════════════════════════════
let visRaf=null;
const visCanvas=document.getElementById('audioVisualizer');
const visCtx=visCanvas.getContext('2d');
const BAR_COUNT=48;
const visPeaks=new Float32Array(BAR_COUNT);
let bassEnergy=0;

const simHeights=new Float32Array(BAR_COUNT);
const simPhases=new Float32Array(BAR_COUNT);
for(let i=0;i<BAR_COUNT;i++) simPhases[i]=Math.random()*Math.PI*2;

const BASS_END=Math.floor(BAR_COUNT*0.27);
const TREB_START=Math.floor(BAR_COUNT*0.72);

function resizeVis(){
  const r=visCanvas.getBoundingClientRect();
  visCanvas.width=Math.floor(r.width);
  visCanvas.height=68;
}

function startVis(){
  if(visRaf) return;
  resizeVis();
  (function draw(ts){
    visRaf=requestAnimationFrame(draw);
    const w=visCanvas.width, h=visCanvas.height;
    if(w===0||h===0) return;

    const nowSec=Date.now()*0.001;
    const H=195 + Math.sin(nowSec*0.25)*65 + Math.sin(nowSec*0.43)*15;

    let useSim=true;

    if(analyser){
      try {
        const bufLen=analyser.frequencyBinCount;
        const raw=new Uint8Array(bufLen);
        analyser.getByteFrequencyData(raw);
        let sum=0; for(let j=0;j<bufLen;j++) sum+=raw[j];
        if(sum>0){
          useSim=false;
          const step=bufLen/BAR_COUNT;
          for(let i=0;i<BAR_COUNT;i++){
            let s=0; const st=Math.floor(i*step), ed=Math.floor((i+1)*step);
            for(let j=st;j<ed;j++) s+=raw[j];
            simHeights[i]=(s/(ed-st))/255;
          }
        }
      } catch(e){ analyser=null; }
    }

    if(useSim){
      const beat=audio.currentTime*2.4;
      for(let i=0;i<BAR_COUNT;i++){
        let val;
        if(playing){
          const phase=beat*Math.PI*2+simPhases[i];
          const wave1=Math.sin(phase)*0.5+0.5;
          const wave2=Math.sin(phase*2.17+i*0.3)*0.5+0.5;
          const wave3=Math.sin(phase*0.43+i*0.7)*0.5+0.5;
          val=0.08 + wave1*0.55 + wave2*0.22 + wave3*0.12 + Math.random()*0.10;
          if(i<BASS_END) val*=1.0+(BASS_END-i)*0.08;
          if(i>TREB_START) val*=0.7;
        } else { val=0; }
        simHeights[i]+=(Math.min(1,val)-simHeights[i])*0.28;
      }
    }

    let bass=0; for(let i=0;i<BASS_END;i++) bass+=simHeights[i];
    bassEnergy=bass/BASS_END;

    visCtx.clearRect(0,0,w,h);
    const gap=3, barW=Math.max(1.2,(w-gap*(BAR_COUNT+1))/BAR_COUNT);
    if(barW<0.5) return;
    const marginBtm=8, drawH=h-marginBtm;

    visCtx.strokeStyle=`hsla(${H},55%,60%,0.035)`;
    visCtx.lineWidth=0.5;
    [0.25,0.5,0.75].forEach(pct=>{
      visCtx.beginPath(); visCtx.moveTo(0,drawH*(1-pct)); visCtx.lineTo(w,drawH*(1-pct)); visCtx.stroke();
    });
    visCtx.strokeStyle=`hsla(${H},60%,65%,0.07)`;
    visCtx.beginPath(); visCtx.moveTo(0,drawH); visCtx.lineTo(w,drawH); visCtx.stroke();

    for(let i=0;i<BAR_COUNT;i++){
      const val=simHeights[i];
      const barH=Math.max(playing?1:0, val*drawH);
      const x=gap+i*(barW+gap);
      const barTop=drawH-barH;

      const barGrad=visCtx.createLinearGradient(0,drawH,0,barTop);
      barGrad.addColorStop(0,`hsla(${H},70%,42%,0.05)`);
      barGrad.addColorStop(0.35,`hsla(${H},75%,52%,0.16)`);
      barGrad.addColorStop(0.65,`hsla(${H},78%,62%,0.42)`);
      barGrad.addColorStop(0.88,`hsla(${H},72%,70%,0.72)`);
      barGrad.addColorStop(1,`hsla(${H},55%,84%,0.92)`);

      visCtx.fillStyle=barGrad;
      visCtx.shadowColor=`hsla(${H},70%,60%,0.18)`;
      visCtx.shadowBlur=val>0.55?2.5:1;
      visCtx.fillRect(x, barTop, barW, barH);
      visCtx.shadowBlur=0;

      if(barH>4){
        const refH=Math.min(barH*0.16, marginBtm-1);
        visCtx.fillStyle=`hsla(${H},60%,55%,0.028)`;
        visCtx.fillRect(x, drawH+1, barW, refH);
      }

      if(barH>visPeaks[i]) visPeaks[i]=barH;
      else visPeaks[i]=Math.max(0, visPeaks[i]-0.3);
    }

    visCtx.beginPath();
    visCtx.strokeStyle=`hsla(${H},72%,68%,0.22)`;
    visCtx.lineWidth=0.8;
    visCtx.shadowColor=`hsla(${H},65%,60%,0.12)`;
    visCtx.shadowBlur=2;
    for(let i=0;i<BAR_COUNT;i++){
      const val=simHeights[i];
      const barH=Math.max(playing?1:0, val*drawH);
      const px=gap+i*(barW+gap)+barW/2;
      const py=drawH-barH;
      if(i===0) visCtx.moveTo(px,py);
      else visCtx.lineTo(px,py);
    }
    visCtx.stroke();
    visCtx.shadowBlur=0;

    for(let i=0;i<BAR_COUNT;i++){
      const val=simHeights[i];
      if(val>0.55 && visPeaks[i]>2.5){
        const px=gap+i*(barW+gap)+barW/2;
        const py=drawH-visPeaks[i];
        visCtx.fillStyle=val>0.78?`hsla(${H},20%,94%,0.8)`:`hsla(${H},60%,74%,0.6)`;
        visCtx.beginPath();
        visCtx.arc(px, py, Math.max(0.8, barW*0.55), 0, Math.PI*2);
        visCtx.fill();
      }
    }
  })();
}

function stopVis(){
  if(visRaf){ cancelAnimationFrame(visRaf); visRaf=null; }
  bassEnergy=0;
}

if(window.ResizeObserver){ new ResizeObserver(()=>{ resizeVis(); }).observe(visCanvas); }
