const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const MAP_WIDTH = 1600;
const MAP_HEIGHT = 1000;

const mapWalls = [
  { x: 0, y: 0, w: 1600, h: 20 },
  { x: 0, y: 0, w: 20, h: 1000 },
  { x: 1580, y: 0, w: 20, h: 1000 },
  { x: 0, y: 980, w: 1600, h: 20 },
  { x: 400, y: 200, w: 300, h: 40 },
  { x: 900, y: 200, w: 300, h: 40 },
  { x: 760, y: 350, w: 80, h: 300 },
  { x: 300, y: 650, w: 400, h: 40 },
  { x: 900, y: 650, w: 400, h: 40 }
];

const BOMBSITES = [
  { x: 100, y: 80, w: 200, h: 200, name: 'A' },
  { x: 1100, y: 80, w: 200, h: 200, name: 'B' }
];

const WEAPONS = {
  rifle:   { name: 'Rifle', fireRate: 160, damage: 32, maxRange: 1200, speed: 18, radius: 3 },
  smg:     { name: 'SMG',   fireRate: 120, damage: 20, maxRange: 800,  speed: 16, radius: 3 },
  shotgun: { name: 'Shotgun', fireRate: 850, damage: 18, pellets: 6, maxRange: 320, speed: 14, radius: 3 },
  awp:     { name: 'AWP',   fireRate: 2000, damage: 115, maxRange: 2000, speed: 28, radius: 4 },
  c4:      { name: 'C4',    fireRate: 9999, damage: 0, maxRange: 0, speed: 0, radius: 0 }
};

let players = {};
let queue = [];
let roomOwnerId = null;
let matchActive = false;
let roundEnding = false;
let scores = { TR: 0, CT: 0 };
let roundTimer = 115;
let buyPhaseTimer = 6;
let buyPhaseActive = false;
let roundInterval = null;
let secondTimerInterval = null;
let tracers = []; 
let grenades = [];
let effects = [];
let deadBodies = []; 

let c4 = {
  x: 0, y: 0,
  status: 'dropped',
  carrierId: null,
  defuserId: null,
  timer: 40 * 60,
  progress: 0
};

// --- FUNÇÕES MATEMÁTICAS HITSCAN ---
function getLineIntersection(p0_x, p0_y, p1_x, p1_y, p2_x, p2_y, p3_x, p3_y) {
  let s1_x = p1_x - p0_x, s1_y = p1_y - p0_y;
  let s2_x = p3_x - p2_x, s2_y = p3_y - p2_y;
  let denom = (-s2_x * s1_y + s1_x * s2_y);
  if (denom === 0) return null;
  let s = (-s1_y * (p0_x - p2_x) + s1_x * (p0_y - p2_y)) / denom;
  let t = ( s2_x * (p0_y - p2_y) - s2_y * (p0_x - p2_x)) / denom;
  if (s >= 0 && s <= 1 && t >= 0 && t <= 1) return { x: p0_x + (t * s1_x), y: p0_y + (t * s1_y) };
  return null;
}

function getClosestWallHit(x1, y1, x2, y2, walls) {
  let closestDist = Infinity;
  let closestHit = { x: x2, y: y2 };
  for (let w of walls) {
    let lines = [
      [w.x, w.y, w.x + w.w, w.y], 
      [w.x, w.y + w.h, w.x + w.w, w.y + w.h], 
      [w.x, w.y, w.x, w.y + w.h], 
      [w.x + w.w, w.y, w.x + w.w, w.y + w.h] 
    ];
    for (let l of lines) {
      let hit = getLineIntersection(x1, y1, x2, y2, l[0], l[1], l[2], l[3]);
      if (hit) {
        let d = Math.hypot(hit.x - x1, hit.y - y1);
        if (d < closestDist) {
          closestDist = d;
          closestHit = hit;
        }
      }
    }
  }
  return { hit: closestHit, dist: closestDist };
}

function lineIntersectsCircleCoords(x1, y1, x2, y2, cx, cy, r) {
  let dx = x2 - x1, dy = y2 - y1;
  let len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    let d = Math.hypot(cx - x1, cy - y1);
    return { hit: d <= r, dist: d };
  }
  let t = Math.max(0, Math.min(1, ((cx - x1) * dx + (cy - y1) * dy) / len2));
  let projX = x1 + t * dx, projY = y1 + t * dy;
  let d2 = Math.hypot(cx - projX, cy - projY);
  if (d2 <= r) {
    return { hit: true, dist: Math.hypot(projX - x1, projY - y1) };
  }
  return { hit: false };
}

function checkWallCollision(x, y, radius) {
  for (let w of mapWalls) {
    if (x + radius > w.x && x - radius < w.x + w.w && y + radius > w.y && y - radius < w.y + w.h) {
      return true;
    }
  }
  return false;
}

function killPlayer(p) {
  if (!p.alive || roundEnding) return;
  p.hp = 0;
  p.alive = false;
  
  p.deathTime = Date.now();
  deadBodies.push({ x: p.x, y: p.y, team: p.team });

  if (p.hasC4) {
    p.hasC4 = false;
    c4.status = 'dropped';
    c4.x = p.x;
    c4.y = p.y;
    c4.carrierId = null;
    p.weapon = p.primaryWeapon;
  }
}

io.on('connection', socket => {
  players[socket.id] = {
    id: socket.id,
    nickname: 'Player',
    x: 200, y: 500, angle: 0,
    team: 'TR', hp: 100, alive: true, inMatch: false,
    primaryWeapon: 'rifle', weapon: 'rifle',
    grenades: { molotov: 0, smoke: 0, flash: 0, he: 0 },
    lastShotTime: 0, hasC4: false,
    radius: 14, speed: 3.5,
    keys: { w: false, a: false, s: false, d: false, e: false, click: false }
  };

  if (!roomOwnerId) roomOwnerId = socket.id;

  socket.on('setNickname', name => {
    let p = players[socket.id];
    if (p && !p.inMatch) p.nickname = name || 'Player';
  });

  socket.on('joinQueue', () => {
    if (!queue.includes(socket.id)) { 
      queue.push(socket.id); 
      if (!roomOwnerId) roomOwnerId = socket.id; 
    }
    broadcastQueue();
  });

  socket.on('leaveQueue', () => {
    queue = queue.filter(id => id !== socket.id);
    if (roomOwnerId === socket.id) roomOwnerId = queue[0] || Object.keys(players)[0] || null;
    if (players[socket.id]) players[socket.id].inMatch = false;
    broadcastQueue();
  });

  socket.on('manualStartMatch', () => {
    if (socket.id === roomOwnerId || !roomOwnerId) {
      startMatch();
    }
  });

  socket.on('input', data => {
    let p = players[socket.id];
    if (p && p.alive && p.inMatch && !roundEnding) {
      p.keys = data.keys || p.keys;
      if (data.angle !== undefined && !isNaN(data.angle)) p.angle = data.angle;
    }
  });

  socket.on('buyItem', item => {
    let p = players[socket.id];
    if (!p || !p.inMatch || !p.alive || roundEnding) return;

    let activeCount = Object.values(players).filter(pl => pl.inMatch).length;
    if (!buyPhaseActive && activeCount > 1) return;

    if (WEAPONS[item] && item !== 'c4') {
      p.primaryWeapon = item;
      p.weapon = item;
    } else if (['molotov', 'smoke', 'flash', 'he'].includes(item)) {
      const limits = { flash: 2, molotov: 1, smoke: 1, he: 1 };
      let current = p.grenades[item] || 0;
      if (current < limits[item]) {
        p.grenades[item] = current + 1;
      }
    }
  });

  socket.on('switch', targetWeapon => { 
    let p = players[socket.id]; 
    if (!p || !p.alive || !p.inMatch || roundEnding) return;

    let isPlanting = (c4.status === 'planting' && c4.carrierId === p.id);
    let isDefusing = (c4.status === 'defusing' && c4.defuserId === p.id);
    if (isPlanting || isDefusing) return;

    if (targetWeapon === 'c4') {
      if (p.hasC4) p.weapon = 'c4';
    } else if (targetWeapon === p.primaryWeapon) {
      p.weapon = p.primaryWeapon;
    }
  });

  socket.on('shoot', () => {
    let p = players[socket.id];
    let activeCount = Object.values(players).filter(pl => pl.inMatch).length;
    if (!p || !p.alive || !p.inMatch || p.weapon === 'c4' || roundEnding) return;
    if (buyPhaseActive && activeCount > 1) return;

    let isPlanting = (c4.status === 'planting' && c4.carrierId === p.id);
    let isDefusing = (c4.status === 'defusing' && c4.defuserId === p.id);
    if (isPlanting || isDefusing) return;

    let now = Date.now();
    let wData = WEAPONS[p.weapon] || WEAPONS.rifle;
    if (now - p.lastShotTime < wData.fireRate) return;
    p.lastShotTime = now;

    function processHitscanShot(angle) {
      let endX = p.x + Math.cos(angle) * wData.maxRange;
      let endY = p.y + Math.sin(angle) * wData.maxRange;
      
      let wallHit = getClosestWallHit(p.x, p.y, endX, endY, mapWalls);
      let actualEndX = wallHit.hit.x;
      let actualEndY = wallHit.hit.y;
      
      let hitPlayer = null;
      let closestEnemyDist = Infinity;
      
      for (let target of Object.values(players)) {
        if (target.inMatch && target.alive && target.id !== p.id) {
           let res = lineIntersectsCircleCoords(p.x, p.y, actualEndX, actualEndY, target.x, target.y, target.radius + wData.radius);
           if (res.hit && res.dist < closestEnemyDist) {
              closestEnemyDist = res.dist;
              hitPlayer = target;
           }
        }
      }

      if (hitPlayer) {
        actualEndX = p.x + Math.cos(angle) * closestEnemyDist;
        actualEndY = p.y + Math.sin(angle) * closestEnemyDist;
        let dmg = Math.round(wData.damage * Math.max(0.2, 1 - (closestEnemyDist / wData.maxRange)));
        hitPlayer.hp -= dmg;
        if (hitPlayer.hp <= 0) killPlayer(hitPlayer);
      }
      tracers.push({ startX: p.x, startY: p.y, endX: actualEndX, endY: actualEndY, duration: 6 });
    }

    if (p.weapon === 'shotgun') {
      for (let i = -3; i <= 3; i++) processHitscanShot(p.angle + (i * 0.08));
    } else {
      processHitscanShot(p.angle);
    }
  });

  socket.on('grenade', data => {
    let p = players[socket.id];
    let activeCount = Object.values(players).filter(pl => pl.inMatch).length;
    if (!p || !p.alive || !p.inMatch || roundEnding) return;
    if (buyPhaseActive && activeCount > 1) return;

    let isPlanting = (c4.status === 'planting' && c4.carrierId === p.id);
    let isDefusing = (c4.status === 'defusing' && c4.defuserId === p.id);
    if (isPlanting || isDefusing) return;

    if (!p.grenades[data.type] || p.grenades[data.type] <= 0) return;
    p.grenades[data.type]--;

    let tx = data.targetX;
    let ty = data.targetY;
    let dist = Math.min(1200, Math.hypot(tx - p.x, ty - p.y));
    let angle = Math.atan2(ty - p.y, tx - p.x);
    let initialVel = dist / 16.5;

    grenades.push({ 
      x: p.x, y: p.y, 
      vx: Math.cos(angle) * initialVel, 
      vy: Math.sin(angle) * initialVel, 
      type: data.type, 
      throwType: data.throwType || 'jump',
      timer: 80, 
      ownerId: p.id 
    });
  });

  socket.on('quitMatch', () => {
    let p = players[socket.id];
    if (p && p.inMatch) {
      killPlayer(p); 
      p.inMatch = false; 
      queue = queue.filter(id => id !== socket.id);
      broadcastQueue();
    }
  });

  socket.on('disconnect', () => {
    let p = players[socket.id];
    if (p && p.hasC4) {
      c4.status = 'dropped'; c4.x = p.x; c4.y = p.y; c4.carrierId = null; c4.defuserId = null;
    }
    queue = queue.filter(id => id !== socket.id);
    delete players[socket.id];
    if (roomOwnerId === socket.id) roomOwnerId = queue[0] || Object.keys(players)[0] || null;
    broadcastQueue();
  });

  broadcastQueue();
});

function broadcastQueue() {
  io.emit('queueUpdate', { 
    count: queue.length, max: 10, ownerId: roomOwnerId, 
    players: queue.map(id => ({ id, nickname: players[id] ? players[id].nickname : 'Player' })) 
  });
}

function startMatch() {
  matchActive = true;
  scores = { TR: 0, CT: 0 };
  let targetIds = queue.length > 0 ? queue : Object.keys(players);
  if (targetIds.length === 0) return;

  // Calibra / Balanceia os times automaticamente
  if (targetIds.length > 1) {
    targetIds.forEach((id, index) => {
      if (players[id]) {
        players[id].inMatch = true;
        players[id].team = (index % 2 === 0) ? 'TR' : 'CT';
      }
    });
  } else {
    if (players[targetIds[0]]) {
      players[targetIds[0]].inMatch = true;
      players[targetIds[0]].team = 'TR'; // Sozinho vai pra TR pra testar plant
    }
  }

  io.emit('matchStart');
  startRound();

  if (secondTimerInterval) clearInterval(secondTimerInterval);
  secondTimerInterval = setInterval(() => {
    if (roundEnding) return;
    let activeCount = Object.values(players).filter(pl => pl.inMatch).length;

    if (buyPhaseActive) {
      if (activeCount > 1) {
        buyPhaseTimer--;
        if (buyPhaseTimer <= 0) buyPhaseActive = false;
      } else {
        buyPhaseTimer = 999;
      }
    } else {
      if (roundTimer > 0 && c4.status !== 'planted' && c4.status !== 'defusing') {
        roundTimer--;
      }
    }
  }, 1000);

  if (roundInterval) clearInterval(roundInterval);
  roundInterval = setInterval(gameLoop, 1000 / 60);
}

function startRound() {
  roundTimer = 115;
  buyPhaseTimer = 6;
  buyPhaseActive = true;
  roundEnding = false;

  c4 = { status: 'dropped', carrierId: null, defuserId: null, progress: 0, timer: 40 * 60, x: 150, y: 500 };
  tracers = []; grenades = []; effects = []; deadBodies = []; 

  // CT Respawn Direita | TR Respawn Esquerda
  let ctSpawns = [{ x: 1400, y: 500 }, { x: 1450, y: 450 }, { x: 1450, y: 550 }];
  let trSpawns = [{ x: 150, y: 500 }, { x: 100, y: 450 }, { x: 100, y: 550 }];
  let ctIdx = 0, trIdx = 0;
  
  let trPlayers = [];

  Object.values(players).forEach(p => {
    if (p.inMatch) {
      p.hp = 100; p.alive = true; p.hasC4 = false; p.deathTime = null;
      p.weapon = p.primaryWeapon || 'rifle';
      p.grenades = { molotov: 0, smoke: 0, flash: 0, he: 0 };
      // Limpa os inputs da rodada passada
      p.keys = { w: false, a: false, s: false, d: false, e: false, click: false }; 

      if (p.team === 'CT') { 
        p.x = ctSpawns[ctIdx % ctSpawns.length].x; 
        p.y = ctSpawns[ctIdx % ctSpawns.length].y; 
        ctIdx++; 
      } else { 
        p.x = trSpawns[trIdx % trSpawns.length].x; 
        p.y = trSpawns[trIdx % trSpawns.length].y; 
        trIdx++; 
        trPlayers.push(p.id); 
      }
    }
  });

  if (trPlayers.length > 0) {
    let chosenId = trPlayers[Math.floor(Math.random() * trPlayers.length)];
    c4.carrierId = chosenId;
    c4.status = 'carried';
    players[chosenId].hasC4 = true;
  }

  io.emit('roundStart');
}

function endRound(winnerTeam, reason) {
  if (roundEnding) return;
  roundEnding = true;
  scores[winnerTeam]++;

  io.emit('roundEnd', { winner: winnerTeam, reason: reason, scores: scores });

  // Reseta o round depois de 5 segundos
  setTimeout(() => {
    startRound();
  }, 5000);
}

function gameLoop() {
  let activeCount = Object.values(players).filter(pl => pl.inMatch).length;

  if (!roundEnding && (!buyPhaseActive || activeCount === 1)) {
    // 1. CHECAGEM DE VITÓRIA / ELIMINAÇÃO DE TIMES
    let aliveTR = 0, aliveCT = 0;
    
    Object.values(players).forEach(p => {
      if (!p.inMatch) return;
      if (p.alive) {
        if (p.team === 'TR') aliveTR++;
        else if (p.team === 'CT') aliveCT++;
      }

      let isPlanting = (c4.status === 'planting' && c4.carrierId === p.id);
      let isDefusing = (c4.status === 'defusing' && c4.defuserId === p.id);

      if (p.alive && !isPlanting && !isDefusing) {
        let dx = 0, dy = 0;
        if (p.keys.w) dy -= 1; if (p.keys.s) dy += 1;
        if (p.keys.a) dx -= 1; if (p.keys.d) dx += 1;
        let len = Math.hypot(dx, dy);
        if (len > 0) { dx /= len; dy /= len; }
        let moveX = dx * p.speed, moveY = dy * p.speed;
        if (!checkWallCollision(p.x + moveX, p.y, p.radius)) p.x += moveX;
        if (!checkWallCollision(p.x, p.y + moveY, p.radius)) p.y += moveY;
      }

      if (p.alive && p.team === 'TR' && c4.status === 'dropped') {
        if (Math.hypot(p.x - c4.x, p.y - c4.y) < p.radius + 20) {
          p.hasC4 = true; c4.status = 'carried'; c4.carrierId = p.id;
        }
      }
    });

    // REGRAS DO FIM DO ROUND
    if (activeCount > 1) {
      if (c4.status === 'exploded') {
        endRound('TR', 'A C4 Explodiu!');
      } else if (c4.status === 'defused') {
        endRound('CT', 'A C4 foi Defusada!');
      } else if (aliveTR === 0 && (c4.status !== 'planted' && c4.status !== 'defusing')) {
        endRound('CT', 'Os Terroristas foram eliminados!');
      } else if (aliveCT === 0) {
        endRound('TR', 'Os Contra-Terroristas foram eliminados!');
      } else if (roundTimer <= 0 && (c4.status !== 'planted' && c4.status !== 'defusing')) {
        endRound('CT', 'O tempo acabou!');
      }
    }
    
    // Processamento Visual de Efeitos (Fumaça, Tiros, Granadas)
    for (let i = tracers.length - 1; i >= 0; i--) {
      tracers[i].duration--;
      if (tracers[i].duration <= 0) tracers.splice(i, 1);
    }

    for (let i = grenades.length - 1; i >= 0; i--) {
      let g = grenades[i];
      if (g.throwType === 'bounce') {
        let nextX = g.x + g.vx, nextY = g.y + g.vy;
        let hitX = false, hitY = false;
        
        for (let w of mapWalls) {
          if (nextX > w.x && nextX < w.x + w.w && g.y > w.y && g.y < w.y + w.h) hitX = true;
          if (g.x > w.x && g.x < w.x + w.w && nextY > w.y && nextY < w.y + w.h) hitY = true;
        }
        if (hitX) { g.vx *= -1; nextX = g.x + g.vx; }
        if (hitY) { g.vy *= -1; nextY = g.y + g.vy; }
        g.x = nextX; g.y = nextY;
      } else {
        g.x += g.vx; g.y += g.vy; 
      }
      g.vx *= 0.94; g.vy *= 0.94; g.timer--;

      if (g.timer <= 0) {
        if (g.type === 'smoke') {
          effects.push({ x: g.x, y: g.y, type: 'smoke', radius: 110, duration: 450 });
          effects = effects.filter(ef => !(ef.type === 'molotov' && Math.hypot(ef.x - g.x, ef.y - g.y) < 160));
        } else if (g.type === 'molotov') {
          let inSmoke = effects.some(ef => ef.type === 'smoke' && Math.hypot(ef.x - g.x, ef.y - g.y) < 160);
          if (!inSmoke) effects.push({ x: g.x, y: g.y, type: 'molotov', radius: 80, duration: 250 });
        } else if (g.type === 'flash') {
          io.emit('flashEvent', { x: g.x, y: g.y });
        } else if (g.type === 'he') {
          Object.values(players).forEach(p => {
            if (p.inMatch && p.alive && Math.hypot(p.x - g.x, p.y - g.y) < 120) {
              p.hp -= Math.round((1 - Math.hypot(p.x - g.x, p.y - g.y) / 120) * 75);
              if (p.hp <= 0) killPlayer(p);
            }
          });
        }
        grenades.splice(i, 1);
      }
    }

    for (let i = effects.length - 1; i >= 0; i--) {
      let ef = effects[i]; ef.duration--;
      if (ef.type === 'molotov' && ef.duration % 20 === 0) {
        Object.values(players).forEach(p => {
          if (p.inMatch && p.alive && Math.hypot(p.x - ef.x, p.y - ef.y) < ef.radius) { 
            p.hp -= 12; if (p.hp <= 0) killPlayer(p);
          }
        });
      }
      if (ef.duration <= 0) effects.splice(i, 1);
    }

    handleC4Logic();
  }

  io.emit('sync', { 
    players, tracers, grenades, effects, c4, mapWalls, deadBodies,
    round: { time: roundTimer, buyPhase: buyPhaseActive, buyTimer: buyPhaseTimer },
    scores
  });
}

function handleC4Logic() {
  if (c4.status === 'carried' || c4.status === 'planting') {
    let carrier = players[c4.carrierId];
    if (!carrier || !carrier.alive || !carrier.inMatch || !carrier.hasC4) {
      c4.status = 'dropped';
      if (carrier) { c4.x = carrier.x; c4.y = carrier.y; }
      c4.carrierId = null; 
      c4.progress = 0;
    } else {
      c4.x = carrier.x; c4.y = carrier.y;
      let inSite = BOMBSITES.some(s => carrier.x >= s.x && carrier.x <= s.x + s.w && carrier.y >= s.y && carrier.y <= s.y + s.h);
      
      if (inSite && carrier.weapon === 'c4' && (carrier.keys.e || carrier.keys.click)) {
        c4.status = 'planting';
        c4.progress++;
        if (c4.progress >= 240) { 
          c4.status = 'planted';
          c4.timer = 40 * 60; // CRAVADO O TIMER EXATO DE 40S
          carrier.hasC4 = false;
          carrier.weapon = carrier.primaryWeapon;
          c4.carrierId = null;
          c4.progress = 0;
        }
      } else {
        c4.status = 'carried';
        c4.progress = 0;
      }
    }
  } else if (c4.status === 'planted' || c4.status === 'defusing') {
    c4.timer--;
    if (c4.timer <= 0) {
      c4.status = 'exploded';
      c4.defuserId = null;
      return;
    }

    let activeDefuser = null;
    for (let p of Object.values(players)) {
      if (p.team === 'CT' && p.alive && p.inMatch && p.keys.e) {
        let dist = Math.hypot(p.x - c4.x, p.y - c4.y);
        if (dist <= 35) {
          let angleToC4 = Math.atan2(c4.y - p.y, c4.x - p.x);
          let angleDiff = Math.abs(Math.atan2(Math.sin(angleToC4 - p.angle), Math.cos(angleToC4 - p.angle)));
          if (angleDiff <= (dist < 20 ? 1.6 : 0.95)) {
            activeDefuser = p;
            break;
          }
        }
      }
    }

    if (activeDefuser) {
      c4.status = 'defusing';
      c4.defuserId = activeDefuser.id;
      c4.progress++;
      if (c4.progress >= 300) { 
        c4.status = 'defused';
        c4.defuserId = null;
      }
    } else {
      c4.status = 'planted';
      c4.defuserId = null;
      c4.progress = 0;
    }
  }
}

server.listen(process.env.PORT || 3000, () => console.log('Servidor rodando na porta 3000'));