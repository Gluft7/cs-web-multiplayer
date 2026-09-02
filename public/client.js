const socket = io();
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const FOV_ANGLE = 75 * Math.PI / 180;

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

// Previne o menu de contexto (botão direito do mouse)
window.addEventListener('contextmenu', e => e.preventDefault());

let gameState = null;
let keys = { w: false, a: false, s: false, d: false, e: false, click: false };
let localAngle = 0;
let isShooting = false;
let flashAlpha = 0;
let flashHoldTimer = 0;
let inMatch = false;
let isPaused = false;
let showBuyMenu = false;

// VARIÁVEIS DO SISTEMA DE RECUO/TIRO (NOVAS)
let currentRecoil = 0;
let lastClientShot = 0; 

let mousePos = { x: canvas.width / 2, y: canvas.height / 2 };
let currentCamTransform = { scale: 1.0, x: 800, y: 500 };

let equippedGrenade = null;

let binds = JSON.parse(localStorage.getItem('cs_binds')) || {
  grenade1: 'z',
  grenade2: 'x',
  grenade3: 'c',
  grenade4: 'v',
  c4: '5'
};

let cameraSettings = JSON.parse(localStorage.getItem('cs_camera')) || {
  mode: 'player',
  zoom: 50
};

let userNickname = localStorage.getItem('cs_nickname') || 'Player_' + Math.floor(1000 + Math.random() * 9000);

function sanitizeInput(str) {
  return str.replace(/[&<>"']/g, '').trim().substring(0, 15);
}

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  if (screenId) {
    const el = document.getElementById(screenId);
    if (el) el.classList.add('active');
  }
}

function togglePause() {
  if (!inMatch) return;
  isPaused = !isPaused;
  if (isPaused) {
    keys = { w: false, a: false, s: false, d: false, e: false, click: false };
    socket.emit('input', { keys, angle: localAngle });
    showScreen('pauseScreen');
  } else {
    showScreen(null);
  }
}

function initUI() {
  document.getElementById('nicknameInput').value = userNickname;
  socket.emit('setNickname', userNickname);

  document.getElementById('bindG1').value = binds.grenade1.toUpperCase();
  document.getElementById('bindG2').value = binds.grenade2.toUpperCase();
  document.getElementById('bindG3').value = binds.grenade3.toUpperCase();
  document.getElementById('bindG4').value = binds.grenade4.toUpperCase();

  const camRadios = document.getElementsByName('cameraMode');
  camRadios.forEach(r => {
    r.checked = (r.value === cameraSettings.mode);
    r.onchange = () => {
      const selected = Array.from(camRadios).find(radio => radio.checked)?.value;
      const sliderGroup = document.getElementById('zoomSliderGroup');
      if (sliderGroup) {
        sliderGroup.style.display = (selected === 'custom') ? 'block' : 'none';
      }
    };
  });

  const zoomSlider = document.getElementById('zoomSlider');
  const zoomText = document.getElementById('zoomValueText');
  if (zoomSlider && zoomText) {
    zoomSlider.value = cameraSettings.zoom;
    zoomText.innerText = cameraSettings.zoom + '%';
    zoomSlider.oninput = () => {
      zoomText.innerText = zoomSlider.value + '%';
    };
  }

  const initialMode = Array.from(camRadios).find(r => r.checked)?.value;
  const sliderGroup = document.getElementById('zoomSliderGroup');
  if (sliderGroup) {
    sliderGroup.style.display = (initialMode === 'custom') ? 'block' : 'none';
  }

  document.getElementById('btnPlay').onclick = () => { showScreen('queueScreen'); socket.emit('joinQueue'); };
  document.getElementById('btnSettings').onclick = () => showScreen('settingsScreen');
  document.getElementById('btnAbout').onclick = () => showScreen('aboutScreen');

  document.getElementById('btnBackSettings').onclick = () => {
    if (inMatch) showScreen('pauseScreen');
    else showScreen('mainMenuScreen');
  };
  document.getElementById('btnBackAbout').onclick = () => showScreen('mainMenuScreen');

  document.getElementById('btnResumeGame').onclick = () => togglePause();
  document.getElementById('btnPauseSettings').onclick = () => showScreen('settingsScreen');

  const btnQuitMatch = document.getElementById('btnQuitMatch');
  if (btnQuitMatch) {
    btnQuitMatch.onclick = () => {
      socket.emit('quitMatch');
      inMatch = false;
      isPaused = false;
      showScreen('mainMenuScreen');
    };
  }

  document.getElementById('btnSaveSettings').onclick = () => {
    const nameVal = sanitizeInput(document.getElementById('nicknameInput').value);
    userNickname = nameVal || 'Player_' + Math.floor(1000 + Math.random() * 9000);
    localStorage.setItem('cs_nickname', userNickname);
    socket.emit('setNickname', userNickname);

    binds.grenade1 = (document.getElementById('bindG1').value || 'z').toLowerCase();
    binds.grenade2 = (document.getElementById('bindG2').value || 'x').toLowerCase();
    binds.grenade3 = (document.getElementById('bindG3').value || 'c').toLowerCase();
    binds.grenade4 = (document.getElementById('bindG4').value || 'v').toLowerCase();

    localStorage.setItem('cs_binds', JSON.stringify(binds));

    const selectedMode = Array.from(document.getElementsByName('cameraMode')).find(r => r.checked)?.value || 'player';
    const sliderVal = parseInt(document.getElementById('zoomSlider').value, 10) || 50;
    
    cameraSettings.mode = selectedMode;
    cameraSettings.zoom = sliderVal;
    localStorage.setItem('cs_camera', JSON.stringify(cameraSettings));

    if (inMatch) showScreen('pauseScreen');
    else showScreen('mainMenuScreen');
  };

  document.getElementById('btnCancelQueue').onclick = () => {
    socket.emit('leaveQueue');
    showScreen('mainMenuScreen');
  };

  const btnStart = document.getElementById('btnStartMatch');
  if (btnStart) {
    btnStart.onclick = () => {
      socket.emit('manualStartMatch');
    };
  }
}

initUI();

// ----------------- SISTEMA DE VISÃO E FOV -----------------

function isPointInSmoke(px, py, effects) {
  return (effects || []).some(e => e.type === 'smoke' && Math.hypot(px - e.x, py - e.y) <= e.radius);
}

function lineIntersectsSegment(x1, y1, x2, y2, x3, y3, x4, y4) {
  let denom = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1);
  if (denom === 0) return false;
  let ua = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / denom;
  let ub = ((x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3)) / denom;
  return (ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1);
}

function lineIntersectsWall(x1, y1, x2, y2, walls) {
  for (let w of (walls || [])) {
    if (lineIntersectsSegment(x1, y1, x2, y2, w.x, w.y, w.x + w.w, w.y) ||
        lineIntersectsSegment(x1, y1, x2, y2, w.x + w.w, w.y, w.x + w.w, w.y + w.h) ||
        lineIntersectsSegment(x1, y1, x2, y2, w.x + w.w, w.y + w.h, w.x, w.y + w.h) ||
        lineIntersectsSegment(x1, y1, x2, y2, w.x, w.y + w.h, w.x, w.y)) {
      return true;
    }
  }
  return false;
}

function lineIntersectsCircle(x1, y1, x2, y2, cx, cy, r) {
  let dx = x2 - x1, dy = y2 - y1;
  let len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(x1 - cx, y1 - cy) <= r;
  let u = Math.max(0, Math.min(1, ((cx - x1) * dx + (cy - y1) * dy) / (len * len)));
  return Math.hypot((x1 + u * dx) - cx, (y1 + u * dy) - cy) <= r;
}

function canSeePoint(obs, tx, ty) {
  if (!obs || !gameState) return false;

  if (isPointInSmoke(obs.x, obs.y, gameState.effects)) return false;
  if (isPointInSmoke(tx, ty, gameState.effects)) return false;

  for (let ef of (gameState.effects || [])) {
    if (ef.type === 'smoke' && lineIntersectsCircle(obs.x, obs.y, tx, ty, ef.x, ef.y, ef.radius)) {
      return false;
    }
  }

  let angleToTarget = Math.atan2(ty - obs.y, tx - obs.x);
  let diff = Math.atan2(Math.sin(angleToTarget - obs.angle), Math.cos(angleToTarget - obs.angle));
  if (Math.abs(diff) > FOV_ANGLE / 2) return false;

  if (lineIntersectsWall(obs.x, obs.y, tx, ty, gameState.mapWalls)) return false;

  return true;
}

// ----------------- CONTROLES E INPUTS -----------------

function updateAimAngle() {
  if (!inMatch || isPaused || !gameState || !gameState.players[socket.id]) return;
  const me = gameState.players[socket.id];
  if (!me.alive) return;

  let worldMouseX = (mousePos.x - canvas.width / 2) / currentCamTransform.scale + currentCamTransform.x;
  let worldMouseY = (mousePos.y - canvas.height / 2) / currentCamTransform.scale + currentCamTransform.y;

  let baseAngle = Math.atan2(worldMouseY - me.y, worldMouseX - me.x);
  
  // APLICA O SPREAD ALEATÓRIO (RECUO) NA MIRA ENVIADA AO SERVIDOR
  let sprayOffset = (Math.random() - 0.5) * currentRecoil;
  localAngle = baseAngle + sprayOffset;
  
  socket.emit('input', { keys, angle: localAngle });
}

window.addEventListener('mousemove', e => {
  mousePos.x = e.clientX;
  mousePos.y = e.clientY;
  updateAimAngle();
});

canvas.addEventListener('mousedown', (e) => {
  if (!inMatch || isPaused) return;
  if (e.button !== 0 && e.button !== 2) return;

  const me = gameState.players[socket.id];

  if (equippedGrenade) {
    let worldMouseX = (mousePos.x - canvas.width / 2) / currentCamTransform.scale + currentCamTransform.x;
    let worldMouseY = (mousePos.y - canvas.height / 2) / currentCamTransform.scale + currentCamTransform.y;
    let throwType = (e.button === 2) ? 'bounce' : 'jump';
    
    socket.emit('grenade', { type: equippedGrenade, targetX: worldMouseX, targetY: worldMouseY, throwType });
    equippedGrenade = null;
  } else if (e.button === 0) { 
    if (me && me.weapon === 'c4') {
      keys.click = true;
      socket.emit('input', { keys, angle: localAngle });
    } else {
      isShooting = true;
    }
  }
});

canvas.addEventListener('mouseup', (e) => {
  if (e.button === 0) {
    isShooting = false;
    keys.click = false;
    socket.emit('input', { keys, angle: localAngle });
  }
});

window.addEventListener('keydown', e => {
  let k = e.key.toLowerCase();

  if (k === 'escape' || k === 'esc') {
    if (inMatch) togglePause();
    return;
  }

  if (!inMatch || isPaused) return;

  if (k === 'b') {
    showBuyMenu = !showBuyMenu;
  }

  // TECLA DE RECARREGAR (NOVA)
  if (k === 'r') {
    socket.emit('reload');
  }

  if (k in keys) {
    keys[k] = true;
    socket.emit('input', { keys, angle: localAngle });
  }

  const me = gameState ? gameState.players[socket.id] : null;

  if (k === '1' && me) {
    equippedGrenade = null;
    socket.emit('switch', me.primaryWeapon);
  }

  if (k === (binds.c4 || '5') || k === '5') {
    equippedGrenade = null;
    socket.emit('switch', 'c4');
  }

  if (me) {
    if (k === binds.grenade1 && me.grenades.molotov > 0) equippedGrenade = 'molotov';
    if (k === binds.grenade2 && me.grenades.smoke > 0) equippedGrenade = 'smoke';
    if (k === binds.grenade3 && me.grenades.flash > 0) equippedGrenade = 'flash';
    if (k === binds.grenade4 && me.grenades.he > 0) equippedGrenade = 'he';
  }

  if (k === 'm') socket.emit('switchTeam');
});

window.addEventListener('keyup', e => {
  if (!inMatch || isPaused) return;
  let k = e.key.toLowerCase();
  if (k in keys) {
    keys[k] = false;
    socket.emit('input', { keys, angle: localAngle });
  }
});

socket.on('queueUpdate', data => {
  document.getElementById('queueCount').innerText = `${data.count} / ${data.max}`;
  const listEl = document.getElementById('queueList');
  listEl.innerHTML = '';
  let ownerName = 'Nenhum';
  data.players.forEach(p => {
    const li = document.createElement('li');
    li.innerText = p.nickname + (p.id === data.ownerId ? ' ★' : '');
    listEl.appendChild(li);
    if (p.id === data.ownerId) ownerName = p.nickname;
  });
  document.getElementById('ownerName').innerText = ownerName;

  const btnStart = document.getElementById('btnStartMatch');
  if (btnStart) {
    const isOwner = (socket.id === data.ownerId);
    btnStart.style.display = isOwner ? 'block' : 'none';
    btnStart.disabled = false;
  }
});

socket.on('matchStart', () => {
  inMatch = true;
  isPaused = false;
  showBuyMenu = false;
  showScreen(null);
});

socket.on('sync', state => {
  gameState = state;
  if (gameState.players && gameState.players[socket.id] && gameState.players[socket.id].inMatch && !inMatch) {
    inMatch = true;
    isPaused = false;
    showScreen(null);
  }
});

socket.on('flashEvent', flashData => {
  let me = gameState ? gameState.players[socket.id] : null;
  if (!me || !me.alive) return;

  let dist = Math.hypot(me.x - flashData.x, me.y - flashData.y);
  let blocked = lineIntersectsWall(me.x, me.y, flashData.x, flashData.y, gameState.mapWalls);

  if (blocked) dist += 350;

  if (dist <= 150) {
    flashAlpha = 1.0;
    flashHoldTimer = 300; 
  } else if (dist < 650) {
    let factor = 1 - ((dist - 150) / 500);
    flashAlpha = Math.min(1.0, factor * 1.1);
    flashHoldTimer = Math.floor(factor * 240);
  }
});

function buy(item) {
  socket.emit('buyItem', item);
}

// ----------------- RENDERIZAÇÃO -----------------

function draw2D(cam) {
  ctx.fillStyle = '#15181c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();

  let scale = 1.0;
  let camX = cam.x;
  let camY = cam.y;

  if (cameraSettings.mode === 'full') {
    let scaleX = canvas.width / MAP_WIDTH;
    let scaleY = canvas.height / MAP_HEIGHT;
    scale = Math.min(scaleX, scaleY);
    camX = MAP_WIDTH / 2;
    camY = MAP_HEIGHT / 2;
  } else if (cameraSettings.mode === 'custom') {
    scale = 0.45 + (1.15) * (cameraSettings.zoom / 100);
  }

  // EFEITO DE TREMEDEIRA (CAMERA SHAKE) QUANDO ATIRA (NOVO)
  if (currentRecoil > 0 && cam.id === socket.id) {
    camX += (Math.random() - 0.5) * (currentRecoil * 80);
    camY += (Math.random() - 0.5) * (currentRecoil * 80);
  }

  currentCamTransform = { scale, x: camX, y: camY };

  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.scale(scale, scale);
  ctx.translate(-camX, -camY);

  // 1. Bomb Sites
  ctx.fillStyle = 'rgba(255, 165, 0, 0.25)';
  ctx.strokeStyle = 'rgba(255, 165, 0, 0.8)';
  ctx.lineWidth = 2;
  ctx.fillRect(100, 80, 200, 200); ctx.strokeRect(100, 80, 200, 200);
  ctx.fillStyle = '#ffaa00'; ctx.font = 'bold 32px Arial'; ctx.textAlign = 'center'; ctx.fillText('A', 200, 190);

  ctx.fillStyle = 'rgba(255, 165, 0, 0.25)';
  ctx.fillRect(1100, 80, 200, 200); ctx.strokeRect(1100, 80, 200, 200);
  ctx.fillStyle = '#ffaa00'; ctx.fillText('B', 1200, 190);

  // 2. Paredes
  ctx.fillStyle = '#2c3542';
  ctx.strokeStyle = '#4a586e';
  ctx.lineWidth = 2;
  (gameState.mapWalls || []).forEach(w => {
    ctx.fillRect(w.x, w.y, w.w, w.h);
    ctx.strokeRect(w.x, w.y, w.w, w.h);
  });

  // 3. Cadáveres (Marcas X no chão)
  (gameState.deadBodies || []).forEach(db => {
    ctx.strokeStyle = db.team === 'CT' ? 'rgba(0, 119, 255, 0.6)' : 'rgba(255, 170, 0, 0.6)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(db.x - 10, db.y - 10); ctx.lineTo(db.x + 10, db.y + 10);
    ctx.moveTo(db.x + 10, db.y - 10); ctx.lineTo(db.x - 10, db.y + 10);
    ctx.stroke();
  });

  // 4. Efeitos Visuais (Smoke / Molotov)
  (gameState.effects || []).forEach(e => {
    ctx.beginPath();
    ctx.arc(e.x, e.y, e.radius || 100, 0, Math.PI * 2);
    if (e.type === 'smoke') ctx.fillStyle = 'rgba(120, 120, 120, 0.98)';
    else if (e.type === 'molotov') ctx.fillStyle = 'rgba(255, 100, 0, 0.55)';
    ctx.fill();
  });

  // 5. C4 no Mapa
  let c4Data = gameState.c4;
  if (c4Data && c4Data.status !== 'carried') {
    ctx.fillStyle = (c4Data.status === 'planted' || c4Data.status === 'defusing') ? '#ff0044' : '#ffffff';
    ctx.beginPath();
    ctx.arc(c4Data.x, c4Data.y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#000000'; ctx.lineWidth = 1.5; ctx.stroke();

    if (c4Data.status === 'planted' || c4Data.status === 'defusing') {
      ctx.strokeStyle = '#ff0044';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(c4Data.x, c4Data.y, 14 + Math.sin(Date.now() / 120) * 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // 6. Granadas Voadoras
  (gameState.grenades || []).forEach(g => {
    if (canSeePoint(cam, g.x, g.y)) {
      ctx.beginPath();
      ctx.arc(g.x, g.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = g.type === 'smoke' ? '#aaa' : (g.type === 'molotov' ? '#ff9900' : '#333');
      if (g.type === 'flash') ctx.fillStyle = '#fff';
      ctx.fill();
    }
  });

  // 7. RASTROS DE TIRO (Tracers do Hitscan)
  (gameState.tracers || []).forEach(t => {
    ctx.beginPath();
    ctx.moveTo(t.startX, t.startY);
    ctx.lineTo(t.endX, t.endY);
    ctx.strokeStyle = `rgba(255, 200, 0, ${Math.max(0.1, t.duration / 6)})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  });

  // 8. Jogadores
  Object.values(gameState.players || {}).forEach(p => {
    if (!p.inMatch || !p.alive) return;

    let isSelf = (p.id === cam.id);
    if (!isSelf && !canSeePoint(cam, p.x, p.y)) return;

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle); 

    // Desenha o Visual da Arma na mão
    if (p.weapon === 'rifle') {
      ctx.fillStyle = '#555'; ctx.fillRect(14, 4, 26, 4);
    } else if (p.weapon === 'awp') {
      ctx.fillStyle = '#222'; ctx.fillRect(14, 4, 38, 5);
      ctx.fillStyle = '#111'; ctx.fillRect(20, 1, 10, 10);
    } else if (p.weapon === 'smg') {
      ctx.fillStyle = '#666'; ctx.fillRect(14, 4, 16, 5); 
    } else if (p.weapon === 'shotgun') {
      ctx.fillStyle = '#333'; ctx.fillRect(14, 3, 20, 6);
      ctx.fillStyle = '#833'; ctx.fillRect(14, 3, 10, 6); 
    } else if (p.weapon === 'c4') {
      ctx.fillStyle = '#222'; ctx.fillRect(14, -5, 12, 10);
      ctx.fillStyle = '#ff2200'; ctx.fillRect(16, -3, 8, 6);
    } else {
      ctx.fillStyle = '#888'; ctx.fillRect(14, 4, 6, 4);
    }

    ctx.rotate(-p.angle);

    // Corpo/Cabeça do player
    ctx.beginPath();
    ctx.arc(0, 0, 14, 0, Math.PI * 2);
    ctx.fillStyle = p.team === 'CT' ? '#0077ff' : '#ffaa00';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();

    if (p.hasC4) {
      ctx.fillStyle = '#ff2200';
      ctx.fillRect(-6, -6, 12, 12);
    }

    ctx.restore();

    const barW = 36, barH = 5;
    const barX = p.x - barW / 2, barY = p.y - 26;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = p.hp > 50 ? '#00ff66' : (p.hp > 20 ? '#ffcc00' : '#ff3333');
    ctx.fillRect(barX, barY, barW * (Math.max(0, p.hp) / 100), barH);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(p.nickname || 'Player', p.x, p.y - 32);
  });

  // 9. Previsão de Trajetória da Granada
  const me = gameState.players[socket.id];
  if (equippedGrenade && me && me.alive) {
    let worldMouseX = (mousePos.x - canvas.width / 2) / currentCamTransform.scale + currentCamTransform.x;
    let worldMouseY = (mousePos.y - canvas.height / 2) / currentCamTransform.scale + currentCamTransform.y;

    let dist = Math.min(1200, Math.hypot(worldMouseX - me.x, worldMouseY - me.y));
    let angle = Math.atan2(worldMouseY - me.y, worldMouseX - me.x);
    let initialVel = dist / 16.5;

    let jX = me.x, jY = me.y;
    let jVx = Math.cos(angle) * initialVel;
    let jVy = Math.sin(angle) * initialVel;
    
    ctx.beginPath();
    ctx.moveTo(jX, jY);
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.5)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 80; i++) {
        jX += jVx; jY += jVy;
        ctx.lineTo(jX, jY);
        jVx *= 0.94; jVy *= 0.94;
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(jX, jY, 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 229, 255, 0.6)';
    ctx.fill();

    let bX = me.x, bY = me.y;
    let bVx = Math.cos(angle) * initialVel;
    let bVy = Math.sin(angle) * initialVel;
    
    ctx.beginPath();
    ctx.moveTo(bX, bY);
    ctx.strokeStyle = 'rgba(255, 165, 0, 0.7)';
    ctx.setLineDash([5, 5]); 
    for (let i = 0; i < 80; i++) {
        let nX = bX + bVx, nY = bY + bVy;
        let hX = false, hY = false;
        
        for (let w of (gameState.mapWalls || [])) {
            if (nX > w.x && nX < w.x + w.w && bY > w.y && bY < w.y + w.h) hX = true;
            if (bX > w.x && bX < w.x + w.w && nY > w.y && nY < w.y + w.h) hY = true;
        }
        
        if (hX) { bVx *= -1; nX = bX + bVx; }
        if (hY) { bVy *= -1; nY = bY + bVy; }
        
        bX = nX; bY = nY;
        ctx.lineTo(bX, bY);
        bVx *= 0.94; bVy *= 0.94;
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(bX, bY, 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 165, 0, 0.7)';
    ctx.fill();
  }

  // Cone FOV
  if (cam) {
    ctx.save();
    ctx.translate(cam.x, cam.y);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 1200, cam.angle - FOV_ANGLE / 2, cam.angle + FOV_ANGLE / 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  ctx.restore();

  // Mira
  ctx.strokeStyle = '#00e5ff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(mousePos.x, mousePos.y, 6, 0, Math.PI * 2);
  ctx.moveTo(mousePos.x - 10, mousePos.y); ctx.lineTo(mousePos.x + 10, mousePos.y);
  ctx.moveTo(mousePos.x, mousePos.y - 10); ctx.lineTo(mousePos.x, mousePos.y + 10);
  ctx.stroke();

  // Cegueira da Flashbang
  if (flashAlpha > 0) {
    ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(1.0, flashAlpha)})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (flashHoldTimer > 0) {
      flashHoldTimer--;
    } else {
      flashAlpha -= 0.008;
    }
  }
}

function drawHUD(cam) {
  ctx.fillStyle = 'rgba(20, 20, 20, 0.9)';
  ctx.fillRect(20, canvas.height - 90, 520, 70);
  
  ctx.fillStyle = '#fff';
  ctx.font = '14px Arial';
  ctx.textAlign = 'left';

  // ATUALIZAÇÃO NO HUD PARA MOSTRAR A MUNIÇÃO (NOVO)
  let gCount = `[Molo:${cam.grenades.molotov} Smk:${cam.grenades.smoke} Flsh:${cam.grenades.flash} HE:${cam.grenades.he}]`;
  let ammoInfo = (cam.weapon !== 'c4' && !equippedGrenade) ? ` | BALAS: ${cam.ammo ?? 0}/${cam.reserveAmmo ?? 0}` : '';
  let itemHand = equippedGrenade ? `GRANADA: ${equippedGrenade.toUpperCase()}` : `ARMA: ${cam.weapon.toUpperCase()}${ammoInfo}`;
  
  ctx.fillText(`${cam.nickname || 'Player'} | TIME: ${cam.team} | HP: ${cam.hp}`, 80, canvas.height - 65);
  ctx.fillText(`${itemHand} | ${gCount}`, 80, canvas.height - 40);

  ctx.save();
  ctx.translate(45, canvas.height - 58);
  ctx.fillStyle = '#bbb';
  if (equippedGrenade) {
     ctx.beginPath(); ctx.arc(10, 0, 7, 0, Math.PI*2); ctx.fill();
  } else if (cam.weapon === 'rifle') {
     ctx.fillRect(0, -3, 30, 6);
  } else if (cam.weapon === 'awp') {
     ctx.fillRect(0, -3, 40, 6); ctx.fillRect(10, -7, 10, 4);
  } else if (cam.weapon === 'smg') {
     ctx.fillRect(0, -2, 18, 5);
  } else if (cam.weapon === 'shotgun') {
     ctx.fillRect(0, -3, 24, 7); ctx.fillStyle = '#833'; ctx.fillRect(0, -3, 10, 7);
  } else if (cam.weapon === 'c4') {
     ctx.fillStyle = '#140'; ctx.fillRect(0, -8, 16, 16);
  }
  ctx.restore();

  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.fillRect(canvas.width/2 - 80, 20, 160, 45);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 22px Arial';
  ctx.textAlign = 'center';

  let activePlayersCount = Object.values(gameState.players || {}).filter(p => p.inMatch).length;

  if (activePlayersCount === 1) {
    ctx.fillStyle = '#00e5ff';
    ctx.fillText('TREINO / COMPRA', canvas.width/2, 50);
  } else if (gameState.round && gameState.round.buyPhase) {
    ctx.fillStyle = '#00e5ff';
    ctx.fillText(`COMPRA: ${gameState.round.buyTimer}s`, canvas.width/2, 50);
  } else if (gameState.round) {
    let m = Math.floor(gameState.round.time / 60);
    let s = gameState.round.time % 60;
    ctx.fillText(`${m}:${s < 10 ? '0' : ''}${s}`, canvas.width/2, 50);
  }

  if (equippedGrenade && cam.id === socket.id && cam.alive) {
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 15px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('Esquerdo (Pula Paredes) | Direito (Tabela Fisicamente)', canvas.width / 2, canvas.height - 60);
  }

  if (gameState.c4) {
    let c4Data = gameState.c4;
    let isMyPlant = (c4Data.status === 'planting' && c4Data.carrierId === socket.id);
    let isMyDefuse = (c4Data.status === 'defusing' && c4Data.defuserId === socket.id);

    if (isMyPlant || isMyDefuse) {
      let maxProg = isMyPlant ? 240 : 300;
      let pct = Math.min(1, c4Data.progress / maxProg);
      let label = isMyPlant ? 'PLANTANDO C4...' : 'DEFUSANDO C4...';
      let barColor = isMyPlant ? '#ffaa00' : '#0077ff';

      ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
      ctx.fillRect(canvas.width / 2 - 120, canvas.height / 2 + 60, 240, 24);
      ctx.fillStyle = barColor;
      ctx.fillRect(canvas.width / 2 - 120, canvas.height / 2 + 60, 240 * pct, 24);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(canvas.width / 2 - 120, canvas.height / 2 + 60, 240, 24);

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 13px Arial';
      ctx.textAlign = 'center';
      ctx.fillText(label, canvas.width / 2, canvas.height / 2 + 77);
    } else {
      let me = gameState.players[socket.id];
      if (me && me.alive) {
        if (me.team === 'TR' && me.hasC4 && me.weapon === 'c4') {
          let inSite = [
            { x: 100, y: 80, w: 200, h: 200 },
            { x: 1100, y: 80, w: 200, h: 200 }
          ].some(s => me.x >= s.x && me.x <= s.x + s.w && me.y >= s.y && me.y <= s.y + s.h);

          if (inSite) {
            ctx.fillStyle = '#ffaa00';
            ctx.font = 'bold 15px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('SEGURE [E] OU [CLIQUE] PARA PLANTAR A C4', canvas.width / 2, canvas.height / 2 + 80);
          }
        } else if (me.team === 'CT' && c4Data.status === 'planted') {
          let dist = Math.hypot(me.x - c4Data.x, me.y - c4Data.y);
          if (dist <= 35) {
            ctx.fillStyle = '#00e5ff';
            ctx.font = 'bold 15px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('SEGURE [E] OLHANDO PARA A C4 PARA DEFUSAR', canvas.width / 2, canvas.height / 2 + 80);
          }
        }
      }
    }
  }

  if (showBuyMenu) {
    ctx.fillStyle = 'rgba(10, 15, 25, 0.92)';
    ctx.fillRect(canvas.width / 2 - 220, 90, 440, 240);
    ctx.strokeStyle = '#00e5ff';
    ctx.strokeRect(canvas.width / 2 - 220, 90, 440, 240);

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 18px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('MENU DE COMPRA (Pressione B para fechar)', canvas.width / 2, 120);

    ctx.font = '14px Arial';
    ctx.fillText('Armas: [1] Rifle | [2] SMG | [3] Shotgun | [4] AWP', canvas.width / 2, 150);
    ctx.fillText('Granadas: [Z] Molotov | [X] Smoke | [C] Flash | [V] HE', canvas.width / 2, 175);

    let items = [
      { id: 'rifle', label: 'Rifle', x: -160, y: 200 },
      { id: 'smg', label: 'SMG', x: -60, y: 200 },
      { id: 'shotgun', label: '12', x: 40, y: 200 },
      { id: 'awp', label: 'AWP', x: 120, y: 200 },
      { id: 'molotov', label: '+Molo', x: -160, y: 250 },
      { id: 'smoke', label: '+Smoke', x: -60, y: 250 },
      { id: 'flash', label: '+Flash', x: 40, y: 250 },
      { id: 'he', label: '+HE', x: 120, y: 250 }
    ];

    items.forEach(it => {
      let bx = canvas.width / 2 + it.x;
      let by = it.y;
      ctx.fillStyle = '#1c2836';
      ctx.fillRect(bx, by, 70, 35);
      ctx.strokeStyle = '#3a4f66';
      ctx.strokeRect(bx, by, 70, 35);
      ctx.fillStyle = '#00e5ff';
      ctx.font = 'bold 12px Arial';
      ctx.fillText(it.label, bx + 35, by + 22);
    });
  }
}

canvas.addEventListener('click', e => {
  if (!showBuyMenu || !gameState) return;
  let mx = e.clientX;
  let my = e.clientY;

  let items = [
    { id: 'rifle', x: -160, y: 200 }, { id: 'smg', x: -60, y: 200 },
    { id: 'shotgun', x: 40, y: 200 }, { id: 'awp', x: 120, y: 200 },
    { id: 'molotov', x: -160, y: 250 }, { id: 'smoke', x: -60, y: 250 },
    { id: 'flash', x: 40, y: 250 }, { id: 'he', x: 120, y: 250 }
  ];

  items.forEach(it => {
    let bx = canvas.width / 2 + it.x;
    let by = it.y;
    if (mx >= bx && mx <= bx + 70 && my >= by && my <= by + 35) {
      buy(it.id);
    }
  });
});

function draw() {
  requestAnimationFrame(draw);
  if (!inMatch || !gameState || !gameState.players[socket.id]) return;

  updateAimAngle();

  let activePlayersCount = Object.values(gameState.players || {}).filter(p => p.inMatch).length;
  const me = gameState.players[socket.id];

  // LOOP DE TIROS COM CADÊNCIA, SPRAY E BALAS (NOVO)
  if (isShooting && !isPaused && !equippedGrenade && gameState.round) {
    if (!gameState.round.buyPhase || activePlayersCount === 1) {
      
      let clientFireRates = { rifle: 160, smg: 120, shotgun: 850, awp: 2000, c4: 9999 };
      let myFireRate = clientFireRates[me.weapon] || 160;
      let recoilIncrements = { rifle: 0.12, smg: 0.18, shotgun: 0.4, awp: 1.0, c4: 0 };
      
      if (Date.now() - lastClientShot > myFireRate && (me.weapon === 'c4' || (me.ammo !== undefined && me.ammo > 0))) {
        socket.emit('shoot');
        lastClientShot = Date.now();
        
        let rInc = recoilIncrements[me.weapon] || 0.1;
        currentRecoil = Math.min(currentRecoil + rInc, 0.7);
      }
    }
  }

  // DECAIMENTO DO RECUO (A mira volta ao centro lentamente)
  if (currentRecoil > 0) {
    currentRecoil = Math.max(0, currentRecoil - 0.02);
  }

  let cam = me;

  if (!me.alive) {
    if (me.deathTime && (Date.now() - me.deathTime < 2000)) {
      cam = me; 
    } else {
      const allies = Object.values(gameState.players).filter(p => p.inMatch && p.team === me.team && p.alive);
      if (allies.length > 0) {
        cam = allies[0]; 
      } else {
        cam = me; 
      }
    }
  }

  draw2D(cam);
  drawHUD(cam);
}

draw();

// ==========================================
// ============ CÓDIGO DO SERVER ============
// ==========================================

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

// ARMAS ATUALIZADAS COM MUNIÇÃO E RECUO (NOVO)
const WEAPONS = {
  rifle:   { name: 'Rifle', fireRate: 160, damage: 32, maxRange: 1200, speed: 18, radius: 3, magSize: 30, extraMags: 3, recoilInc: 0.12 },
  smg:     { name: 'SMG',   fireRate: 120, damage: 20, maxRange: 800,  speed: 16, radius: 3, magSize: 25, extraMags: 4, recoilInc: 0.18 },
  shotgun: { name: 'Shotgun', fireRate: 850, damage: 18, pellets: 6, maxRange: 320, speed: 14, radius: 3, magSize: 5, extraMags: 4, recoilInc: 0.4 },
  awp:     { name: 'AWP',   fireRate: 2000, damage: 115, maxRange: 2000, speed: 28, radius: 4, magSize: 1, extraMags: 10, recoilInc: 1.0 },
  c4:      { name: 'C4',    fireRate: 9999, damage: 0, maxRange: 0, speed: 0, radius: 0, magSize: 0, extraMags: 0, recoilInc: 0 }
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
    ammo: 30, reserveAmmo: 90, // MUNIÇÃO PADRÃO INICIAL
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
      // ENTREGA DE BALAS AO COMPRAR (NOVO)
      p.ammo = WEAPONS[item].magSize;
      p.reserveAmmo = WEAPONS[item].magSize * WEAPONS[item].extraMags;
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
    
    // GASTO DE BALA DO SERVIDOR (NOVO)
    if (p.weapon !== 'c4') {
      if (p.ammo <= 0) return;
      p.ammo--;
    }

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

  // SISTEMA DE RECARGA DO SERVIDOR (NOVO)
  socket.on('reload', () => {
    let p = players[socket.id];
    if (!p || !p.alive || !p.inMatch || p.weapon === 'c4' || roundEnding) return;
    
    let wData = WEAPONS[p.weapon];
    if (!wData) return;
    
    let needed = wData.magSize - p.ammo;
    if (needed > 0 && p.reserveAmmo > 0) {
      let amountToReload = Math.min(needed, p.reserveAmmo);
      p.ammo += amountToReload;
      p.reserveAmmo -= amountToReload;
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
      players[targetIds[0]].team = 'TR'; 
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

  let ctSpawns = [{ x: 1400, y: 500 }, { x: 1450, y: 450 }, { x: 1450, y: 550 }];
  let trSpawns = [{ x: 150, y: 500 }, { x: 100, y: 450 }, { x: 100, y: 550 }];
  let ctIdx = 0, trIdx = 0;
  
  let trPlayers = [];

  Object.values(players).forEach(p => {
    if (p.inMatch) {
      p.hp = 100; p.alive = true; p.hasC4 = false; p.deathTime = null;
      p.weapon = p.primaryWeapon || 'rifle';
      
      // RESET DA MUNIÇÃO QUANDO O ROUND COMEÇA (NOVO)
      let wData = WEAPONS[p.weapon];
      if (wData) {
        p.ammo = wData.magSize;
        p.reserveAmmo = wData.magSize * wData.extraMags;
      }

      p.grenades = { molotov: 0, smoke: 0, flash: 0, he: 0 };
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

  setTimeout(() => {
    startRound();
  }, 5000);
}

function gameLoop() {
  let activeCount = Object.values(players).filter(pl => pl.inMatch).length;

  if (!roundEnding && (!buyPhaseActive || activeCount === 1)) {
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
          c4.timer = 40 * 60;
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