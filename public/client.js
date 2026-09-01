const socket = io();
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
window.addEventListener('resize', resize); resize();

let gameState = null;
let keys = { w: false, a: false, s: false, d: false, e: false };
let localAngle = 0;
let isLocked = false;
let isShooting = false;
let flashAlpha = 0;

canvas.addEventListener('mousedown', (e) => { 
  if (!isLocked) canvas.requestPointerLock(); 
  else if (e.button === 0) isShooting = true; 
});
canvas.addEventListener('mouseup', (e) => { 
  if (e.button === 0) isShooting = false; 
});

document.addEventListener('pointerlockchange', () => { isLocked = (document.pointerLockElement === canvas); });
document.addEventListener('mousemove', e => {
  if (isLocked) {
    localAngle += e.movementX * 0.003;
    socket.emit('input', { keys, angle: localAngle });
  }
});
window.addEventListener('keydown', e => {
  let k = e.key.toLowerCase(); if (k in keys) keys[k] = true;
  
  if (['1','2','3','4'].includes(k)) socket.emit('switch', { '1':'rifle', '2':'smg', '3':'shotgun', '4':'awp' }[k]);
  if (k === 'z') socket.emit('grenade', 'molotov');
  if (k === 'x') socket.emit('grenade', 'smoke');
  if (k === 'c') socket.emit('grenade', 'flash');
  if (k === 'v') socket.emit('grenade', 'he');
  
  // NOVA BIND: Mudar de time
  if (k === 'm') socket.emit('switchTeam');

  socket.emit('input', { keys, angle: localAngle });
});
window.addEventListener('keyup', e => { let k = e.key.toLowerCase(); if (k in keys) keys[k] = false; socket.emit('input', { keys, angle: localAngle }); });

socket.on('sync', state => { gameState = state; });
socket.on('flashEvent', () => { flashAlpha = 1.0; }); 

function draw3D(cam) {
  ctx.fillStyle = '#1c2026'; ctx.fillRect(0, 0, canvas.width, canvas.height / 2);
  ctx.fillStyle = '#393530'; ctx.fillRect(0, canvas.height / 2, canvas.width, canvas.height / 2);

  const FOV = Math.PI / 3;
  const rays = Math.floor(canvas.width / 4);
  const rayStep = FOV / rays;
  const maxDepth = 1500;
  
  let zBuffer = new Array(rays).fill(maxDepth);
  const walls = gameState.mapWalls || [];

  for(let i = 0; i < rays; i++) {
    let rayAngle = cam.angle - FOV/2 + i * rayStep;
    let dirX = Math.cos(rayAngle);
    let dirY = Math.sin(rayAngle);
    let distance = 0; let hitWall = false;
    
    while (!hitWall && distance < maxDepth) {
        distance += 10;
        let testX = cam.x + dirX * distance; let testY = cam.y + dirY * distance;
        for (let w of walls) {
            if (testX >= w.x && testX <= w.x + w.w && testY >= w.y && testY <= w.y + w.h) { hitWall = true; break; }
        }
    }

    if (hitWall) {
        let correctedDist = distance * Math.cos(rayAngle - cam.angle);
        zBuffer[i] = correctedDist;
        let wallHeight = (canvas.height / correctedDist) * 35;
        let shade = Math.max(20, 255 - distance / 4);
        ctx.fillStyle = `rgb(${shade/2.5}, ${shade/2.2}, ${shade/2})`;
        ctx.fillRect(i * 4, canvas.height/2 - wallHeight/2, 5, wallHeight);
    }
  }

  let entities = [];
  
  Object.values(gameState.players).forEach(p => { if (p.alive && p.id !== cam.id) entities.push({ ...p, isPlayer: true }); });
  gameState.grenades.forEach(g => entities.push({ ...g, isGrenade: true }));
  gameState.bullets.forEach(b => entities.push({ ...b, isBullet: true }));
  gameState.effects.forEach(e => entities.push({ ...e, isEffect: true }));

  entities.sort((a, b) => Math.hypot(b.x - cam.x, b.y - cam.y) - Math.hypot(a.x - cam.x, a.y - cam.y));

  entities.forEach(ent => {
      let dx = ent.x - cam.x; let dy = ent.y - cam.y;
      let dist = Math.hypot(dx, dy);
      
      let angleToEnt = Math.atan2(dy, dx) - cam.angle;
      while(angleToEnt < -Math.PI) angleToEnt += 2*Math.PI;
      while(angleToEnt > Math.PI) angleToEnt -= 2*Math.PI;
      
      if (Math.abs(angleToEnt) < FOV/2 + 0.5 && dist > 15) {
          let correctedDist = dist * Math.cos(angleToEnt);
          let screenX = (0.5 * (angleToEnt / (FOV/2)) + 0.5) * canvas.width;
          let rayIndex = Math.floor((screenX / canvas.width) * rays);
          
          if (rayIndex >= 0 && rayIndex < rays && zBuffer[rayIndex] > dist) {
              if (ent.isPlayer) {
                  let spriteHeight = (canvas.height / correctedDist) * 30;
                  let spriteWidth = spriteHeight * 0.6;
                  let startX = screenX - spriteWidth/2;

                  ctx.fillStyle = ent.team === 'CT' ? '#0077ff' : '#ffaa00';
                  ctx.fillRect(startX, canvas.height/2 - spriteHeight/2, spriteWidth, spriteHeight);
                  
                  ctx.fillStyle = 'red'; ctx.fillRect(startX, canvas.height/2 - spriteHeight/2 - 10, spriteWidth, 5);
                  ctx.fillStyle = '#0f0'; ctx.fillRect(startX, canvas.height/2 - spriteHeight/2 - 10, spriteWidth * (ent.hp/100), 5);
              } 
              else if (ent.isGrenade) {
                  let size = (canvas.height / correctedDist) * 5;
                  ctx.fillStyle = ent.type === 'smoke' ? '#aaa' : (ent.type === 'molotov' ? 'orange' : '#333');
                  if (ent.type === 'flash') ctx.fillStyle = 'white';
                  ctx.fillRect(screenX - size/2, canvas.height/2 + size, size, size);
              }
              else if (ent.isBullet) {
                  let size = (canvas.height / correctedDist) * 3;
                  ctx.fillStyle = 'yellow';
                  ctx.fillRect(screenX - size/2, canvas.height/2, size, size);
              }
              else if (ent.isEffect) {
                  let size = (canvas.height / correctedDist) * (ent.radius || 100);
                  ctx.fillStyle = ent.type === 'smoke' ? 'rgba(150, 150, 150, 0.95)' : 'rgba(255, 100, 0, 0.7)';
                  ctx.fillRect(screenX - size/2, canvas.height/2 - size/3, size, size/1.5);
              }
          }
      }
  });

  ctx.fillStyle = '#0f0'; ctx.fillRect(canvas.width/2 - 2, canvas.height/2 - 2, 4, 4);

  if (flashAlpha > 0) {
    ctx.fillStyle = `rgba(255, 255, 255, ${flashAlpha})`; ctx.fillRect(0, 0, canvas.width, canvas.height);
    flashAlpha -= 0.005; 
  }
}

function drawMinimap(cam) {
  const mmSize = 220; 
  const scale = 0.15;

  ctx.save();
  ctx.translate(canvas.width - mmSize/2 - 20, mmSize/2 + 20);
  ctx.beginPath(); ctx.arc(0, 0, mmSize/2, 0, Math.PI*2); ctx.clip();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'; ctx.fillRect(-mmSize/2, -mmSize/2, mmSize, mmSize);

  ctx.rotate(-cam.angle - Math.PI/2);
  ctx.translate(-cam.x * scale, -cam.y * scale);

  ctx.fillStyle = '#555';
  gameState.mapWalls.forEach(w => ctx.fillRect(w.x*scale, w.y*scale, w.w*scale, w.h*scale));

  ctx.fillStyle = 'rgba(255, 165, 0, 0.4)';
  ctx.fillRect(100*scale, 80*scale, 200*scale, 200*scale); 
  ctx.fillRect(1100*scale, 80*scale, 200*scale, 200*scale); 

  Object.values(gameState.players).forEach(p => {
    if (p.alive && (p.team === cam.team || !gameState.players[socket.id].alive)) {
      ctx.fillStyle = p.id === cam.id ? '#0f0' : '#0af';
      ctx.beginPath(); ctx.arc(p.x*scale, p.y*scale, 4, 0, Math.PI*2); ctx.fill();
      if (p.hasC4) { ctx.fillStyle = 'red'; ctx.fillRect(p.x*scale-2, p.y*scale-2, 4, 4); }
    }
  });

  if (gameState.c4.status !== 'carried') {
    ctx.fillStyle = gameState.c4.status === 'planted' ? 'red' : 'white';
    ctx.beginPath(); ctx.arc(gameState.c4.x*scale, gameState.c4.y*scale, 5, 0, Math.PI*2); ctx.fill();
  }
  ctx.restore();
}

function drawHUD(cam) {
  ctx.fillStyle = 'rgba(20, 20, 20, 0.9)'; ctx.fillRect(20, canvas.height - 80, 300, 60);
  ctx.fillStyle = '#fff'; ctx.font = '18px Arial'; ctx.textAlign = 'left';
  // Exibindo o Time atual na HUD para facilitar
  ctx.fillText(`TIME: ${cam.team} | HP: ${cam.hp} | ARMA: ${cam.weapon.toUpperCase()}`, 35, canvas.height - 45);

  ctx.fillStyle = 'rgba(0,0,0,0.8)'; ctx.fillRect(canvas.width/2 - 40, 20, 80, 40);
  ctx.fillStyle = gameState.c4.status === 'planted' ? 'red' : '#fff';
  ctx.font = 'bold 24px Arial'; ctx.textAlign = 'center';
  
  let timeStr = gameState.c4.status === 'planted' ? gameState.c4.timer : gameState.round.time;
  let m = Math.floor(timeStr / 60); let s = timeStr % 60;
  ctx.fillText(`${m}:${s < 10 ? '0' : ''}${s}`, canvas.width/2, 48);

  if (gameState.c4.status === 'planting' || gameState.c4.status === 'defusing') {
    ctx.fillStyle = 'rgba(0,0,0,0.8)'; ctx.fillRect(canvas.width/2 - 150, canvas.height - 150, 300, 20);
    ctx.fillStyle = gameState.c4.status === 'planting' ? 'red' : 'blue';
    ctx.fillRect(canvas.width/2 - 150, canvas.height - 150, (gameState.c4.progress/100) * 300, 20);
  }

  if (gameState.round.msg) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0, canvas.height/4 - 30, canvas.width, 60);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 32px Arial'; ctx.textAlign = 'center';
    ctx.fillText(gameState.round.msg, canvas.width/2, canvas.height/4 + 10);
  }
}

function draw() {
  requestAnimationFrame(draw);
  if (!gameState || !gameState.players[socket.id]) return;
  
  if (isShooting) socket.emit('shoot');

  const me = gameState.players[socket.id];
  let cam = me;
  if (!me.alive) {
    const allies = Object.values(gameState.players).filter(p => p.team === me.team && p.alive);
    if (allies.length > 0) cam = allies[0]; else return;
  } else { cam.angle = localAngle; }

  draw3D(cam);
  drawMinimap(cam);
  drawHUD(cam);
}

draw();