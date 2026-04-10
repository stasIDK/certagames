'use strict';

// ══════════════════════════════════════════════════════════════════
//  CERTA.GAMES — Browser MMO Client
//  Three.js r128
// ══════════════════════════════════════════════════════════════════

class CertaGame {
  constructor() {
    // Three.js core
    this.scene    = null;
    this.camera   = null;
    this.renderer = null;
    this.clock    = new THREE.Clock();

    // Local player
    this.myId      = null;
    this.myName    = 'Adventurer';
    this.mesh      = null;
    this.velocity  = new THREE.Vector3();
    this.onGround  = false;
    this.isMoving  = false;

    // Third-person camera
    this.camTheta    = 0;        // horizontal orbit angle
    this.camPhi      = 0.45;     // vertical orbit angle  (0=horizon, PI/2=top)
    this.camDist     = 12;       // zoom distance
    this.camTarget   = new THREE.Vector3();

    // Input
    this.keys              = {};
    this.rightMouseDown    = false;
    this.chatOpen          = false;

    // WS send throttle
    this.lastSendMs  = 0;
    this.SEND_RATE   = 50;  // ms between sends (= 20 updates/sec)

    // World data
    this.trees       = [];        // [{x,z,r}]  for minimap + collision
    this.WORLD_SIZE  = 500;

    // Other players: Map<id, {mesh, nameMesh, targetPos}>
    this.others = new Map();

    // WebSocket
    this.ws = null;

    this._init();
  }

  // ── Boot ─────────────────────────────────────────────────────
  _init() {
    const btn   = document.getElementById('enter-btn');
    const input = document.getElementById('name-input');
    btn.addEventListener('click', () => this._enterWorld());
    input.addEventListener('keydown', e => { if (e.key === 'Enter') this._enterWorld(); });
    input.focus();
  }

  _enterWorld() {
    const raw = document.getElementById('name-input').value.trim();
    this.myName = raw.length > 0 ? raw : 'Wanderer';
    document.getElementById('splash').style.display = 'none';
    document.getElementById('hud').style.display = 'block';

    this._setupRenderer();
    this._setupScene();
    this._setupLights();
    this._buildWorld();
    this._spawnLocalPlayer();
    this._setupInput();
    this._connectWS();
    this._loop();
  }

  // ── Renderer ─────────────────────────────────────────────────
  _setupRenderer() {
    const canvas = document.getElementById('game-canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping       = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  // ── Scene + Camera ───────────────────────────────────────────
  _setupScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x89c4e1);
    this.scene.fog = new THREE.Fog(0x89c4e1, 100, 350);

    this.camera = new THREE.PerspectiveCamera(
      60, window.innerWidth / window.innerHeight, 0.1, 800
    );
  }

  // ── Lighting ─────────────────────────────────────────────────
  _setupLights() {
    // Ambient fill
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.45));

    // Hemisphere (sky/ground color)
    this.scene.add(new THREE.HemisphereLight(0x89c4e1, 0x3d6b2a, 0.55));

    // Directional sun
    const sun = new THREE.DirectionalLight(0xfff3cc, 1.1);
    sun.position.set(120, 180, 80);
    sun.castShadow = true;
    const sd = sun.shadow;
    sd.mapSize.width  = 2048;
    sd.mapSize.height = 2048;
    sd.camera.near    = 1;
    sd.camera.far     = 600;
    sd.camera.left    = -150; sd.camera.right  = 150;
    sd.camera.top     = 150;  sd.camera.bottom = -150;
    sd.bias           = -0.0003;
    this.scene.add(sun);
    this.sun = sun;
  }

  // ── World ────────────────────────────────────────────────────
  _buildWorld() {
    this._buildTerrain();
    this._buildWater();
    this._buildTrees(250);
    this._buildClouds(24);
    this._buildRocks(60);
  }

  // Height formula — must be identical to what's baked into geometry
  _height(wx, wz) {
    return (
      Math.sin(wx * 0.048) * Math.cos(wz * 0.048) * 3.0 +
      Math.sin(wx * 0.10 + 1.2) * Math.sin(wz * 0.09) * 1.8 +
      Math.sin(wx * 0.022) * Math.sin(wz * 0.022) * 5.0 +
      Math.cos(wx * 0.035 + 0.5) * Math.cos(wz * 0.028 + 1.0) * 2.0
    );
  }

  _buildTerrain() {
    const SEGS = 128;
    const geo  = new THREE.PlaneGeometry(this.WORLD_SIZE, this.WORLD_SIZE, SEGS, SEGS);
    const pos  = geo.attributes.position;

    for (let i = 0; i < pos.count; i++) {
      const wx =  pos.getX(i);
      const wz = -pos.getY(i);  // PlaneGeometry Y → world -Z after rotation
      pos.setZ(i, this._height(wx, wz));
    }
    geo.computeVertexNormals();

    // Procedural grass texture
    const tex = this._makeGrassTex();

    const mat = new THREE.MeshLambertMaterial({ map: tex });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.groundMesh = mesh;
  }

  _makeGrassTex() {
    const S = 512, ctx = document.createElement('canvas');
    ctx.width = ctx.height = S;
    const c = ctx.getContext('2d');

    c.fillStyle = '#3d7030';
    c.fillRect(0, 0, S, S);

    for (let i = 0; i < 10000; i++) {
      const x = Math.random() * S, y = Math.random() * S;
      const r = Math.random() * 3 + 0.5;
      const g = Math.floor(Math.random() * 35 + 50);
      const b = Math.floor(Math.random() * 20 + 32);
      c.fillStyle = `rgb(${b}, ${g}, ${Math.floor(b * 0.55)})`;
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
    }

    const t = new THREE.CanvasTexture(ctx);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(60, 60);
    return t;
  }

  _buildWater() {
    // Animated-ish lake
    const geo = new THREE.CircleGeometry(30, 48);
    const mat = new THREE.MeshLambertMaterial({
      color: 0x2277bb, transparent: true, opacity: 0.78,
    });
    const lake = new THREE.Mesh(geo, mat);
    lake.rotation.x = -Math.PI / 2;
    lake.position.set(100, 0.3, 80);
    this.scene.add(lake);
    this.lake = lake;
  }

  _buildTrees(count) {
    const trunkMat  = new THREE.MeshLambertMaterial({ color: 0x5c3210 });
    const leafMats  = [
      new THREE.MeshLambertMaterial({ color: 0x2e6e2e }),
      new THREE.MeshLambertMaterial({ color: 0x1e5c1e }),
      new THREE.MeshLambertMaterial({ color: 0x3a7a3a }),
    ];

    for (let i = 0; i < count; i++) {
      const wx = (Math.random() - 0.5) * (this.WORLD_SIZE - 40);
      const wz = (Math.random() - 0.5) * (this.WORLD_SIZE - 40);
      if (Math.abs(wx) < 18 && Math.abs(wz) < 18) continue; // keep spawn clear

      const h  = Math.random() * 5 + 5;
      const g  = new THREE.Group();

      // Trunk
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.28, 0.48, h, 7), trunkMat
      );
      trunk.position.y = h / 2;
      trunk.castShadow = true;
      g.add(trunk);

      // 3 stacked cones of leaves
      for (let j = 0; j < 3; j++) {
        const cone = new THREE.Mesh(
          new THREE.ConeGeometry(2.8 - j * 0.45, h * 0.55, 7),
          leafMats[j % 3]
        );
        cone.position.y = h * 0.75 + j * h * 0.22;
        cone.castShadow = true;
        g.add(cone);
      }

      const gy = this._height(wx, wz);
      g.position.set(wx, gy, wz);
      this.scene.add(g);
      this.trees.push({ x: wx, z: wz, r: 1.3 });
    }
  }

  _buildRocks(count) {
    const mat = new THREE.MeshLambertMaterial({ color: 0x888880 });
    for (let i = 0; i < count; i++) {
      const wx = (Math.random() - 0.5) * 460;
      const wz = (Math.random() - 0.5) * 460;
      const s  = Math.random() * 1.5 + 0.4;
      const geo = new THREE.DodecahedronGeometry(s, 0);
      // Squish + tilt for natural look
      geo.scale(1, 0.5 + Math.random() * 0.4, 0.8 + Math.random() * 0.4);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(wx, this._height(wx, wz) + s * 0.3, wz);
      mesh.rotation.y = Math.random() * Math.PI;
      mesh.castShadow = mesh.receiveShadow = true;
      this.scene.add(mesh);
    }
  }

  _buildClouds(count) {
    const mat = new THREE.MeshLambertMaterial({
      color: 0xffffff, transparent: true, opacity: 0.88
    });
    this.clouds = [];
    for (let i = 0; i < count; i++) {
      const g = new THREE.Group();
      const puffs = Math.floor(Math.random() * 4 + 3);
      for (let j = 0; j < puffs; j++) {
        const s = new THREE.Mesh(
          new THREE.SphereGeometry(Math.random() * 5 + 3, 7, 5), mat
        );
        s.position.set(
          (Math.random() - 0.5) * 16,
          (Math.random() - 0.5) * 3,
          (Math.random() - 0.5) * 9
        );
        g.add(s);
      }
      g.position.set(
        (Math.random() - 0.5) * 500,
        110 + Math.random() * 50,
        (Math.random() - 0.5) * 500
      );
      g.userData.speed = 0.4 + Math.random() * 0.6;
      this.scene.add(g);
      this.clouds.push(g);
    }
  }

  // ── Local Player ─────────────────────────────────────────────
  _spawnLocalPlayer() {
    this.mesh = this._makeCharMesh(0x4488ff);
    this.mesh.position.set(0, 2, 0);
    this.scene.add(this.mesh);
  }

  _makeCharMesh(hexColor) {
    const g   = new THREE.Group();
    const col = new THREE.Color(hexColor);
    const mat = new THREE.MeshLambertMaterial({ color: col });
    const drk = new THREE.MeshLambertMaterial({ color: col.clone().multiplyScalar(0.7) });

    const add = (geo, m, px, py, pz, rx = 0) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(px, py, pz);
      mesh.rotation.x = rx;
      mesh.castShadow = true;
      g.add(mesh);
      return mesh;
    };

    // Body
    add(new THREE.BoxGeometry(0.82, 1.05, 0.52), mat,  0, 0.52, 0);
    // Head
    add(new THREE.BoxGeometry(0.72, 0.72, 0.72), mat,  0, 1.38, 0);
    // Eyes
    const eyeM = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const pupM = new THREE.MeshBasicMaterial({ color: 0x001133 });
    [-0.16, 0.16].forEach(ex => {
      add(new THREE.BoxGeometry(0.13, 0.13, 0.04), eyeM, ex, 1.46, 0.37);
      add(new THREE.BoxGeometry(0.07, 0.07, 0.04), pupM, ex, 1.46, 0.39);
    });
    // Arms
    g.armL = add(new THREE.BoxGeometry(0.26, 0.84, 0.27), drk, -0.56, 0.44, 0);
    g.armR = add(new THREE.BoxGeometry(0.26, 0.84, 0.27), mat,  0.56, 0.44, 0);
    // Legs
    g.legL = add(new THREE.BoxGeometry(0.32, 0.82, 0.32), mat,  -0.22, -0.42, 0);
    g.legR = add(new THREE.BoxGeometry(0.32, 0.82, 0.32), drk,   0.22, -0.42, 0);

    return g;
  }

  // ── Nametag sprite ───────────────────────────────────────────
  _makeNameSprite(name, colorHex = '#ffffff') {
    const W = 256, H = 64;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');

    // Background pill
    c.fillStyle = 'rgba(0,0,0,0.6)';
    c.beginPath();
    c.moveTo(12, 4); c.lineTo(W - 12, 4);
    c.arcTo(W - 4, 4, W - 4, 12, 8);
    c.lineTo(W - 4, H - 12);
    c.arcTo(W - 4, H - 4, W - 12, H - 4, 8);
    c.lineTo(12, H - 4);
    c.arcTo(4, H - 4, 4, H - 12, 8);
    c.lineTo(4, 12);
    c.arcTo(4, 4, 12, 4, 8);
    c.fill();

    // Name text
    c.fillStyle = colorHex;
    c.font = 'bold 26px "Segoe UI", Arial';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(name.slice(0, 18), W / 2, H / 2);

    const tex = new THREE.CanvasTexture(cv);
    const spr = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })
    );
    spr.scale.set(2.8, 0.7, 1);
    spr.position.y = 2.7;
    return spr;
  }

  // ── Input ────────────────────────────────────────────────────
  _setupInput() {
    const onKey = (down) => (e) => {
      if (this.chatOpen) return;
      this.keys[e.code] = down;
    };
    document.addEventListener('keydown', onKey(true));
    document.addEventListener('keyup',   onKey(false));

    // Open/close chat with Enter
    document.addEventListener('keydown', (e) => {
      const ci = document.getElementById('chat-input');
      if (e.key === 'Enter' && !this.chatOpen) {
        this.chatOpen = true;
        ci.classList.add('open');
        ci.focus();
        e.preventDefault();
      } else if (e.key === 'Enter' && this.chatOpen) {
        const txt = ci.value.trim();
        if (txt && this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'chat', text: txt }));
        }
        ci.value = '';
        ci.classList.remove('open');
        ci.blur();
        this.chatOpen = false;
        e.preventDefault();
      } else if (e.key === 'Escape' && this.chatOpen) {
        ci.value = '';
        ci.classList.remove('open');
        ci.blur();
        this.chatOpen = false;
      }
    });

    // Camera mouse
    const cv = this.renderer.domElement;
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('mousedown',   e => { if (e.button === 2) this.rightMouseDown = true; });
    cv.addEventListener('mouseup',     e => { if (e.button === 2) this.rightMouseDown = false; });
    cv.addEventListener('mousemove',   e => {
      if (!this.rightMouseDown) return;
      this.camTheta -= e.movementX * 0.005;
      this.camPhi    = Math.max(0.08, Math.min(1.45, this.camPhi - e.movementY * 0.005));
    });
    cv.addEventListener('wheel', e => {
      this.camDist = Math.max(3, Math.min(35, this.camDist + e.deltaY * 0.02));
    });
  }

  // ── WebSocket ─────────────────────────────────────────────────
  _connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${proto}//${location.host}`);

    this.ws.addEventListener('open', () => {
      this.ws.send(JSON.stringify({ type: 'setName', name: this.myName }));
      this._addChat(null, 'Connected to world!', 'system');
    });

    this.ws.addEventListener('message', ({ data }) => {
      try { this._onMsg(JSON.parse(data)); } catch {}
    });

    this.ws.addEventListener('close', () => {
      this._addChat(null, 'Disconnected — refresh to reconnect.', 'system');
    });
  }

  _onMsg(msg) {
    switch (msg.type) {

      case 'welcome':
        this.myId = msg.id;
        msg.players.forEach(p => { if (p.id !== this.myId) this._spawnOther(p); });
        this._updatePlayerCount();
        break;

      case 'playerJoin':
        this._spawnOther(msg.player);
        this._addChat(null, `${msg.player.name} entered the world.`, 'system');
        this._updatePlayerCount();
        break;

      case 'playerLeave':
        this._removeOther(msg.id);
        if (msg.name) this._addChat(null, `${msg.name} left the world.`, 'system');
        this._updatePlayerCount();
        break;

      case 'playerMove':
        this._moveOther(msg);
        break;

      case 'playerName': {
        const o = this.others.get(msg.id);
        if (o) {
          o.mesh.remove(o.nameSpr);
          o.nameSpr = this._makeNameSprite(msg.name, o.color);
          o.mesh.add(o.nameSpr);
          o.name = msg.name;
        }
        break;
      }

      case 'chat':
        this._addChat(msg.name, msg.text);
        break;
    }
  }

  // ── Other Players ─────────────────────────────────────────────
  _spawnOther(data) {
    const mesh    = this._makeCharMesh(new THREE.Color(data.color || '#ff4444').getHex());
    mesh.position.set(data.x, data.y, data.z);

    const nameSpr = this._makeNameSprite(data.name || `Player${data.id}`, data.color || '#ffffff');
    mesh.add(nameSpr);
    this.scene.add(mesh);

    this.others.set(data.id, {
      mesh,
      nameSpr,
      name  : data.name,
      color : data.color,
      targetPos: new THREE.Vector3(data.x, data.y, data.z),
    });
  }

  _removeOther(id) {
    const o = this.others.get(id);
    if (o) { this.scene.remove(o.mesh); this.others.delete(id); }
  }

  _moveOther(msg) {
    const o = this.others.get(msg.id);
    if (o) {
      o.targetPos.set(msg.x, msg.y, msg.z);
      o.mesh.rotation.y = msg.rotY;
    }
  }

  _updatePlayerCount() {
    const n = this.others.size + 1;
    document.getElementById('player-count').textContent =
      `👥 ${n} player${n !== 1 ? 's' : ''}`;
  }

  // ── Chat ──────────────────────────────────────────────────────
  _addChat(name, text, cls = '') {
    const box = document.getElementById('chat-messages');
    const d   = document.createElement('div');
    d.className = 'msg ' + cls;
    d.textContent = name ? `${name}: ${text}` : text;
    box.appendChild(d);
    while (box.children.length > 12) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  // ── Minimap ───────────────────────────────────────────────────
  _drawMinimap() {
    const cv  = document.getElementById('minimap-canvas');
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    const cx = W / 2, cy = H / 2;
    const scale = W / 160; // 160 world units visible

    ctx.clearRect(0, 0, W, H);

    // bg
    ctx.fillStyle = 'rgba(15, 35, 15, 0.9)';
    ctx.beginPath(); ctx.arc(cx, cy, cx, 0, Math.PI * 2); ctx.fill();

    const px = this.mesh.position.x;
    const pz = this.mesh.position.z;

    // Trees
    ctx.fillStyle = '#2a6a2a';
    this.trees.forEach(t => {
      const mx = cx + (t.x - px) * scale;
      const my = cy + (t.z - pz) * scale;
      ctx.beginPath(); ctx.arc(mx, my, 2, 0, Math.PI * 2); ctx.fill();
    });

    // Others
    this.others.forEach(o => {
      const mx = cx + (o.mesh.position.x - px) * scale;
      const my = cy + (o.mesh.position.z - pz) * scale;
      ctx.fillStyle = o.color || '#ff4444';
      ctx.beginPath(); ctx.arc(mx, my, 4, 0, Math.PI * 2); ctx.fill();
    });

    // Self
    ctx.fillStyle = '#4488ff';
    ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill();

    // Direction indicator
    const dx = Math.sin(this.mesh.rotation.y) * 8;
    const dz = Math.cos(this.mesh.rotation.y) * 8;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + dx, cy + dz); ctx.stroke();

    // Clip to circle
    ctx.globalCompositeOperation = 'destination-in';
    ctx.beginPath(); ctx.arc(cx, cy, cx, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  // ── Walk animation ────────────────────────────────────────────
  _animateCharacter(mesh, moving, t) {
    const speed = 8;
    const { armL, armR, legL, legR } = mesh;
    if (!armL) return;

    if (moving) {
      const swing = Math.sin(t * speed) * 0.45;
      armL.rotation.x =  swing;
      armR.rotation.x = -swing;
      legL.rotation.x = -swing;
      legR.rotation.x =  swing;
    } else {
      // Ease back to rest
      [armL, armR, legL, legR].forEach(p => { p.rotation.x *= 0.85; });
    }
  }

  // ── Main Update ───────────────────────────────────────────────
  _update(dt) {
    const now = performance.now();

    // ── Movement ──
    const speed = 10 * dt;

    // Camera-relative WASD
    const fwd = new THREE.Vector3(-Math.sin(this.camTheta), 0, -Math.cos(this.camTheta));
    const rgt = new THREE.Vector3( Math.cos(this.camTheta), 0, -Math.sin(this.camTheta));
    const dir = new THREE.Vector3();

    if (this.keys['KeyW'] || this.keys['ArrowUp'])    dir.addScaledVector(fwd,  1);
    if (this.keys['KeyS'] || this.keys['ArrowDown'])  dir.addScaledVector(fwd, -1);
    if (this.keys['KeyA'] || this.keys['ArrowLeft'])  dir.addScaledVector(rgt, -1);
    if (this.keys['KeyD'] || this.keys['ArrowRight']) dir.addScaledVector(rgt,  1);

    this.isMoving = dir.lengthSq() > 0;

    if (this.isMoving) {
      dir.normalize();
      this.mesh.position.addScaledVector(dir, speed);
      this.mesh.rotation.y = Math.atan2(dir.x, dir.z);
    }

    // Jump
    if (this.keys['Space'] && this.onGround) {
      this.velocity.y = 9;
      this.onGround = false;
    }

    // Gravity
    this.velocity.y -= 22 * dt;
    this.mesh.position.y += this.velocity.y * dt;

    // Ground snap
    const gy = this._height(this.mesh.position.x, this.mesh.position.z);
    if (this.mesh.position.y <= gy) {
      this.mesh.position.y = gy;
      this.velocity.y      = 0;
      this.onGround        = true;
    }

    // Bounds
    const B = this.WORLD_SIZE / 2 - 10;
    this.mesh.position.x = Math.max(-B, Math.min(B, this.mesh.position.x));
    this.mesh.position.z = Math.max(-B, Math.min(B, this.mesh.position.z));

    // ── Walk animation ──
    this._animateCharacter(this.mesh, this.isMoving, now * 0.001);

    // ── Camera ──
    this.camTarget.lerp(this.mesh.position, 0.14);
    const sinT = Math.sin(this.camTheta), cosT = Math.cos(this.camTheta);
    const sinP = Math.sin(this.camPhi),   cosP = Math.cos(this.camPhi);
    this.camera.position.set(
      this.camTarget.x + this.camDist * sinT * cosP,
      this.camTarget.y + this.camDist * sinP,
      this.camTarget.z + this.camDist * cosT * cosP
    );
    this.camera.lookAt(
      this.camTarget.x, this.camTarget.y + 1.0, this.camTarget.z
    );

    // ── Interpolate other players ──
    this.others.forEach(o => {
      o.mesh.position.lerp(o.targetPos, 0.22);
      this._animateCharacter(
        o.mesh,
        o.targetPos.distanceTo(o.mesh.position) > 0.05,
        now * 0.001
      );
    });

    // ── Drift clouds ──
    this.clouds.forEach(c => {
      c.position.x += c.userData.speed * dt;
      if (c.position.x > 260) c.position.x = -260;
    });

    // ── Send position to server (throttled) ──
    if (now - this.lastSendMs > this.SEND_RATE && this.ws?.readyState === WebSocket.OPEN) {
      this.lastSendMs = now;
      this.ws.send(JSON.stringify({
        type: 'move',
        x   : +this.mesh.position.x.toFixed(2),
        y   : +this.mesh.position.y.toFixed(2),
        z   : +this.mesh.position.z.toFixed(2),
        rotY: +this.mesh.rotation.y.toFixed(3),
      }));
    }

    // ── HUD coords ──
    document.getElementById('coords').textContent =
      `X: ${this.mesh.position.x.toFixed(0)}  Z: ${this.mesh.position.z.toFixed(0)}`;

    // ── Minimap ──
    this._drawMinimap();
  }

  // ── Render Loop ───────────────────────────────────────────────
  _loop() {
    requestAnimationFrame(() => this._loop());
    const dt = Math.min(this.clock.getDelta(), 0.1);
    if (this.mesh) this._update(dt);
    this.renderer.render(this.scene, this.camera);
  }
}

// ── Boot ──────────────────────────────────────────────────────
window.addEventListener('load', () => {
  window._game = new CertaGame();
});
