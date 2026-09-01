const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));

const MAP = {
  width: 1400,
  height: 800,
  siteA: { x: 1080, y: 80, w: 180, h: 180, name: 'A' },
  siteB: { x: 1080, y: 540, w: 180, h: 180, name: 'B' },
  ctSpawn: { x: 100, y: 400 },
  trSpawn: { x: 1300, y: 400 },
  walls: [
    // Paredes Externas
    { x: 0, y: 0, w: 1400, h: 20 }, { x: 0, y: 780, w: 1400, h: 20 },
    { x: 0, y: 0, w: 20, h: 800 }, { x: 1380, y: 0, w: 20, h: 800 },
    
    // Obstáculos do Meio e Corredores (Layout Competitivo)
    { x: 250, y: 150, w: 140, h: 180 }, { x: 250, y: 470, w: 140, h: 180 },
    { x: 500, y: 0, w: 50, h: 320 },   { x: 500, y: 480, w: 50, h: 320 },
    { x: 700, y: 260, w: 200, h: 280 }, // Bloco Central Mid
    { x: 980, y: 140, w: 60, h: 100 },  // Cobertura Site A
    { x: 980, y: 560, w: 60, h: 100 },  // Cobertura Site B
    { x: 1180, y: 320, w: 100, h: 160 } // Caixas Fundo TR
  ]
};

const gameState = {
  players: {},
  bullets: [],
  grenades: [],
  activeEffects: {
    smokes: [],
    molotovs: []
  },
  c4: {
    status: 'carried',
    x: 0, y: 0, carrierId: null, plantProgress: 0, defuseProgress: 0, timer: 40, lethalRadius: 400
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

function dropC4IfCarried(p) {
  if (p.hasC4) {
    p.hasC4 = false;
    gameState.c4.status = 'dropped';
    gameState.c4.x = p.x;
    gameState.c4.y = p.y;
    gameState.c4.carrierId = null;
  }
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
            dropC4IfCarried(p);
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
    lastShot: 0,
    lastGrenade: 0
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
        team: p.team
      });
    }
  });

  socket.on('throwGrenade', (data) => {
    const p = gameState.players[socket.id];
    if (!p || !p.alive) return;
    const now = Date.now();
    if (now - p.lastGrenade < 800) return; // Cooldown de arremesso
    p.lastGrenade = now;

    const dx = data.targetX - p.x;
    const dy = data.targetY - p.y;
    const dist = Math.min(Math.hypot(dx, dy), 380);
    const angle = Math.atan2(dy, dx);

    gameState.grenades.push({
      type: data.type,
      x: p.x,
      y: p.y,
      targetX: p.x + Math.cos(angle) * dist,
      targetY: p.y + Math.sin(angle) * dist,
      speed: 12
    });
  });

  socket.on('disconnect', () => {
    const p = gameState.players[socket.id];
    if (p) dropC4IfCarried(p);
    delete gameState.players[socket.id];
  });
});

// Loop principal (60 FPS)
setInterval(() => {
  const now = Date.now();

  // Coleta C4
  if (gameState.c4.status === 'dropped') {
    Object.values(gameState.players).forEach(p => {
      if (p.alive && p.team === 'TR' && !p.hasC4 && Math.hypot(p.x - gameState.c4.x, p.y - gameState.c4.y) < 25) {
        p.hasC4 = true;
        gameState.c4.status = 'carried';
        gameState.c4.carrierId = p.id;
      }
    });
  }

  // Movimento e Ações
  Object.values(gameState.players).forEach(p => {
    if (!p.alive) return;
    const speed = 2.4;
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

    // Plant / Defuse
    if (p.inputs.e) {
      const inSite = isInside(p.x, p.y, MAP.siteA) || isInside(p.x, p.y, MAP.siteB);
      
      // Plant C4 (Exatos 4.0 Segundos)
      if (p.team === 'TR' && p.hasC4 && inSite && (gameState.c4.status === 'carried' || gameState.c4.status === 'planting')) {
        gameState.c4.status = 'planting';
        gameState.c4.carrierId = p.id;
        gameState.c4.plantProgress += (100 / (4.0 * 60));
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

      // Defuse C4 (Exatos 5.0 Segundos)
      if (p.team === 'CT' && (gameState.c4.status === 'planted' || gameState.c4.status === 'defusing')) {
        if (Math.hypot(p.x - gameState.c4.x, p.y - gameState.c4.y) < 40) {
          gameState.c4.status = 'defusing';
          gameState.c4.defuseProgress += (100 / (5.0 * 60));
          if (gameState.c4.defuseProgress >= 100) {
            gameState.c4.status = 'defused';
            gameState.c4.defuseProgress = 0;
            if (c4TickInterval) clearInterval(c4TickInterval);
          }
        }
      }
    } else {
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

  // Atualização de Granadas em Voo
  for (let i = gameState.grenades.length - 1; i >= 0; i--) {
    const g = gameState.grenades[i];
    const dx = g.targetX - g.x;
    const dy = g.targetY - g.y;
    const dist = Math.hypot(dx, dy);

    if (dist < g.speed) {
      g.x = g.targetX;
      g.y = g.targetY;
      
      // Detonação
      if (g.type === 'smoke') {
        gameState.activeEffects.smokes.push({ x: g.x, y: g.y, radius: 95, expiresAt: now + 12000 });
      } else if (g.type === 'molotov') {
        gameState.activeEffects.molotovs.push({ x: g.x, y: g.y, radius: 80, expiresAt: now + 7000 });
      } else if (g.type === 'he') {
        Object.values(gameState.players).forEach(p => {
          if (!p.alive) return;
          const d = Math.hypot(p.x - g.x, p.y - g.y);
          if (d < 110) {
            p.hp -= Math.floor((1 - d / 110) * 80);
            if (p.hp <= 0) { p.hp = 0; p.alive = false; dropC4IfCarried(p); }
          }
        });
      } else if (g.type === 'flash') {
        io.emit('flashEvent', { x: g.x, y: g.y, radius: 450 });
      }
      gameState.grenades.splice(i, 1);
    } else {
      const angle = Math.atan2(dy, dx);
      g.x += Math.cos(angle) * g.speed;
      g.y += Math.sin(angle) * g.speed;
    }
  }

  // Efeitos Ativos (Smoke / Fogo)
  gameState.activeEffects.smokes = gameState.activeEffects.smokes.filter(s => s.expiresAt > now);
  gameState.activeEffects.molotovs = gameState.activeEffects.molotovs.filter(m => {
    if (m.expiresAt <= now) return false;
    Object.values(gameState.players).forEach(p => {
      if (p.alive && Math.hypot(p.x - m.x, p.y - m.y) < m.radius) {
        p.hp -= 0.5; // Dano do Fogo
        if (p.hp <= 0) { p.hp = 0; p.alive = false; dropC4IfCarried(p); }
      }
    });
    return true;
  });

  // Projetéis de Tiros
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
          if (p.hp <= 0) { p.hp = 0; p.alive = false; dropC4IfCarried(p); }
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