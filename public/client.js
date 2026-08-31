const socket = io ();
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

// Eventos de Teclado e Mouse
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

// Renderização
function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 1. Desenhar Bomb Sites
  [MAP.siteA, MAP.siteB].forEach(s => {
    ctx.fillStyle = 'rgba(255, 153, 0, 0.15)';
    ctx.strokeStyle = '#ff9900';
    ctx.fillRect(s.x, s.y, s.w, s.h);
    ctx.strokeRect(s.x, s.y, s.w, s.h);
    ctx.fillStyle = '#ff9900';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText(s.name, s.x + 50, s.y + 65);
  });

  // 2. Desenhar Paredes
  ctx.fillStyle = '#21262d';
  ctx.strokeStyle = '#30363d';
  MAP.walls.forEach(w => {
    ctx.fillRect(w.x, w.y, w.w, w.h);
    ctx.strokeRect(w.x, w.y, w.w, w.h);
  });

  // 3. Raio Mortal e C4
  const c4 = latestState.c4;
  if (c4.status === 'planted' || c4.status === 'defusing') {
    ctx.beginPath();
    ctx.arc(c4.x, c4.y, c4.lethalRadius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 0, 0, 0.05)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 0, 0, 0.3)';
    ctx.stroke();

    ctx.fillStyle = '#ff0000';
    ctx.beginPath(); ctx.arc(c4.x, c4.y, 6, 0, Math.PI * 2); ctx.fill();
  }

  // 4. Tiros
  ctx.fillStyle = '#ffee55';
  latestState.bullets.forEach(b => {
    ctx.beginPath(); ctx.arc(b.x, b.y, 3, 0, Math.PI * 2); ctx.fill();
  });

  // 5. Jogadores
  Object.values(latestState.players).forEach(p => {
    if (!p.alive) return;

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, -2, 18, 4); // Arma
    ctx.restore();

    ctx.beginPath();
    ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
    ctx.fillStyle = p.team === 'CT' ? '#0099ff' : '#ffaa00';
    ctx.fill();
    ctx.strokeStyle = p.id === socket.id ? '#ffffff' : '#000000';
    ctx.lineWidth = p.id === socket.id ? 3 : 1;
    ctx.stroke();

    // Barra de Vida
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(p.x - 15, p.y - 22, 30, 4);
    ctx.fillStyle = '#00ff88';
    ctx.fillRect(p.x - 15, p.y - 22, (p.hp / 100) * 30, 4);
  });

  requestAnimationFrame(render);
}

render();