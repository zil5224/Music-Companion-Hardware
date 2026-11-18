// ═══════════════════════════════════════════════════════════════
//  CLOCK
// ═══════════════════════════════════════════════════════════════
(function tick(){
  const n=new Date();
  document.getElementById('clockDisplay').innerHTML=String(n.getHours()).padStart(2,'0')+'<span class="clock-sep">:</span>'+String(n.getMinutes()).padStart(2,'0');
  document.getElementById('dayDisplay').textContent=['SUN','MON','TUE','WED','THU','FRI','SAT'][n.getDay()];
  document.getElementById('dateDisplay').textContent=String(n.getMonth()+1).padStart(2,'0')+'/'+String(n.getDate()).padStart(2,'0');
  setTimeout(tick,1000);
})();
