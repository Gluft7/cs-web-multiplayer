const socket = io();
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const keys = { w: false, a: false, s: false, d: false, e: false };
let mousePos = { x: 0, y: 0 };
let localAngle = 0;
let latestState = { players: {}, bullets: [], c4: {} };

const MAP = {
  siteA: { x: 380, y: 80, w: 120, h: 120, name: 'A' },
  siteB: { x: 380, y: 450, w: 120, h: 120, name: 'B' },
  walls: [
    { x: 0, y: 0, w: 1000, h: 20 }, { x: 0, y: 630, w: 1000, h: 20 },
    { x: 0, y: 0, w: 20, h: 650 }, { x: 980, y: 0, w: 20, h: 650 },
    { x: 220, y: 180, w: 120, h: 80 }, { x: 220, y: 390, w: 120, h: 80 },
    { x: 500, y: 240, w: 140, h: 170 }, { x: 680, y: 120, w: 100, h: 160 },
    { x: 680, y: 370, w: 100, h: 160 }
  ]
};

window.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (k in keys) { keys[k] = true; sendInput(); }
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

socket.on('stateUpdate', state => {
  latestState = state;
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
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(s.name, s.x + 50, s.y + 68);
  });

  // 2. Paredes
  ctx.fillStyle = '#21262d';
  ctx.strokeStyle = '#30363d';
  MAP.walls.forEach(w => {
    ctx.fillRect(w.x, w.y, w.w, w.h);
    ctx.strokeRect(w.x, w.y, w.w, w.h);
  });

  // 3. C4 no Chão ou Plantada
  const c4 = latestState.c4;
  if (c4.status === 'dropped') {
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(c4.x - 6, c4.y - 6, 12, 12);
  } else if (c4.status === 'planted' || c4.status === 'defusing') {
    ctx.beginPath();
    ctx.arc(c4.x, c4.y, c4.lethalRadius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 0, 0, 0.06)';
    ctx.fill();
    ctx.strokeStyle = (Math.floor(Date.now() / 300) % 2 === 0) ? 'rgba(255, 50, 50, 0.5)' : 'rgba(255, 0, 0, 0.2)';
    ctx.setLineDash([8, 8]);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = (Math.floor(Date.now() / 200) % 2 === 0) ? '#ff0000' : '#ffffff';
    ctx.beginPath(); ctx.arc(c4.x, c4.y, 7, 0, Math.PI * 2); ctx.fill();
  }

  // 4. Tiros
  ctx.fillStyle = '#ffee55';
  latestState.bullets.forEach(b => {
    ctx.beginPath(); ctx.arc(b.x, b.y, 2.5, 0, Math.PI * 2); ctx.fill();
  });

  // 5. Jogadores + FOV
  Object.values(latestState.players).forEach(p => {
    if (!p.alive) return;

    // CAMPO DE VISÃO (FOV) PARA TODOS OS JOGADORES
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 220, -Math.PI / 4, Math.PI / 4); // 90° FOV, Alcance 220px
    ctx.closePath();
    ctx.fillStyle = p.team === 'CT' ? 'rgba(0, 170, 255, 0.12)' : 'rgba(255, 204, 0, 0.12)';
    ctx.fill();

    // Arma
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, -2, 18, 4);
    ctx.restore();

    // Corpo do Jogador
    ctx.beginPath();
    ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
    ctx.fillStyle = p.team === 'CT' ? '#0099ff' : '#ffaa00';
    ctx.fill();
    ctx.strokeStyle = p.id === socket.id ? '#ffffff' : '#000000';
    ctx.lineWidth = p.id === socket.id ? 2.5 : 1;
    ctx.stroke();

    // Indicador de C4 nas costas do TR
    if (p.hasC4) {
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(p.x - 4, p.y - 4, 8, 8);
    }

    // Barra de Vida
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(p.x - 15, p.y - 22, 30, 4);
    ctx.fillStyle = p.hp > 40 ? '#00ff88' : '#ff3344';
    ctx.fillRect(p.x - 15, p.y - 22, (p.hp / 100) * 30, 4);
  });

  // 6. UI do Progresso de Plant/Defuse
  if (c4.status === 'planting' || c4.status === 'defusing') {
    const isPlanting = c4.status === 'planting';
    const progress = isPlanting ? c4.plantProgress : c4.defuseProgress;
    const label = isPlanting ? 'PLANTANDO C4...' : 'DEFUSANDO C4...';
    const color = isPlanting ? '#ff3300' : '#00aaff';

    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillRect(350, 560, 300, 22);
    ctx.fillStyle = color;
    ctx.fillRect(350, 560, (Math.min(100, progress) / 100) * 300, 22);
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(350, 560, 300, 22);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, 500, 575);
  }

  // 7. HUD Superior
  const ctAlive = Object.values(latestState.players).filter(p => p.team === 'CT' && p.alive).length;
  const trAlive = Object.values(latestState.players).filter(p => p.team === 'TR' && p.alive).length;

  ctx.fillStyle = 'rgba(15, 20, 28, 0.85)';
  ctx.fillRect(350, 10, 300, 40);
  ctx.strokeStyle = '#30363d';
  ctx.strokeRect(350, 10, 300, 40);

  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#00aaff'; ctx.fillText(`CT: ${ctAlive}`, 400, 35);
  ctx.fillStyle = '#ffcc00'; ctx.fillText(`TR: ${trAlive}`, 600, 35);

  if (c4.status === 'planted' || c4.status === 'defusing') {
    ctx.fillStyle = (Math.floor(Date.now() / 250) % 2 === 0) ? '#ff3333' : '#ffffff';
    ctx.fillText(`💣 ${c4.timer}s`, 500, 35);
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`VS`, 500, 35);
  }

  requestAnimationFrame(render);
}

render();