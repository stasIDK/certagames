'use strict';

// ── Shared constants (must match server) ─────────────────────
const FOOT_OFFSET   = 0.83;   // character mesh origin → feet distance
const GUN_MAX_AMMO  = 30;

// Building definitions — identical to server
const BUILDING_DEFS = [
  { x:  25, z:  25, w: 14, d: 10 },
  { x: -45, z:  35, w: 12, d:  8 },
  { x:  60, z: -40, w: 16, d: 10 },
  { x: -60, z: -50, w: 12, d: 12 },
  { x:  90, z:  70, w: 14, d:  8 },
  { x: -80, z:  90, w: 10, d: 10 },
  { x:  30, z: -90, w: 12, d:  8 },
  { x:-100, z: -30, w: 16, d: 10 },
];

// ══════════════════════════════════════════════════════════════
class CertaGame {
  constructor() {
    this.scene    = null;
    this.camera   = null;
    this.renderer = null;
    this.clock    = new THREE.Clock();

    // Local player state
    this.myId     = null;
    this.myName   = 'Adventurer';
    this.mesh     = null;
    this.velocity = new THREE.Vector3();
    this.onGround = false;
    this.alive    = true;
    this.hp       = 100;
    this.maxHp    = 100;
    this.hasGun   = false;
    this.ammo     = 0;
    this.lastPunch = 0;
    this.lastShoot = 0;

    // Camera (third-person orbit)
    this.camTheta  = 0;
    this.camPhi    = 0.45;
    this.camDist   = 12;
    this.camTarget = new THREE.Vector3();

    // Input
    this.keys           = {};
    this.rightMouseDown = false;
    this.chatOpen       = false;

    // Network throttle
    this.lastSendMs = 0;
    this.SEND_RATE  = 50;

    // World
    this.WORLD_SIZE = 500;
    this.trees      = [];

    // Multiplayer
    this.others  = new Map(); // id -> { mesh, nameSpr, targetPos, color }
    this.zombies = new Map(); // id -> { mesh, targetPos, hp, maxHp }
    this.loots   = [];        // [ { id, mesh, available, x, z } ]

    this.ws = null;
    this._init();
  }

  // ── Boot ─────────────────────────────────────────────────────
  _init() {
    document.getElementById('enter-btn').addEventListener('click', () => this._enterWorld());
    document.getElementById('name-input').addEventListener('keydown', e => { if (e.key === 'Enter') this._enterWorld(); });
    document.getElementById('respawn-btn').addEventListener('click', () => this._respawn());
    document.getElementById('name-input').focus();
  }

  _enterWorld() {
    const raw = document.getElementById('name-input').value.trim();
    this.myName = raw || 'Wanderer';
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
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  _setupScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x89c4e1);
    this.scene.fog = new THREE.Fog(0x89c4e1, 100, 350);
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 800);
  }

  _setupLights() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.45));
    this.scene.add(new THREE.HemisphereLight(0x89c4e1, 0x3d6b2a, 0.55));
    const sun = new THREE.DirectionalLight(0xfff3cc, 1.1);
    sun.position.set(120, 180, 80);
    sun.castShadow = true;
    const s = sun.shadow;
    s.mapSize.set(2048, 2048);
    s.camera.near = 1; s.camera.far = 600;
    s.camera.left = -150; s.camera.right = 150;
    s.camera.top  = 150;  s.camera.bottom = -150;
    s.bias = -0.0003;
    this.scene.add(sun);
  }

  // ── World ─────────────────────────────────────────────────────
  _buildWorld() {
    this._buildTerrain();
    this._buildWater();
    this._buildTrees(220);
    this._buildClouds(24);
    this._buildRocks(60);
    this._buildBuildings();
    this._spawnLoots();
  }

  // Height formula — identical to server groundHeight()
  _height(x, z) {
    return (
      Math.sin(x * 0.048) * Math.cos(z * 0.048) * 3.0 +
      Math.sin(x * 0.10 + 1.2) * Math.sin(z * 0.09) * 1.8 +
      Math.sin(x * 0.022) * Math.sin(z * 0.022) * 5.0 +
      Math.cos(x * 0.035 + 0.5) * Math.cos(z * 0.028 + 1.0) * 2.0
    );
  }

  _buildTerrain() {
    const SEGS = 128;
    const geo  = new THREE.PlaneGeometry(this.WORLD_SIZE, this.WORLD_SIZE, SEGS, SEGS);
    const pos  = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setZ(i, this._height(pos.getX(i), -pos.getY(i)));
    }
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: this._makeGrassTex() }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  _makeGrassTex() {
    const S = 512, cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const c = cv.getContext('2d');
    c.fillStyle = '#3d7030'; c.fillRect(0, 0, S, S);
    for (let i = 0; i < 10000; i++) {
      const x = Math.random()*S, y = Math.random()*S, r = Math.random()*3+0.5;
      const g = Math.floor(Math.random()*35+50), b = Math.floor(Math.random()*20+32);
      c.fillStyle = `rgb(${b},${g},${Math.floor(b*0.55)})`;
      c.beginPath(); c.arc(x,y,r,0,Math.PI*2); c.fill();
    }
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(60, 60);
    return t;
  }

  _buildWater() {
    const lake = new THREE.Mesh(
      new THREE.CircleGeometry(30, 48),
      new THREE.MeshLambertMaterial({ color: 0x2277bb, transparent: true, opacity: 0.78 })
    );
    lake.rotation.x = -Math.PI / 2;
    lake.position.set(100, 0.3, 80);
    this.scene.add(lake);
  }

  _buildTrees(count) {
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x5c3210 });
    const leafMats = [0x2e6e2e, 0x1e5c1e, 0x3a7a3a].map(c => new THREE.MeshLambertMaterial({ color: c }));
    for (let i = 0; i < count; i++) {
      const wx = (Math.random()-0.5)*(this.WORLD_SIZE-40);
      const wz = (Math.random()-0.5)*(this.WORLD_SIZE-40);
      if (Math.abs(wx) < 18 && Math.abs(wz) < 18) continue;
      const h = Math.random()*5+5, g = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.28,0.48,h,7), trunkMat);
      trunk.position.y = h/2; trunk.castShadow = true; g.add(trunk);
      for (let j = 0; j < 3; j++) {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(2.8-j*0.45, h*0.55, 7), leafMats[j%3]);
        cone.position.y = h*0.75+j*h*0.22; cone.castShadow = true; g.add(cone);
      }
      g.position.set(wx, this._height(wx, wz), wz);
      this.scene.add(g);
      this.trees.push({ x: wx, z: wz });
    }
  }

  _buildRocks(count) {
    const mat = new THREE.MeshLambertMaterial({ color: 0x888880 });
    for (let i = 0; i < count; i++) {
      const wx = (Math.random()-0.5)*460, wz = (Math.random()-0.5)*460;
      const s  = Math.random()*1.5+0.4;
      const geo = new THREE.DodecahedronGeometry(s, 0);
      geo.scale(1, 0.5+Math.random()*0.4, 0.8+Math.random()*0.4);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(wx, this._height(wx,wz)+s*0.3, wz);
      mesh.rotation.y = Math.random()*Math.PI;
      mesh.castShadow = mesh.receiveShadow = true;
      this.scene.add(mesh);
    }
  }

  _buildClouds(count) {
    this.clouds = [];
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.88 });
    for (let i = 0; i < count; i++) {
      const g = new THREE.Group();
      for (let j = 0; j < Math.floor(Math.random()*4+3); j++) {
        const s = new THREE.Mesh(new THREE.SphereGeometry(Math.random()*5+3, 7, 5), mat);
        s.position.set((Math.random()-0.5)*16, (Math.random()-0.5)*3, (Math.random()-0.5)*9);
        g.add(s);
      }
      g.position.set((Math.random()-0.5)*500, 110+Math.random()*50, (Math.random()-0.5)*500);
      g.userData.speed = 0.4+Math.random()*0.6;
      this.scene.add(g); this.clouds.push(g);
    }
  }

  // ── Buildings ────────────────────────────────────────────────
  _buildBuildings() {
    const wallMat  = new THREE.MeshLambertMaterial({ color: 0xc8b88a });
    const roofMat  = new THREE.MeshLambertMaterial({ color: 0x7a4f2d });
    const floorMat = new THREE.MeshLambertMaterial({ color: 0xa0916e });

    BUILDING_DEFS.forEach(b => {
      const gy = this._height(b.x, b.z);
      const g  = new THREE.Group();
      const H = 5, T = 0.45, DW = 2.2;

      const add = (geo, mat, x, y, z) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, z);
        m.castShadow = m.receiveShadow = true;
        g.add(m);
      };

      // Floor
      add(new THREE.BoxGeometry(b.w, 0.2, b.d), floorMat, 0, 0.1, 0);
      // Back wall
      add(new THREE.BoxGeometry(b.w, H, T), wallMat, 0, H/2, -b.d/2);
      // Side walls
      add(new THREE.BoxGeometry(T, H, b.d), wallMat, -b.w/2, H/2, 0);
      add(new THREE.BoxGeometry(T, H, b.d), wallMat,  b.w/2, H/2, 0);
      // Front wall — two pieces with door gap
      const sw = (b.w - DW) / 2;
      add(new THREE.BoxGeometry(sw, H, T), wallMat, -(DW/2+sw/2), H/2, b.d/2);
      add(new THREE.BoxGeometry(sw, H, T), wallMat,  (DW/2+sw/2), H/2, b.d/2);
      // Door header
      add(new THREE.BoxGeometry(DW, H-3, T), wallMat, 0, 3+(H-3)/2, b.d/2);
      // Roof
      add(new THREE.BoxGeometry(b.w+0.6, 0.4, b.d+0.6), roofMat, 0, H+0.2, 0);

      g.position.set(b.x, gy, b.z);
      this.scene.add(g);
    });
  }

  // ── Loot (guns) ───────────────────────────────────────────────
  _spawnLoots() {
    BUILDING_DEFS.forEach((b, i) => {
      const lx = b.x + 2, lz = b.z + 2;
      const mesh = this._makeLootMesh();
      mesh.position.set(lx, this._height(lx, lz) + 1.2, lz);
      this.scene.add(mesh);
      this.loots.push({ id: i, mesh, available: true, x: lx, z: lz });
    });
  }

  _makeLootMesh() {
    const g    = new THREE.Group();
    const dark = new THREE.MeshLambertMaterial({ color: 0x222222 });
    const grey = new THREE.MeshLambertMaterial({ color: 0x888888 });
    // Barrel
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.16, 0.16), dark);
    barrel.position.set(0.15, 0.06, 0); g.add(barrel);
    // Body
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.26, 0.2), dark);
    body.position.set(-0.12, 0, 0); g.add(body);
    // Grip
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.34, 0.18), grey);
    grip.position.set(-0.18, -0.24, 0); g.add(grip);
    // Glow ring
    const glow = new THREE.Mesh(
      new THREE.TorusGeometry(0.48, 0.04, 6, 12),
      new THREE.MeshBasicMaterial({ color: 0xffdd00 })
    );
    glow.rotation.x = Math.PI / 2;
    g.add(glow);
    g.userData.glow = glow;
    return g;
  }

  _setLootAvailable(id, available) {
    const l = this.loots.find(l => l.id === id);
    if (!l) return;
    l.available = available;
    l.mesh.visible = available;
  }

  // ── Local player ──────────────────────────────────────────────
  _spawnLocalPlayer() {
    this.mesh = this._makeCharMesh(0x4488ff);
    const gy  = this._height(0, 0);
    this.mesh.position.set(0, gy + FOOT_OFFSET, 0);
    this.scene.add(this.mesh);
  }

  // ── Character mesh builder ────────────────────────────────────
  _makeCharMesh(hexColor) {
    const g   = new THREE.Group();
    const col = new THREE.Color(hexColor);
    const mat = new THREE.MeshLambertMaterial({ color: col });
    const drk = new THREE.MeshLambertMaterial({ color: col.clone().multiplyScalar(0.65) });

    const add = (geo, m, x, y, z) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      g.add(mesh);
      return mesh;
    };

    // Body
    add(new THREE.BoxGeometry(0.82, 1.05, 0.52), mat, 0, 0.52, 0);
    // Head
    add(new THREE.BoxGeometry(0.72, 0.72, 0.72), mat, 0, 1.38, 0);
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

  _makeNameSprite(name, colorHex = '#ffffff') {
    const W = 256, H = 64, cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    c.fillStyle = 'rgba(0,0,0,0.6)';
    c.beginPath(); c.roundRect(4, 4, W-8, H-8, 8); c.fill();
    c.fillStyle = colorHex;
    c.font = 'bold 26px "Segoe UI", Arial';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(name.slice(0, 18), W/2, H/2);
    const tex = new THREE.CanvasTexture(cv);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    spr.scale.set(2.8, 0.7, 1);
    spr.position.y = 2.7;
    return spr;
  }

  // ── Input ─────────────────────────────────────────────────────
  _setupInput() {
    document.addEventListener('keydown', e => {
      if (this.chatOpen) return;
      this.keys[e.code] = true;
      if (e.code === 'KeyF') this._doPunch();
      if (e.code === 'KeyE') this._doPickup();
    });
    document.addEventListener('keyup', e => { this.keys[e.code] = false; });

    // Chat
    document.addEventListener('keydown', e => {
      const ci = document.getElementById('chat-input');
      if (e.key === 'Enter' && !this.chatOpen) {
        this.chatOpen = true; ci.classList.add('open'); ci.focus(); e.preventDefault();
      } else if (e.key === 'Enter' && this.chatOpen) {
        const txt = ci.value.trim();
        if (txt && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'chat', text: txt }));
        ci.value = ''; ci.classList.remove('open'); ci.blur(); this.chatOpen = false; e.preventDefault();
      } else if (e.key === 'Escape' && this.chatOpen) {
        ci.value = ''; ci.classList.remove('open'); ci.blur(); this.chatOpen = false;
      }
    });

    // Camera
    const cv = this.renderer.domElement;
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('mousedown', e => {
      if (e.button === 2) this.rightMouseDown = true;
      if (e.button === 0) this._doShoot();
    });
    cv.addEventListener('mouseup',   e => { if (e.button === 2) this.rightMouseDown = false; });
    cv.addEventListener('mousemove', e => {
      if (!this.rightMouseDown) return;
      this.camTheta -= e.movementX * 0.005;
      this.camPhi = Math.max(0.08, Math.min(1.45, this.camPhi - e.movementY * 0.005));
    });
    cv.addEventListener('wheel', e => {
      this.camDist = Math.max(3, Math.min(35, this.camDist + e.deltaY * 0.02));
    });
  }

  // ── Combat ────────────────────────────────────────────────────
  _doPunch() {
    if (!this.alive) return;
    const now = performance.now();
    if (now - this.lastPunch < 800) return;
    this.lastPunch = now;
    this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ type: 'punch' }));
    // Arm swing visual
    if (this.mesh?.armR) {
      this.mesh.armR.rotation.x = -Math.PI * 0.65;
      setTimeout(() => { if (this.mesh?.armR) this.mesh.armR.rotation.x = 0; }, 220);
    }
  }

  _doShoot() {
    if (!this.alive || !this.hasGun || this.ammo <= 0 || this.chatOpen) return;
    const now = performance.now();
    if (now - this.lastShoot < 350) return;
    this.lastShoot = now;
    this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ type: 'shoot' }));
    this._muzzleFlash();
  }

  _doPickup() {
    if (!this.alive || this.hasGun) return;
    this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ type: 'pickup' }));
  }

  _muzzleFlash() {
    const flash = new THREE.PointLight(0xffaa00, 6, 10);
    flash.position.copy(this.mesh.position).setY(this.mesh.position.y + 1.2);
    this.scene.add(flash);
    setTimeout(() => this.scene.remove(flash), 80);
  }

  _flashDamage() {
    const o = document.getElementById('damage-overlay');
    o.classList.add('flash');
    setTimeout(() => o.classList.remove('flash'), 300);
  }

  // ── Death / Respawn ───────────────────────────────────────────
  _onDied() {
    this.alive = false;
    // Tip character over
    let t = 0;
    const tween = setInterval(() => {
      t += 0.06;
      if (this.mesh) this.mesh.rotation.z = Math.min(t, Math.PI / 2);
      if (t >= Math.PI / 2) clearInterval(tween);
    }, 16);
    setTimeout(() => {
      document.getElementById('death-screen').style.display = 'flex';
    }, 900);
  }

  _respawn() {
    document.getElementById('death-screen').style.display = 'none';
    if (this.mesh) this.mesh.rotation.z = 0;
    this.hasGun = false;
    this.ammo   = 0;
    this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ type: 'respawn' }));
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
        msg.zombies.forEach(z => this._spawnZombie(z));
        msg.loots.forEach(l => this._setLootAvailable(l.id, l.available));
        this._updatePlayerCount();
        this._updateHUD();
        break;

      case 'playerJoin':
        this._spawnOther(msg.player);
        this._addChat(null, `${msg.player.name} entered the world.`, 'system');
        this._updatePlayerCount();
        break;

      case 'playerLeave':
        this._removeOther(msg.id);
        if (msg.name) this._addChat(null, `${msg.name} left.`, 'system');
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

      case 'playerHp': {
        const o = this.others.get(msg.id);
        if (o) o.hp = msg.hp;
        break;
      }

      case 'playerDied': {
        const o = this.others.get(msg.id);
        if (o) o.mesh.rotation.z = Math.PI / 2;
        break;
      }

      case 'playerRespawn':
        if (msg.id !== this.myId) {
          const o = this.others.get(msg.id);
          if (o) {
            o.targetPos.set(msg.x, this._height(msg.x, msg.z) + FOOT_OFFSET, msg.z);
            o.mesh.rotation.z = 0;
          }
        }
        break;

      case 'selfHit':
        this.hp = msg.hp;
        this._updateHUD();
        this._flashDamage();
        break;

      case 'youDied':
        this.hp = 0;
        this._updateHUD();
        this._onDied();
        break;

      case 'respawned':
        this.alive = true;
        this.hp    = this.maxHp;
        this.mesh.position.set(msg.x, this._height(msg.x, msg.z) + FOOT_OFFSET, msg.z);
        this.mesh.rotation.z = 0;
        this._updateHUD();
        break;

      case 'ammoUpdate':
        this.ammo = msg.ammo;
        this._updateHUD();
        break;

      case 'pickedUpGun':
        this.hasGun = true;
        this.ammo   = msg.ammo;
        this._addChat(null, 'You picked up a pistol! Left-click to shoot.', 'system');
        this._updateHUD();
        break;

      case 'lootUpdate':
        this._setLootAvailable(msg.id, msg.available);
        break;

      case 'zombieUpdate':
        this._updateZombies(msg.zombies);
        break;

      case 'zombieHit':
        // No visual HP bar — just a brief flash on zombie
        this._flashZombie(msg.id);
        break;

      case 'zombieDied':
        this._removeZombie(msg.id);
        break;

      case 'zombieRespawn':
        this._spawnZombie(msg.zombie);
        break;

      case 'gunshot':
        if (msg.id !== this.myId) this._remoteGunshot(msg);
        break;

      case 'chat':
        this._addChat(msg.name, msg.text);
        break;
    }
  }

  // ── Other players ─────────────────────────────────────────────
  _spawnOther(data) {
    const mesh   = this._makeCharMesh(new THREE.Color(data.color || '#ff4444').getHex());
    const nameSpr = this._makeNameSprite(data.name || `Player${data.id}`, data.color || '#fff');
    mesh.add(nameSpr);
    mesh.position.set(data.x, (data.y || 0) + FOOT_OFFSET, data.z);
    if (!data.alive) mesh.rotation.z = Math.PI / 2;
    this.scene.add(mesh);
    this.others.set(data.id, {
      mesh, nameSpr, name: data.name, color: data.color,
      hp: data.hp || 100,
      targetPos: new THREE.Vector3(data.x, (data.y||0), data.z),
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
    document.getElementById('player-count').textContent = `👥 ${n} player${n!==1?'s':''}`;
  }

  // ── Zombies ───────────────────────────────────────────────────
  _spawnZombie(data) {
    if (this.zombies.has(data.id)) return;
    const mesh    = this._makeCharMesh(0xbb1111);
    const nameSpr = this._makeNameSprite('ZOMBIE', '#ff4444');
    mesh.add(nameSpr);
    const gy = this._height(data.x, data.z);
    mesh.position.set(data.x, gy + FOOT_OFFSET, data.z);
    this.scene.add(mesh);
    this.zombies.set(data.id, {
      mesh,
      hp: data.hp, maxHp: data.maxHp,
      targetPos: new THREE.Vector3(data.x, gy + FOOT_OFFSET, data.z),
    });
  }

  _removeZombie(id) {
    const z = this.zombies.get(id);
    if (z) { this.scene.remove(z.mesh); this.zombies.delete(id); }
  }

  _updateZombies(data) {
    data.forEach(zd => {
      const z = this.zombies.get(zd.id);
      if (!z) return;
      const gy = this._height(zd.x, zd.z);
      z.targetPos.set(zd.x, gy + FOOT_OFFSET, zd.z);
      z.hp = zd.hp;
    });
  }

  _flashZombie(id) {
    const z = this.zombies.get(id);
    if (!z) return;
    z.mesh.children.forEach(c => {
      if (c.material && c.material.color) {
        const orig = c.material.color.clone();
        c.material.color.set(0xffffff);
        setTimeout(() => { if (c.material) c.material.color.copy(orig); }, 120);
      }
    });
  }

  _remoteGunshot(msg) {
    const flash = new THREE.PointLight(0xffaa00, 5, 10);
    flash.position.set(msg.x, this._height(msg.x, msg.z) + 1.2, msg.z);
    this.scene.add(flash);
    setTimeout(() => this.scene.remove(flash), 80);
  }

  // ── HUD ───────────────────────────────────────────────────────
  _updateHUD() {
    const pct = Math.max(0, this.hp / this.maxHp);
    const bar = document.getElementById('hp-bar');
    bar.style.width = (pct * 100) + '%';
    bar.style.background = pct > 0.5 ? '#44ff44' : pct > 0.25 ? '#ffaa00' : '#ff2222';
    document.getElementById('hp-text').textContent = `${this.hp} / ${this.maxHp}`;
    const ammoEl = document.getElementById('ammo-display');
    ammoEl.textContent = this.hasGun ? `🔫 ${this.ammo} / ${GUN_MAX_AMMO}` : '[ no gun ]';
    ammoEl.style.color  = (this.hasGun && this.ammo === 0) ? '#ff4444' : '#fff';
  }

  // ── Chat ──────────────────────────────────────────────────────
  _addChat(name, text, cls = '') {
    const box = document.getElementById('chat-messages');
    const d   = document.createElement('div');
    d.className = 'msg ' + cls;
    d.textContent = name ? `${name}: ${text}` : text;
    box.appendChild(d);
    while (box.children.length > 12) box.removeChild(box.firstChild);
  }

  // ── Minimap ───────────────────────────────────────────────────
  _drawMinimap() {
    const cv  = document.getElementById('minimap-canvas');
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height, cx = W/2, cy = H/2;
    const scale = W / 160;
    const px = this.mesh.position.x, pz = this.mesh.position.z;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(15,35,15,0.9)';
    ctx.beginPath(); ctx.arc(cx, cy, cx, 0, Math.PI*2); ctx.fill();

    // Trees
    ctx.fillStyle = '#2a6a2a';
    this.trees.forEach(t => {
      const mx = cx+(t.x-px)*scale, my = cy+(t.z-pz)*scale;
      ctx.beginPath(); ctx.arc(mx, my, 2, 0, Math.PI*2); ctx.fill();
    });

    // Buildings
    ctx.fillStyle = '#b8a070';
    BUILDING_DEFS.forEach(b => {
      const mx = cx+(b.x-px)*scale, my = cy+(b.z-pz)*scale;
      ctx.fillRect(mx - b.w*scale/2, my - b.d*scale/2, b.w*scale, b.d*scale);
    });

    // Zombies
    ctx.fillStyle = '#cc2222';
    this.zombies.forEach(z => {
      const mx = cx+(z.mesh.position.x-px)*scale, my = cy+(z.mesh.position.z-pz)*scale;
      ctx.beginPath(); ctx.arc(mx, my, 3, 0, Math.PI*2); ctx.fill();
    });

    // Others
    this.others.forEach(o => {
      ctx.fillStyle = o.color || '#ff4444';
      const mx = cx+(o.mesh.position.x-px)*scale, my = cy+(o.mesh.position.z-pz)*scale;
      ctx.beginPath(); ctx.arc(mx, my, 4, 0, Math.PI*2); ctx.fill();
    });

    // Self
    ctx.fillStyle = '#4488ff';
    ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI*2); ctx.fill();
    const dx = Math.sin(this.mesh.rotation.y)*8, dz = Math.cos(this.mesh.rotation.y)*8;
    ctx.strokeStyle='#fff'; ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx+dx, cy+dz); ctx.stroke();

    // Clip circle
    ctx.globalCompositeOperation = 'destination-in';
    ctx.beginPath(); ctx.arc(cx, cy, cx, 0, Math.PI*2); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  // ── Walk animation ────────────────────────────────────────────
  _animateCharacter(mesh, moving, t) {
    const { armL, armR, legL, legR } = mesh;
    if (!armL) return;
    if (moving) {
      const s = Math.sin(t * 8) * 0.45;
      armL.rotation.x =  s; armR.rotation.x = -s;
      legL.rotation.x = -s; legR.rotation.x =  s;
    } else {
      [armL, armR, legL, legR].forEach(p => { p.rotation.x *= 0.85; });
    }
  }

  // ── Main Update ───────────────────────────────────────────────
  _update(dt) {
    const now = performance.now();
    const t   = now * 0.001;

    // ── Local player movement (skip if dead) ──
    if (this.alive && this.mesh) {
      const speed = 10 * dt;
      const fwd   = new THREE.Vector3(-Math.sin(this.camTheta), 0, -Math.cos(this.camTheta));
      const rgt   = new THREE.Vector3( Math.cos(this.camTheta), 0, -Math.sin(this.camTheta));
      const dir   = new THREE.Vector3();

      if (this.keys['KeyW']    || this.keys['ArrowUp'])    dir.addScaledVector(fwd,  1);
      if (this.keys['KeyS']    || this.keys['ArrowDown'])  dir.addScaledVector(fwd, -1);
      if (this.keys['KeyA']    || this.keys['ArrowLeft'])  dir.addScaledVector(rgt, -1);
      if (this.keys['KeyD']    || this.keys['ArrowRight']) dir.addScaledVector(rgt,  1);

      const isMoving = dir.lengthSq() > 0;
      if (isMoving) {
        dir.normalize();
        this.mesh.position.addScaledVector(dir, speed);
        this.mesh.rotation.y = Math.atan2(dir.x, dir.z);
      }

      // Jump
      if (this.keys['Space'] && this.onGround) {
        this.velocity.y = 9;
        this.onGround   = false;
      }

      // Gravity
      this.velocity.y -= 22 * dt;
      this.mesh.position.y += this.velocity.y * dt;

      // Ground snap — FOOT_OFFSET keeps feet on the surface
      const gy = this._height(this.mesh.position.x, this.mesh.position.z);
      if (this.mesh.position.y <= gy + FOOT_OFFSET) {
        this.mesh.position.y = gy + FOOT_OFFSET;
        this.velocity.y      = 0;
        this.onGround        = true;
      }

      // World bounds
      const B = this.WORLD_SIZE / 2 - 10;
      this.mesh.position.x = Math.max(-B, Math.min(B, this.mesh.position.x));
      this.mesh.position.z = Math.max(-B, Math.min(B, this.mesh.position.z));

      this._animateCharacter(this.mesh, isMoving, t);

      // ── Camera ──
      this.camTarget.lerp(this.mesh.position, 0.14);
      const sinT = Math.sin(this.camTheta), cosT = Math.cos(this.camTheta);
      const sinP = Math.sin(this.camPhi),   cosP = Math.cos(this.camPhi);
      this.camera.position.set(
        this.camTarget.x + this.camDist * sinT * cosP,
        this.camTarget.y + this.camDist * sinP,
        this.camTarget.z + this.camDist * cosT * cosP
      );
      this.camera.lookAt(this.camTarget.x, this.camTarget.y + 1.0, this.camTarget.z);

      // ── Send position ──
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

      // ── Coords HUD ──
      document.getElementById('coords').textContent =
        `X: ${this.mesh.position.x.toFixed(0)}  Z: ${this.mesh.position.z.toFixed(0)}`;

      // ── Pickup prompt ──
      let nearLoot = false;
      if (!this.hasGun) {
        this.loots.forEach(l => {
          if (!l.available) return;
          const dx = l.x - this.mesh.position.x, dz = l.z - this.mesh.position.z;
          if (Math.sqrt(dx*dx+dz*dz) < 4.5) nearLoot = true;
        });
      }
      document.getElementById('pickup-prompt').style.display = nearLoot ? 'block' : 'none';
    }

    // ── Interpolate other players ──
    this.others.forEach(o => {
      const prev = o.mesh.position.clone();
      o.mesh.position.lerp(o.targetPos, 0.22);
      // Ground-snap other players too
      const gy = this._height(o.mesh.position.x, o.mesh.position.z);
      if (o.mesh.position.y < gy + FOOT_OFFSET) o.mesh.position.y = gy + FOOT_OFFSET;
      this._animateCharacter(o.mesh, o.mesh.position.distanceTo(prev) > 0.01, t);
    });

    // ── Interpolate zombies ──
    this.zombies.forEach(z => {
      const prev = z.mesh.position.clone();
      z.mesh.position.lerp(z.targetPos, 0.2);
      // Ground-snap zombie
      const gy = this._height(z.mesh.position.x, z.mesh.position.z);
      if (z.mesh.position.y < gy + FOOT_OFFSET) z.mesh.position.y = gy + FOOT_OFFSET;
      const moved = z.mesh.position.distanceTo(prev);
      if (moved > 0.01) {
        const dx = z.mesh.position.x - prev.x, dz = z.mesh.position.z - prev.z;
        z.mesh.rotation.y = Math.atan2(dx, dz);
      }
      this._animateCharacter(z.mesh, moved > 0.01, t);
    });

    // ── Floating loot animation ──
    this.loots.forEach(l => {
      if (!l.available) return;
      l.mesh.position.y = this._height(l.x, l.z) + 1.2 + Math.sin(t * 2) * 0.25;
      l.mesh.rotation.y += dt * 1.5;
    });

    // ── Drift clouds ──
    this.clouds.forEach(c => {
      c.position.x += c.userData.speed * dt;
      if (c.position.x > 260) c.position.x = -260;
    });

    // ── Minimap ──
    if (this.mesh) this._drawMinimap();
  }

  // ── Render loop ───────────────────────────────────────────────
  _loop() {
    requestAnimationFrame(() => this._loop());
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this._update(dt);
    this.renderer.render(this.scene, this.camera);
  }
}

window.addEventListener('load', () => { window._game = new CertaGame(); });
