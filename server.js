const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));

const MAP = {
  width: 1400, height: 800,
  siteA: { x: 100, y: 80, w: 200, h: 200, name: 'A' },
  siteB: { x: 1100, y: 80, w: 200, h: 200, name: 'B' },
  ctSpawn: { x: 700, y: 120 }, trSpawn: { x: 700, y: 720 },
  walls: [
    { x: 0, y: 0, w: 1400, h: 20 }, { x: 0, y: 780, w: 1400, h: 20 },
    { x: 0, y: 0, w: 20, h: 800 }, { x: 1380, y: 0, w: 20, h: 800 },
    { x: 120, y: 350, w: 250, h: 30 }, { x: 220, y: 480, w: 30, h: 180 },
    { x: 350, y: 480, w: 180, h: 30 }, { x: 250, y: 220, w: 30, h: 140 },
    { x: 380, y: 100, w: 30, h: 200 }, { x: 100, y: 560, w: 140, h: 30 },
    { x: 1030, y: 350, w: 250, h: 30 }, { x: 1150, y: 480, w: 30, h: 180 },
    { x: 870, y: 480, w: 180, h: 30 }, { x: 1120, y: 220, w: 30, h: 140 },
    { x: 990, y: 100, w: 30, h: 200 }, { x: 1160, y: 560, w: 140, h: 30 },
    { x: 450, y: 640, w: 160, h: 30 }, { x: 790, y: 640, w: 160, h: 30 },
    { x: 500, y: 280, w: 120, h: 30 }, { x: 780, y: 280, w: 120, h: 30 },
    { x: 600, y: 380, w: 200, h: 40 }, { x: 480, y: 420, w: 30, h: 150 },
    { x: 890, y: 420, w: 30, h: 150 }
  ]
};

const WEAPONS = {
  rifle:   { cooldown: 120, damage: 30, speed: 25, spread: 0.03, pellets: 1, moveSpeed: 2.5 },
  smg:     { cooldown: 80,  damage: 15, speed: 20, spread: 0.08, pellets: 1, moveSpeed: 2.8 },
  shotgun: { cooldown: 800, damage: 20, speed: 18, spread: 0.20, pellets: 8, moveSpeed: 2.4 },
  awp:     { cooldown: 1400,damage: 120,speed: 35, spread: 0.001, pellets: 1, moveSpeed: 2.0 }
};

const state = {
  players: {}, bullets: [], grenades: [], effects: [], mapWalls: MAP.walls,
  c4: { status: 'carried', x: 0, y: 0, carrierId: null, progress: 0, timer: 0 },
  round: { status: 'WARMUP', time: 30, winner: null, msg: '' }
};

function checkCollision(cx, cy, radius, rect) {
  const nearX = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const nearY = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  return (Math.pow(cx - nearX, 2) + Math.pow(cy - nearY, 2)) <= (radius * radius);
}

function resolveCollision(x, y, radius) {
  for (let wall of MAP.walls) if (checkCollision(x, y, radius, wall)) return true;
  return false;
}

function startRound() {
  state.round.status = 'LIVE'; state.round.time = 90; state.round.msg = '';
  state.bullets = []; state.grenades = []; state.effects = [];
  
  Object.values(state.players).forEach(p => {
    p.alive = true; p.hp = 100; p.hasC4 = false;
    p.grenades = { smoke: 1, flash: 1, he: 1, molotov: 1 };
    const spawn = p.team === 'CT' ? MAP.ctSpawn : MAP.trSpawn;
    p.x = spawn.x + (Math.random() * 60 - 30);
    p.y = spawn.y + (Math.random() * 60 - 30);
  });
  
  state.c4 = { status: 'carried', x: 0, y: 0, carrierId: null, progress: 0, timer: 40 };
  const trs = Object.values(state.players).filter(p => p.team === 'TR');
  if (trs.length > 0) {
    const carrier = trs[Math.floor(Math.random() * trs.length)];
    carrier.hasC4 = true; state.c4.carrierId = carrier.id;
  }
}

function endRound(winner, msg) {
  if (state.round.status === 'ENDED') return;
  state.round.status = 'ENDED'; state.round.winner = winner; state.round.msg = msg;
  setTimeout(startRound, 5000);
}

setInterval(() => {
  let totalPlayers = Object.keys(state.players).length;

  Object.values(state.players).forEach(p => {
    if (!p.alive) return;
    
    // Movimentação
    let dx = 0, dy = 0;
    if (p.keys.w) { dx += Math.cos(p.angle); dy += Math.sin(p.angle); }
    if (p.keys.s) { dx -= Math.cos(p.angle); dy -= Math.sin(p.angle); }
    if (p.keys.a) { dx += Math.cos(p.angle - Math.PI/2); dy += Math.sin(p.angle - Math.PI/2); }
    if (p.keys.d) { dx += Math.cos(p.angle + Math.PI/2); dy += Math.sin(p.angle + Math.PI/2); }
    
    const mag = Math.hypot(dx, dy);
    if (mag > 0) { dx /= mag; dy /= mag; } 

    const speed = (WEAPONS[p.weapon] || WEAPONS.rifle).moveSpeed;
    if (!resolveCollision(p.x + dx * speed, p.y, 14)) p.x += dx * speed;
    if (!resolveCollision(p.x, p.y + dy * speed, 14)) p.y += dy * speed;

    // Lógica de pegar a C4 do chão (TR apenas)
    if (p.team === 'TR' && state.c4.status === 'dropped' && Math.hypot(p.x - state.c4.x, p.y - state.c4.y) < 25) {
      p.hasC4 = true;
      state.c4.status = 'carried';
      state.c4.carrierId = p.id;
    }

    // Lógica de Plant e Defuse (Corrigida para não bugar com outros players)
    if (p.keys.e && state.round.status === 'LIVE') {
      const inA = (p.x > MAP.siteA.x && p.x < MAP.siteA.x+MAP.siteA.w && p.y > MAP.siteA.y && p.y < MAP.siteA.y+MAP.siteA.h);
      const inB = (p.x > MAP.siteB.x && p.x < MAP.siteB.x+MAP.siteB.w && p.y > MAP.siteB.y && p.y < MAP.siteB.y+MAP.siteB.h);

      if (p.team === 'TR' && p.hasC4 && (inA || inB)) {
        state.c4.status = 'planting'; state.c4.progress += (100 / (60 * 4)); 
        if (state.c4.progress >= 100) { state.c4.status = 'planted'; state.c4.x = p.x; state.c4.y = p.y; p.hasC4 = false; }
      }
      if (p.team === 'CT' && state.c4.status === 'planted' && Math.hypot(p.x - state.c4.x, p.y - state.c4.y) < 50) {
        state.c4.status = 'defusing'; state.c4.progress += (100 / (60 * 5));
        if (state.c4.progress >= 100) endRound('CT', 'BOMBA DESARMADA!');
      }
    } else {
      // Só reseta o progresso se quem estava plantando/defusando soltar o E
      if (p.hasC4 && state.c4.status === 'planting') { state.c4.status = 'carried'; state.c4.progress = 0; }
      if (p.team === 'CT' && state.c4.status === 'defusing' && Math.hypot(p.x - state.c4.x, p.y - state.c4.y) < 50) { 
        state.c4.status = 'planted'; state.c4.progress = 0; 
      }
    }
  });

  // Física e Remoção de Balas
  for (let i = state.bullets.length - 1; i >= 0; i--) {
    let b = state.bullets[i];
    let hit = false;
    for(let s = 0; s < 10; s++) {
      b.x += b.vx / 10; b.y += b.vy / 10;
      if (resolveCollision(b.x, b.y, 2)) { hit = true; break; }
      Object.values(state.players).forEach(p => {
        if (p.alive && p.team !== b.team && Math.hypot(p.x - b.x, p.y - b.y) < 14) {
          p.hp -= b.damage; hit = true;
        }
      });
      if (hit) break;
    }
    if (hit) state.bullets.splice(i, 1);
  }

  // Física de Granadas
  for (let i = state.grenades.length - 1; i >= 0; i--) {
    let g = state.grenades[i];
    if (resolveCollision(g.x + g.vx, g.y, 5)) g.vx *= -0.7; else g.x += g.vx;
    if (resolveCollision(g.x, g.y + g.vy, 5)) g.vy *= -0.7; else g.y += g.vy;
    g.vx *= 0.95; g.vy *= 0.95;
    g.timer--;

    if (g.timer <= 0) {
      if (g.type === 'smoke') state.effects.push({ type: 'smoke', x: g.x, y: g.y, life: 60 * 15, radius: 110 });
      if (g.type === 'molotov') state.effects.push({ type: 'molotov', x: g.x, y: g.y, life: 60 * 7, radius: 90 });
      if (g.type === 'he') {
        Object.values(state.players).forEach(p => {
          let dist = Math.hypot(p.x - g.x, p.y - g.y);
          if (p.alive && dist < 150) p.hp -= Math.floor((1 - dist/150) * 80);
        });
      }
      if (g.type === 'flash') {
        // Flash agora cega qualquer um (CT ou TR) que estiver no raio de 600
        Object.values(state.players).forEach(p => {
          if (p.alive && Math.hypot(p.x - g.x, p.y - g.y) < 600) {
            io.to(p.id).emit('flashEvent');
          }
        });
      }
      state.grenades.splice(i, 1);
    }
  }

  // Timer dos efeitos
  for (let i = state.effects.length - 1; i >= 0; i--) {
    state.effects[i].life--;
    if (state.effects[i].life <= 0) state.effects.splice(i, 1);
  }

  let trAlive = 0, ctAlive = 0;
  Object.values(state.players).forEach(p => {
    if (p.hp <= 0 && p.alive) { 
      p.alive = false; 
      p.hp = 0; 
      // Dropa a C4 ao morrer
      if (p.hasC4) { 
        p.hasC4 = false; 
        state.c4.status = 'dropped'; 
        state.c4.x = p.x; 
        state.c4.y = p.y; 
      } 
    }
    if (p.alive) p.team === 'TR' ? trAlive++ : ctAlive++;
  });

  if (state.round.status === 'LIVE' && totalPlayers > 1) {
    if (trAlive === 0 && state.c4.status !== 'planted') endRound('CT', 'CT VENCE!');
    else if (ctAlive === 0) endRound('TR', 'TR VENCE!');
  }

  io.emit('sync', state);
}, 1000 / 60);

setInterval(() => {
  if (state.round.status === 'LIVE' && state.c4.status !== 'planted') {
    state.round.time--;
    if (state.round.time <= 0) endRound('CT', 'TEMPO ESGOTOU!');
  }
  if (state.c4.status === 'planted' || state.c4.status === 'defusing') {
    state.c4.timer--;
    if (state.c4.timer <= 0) {
      endRound('TR', 'BOMBA EXPLODIU!');
      Object.values(state.players).forEach(p => { if (Math.hypot(p.x - state.c4.x, p.y - state.c4.y) < 450) p.hp = 0; });
    }
  }
}, 1000);

io.on('connection', socket => {
  const t = Object.keys(state.players).length === 0 ? 'TR' : 'CT';
  const spawn = t === 'CT' ? MAP.ctSpawn : MAP.trSpawn;
  
  state.players[socket.id] = { 
    id: socket.id, team: t, x: spawn.x, y: spawn.y, angle: 0, hp: 100, 
    alive: true, hasC4: false, weapon: 'rifle', keys: {}, lastShot: 0,
    grenades: { smoke: 1, flash: 1, he: 1, molotov: 1 }
  };
  
  if (Object.keys(state.players).length >= 1 && state.round.status === 'WARMUP') startRound();

  socket.on('switchTeam', () => {
    let p = state.players[socket.id];
    if (p) {
      if (p.hasC4) {
        p.hasC4 = false;
        state.c4.status = 'dropped';
        state.c4.x = p.x;
        state.c4.y = p.y;
      }
      p.team = p.team === 'CT' ? 'TR' : 'CT';
      
      const newSpawn = p.team === 'CT' ? MAP.ctSpawn : MAP.trSpawn;
      p.x = newSpawn.x + (Math.random() * 60 - 30);
      p.y = newSpawn.y + (Math.random() * 60 - 30);
      p.hp = 100;
      p.alive = true;
      p.grenades = { smoke: 1, flash: 1, he: 1, molotov: 1 };
    }
  });

  socket.on('input', data => { if (state.players[socket.id]) { state.players[socket.id].keys = data.keys; state.players[socket.id].angle = data.angle; } });
  
  socket.on('shoot', () => {
    let p = state.players[socket.id];
    if (!p || !p.alive || state.round.status !== 'LIVE') return;
    let w = WEAPONS[p.weapon];
    if (Date.now() - p.lastShot >= w.cooldown) {
      p.lastShot = Date.now();
      for (let i = 0; i < w.pellets; i++) {
        let spread = p.angle + (Math.random() - 0.5) * w.spread;
        state.bullets.push({ x: p.x, y: p.y, vx: Math.cos(spread) * w.speed, vy: Math.sin(spread) * w.speed, damage: w.damage, team: p.team });
      }
    }
  });

  socket.on('switch', w => { if (WEAPONS[w]) state.players[socket.id].weapon = w; });
  
  socket.on('grenade', type => {
    let p = state.players[socket.id];
    if (p && p.alive && p.grenades[type] > 0) {
      p.grenades[type]--;
      state.grenades.push({
        type: type, team: p.team, x: p.x, y: p.y,
        vx: Math.cos(p.angle) * 12, vy: Math.sin(p.angle) * 12, timer: 60
      });
    }
  });

  socket.on('disconnect', () => {
    if (state.players[socket.id]?.hasC4) { state.c4.status = 'dropped'; state.c4.x = state.players[socket.id].x; state.c4.y = state.players[socket.id].y; }
    delete state.players[socket.id];
  });
});

const PORT = 3000;
server.listen(PORT, () => console.log(`Rodando em http://localhost:${PORT}`));