// ═══════════════════════════════════════════════════════════════
//  漫天星空
// ═══════════════════════════════════════════════════════════════
(function initStarfield(){
  const cvs=document.getElementById('starfieldCanvas');
  const ctx=cvs.getContext('2d');
  let W,H;
  function resize(){ W=cvs.width=window.innerWidth; H=cvs.height=window.innerHeight; }
  resize(); window.addEventListener('resize',resize);

  const deepStars=Array.from({length:150},()=>({
    x:Math.random(), y:Math.random(), r:0.3+Math.random()*0.9,
    baseAlpha:0.06+Math.random()*0.14, freq:0.05+Math.random()*0.15
  }));
  const midStars=Array.from({length:80},()=>({
    x:Math.random(), y:Math.random(), r:0.6+Math.random()*1.6,
    baseAlpha:0.14+Math.random()*0.26, freq:0.2+Math.random()*0.6,
    hue:Math.random()<0.25?240:Math.random()<0.45?260:Math.random()<0.55?40:210
  }));
  const nearStars=Array.from({length:25},()=>({
    x:Math.random(), y:Math.random(), r:1.2+Math.random()*2.6,
    baseAlpha:0.18+Math.random()*0.32, freq:0.08+Math.random()*0.25,
    hue:Math.random()<0.35?220:Math.random()<0.5?270:Math.random()<0.6?45:30
  }));
  const nebulae=[
    {x:0.22,y:0.30,rx:0.48,ry:0.30,hue:250,alpha:0.028},
    {x:0.72,y:0.55,rx:0.40,ry:0.34,hue:210,alpha:0.024},
    {x:0.50,y:0.18,rx:0.52,ry:0.22,hue:275,alpha:0.020},
    {x:0.38,y:0.70,rx:0.35,ry:0.26,hue:230,alpha:0.018},
  ];
  const meteors=[];
  const MAX_METEORS=9;
  const meteorHues=[192,210,260,280,35,320,15,340];
  function spawnMeteor(){
    if(meteors.length>=MAX_METEORS) return;
    meteors.push({
      x:Math.random()*W*0.9, y:-20-Math.random()*120,
      vx:0.3+Math.random()*1.8, vy:1.4+Math.random()*3.0,
      life:1, decay:0.004+Math.random()*0.009, len:90+Math.random()*150,
      hue:meteorHues[Math.floor(Math.random()*meteorHues.length)], particles:[]
    });
  }
  for(let i=0;i<5;i++) spawnMeteor();
  (function scheduleMeteor(){
    setTimeout(()=>{ spawnMeteor(); scheduleMeteor(); },500+Math.random()*900);
  })();
  const stardust=Array.from({length:45},()=>({
    x:Math.random(), y:Math.random(), r:0.4+Math.random()*1.3,
    vy:-(0.01+Math.random()*0.07), vx:(Math.random()-0.5)*0.03,
    alpha:0.10+Math.random()*0.35, phase:Math.random()*Math.PI*2, freq:0.003+Math.random()*0.012
  }));

  (function draw(ts){
    requestAnimationFrame(draw);
    ctx.clearRect(0,0,W,H);
    const now=ts*0.001;
    for(const n of nebulae){
      const cx=n.x*W, cy=n.y*H, rx=n.rx*W, ry=n.ry*H;
      const grad=ctx.createRadialGradient(cx,cy,0,cx,cy,Math.max(rx,ry));
      grad.addColorStop(0,`hsla(${n.hue},75%,70%,${n.alpha.toFixed(4)})`);
      grad.addColorStop(0.45,`hsla(${n.hue},65%,55%,${(n.alpha*0.55).toFixed(4)})`);
      grad.addColorStop(1,`hsla(${n.hue},50%,30%,0)`);
      ctx.save(); ctx.translate(cx,cy); ctx.scale(rx/Math.max(rx,ry),ry/Math.max(rx,ry));
      ctx.beginPath(); ctx.arc(0,0,Math.max(rx,ry),0,Math.PI*2); ctx.fillStyle=grad; ctx.fill(); ctx.restore();
    }
    for(const s of deepStars){
      const a=s.baseAlpha+0.04*Math.sin(now*s.freq);
      ctx.beginPath(); ctx.arc(s.x*W,s.y*H,s.r,0,Math.PI*2);
      ctx.fillStyle=`rgba(195,215,245,${Math.max(0,a).toFixed(4)})`; ctx.fill();
    }
    for(const s of midStars){
      const twinkle=Math.sin(now*2.5*s.freq)*0.5+0.5;
      const a=s.baseAlpha*(0.55+0.45*twinkle), px=s.x*W, py=s.y*H;
      ctx.beginPath(); ctx.arc(px,py,s.r,0,Math.PI*2);
      ctx.fillStyle=`hsla(${s.hue},65%,80%,${Math.max(0,a).toFixed(4)})`; ctx.fill();
      if(twinkle>0.78){
        ctx.strokeStyle=`hsla(${s.hue},55%,88%,${(twinkle*0.18).toFixed(4)})`; ctx.lineWidth=0.5;
        ctx.beginPath(); ctx.moveTo(px-s.r*3.5,py); ctx.lineTo(px+s.r*3.5,py); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(px,py-s.r*3.5); ctx.lineTo(px,py+s.r*3.5); ctx.stroke();
      }
    }
    for(const s of nearStars){
      const breathe=Math.sin(now*1.8*s.freq)*0.5+0.5;
      const a=s.baseAlpha*(0.5+0.5*breathe), px=s.x*W, py=s.y*H;
      ctx.beginPath(); ctx.arc(px,py,s.r*4.5,0,Math.PI*2);
      ctx.fillStyle=`hsla(${s.hue},75%,75%,${(a*0.16).toFixed(4)})`; ctx.fill();
      ctx.beginPath(); ctx.arc(px,py,s.r,0,Math.PI*2);
      ctx.fillStyle=`hsla(${s.hue},35%,92%,${a.toFixed(4)})`; ctx.fill();
    }
    for(const d of stardust){
      d.y+=d.vy; d.x+=d.vx+Math.sin(now*0.7+d.phase)*0.015;
      if(d.y<-0.05){d.y=1.05;d.x=Math.random();}
      if(d.x<-0.05)d.x=1.05; if(d.x>1.05)d.x=-0.05;
      const flicker=Math.sin(now*3+d.phase)*0.5+0.5, a=d.alpha*(0.4+0.6*flicker);
      ctx.beginPath(); ctx.arc(d.x*W,d.y*H,d.r,0,Math.PI*2);
      ctx.fillStyle=`rgba(205,215,245,${Math.max(0,a).toFixed(4)})`; ctx.fill();
    }
    for(let i=meteors.length-1;i>=0;i--){
      const m=meteors[i];
      m.x+=m.vx; m.y+=m.vy; m.life-=m.decay;
      if(m.life<=0||m.y>H+120){meteors.splice(i,1);continue;}
      const ex=m.x, ey=m.y, angle=Math.atan2(m.vy,m.vx);
      const sx=ex-Math.cos(angle)*m.len, sy=ey-Math.sin(angle)*m.len;
      const grad=ctx.createLinearGradient(sx,sy,ex,ey);
      const h=m.hue, life=m.life;
      grad.addColorStop(0,`hsla(${h},85%,75%,0)`);
      grad.addColorStop(0.4,`hsla(${h},82%,76%,${(life*0.14).toFixed(4)})`);
      grad.addColorStop(0.8,`hsla(${h},72%,84%,${(life*0.48).toFixed(4)})`);
      grad.addColorStop(1,`hsla(${h},45%,96%,${life.toFixed(4)})`);
      ctx.beginPath(); ctx.moveTo(sx,sy); ctx.lineTo(ex,ey);
      ctx.strokeStyle=grad; ctx.lineWidth=2.4; ctx.lineCap='round'; ctx.stroke();
      ctx.beginPath(); ctx.arc(ex,ey,2.8,0,Math.PI*2);
      ctx.fillStyle=`hsla(${h},35%,98%,${life.toFixed(4)})`; ctx.fill();
      ctx.beginPath(); ctx.arc(ex,ey,7.5,0,Math.PI*2);
      ctx.fillStyle=`hsla(${h},88%,84%,${(life*0.24).toFixed(4)})`; ctx.fill();
      if(Math.random()<0.55){
        m.particles.push({
          x:ex-Math.cos(angle)*(m.len*0.25+Math.random()*m.len*0.7),
          y:ey-Math.sin(angle)*(m.len*0.25+Math.random()*m.len*0.7),
          r:0.3+Math.random()*1.2, life:0.35+Math.random()*0.55
        });
      }
      for(let j=m.particles.length-1;j>=0;j--){
        const p=m.particles[j]; p.life-=0.018;
        if(p.life<=0){m.particles.splice(j,1);continue;}
        ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
        ctx.fillStyle=`hsla(${h},80%,82%,${p.life.toFixed(4)})`; ctx.fill();
      }
    }
  })();
})();
