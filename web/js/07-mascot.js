// ═══════════════════════════════════════════════════════════════
//  吉祥物「AI 伙伴」
// ═══════════════════════════════════════════════════════════════
const mascotImg=document.getElementById('mascotImg');
const mascotBubble=document.getElementById('mascotBubble');
const mascotTips=['今晚我在，别硬撑。','点我一下，我就醒着陪你。','累了就让歌先替你说。','先呼吸，代码一行一行来。'];
let mascotTipIndex=0;
let mascotBeatTimer=null;
let mascotFlashTimer;

function syncMascotToBeat(){
  const duration=playing?Math.max(1700,3000*(1-bassEnergy*0.4)):3000;
  mascotImg.style.setProperty('--mascot-breath-duration',Math.round(duration)+'ms');
}

function startBearAnim(){
  if(mascotBeatTimer!==null) return;
  syncMascotToBeat();
  mascotBeatTimer=setInterval(syncMascotToBeat,1000);
}

function triggerBearBoost(){
  clearTimeout(mascotFlashTimer);
  mascotImg.classList.add('click-flash');
  updateMascotTip();
  mascotFlashTimer=setTimeout(()=>mascotImg.classList.remove('click-flash'),300);
}

function updateMascotTip(){
  if(!mascotBubble) return;
  mascotTipIndex=(mascotTipIndex+1)%mascotTips.length;
  mascotBubble.textContent=mascotTips[mascotTipIndex];
  mascotBubble.classList.add('soft-flash');
  setTimeout(()=>mascotBubble.classList.remove('soft-flash'),520);
}

function syncMascotBubblePosition(){
  if(!mascotBubble) return;
  const r=mascotImg.getBoundingClientRect();
  mascotBubble.style.right='auto';
  mascotBubble.style.bottom='auto';
  mascotBubble.style.left=Math.max(8,r.left-118)+'px';
  mascotBubble.style.top=Math.max(8,r.top-42)+'px';
}

// ── 拖拽 ──
let dragging=false, dsX=0, dsY=0, bL=0, bT=0, posInit=false;
function initMascotPosition(){
  const r=mascotImg.getBoundingClientRect();
  bL=r.left; bT=r.top;
  mascotImg.style.right='auto'; mascotImg.style.bottom='auto';
  mascotImg.style.left=bL+'px'; mascotImg.style.top=bT+'px';
  syncMascotBubblePosition();
  posInit=true;
}
mascotImg.addEventListener('mousedown',e=>{
  if(!posInit) initMascotPosition();
  dragging=true; dsX=e.clientX; dsY=e.clientY;
  const r=mascotImg.getBoundingClientRect(); bL=r.left; bT=r.top;
  mascotImg.classList.add('dragging'); e.preventDefault();
});
mascotImg.addEventListener('touchstart',e=>{
  if(!posInit) initMascotPosition();
  dragging=true; const t=e.touches[0]; dsX=t.clientX; dsY=t.clientY;
  const r=mascotImg.getBoundingClientRect(); bL=r.left; bT=r.top;
  mascotImg.classList.add('dragging'); e.preventDefault();
},{passive:false});
document.addEventListener('mousemove',e=>{
  if(!dragging) return;
  mascotImg.style.left=(bL+e.clientX-dsX)+'px';
  mascotImg.style.top=(bT+e.clientY-dsY)+'px';
  syncMascotBubblePosition();
});
document.addEventListener('touchmove',e=>{
  if(!dragging) return;
  const t=e.touches[0];
  mascotImg.style.left=(bL+t.clientX-dsX)+'px';
  mascotImg.style.top=(bT+t.clientY-dsY)+'px';
  syncMascotBubblePosition();
},{passive:false});
document.addEventListener('mouseup',e=>{
  if(!dragging) return;
  const dx=e.clientX-dsX, dy=e.clientY-dsY;
  if(Math.abs(dx)<5&&Math.abs(dy)<5){ triggerBearBoost(); }
  dragging=false; mascotImg.classList.remove('dragging');
});
document.addEventListener('touchend',e=>{
  if(!dragging) return;
  const t=e.changedTouches[0];
  const dx=(t?t.clientX:dsX)-dsX, dy=(t?t.clientY:dsY)-dsY;
  if(Math.abs(dx)<5&&Math.abs(dy)<5){ triggerBearBoost(); }
  dragging=false; mascotImg.classList.remove('dragging');
});
