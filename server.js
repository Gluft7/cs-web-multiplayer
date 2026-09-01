const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));

const MAP = {
  width: 1000,
  height: 650,
  siteA: { x: 380, y: 80, w: 120, h: 120, name: 'A' },
  siteB: { x: 380, y: 450, w: 120, h: 120, name: 'B' },
  ctSpawn: { x: 80, y: 325 },
  trSpawn: { x: 920, y: 325 },
  walls: [
    { x: 0, y: 0, w: 1000, h: 20 }, { x: 0, y: 630, w: 1000, h: 20 },
    { x: 0, y: 0, w: 20, h: 650 }, { x: 980, y: 0, w: 20, h: 650 },
    { x: 220, y: 180, w: 120, h: 80 }, { x: 220, y: 390, w: 120, h: 80 },
    { x: 500, y: 240, w: 140, h: 170 }, { x: 680, y: 120, w: 100, h: 160 },
    { x: 680, y: 370, w: 100, h: 160 }
  ]
};

const gameState = {
  players: {},
  bullets: [],
  c4: {
    status: 'carried', // 'carried', 'dropped', 'planting', 'planted', 'defusing', 'defused', 'exploded'
    x: 0, y: 0, carrierId: null, plantProgress: 0, defuseProgress: 0, timer: 40, lethalRadius: 350
  }
};

let c4TickInterval = null;

function circleRectCollision(cx, cy, radius, rect) {
  const nearestX = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const nearestY = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  const dx = cx - nearestX;
  const dy = cy - nearestY;
  return (dx * dx + dy * dy) < (radius * radius);
}

function isInside(x, y, rect) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

function startC4Timer() {
  gameState.c4.timer = 40;
  if (c4TickInterval) clearInterval(c4TickInterval);
  c4TickInterval = setInterval(() => {
    if (gameState.c4.status === 'planted' || gameState.c4.status === 'defusing') {
      gameState.c4.timer--;
      if (gameState.c4.timer <= 0) {
        gameState.c4.status = 'exploded';
        Object.values(gameState.players).forEach(p => {
          if (p.alive && Math.hypot(p.x - gameState.c4.x, p.y - gameState.c4.y) <= gameState.c4.lethalRadius) {
            p.hp = 0;
            p.alive = false;
          }
        });
        clearInterval(c4TickInterval);
      }
    }
  }, 1000);
}

io.on('connection', (socket) => {
  const trCount = Object.values(gameState.players).filter(p => p.team === 'TR').length;
  const ctCount = Object.values(gameState.players).filter(p => p.team === 'CT').length;
  const team = trCount <= ctCount ? 'TR' : 'CT';
  const spawn = team === 'CT' ? MAP.ctSpawn : MAP.trSpawn;

  gameState.players[socket.id] = {
    id: socket.id,
    team: team,
    x: spawn.x + (Math.random() * 40 - 20),
    y: spawn.y + (Math.random() * 40 - 20),
    angle: 0,
    hp: 100,
    alive: true,
    hasC4: false,
    inputs: { w: false, a: false, s: false, d: false, e: false },
    lastShot: 0
  };

  if (team === 'TR' && !gameState.c4.carrierId && (gameState.c4.status === 'carried' || gameState.c4.status === 'dropped')) {
    gameState.players[socket.id].hasC4 = true;
    gameState.c4.carrierId = socket.id;
    gameState.c4.status = 'carried';
  }

  socket.on('playerInput', (inputs) => {
    const p = gameState.players[socket.id];
    if (p) {
      p.inputs = inputs.keys || p.inputs;
      p.angle = inputs.angle || p.angle;
    }
  });

  socket.on('shoot', () => {
    const p = gameState.players[socket.id];
    if (!p || !p.alive) return;
    const now = Date.now();
    if (now - p.lastShot > 130) {
      p.lastShot = now;
      gameState.bullets.push({
        x: p.x + Math.cos(p.angle) * 20,
        y: p.y + Math.sin(p.angle) * 20,
        vx: Math.cos(p.angle + (Math.random() - 0.5) * 0.05) * 15,
        vy: Math.sin(p.angle + (Math.random() - 0.5) * 0.05) * 15,
        ownerId: socket.id,
        team: p.team
      });
    }
  });

  socket.on('disconnect', () => {
    const p = gameState.players[socket.id];
    if (p && p.hasC4) {
      gameState.c4.status = 'dropped';
      gameState.c4.x = p.x;
      gameState.c4.y = p.y;
      gameState.c4.carrierId = null;
    }
    delete gameState.players[socket.id];
  });
});

// Loop do Servidor (60 Ticks / segundo)
setInterval(() => {
  // Coletar C4 do chão se TR passar por cima
  if (gameState.c4.status === 'dropped') {
    Object.values(gameState.players).forEach(p => {
      if (p.alive && p.team === 'TR' && !p.hasC4 && Math.hypot(p.x - gameState.c4.x, p.y - gameState.c4.y) < 25) {
        p.hasC4 = true;
        gameState.c4.status = 'carried';
        gameState.c4.carrierId = p.id;
      }
    });
  }

  // 1. Movimentação e Ações
  Object.values(gameState.players).forEach(p => {
    if (!p.alive) return;
    const speed = 2.2;
    let dx = 0, dy = 0;

    if (p.inputs.w) dy -= 1;
    if (p.inputs.s) dy += 1;
    if (p.inputs.a) dx -= 1;
    if (p.inputs.d) dx += 1;

    if (dx !== 0 && dy !== 0) { dx *= 0.7071; dy *= 0.7071; }

    p.x += dx * speed;
    MAP.walls.forEach(w => { if (circleRectCollision(p.x, p.y, 14, w)) p.x -= dx * speed; });

    p.y += dy * speed;
    MAP.walls.forEach(w => { if (circleRectCollision(p.x, p.y, 14, w)) p.y -= dy * speed; });

    // Lógica da Tecla E (Plantar / Defusar C4)
    if (p.inputs.e) {
      const inSite = isInside(p.x, p.y, MAP.siteA) || isInside(p.x, p.y, MAP.siteB);
      
      // TR Plantando C4
      if (p.team === 'TR' && p.hasC4 && inSite && (gameState.c4.status === 'carried' || gameState.c4.status === 'planting')) {
        gameState.c4.status = 'planting';
        gameState.c4.carrierId = p.id;
        gameState.c4.plantProgress += (100 / (3.2 * 60)); // ~3.2 segundos
        if (gameState.c4.plantProgress >= 100) {
          gameState.c4.status = 'planted';
          gameState.c4.x = p.x;
          gameState.c4.y = p.y;
          p.hasC4 = false;
          gameState.c4.carrierId = null;
          gameState.c4.plantProgress = 0;
          startC4Timer();
        }
      }

      // CT Defusando C4
      if (p.team === 'CT' && (gameState.c4.status === 'planted' || gameState.c4.status === 'defusing')) {
        if (Math.hypot(p.x - gameState.c4.x, p.y - gameState.c4.y) < 40) {
          gameState.c4.status = 'defusing';
          gameState.c4.defuseProgress += (100 / (4.5 * 60)); // ~4.5 segundos
          if (gameState.c4.defuseProgress >= 100) {
            gameState.c4.status = 'defused';
            gameState.c4.defuseProgress = 0;
            if (c4TickInterval) clearInterval(c4TickInterval);
          }
        }
      }
    } else {
      // Se soltar a tecla E, reseta o progresso
      if (gameState.c4.status === 'planting' && gameState.c4.carrierId === p.id) {
        gameState.c4.status = 'carried';
        gameState.c4.plantProgress = 0;
      }
      if (gameState.c4.status === 'defusing' && p.team === 'CT') {
        gameState.c4.status = 'planted';
        gameState.c4.defuseProgress = 0;
      }
    }
  });

  // 2. Tiros
  for (let i = gameState.bullets.length - 1; i >= 0; i--) {
    const b = gameState.bullets[i];
    b.x += b.vx;
    b.y += b.vy;

    let hit = MAP.walls.some(w => circleRectCollision(b.x, b.y, 3, w));

    if (!hit) {
      Object.values(gameState.players).forEach(p => {
        if (p.alive && p.team !== b.team && Math.hypot(p.x - b.x, p.y - b.y) < 14) {
          p.hp -= 28;
          hit = true;
          if (p.hp <= 0) {
            p.hp = 0;
            p.alive = false;
            if (p.hasC4) {
              p.hasC4 = false;
              gameState.c4.status = 'dropped';
              gameState.c4.x = p.x;
              gameState.c4.y = p.y;
              gameState.c4.carrierId = null;
            }
          }
        }
      });
    }

    if (hit || b.x < 0 || b.x > MAP.width || b.y < 0 || b.y > MAP.height) {
      gameState.bullets.splice(i, 1);
    }
  }

  io.emit('stateUpdate', gameState);
}, 1000 / 60);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));