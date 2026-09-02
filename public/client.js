const socket = io();
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const MAP_WIDTH = 1600;
const MAP_HEIGHT = 1000;
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

  // NOVO BOTÃO: SAIR DA PARTIDA VIA MENU DE PAUSA (ESC)
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

  localAngle = Math.atan2(worldMouseY - me.y, worldMouseX - me.x);
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
    // Faz o rastro sumir suavemente de acordo com a duração
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

    // A) Trajetória de Pulo (Azul / Esquerdo) - Linha reta, sem colisão
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

    // B) Trajetória de Tabela (Laranja / Direito) - Com colisão física
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
  // Caixa Background HUD
  ctx.fillStyle = 'rgba(20, 20, 20, 0.9)';
  ctx.fillRect(20, canvas.height - 90, 520, 70);
  
  ctx.fillStyle = '#fff';
  ctx.font = '14px Arial';
  ctx.textAlign = 'left';

  let gCount = `[Molo:${cam.grenades.molotov} Smk:${cam.grenades.smoke} Flsh:${cam.grenades.flash} HE:${cam.grenades.he}]`;
  let itemHand = equippedGrenade ? `GRANADA: ${equippedGrenade.toUpperCase()}` : `ARMA: ${cam.weapon.toUpperCase()}`;
  
  ctx.fillText(`${cam.nickname || 'Player'} | TIME: ${cam.team} | HP: ${cam.hp}`, 80, canvas.height - 65);
  ctx.fillText(`${itemHand} | ${gCount}`, 80, canvas.height - 40);

  // Ícone visual de Arma do HUD
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

  // Tempo / Status Principal no Topo
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

  // Dicas HUD - Granadas
  if (equippedGrenade && cam.id === socket.id && cam.alive) {
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 15px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('Esquerdo (Pula Paredes) | Direito (Tabela Fisicamente)', canvas.width / 2, canvas.height - 60);
  }

  // HUD DE PLANT / DEFUSE NO CENTRO DA TELA
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

  if (isShooting && !isPaused && !equippedGrenade && gameState.round) {
    if (!gameState.round.buyPhase || activePlayersCount === 1) {
      socket.emit('shoot');
    }
  }

  const me = gameState.players[socket.id];
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