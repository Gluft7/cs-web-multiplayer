const socket = io();
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

canvas.width = 1400;
canvas.height = 800;

const keys = { w: false, a: false, s: false, d: false, e: false };
let mousePos = { x: 0, y: 0 };
let localAngle = 0;
let flashAlpha = 0;
let latestState = { players: {}, bullets: [], grenades: [], activeEffects: { smokes: [], molotovs: [] }, c4: {} };

const MAP = {
  siteA: { x: 1080, y: 80, w: 180, h: 180, name: 'A' },
  siteB: { x: 1080, y: 540, w: 180, h: 180, name: 'B' },
  walls: [
    { x: 0, y: 0, w: 1400, h: 20 }, { x: 0, y: 780, w: 1400, h: 20 },
    { x: 0, y: 0, w: 20, h: 800 }, { x: 1380, y: 0, w: 20, h: 800 },
    { x: 250, y: 150, w: 140, h: 180 }, { x: 250, y: 470, w: 140, h: 180 },
    { x: 500, y: 0, w: 50, h: 320 },   { x: 500, y: 480, w: 50, h: 320 },
    { x: 700, y: 260, w: 200, h: 280 },
    { x: 980, y: 140, w: 60, h: 100 },  { x: 980, y: 560, w: 60, h: 100 },
    { x: 1180, y: 320, w: 100, h: 160 }
  ]
};

window.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (k in keys) { keys[k] = true; sendInput(); }

  // Teclas de Granadas
  if (['x', 'c', 'v', 'z'].includes(k)) {
    let type = '';
    if (k === 'x') type = 'smoke';
    if (k === 'c') type = 'flash';
    if (k === 'v') type = 'he';
    if (k === 'z') type = 'molotov';

    socket.emit('throwGrenade', {
      type: type,
      targetX: mousePos.x,
      targetY: mousePos.y
    });
  }
});

window.addEventListener('keyup', e => {
  const k = e.key.toLowerCase();
  if (k in keys) { keys[k] = false; sendInput(); }
});

canvas.addEventListener('mousemove', e => {
  const rect = canvas.getBoundingClientRect();
  mousePos.x = e.clientX - rect.left;
  mousePos.y = e.clientY - rect.top;

  const myPlayer = latestState.players[socket.id];
  if (myPlayer) {
    localAngle = Math.atan2(mousePos.y - myPlayer.y, mousePos.x - myPlayer.x);
    sendInput();
  }
});

canvas.addEventListener('mousedown', e => {
  if (e.button === 0) socket.emit('shoot');
});

function sendInput() {
  socket.emit('playerInput', { keys, angle: localAngle });
}

socket.on('stateUpdate', state => { latestState = state; });

socket.on('flashEvent', data => {
  const myPlayer = latestState.players[socket.id];
  if (myPlayer && myPlayer.alive) {
    const d = Math.hypot(myPlayer.x - data.x, myPlayer.y - data.y);
    if (d < data.radius) flashAlpha = 1.0; // Flash Total
  }
});

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 1. Bomb Sites
  [MAP.siteA, MAP.siteB].forEach(s => {
    ctx.fillStyle = 'rgba(255, 153, 0, 0.15)';
    ctx.strokeStyle = '#ff9900';
    ctx.lineWidth = 2;
    ctx.fillRect(s.x, s.y, s.w, s.h);
    ctx.strokeRect(s.x, s.y, s.w, s.h);
    ctx.fillStyle = '#ff9900';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText(s.name, s.x + 80, s.y + 100);
  });

  // 2. Paredes
  ctx.fillStyle = '#21262d';
  ctx.strokeStyle = '#30363d';
  MAP.walls.forEach(w => {
    ctx.fillRect(w.x, w.y, w.w, w.h);
    ctx.strokeRect(w.x, w.y, w.w, w.h);
  });

  // 3. Fogo do Molotov
  latestState.activeEffects.molotovs.forEach(m => {
    ctx.beginPath();
    ctx.arc(m.x, m.y, m.radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 68, 0, 0.45)';
    ctx.fill();
  });

  // 4. C4 no Chão/Plantada
  const c4 = latestState.c4;
  if (c4.status === 'dropped') {
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(c4.x - 6, c4.y - 6, 12, 12);
  } else if (c4.status === 'planted' || c4.status === 'defusing') {
    ctx.beginPath();
    ctx.arc(c4.x, c4.y, c4.lethalRadius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 0, 0, 0.05)';
    ctx.fill();
    ctx.fillStyle = (Math.floor(Date.now() / 200) % 2 === 0) ? '#ff0000' : '#ffffff';
    ctx.beginPath(); ctx.arc(c4.x, c4.y, 7, 0, Math.PI * 2); ctx.fill();
  }

  // 5. Tiros
  ctx.fillStyle = '#ffee55';
  latestState.bullets.forEach(b => {
    ctx.beginPath(); ctx.arc(b.x, b.y, 2.5, 0, Math.PI * 2); ctx.fill();
  });

  // 6. Granadas em Voo
  latestState.grenades.forEach(g => {
    ctx.beginPath(); ctx.arc(g.x, g.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = g.type === 'flash' ? '#ffffff' : g.type === 'smoke' ? '#aaaaaa' : '#ffaa00';
    ctx.fill();
  });

  // 7. Jogadores e FOV
  Object.values(latestState.players).forEach(p => {
    if (!p.alive) return;

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);

    // FOV 90°
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 240, -Math.PI / 4, Math.PI / 4);
    ctx.closePath();
    ctx.fillStyle = p.team === 'CT' ? 'rgba(0, 170, 255, 0.12)' : 'rgba(255, 204, 0, 0.12)';
    ctx.fill();

    // Arma
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, -2, 18, 4);
    ctx.restore();

    // Corpo
    ctx.beginPath();
    ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
    ctx.fillStyle = p.team === 'CT' ? '#0099ff' : '#ffaa00';
    ctx.fill();
    ctx.strokeStyle = p.id === socket.id ? '#ffffff' : '#000000';
    ctx.lineWidth = p.id === socket.id ? 2.5 : 1;
    ctx.stroke();

    if (p.hasC4) {
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(p.x - 4, p.y - 4, 8, 8);
    }

    // Barra HP
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(p.x - 15, p.y - 22, 30, 4);
    ctx.fillStyle = p.hp > 40 ? '#00ff88' : '#ff3344';
    ctx.fillRect(p.x - 15, p.y - 22, (p.hp / 100) * 30, 4);
  });

  // 8. Fumaça (Smoke - Desenhar por cima dos players)
  latestState.activeEffects.smokes.forEach(s => {
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(120, 130, 140, 0.94)';
    ctx.fill();
  });

  // 9. Progresso Plant/Defuse
  if (c4.status === 'planting' || c4.status === 'defusing') {
    const isPlanting = c4.status === 'planting';
    const progress = isPlanting ? c4.plantProgress : c4.defuseProgress;
    const label = isPlanting ? 'PLANTANDO C4 (4s)...' : 'DEFUSANDO C4 (5s)...';
    const color = isPlanting ? '#ff3300' : '#00aaff';

    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillRect(550, 710, 300, 22);
    ctx.fillStyle = color;
    ctx.fillRect(550, 710, (Math.min(100, progress) / 100) * 300, 22);
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(550, 710, 300, 22);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, 700, 725);
  }

  // 10. Efeito Flashbang
  if (flashAlpha > 0) {
    ctx.fillStyle = `rgba(255, 255, 255, ${flashAlpha})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    flashAlpha -= (1 / (3.0 * 60)); // Decaimento em 3s
    if (flashAlpha < 0) flashAlpha = 0;
  }

  // 11. HUD Superior
  const ctAlive = Object.values(latestState.players).filter(p => p.team === 'CT' && p.alive).length;
  const trAlive = Object.values(latestState.players).filter(p => p.team === 'TR' && p.alive).length;

  ctx.fillStyle = 'rgba(15, 20, 28, 0.85)';
  ctx.fillRect(550, 10, 300, 40);
  ctx.strokeStyle = '#30363d';
  ctx.strokeRect(550, 10, 300, 40);

  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#00aaff'; ctx.fillText(`CT: ${ctAlive}`, 600, 35);
  ctx.fillStyle = '#ffcc00'; ctx.fillText(`TR: ${trAlive}`, 800, 35);

  if (c4.status === 'planted' || c4.status === 'defusing') {
    ctx.fillStyle = (Math.floor(Date.now() / 250) % 2 === 0) ? '#ff3333' : '#ffffff';
    ctx.fillText(`💣 ${c4.timer}s`, 700, 35);
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`VS`, 700, 35);
  }

  requestAnimationFrame(render);
}

render();