'use strict';

// ── Shared constants (must match server) ─────────────────────
const FOOT_OFFSET = 0.83;
const EYE_HEIGHT = 1.65; // camera height above feet

// ── Building definitions — identical to server ────────────────
const BUILDING_DEFS = [
  { x: 25, z: 25, w: 8, d: 6, gun: 'pistol' },
  { x: -45, z: 35, w: 8, d: 6, gun: 'pistol' },
  { x: 60, z: -40, w: 8, d: 6, gun: 'pistol' },
  { x: -60, z: -50, w: 8, d: 6, gun: 'pistol' },
  { x: 90, z: 70, w: 9, d: 7, gun: 'shotgun' },
  { x: -80, z: 90, w: 9, d: 7, gun: 'shotgun' },
  { x: 30, z: -90, w: 11, d: 8, gun: 'ar' },
  { x: -100, z: -30, w: 12, d: 8, gun: 'sniper' },
];

// ── Gun display info (client-side) ────────────────────────────
const GUN_INFO = {
  pistol: { label: 'PISTOL', maxAmmo: 12, color: '#ffdd55', fireRate: 450, auto: false },
  shotgun: { label: 'SHOTGUN', maxAmmo: 6, color: '#ff8844', fireRate: 900, auto: false },
  ar: { label: 'AR', maxAmmo: 30, color: '#44ff88', fireRate: 110, auto: true },
  sniper: { label: 'SNIPER', maxAmmo: 5, color: '#44ccff', fireRate: 1800, auto: false },
};

// ══════════════════════════════════════════════════════════════
// ── Gore Manager ─────────────────────────────────────────────
class GoreManager {
  constructor(scene) {
    this.scene = scene;
    this.particles = [];
    this.pools = [];
    this.ragdolls = [];
  }

  // Blood burst at world position
  spawnBlood(pos, count = 28, big = false) {
    for (let i = 0; i < count; i++) {
      const geo = new THREE.SphereGeometry(big ? 0.08 + Math.random() * 0.12 : 0.04 + Math.random() * 0.08, 4, 4);
      const hue = Math.random() < 0.3 ? 0.02 : 0.0;
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(hue, 1, 0.2 + Math.random() * 0.15) });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(pos).add(new THREE.Vector3((Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6));

      const speed = 3 + Math.random() * (big ? 10 : 6);
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI;
      const vx = Math.sin(phi) * Math.cos(theta) * speed;
      const vy = Math.abs(Math.cos(phi)) * speed + 2;
      const vz = Math.sin(phi) * Math.sin(theta) * speed;

      this.scene.add(mesh);
      this.particles.push({ mesh, vx, vy, vz, life: 1.2 + Math.random() * 0.8, age: 0 });
    }
    // Blood pool decal
    if (big) this._spawnPool(pos);
  }

  _spawnPool(pos) {
    const size = 0.8 + Math.random() * 1.4;
    const mat = new THREE.MeshBasicMaterial({ color: 0x550000, transparent: true, opacity: 0.75, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(size, 10), mat);
    mesh.rotation.x = -Math.PI / 2;
    // Sample ground height at blood position so pool lies flat on terrain, never floats
    const groundY = this.scene.userData.getHeight ? this.scene.userData.getHeight(pos.x, pos.z) : pos.y;
    mesh.position.set(pos.x, groundY + 0.02, pos.z);
    this.scene.add(mesh);
    this.pools.push({ mesh, age: 0, maxAge: 30 });
  }

  // Ragdoll limbs flying off a position
  spawnRagdoll(pos, dir) {
    const parts = [
      { geo: new THREE.BoxGeometry(0.4, 0.8, 0.35), name: 'torso' },
      { geo: new THREE.BoxGeometry(0.35, 0.35, 0.35), name: 'head' },
      { geo: new THREE.BoxGeometry(0.22, 0.7, 0.22), name: 'armL' },
      { geo: new THREE.BoxGeometry(0.22, 0.7, 0.22), name: 'armR' },
      { geo: new THREE.BoxGeometry(0.26, 0.7, 0.26), name: 'legL' },
      { geo: new THREE.BoxGeometry(0.26, 0.7, 0.26), name: 'legR' },
    ];
    parts.forEach(p => {
      const r = Math.random();
      const mat = new THREE.MeshLambertMaterial({
        color: p.name === 'head' ? 0xd4a56a : (r < 0.5 ? 0x111111 : 0xaa2222),
      });
      const mesh = new THREE.Mesh(p.geo, mat);
      mesh.position.copy(pos).add(new THREE.Vector3((Math.random() - 0.5) * 0.5, Math.random() * 0.5, (Math.random() - 0.5) * 0.5));

      const speed = 4 + Math.random() * 8;
      const theta = Math.random() * Math.PI * 2;
      const vx = Math.cos(theta) * speed + (dir ? dir.x * 2 : 0);
      const vy = 3 + Math.random() * 7;
      const vz = Math.sin(theta) * speed + (dir ? dir.z * 2 : 0);
      const rx = (Math.random() - 0.5) * 8;
      const ry = (Math.random() - 0.5) * 8;
      const rz = (Math.random() - 0.5) * 8;

      this.scene.add(mesh);
      this.ragdolls.push({ mesh, vx, vy, vz, rx, ry, rz, life: 4.5, age: 0, landed: false });
    });
  }

  update(dt, heightFn) {
    // Blood particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += dt;
      if (p.age >= p.life) { this.scene.remove(p.mesh); this.particles.splice(i, 1); continue; }
      p.vy -= 18 * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      const gy = heightFn(p.mesh.position.x, p.mesh.position.z);
      if (p.mesh.position.y < gy + 0.05) {
        p.mesh.position.y = gy + 0.05;
        p.vy = 0; p.vx *= 0.3; p.vz *= 0.3;
      }
      p.mesh.material.opacity = Math.max(0, 1 - p.age / p.life);
      p.mesh.material.transparent = true;
    }

    // Ragdoll
    for (let i = this.ragdolls.length - 1; i >= 0; i--) {
      const r = this.ragdolls[i];
      r.age += dt;
      if (r.age >= r.life) { this.scene.remove(r.mesh); this.ragdolls.splice(i, 1); continue; }
      if (!r.landed) {
        r.vy -= 20 * dt;
        r.mesh.position.x += r.vx * dt;
        r.mesh.position.y += r.vy * dt;
        r.mesh.position.z += r.vz * dt;
        r.mesh.rotation.x += r.rx * dt;
        r.mesh.rotation.y += r.ry * dt;
        r.mesh.rotation.z += r.rz * dt;
        const gy = heightFn(r.mesh.position.x, r.mesh.position.z);
        if (r.mesh.position.y < gy + 0.1) {
          r.mesh.position.y = gy + 0.1;
          r.landed = true; r.vx = r.vz = 0; r.vy = 0;
        }
      }
      const fade = Math.max(0, 1 - (r.age - 2.5) / 2);
      if (r.age > 2.5) { r.mesh.material.transparent = true; r.mesh.material.opacity = fade; }
    }

    // Blood pools fade
    for (let i = this.pools.length - 1; i >= 0; i--) {
      const p = this.pools[i];
      p.age += dt;
      if (p.age >= p.maxAge) { this.scene.remove(p.mesh); this.pools.splice(i, 1); continue; }
      const fade = Math.max(0, 1 - (p.age - p.maxAge * 0.6) / (p.maxAge * 0.4));
      p.mesh.material.opacity = 0.75 * fade;
    }
  }
}

// ── Bullet trace (spark) ──────────────────────────────────────
class BulletTrace {
  constructor(scene) {
    this.scene = scene;
    this.traces = [];
  }

  spawn(from, to) {
    const dir = to.clone().sub(from);
    const len = dir.length();
    if (len < 0.1) return;

    const mat = new THREE.LineBasicMaterial({ color: 0xffee88, transparent: true, opacity: 0.88 });
    const pts = [from.clone(), to.clone()];
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);

    // Spark at impact
    const sparkMat = new THREE.MeshBasicMaterial({ color: 0xffcc44, transparent: true, opacity: 1 });
    const spark = new THREE.Mesh(new THREE.SphereGeometry(0.08, 4, 4), sparkMat);
    spark.position.copy(to);
    this.scene.add(spark);

    this.traces.push({ line, spark, mat, sparkMat, age: 0, life: 0.12 });
  }

  update(dt) {
    for (let i = this.traces.length - 1; i >= 0; i--) {
      const t = this.traces[i];
      t.age += dt;
      const a = Math.max(0, 1 - t.age / t.life);
      t.mat.opacity = a * 0.88;
      t.sparkMat.opacity = a;
      if (t.age >= t.life) {
        this.scene.remove(t.line);
        this.scene.remove(t.spark);
        this.traces.splice(i, 1);
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════
class CertaGame {
  constructor() {
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.clock = new THREE.Clock();

    // Viewmodel (arms + gun rendered on second pass)
    this.vmScene = null;
    this.vmCamera = null;

    // Local player state
    this.myId = null;
    this.myName = 'Adventurer';
    this.myColor = '#00ccff';
    this.footPos = new THREE.Vector3(); // feet position
    this.velocity = new THREE.Vector3();
    this.onGround = false;
    this.alive = true;
    this.hp = 100;
    this.maxHp = 100;
    this.hasGun = false;
    this.gunType = null;
    this.ammo = 0;
    this.lastPunch = 0;
    this.lastShoot = 0;
    this.isReloading = false;
    this.reloadTimer = 0;

    // FPS camera — yaw/pitch
    this.yaw = 0;
    this.pitch = 0;
    this.isLocked = false; // pointer lock active
    this.isADS = false;

    // Auto fire tracking
    this.mouseDown = false;
    this.autoFireInterval = null;

    // Input
    this.keys = {};
    this.chatOpen = false;

    // Network throttle
    this.lastSendMs = 0;
    this.SEND_RATE = 50;

    // World
    this.WORLD_SIZE = 500;
    this.trees = [];
    this.clouds = [];

    // Multiplayer
    this.others = new Map();
    this.zombies = new Map();
    this.loots = [];

    // Economy + upgrades
    this.balance = 100;
    this.zombieKills = 0;
    this.shieldHp = 0;
    this.upgrades = {};      // { dmg_boost: 0, extra_hp: 0, fast_regen: false, shield: 0 }
    this.upgradeDefs = {};   // filled from server welcome message
    this.shopOpen = false;

    // Gore + traces
    this.gore = null;
    this.traces = null;

    // Viewmodel meshes
    this.vmRoot = null;
    this.vmGunMesh = null;
    this.vmArmL = null;
    this.vmArmR = null;
    this.vmFistL = null;   // shown when no gun
    this.vmFistR = null;
    // Animation state
    this.vmRecoil = 0;
    this.vmPunchAnim = 0;
    this.vmReloadAnim = 0;
    this.vmIdleBob = 0;
    this.vmPullout = 1;        // 1 = ready position; animated 0→1 on equip
    this.vmPullingOut = false; // true while pull-out anim plays

    // Building floor heights — set during _buildBuildings, used in ground snap
    this.buildingFloors = [];

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
    this._setupViewmodel();
    this._setupLights();
    this._buildWorld();
    this._setupInput();
    this._connectWS();
    this._loop();

    // Show lock overlay immediately
    document.getElementById('lock-overlay').style.display = 'flex';
  }

  // ── Renderer ─────────────────────────────────────────────────
  _setupRenderer() {
    const canvas = document.getElementById('game-canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.autoClear = false; // we'll clear manually for two-pass render
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.vmCamera.aspect = window.innerWidth / window.innerHeight;
      this.vmCamera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  _setupScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x89c4e1);
    this.scene.fog = new THREE.Fog(0x89c4e1, 120, 380);
    // FPS camera — positioned at eye level, no parent mesh
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.08, 800);
    // Initialize at spawn origin (will be set properly once WS welcome comes)
    this.footPos.set(0, this._height(0, 0), 0);
    this.camera.position.set(0, this.footPos.y + EYE_HEIGHT, 0);
  }

  // ── Viewmodel (arms + gun) — second render pass ─────────────
  _setupViewmodel() {
    this.vmScene = new THREE.Scene();
    this.vmCamera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.01, 20);
    this.vmCamera.position.set(0, 0, 0);

    this.vmScene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const vmSun = new THREE.DirectionalLight(0xfff4cc, 0.7);
    vmSun.position.set(0.5, 1.5, 0.8);
    this.vmScene.add(vmSun);

    this.vmRoot = new THREE.Group();
    this.vmRoot.position.set(0.18, -0.26, -0.55);
    this.vmScene.add(this.vmRoot);

    this._buildViewmodelArms();
    // Start with fists visible, no gun
    this._showFists();
  }

  // ── Arms: sleeves (bottom, off-screen) → forearm → hand/fist at top (visible) ──
  _buildViewmodelArms() {
    if (this.vmArmL) this.vmRoot.remove(this.vmArmL);
    if (this.vmArmR) this.vmRoot.remove(this.vmArmR);
    if (this.vmFistL) this.vmRoot.remove(this.vmFistL);
    if (this.vmFistR) this.vmRoot.remove(this.vmFistR);

    const sleeveMat  = new THREE.MeshLambertMaterial({ color: 0x111111 });
    const stripeMat  = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const skinMat    = new THREE.MeshLambertMaterial({ color: 0xc68642 });
    const knuckleMat = new THREE.MeshLambertMaterial({ color: 0xb07840 });

    // makeArm: group origin = wrist level (visible).
    // Hand at +Y (slightly visible), forearm toward 0, sleeve at -Y (disappears off-screen).
    const makeArm = (isLeft) => {
      const g = new THREE.Group();

      // Hand / fist — topmost, clearly visible
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.09, 0.09), skinMat);
      hand.position.y = 0.06;
      g.add(hand);
      // Knuckle row
      const knuckles = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.03, 0.06), knuckleMat);
      knuckles.position.set(0, 0.10, 0.03);
      g.add(knuckles);

      // Forearm (skin) — middle section
      const forearm = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.22, 0.09), skinMat);
      forearm.position.y = -0.11;
      g.add(forearm);

      // Sleeve — black, extends below, mostly off-screen
      const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.115, 0.28, 0.105), sleeveMat);
      sleeve.position.y = -0.33;
      g.add(sleeve);

      // 3 Adidas stripes on sleeve
      [-0.038, 0, 0.038].forEach(ox => {
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.26, 0.003), stripeMat);
        stripe.position.set(ox, -0.33, isLeft ? -0.054 : 0.054);
        g.add(stripe);
      });

      return g;
    };

    // Gun-holding arms (used when armed)
    this.vmArmR = makeArm(false);
    this.vmArmR.position.set(0.17, -0.06, 0.0);
    this.vmArmR.rotation.x = 0.10;
    this.vmRoot.add(this.vmArmR);

    this.vmArmL = makeArm(true);
    this.vmArmL.position.set(-0.15, -0.08, -0.15);
    this.vmArmL.rotation.x = 0.12;
    this.vmRoot.add(this.vmArmL);

    // Fist arms — wider stance for unarmed
    this.vmFistR = makeArm(false);
    this.vmFistR.position.set(0.20, -0.06, 0.0);
    this.vmFistR.rotation.x = 0.08;
    this.vmRoot.add(this.vmFistR);

    this.vmFistL = makeArm(true);
    this.vmFistL.position.set(-0.20, -0.08, -0.08);
    this.vmFistL.rotation.x = 0.08;
    this.vmRoot.add(this.vmFistL);

    // Start hidden; _showFists() / _showGun() control visibility
    [this.vmArmL, this.vmArmR, this.vmFistL, this.vmFistR].forEach(a => { if (a) a.visible = false; });
  }

  // Show unarmed fist viewmodel
  _showFists() {
    if (this.vmArmL)  this.vmArmL.visible  = false;
    if (this.vmArmR)  this.vmArmR.visible  = false;
    if (this.vmFistL) this.vmFistL.visible = true;
    if (this.vmFistR) this.vmFistR.visible = true;
    if (this.vmGunMesh) this.vmGunMesh.visible = false;
  }

  // Show armed viewmodel with pull-out animation
  _showGun() {
    if (this.vmArmL)  this.vmArmL.visible  = true;
    if (this.vmArmR)  this.vmArmR.visible  = true;
    if (this.vmFistL) this.vmFistL.visible = false;
    if (this.vmFistR) this.vmFistR.visible = false;
    if (this.vmGunMesh) this.vmGunMesh.visible = true;
    // Trigger pull-out animation
    this.vmPullout = 0;
    this.vmPullingOut = true;
  }

  _buildViewmodelGun(type) {
    if (this.vmGunMesh) this.vmRoot.remove(this.vmGunMesh);
    this.vmGunMesh = this._makeGunModel(type, true);
    this.vmGunMesh.rotation.y = Math.PI / 2;
    this.vmGunMesh.position.set(-0.02, 0.06, 0.0);
    this.vmGunMesh.visible = false; // hidden until _showGun() called
    this.vmRoot.add(this.vmGunMesh);
  }

  // ── Gun 3D model builder ─────────────────────────────────────
  _makeGunModel(type, forVM = false) {
    const g = new THREE.Group();
    const dark = new THREE.MeshLambertMaterial({ color: 0x111111 });
    const grey = new THREE.MeshLambertMaterial({ color: 0x666666 });
    const tan = new THREE.MeshLambertMaterial({ color: 0x8B7355 });
    const blk = new THREE.MeshLambertMaterial({ color: 0x222222 });

    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      m.castShadow = !forVM;
      g.add(m);
      return m;
    };

    if (type === 'pistol') {
      add(new THREE.BoxGeometry(0.5, 0.22, 0.16), dark, 0.08, 0.06, 0);   // body
      add(new THREE.BoxGeometry(0.32, 0.12, 0.12), blk, 0.28, 0.06, 0);    // slide
      add(new THREE.BoxGeometry(0.16, 0.3, 0.14), tan, -0.1, -0.14, 0);  // grip
      add(new THREE.CylinderGeometry(0.04, 0.04, 0.18, 8), grey, 0.42, 0.06, 0, Math.PI / 2, 0, 0); // barrel tip
    } else if (type === 'shotgun') {
      add(new THREE.BoxGeometry(0.82, 0.22, 0.18), dark, 0.08, 0.06, 0);  // receiver
      add(new THREE.CylinderGeometry(0.06, 0.06, 0.72, 8), grey, 0.48, 0.06, 0, Math.PI / 2, 0, 0); // barrel
      add(new THREE.BoxGeometry(0.48, 0.16, 0.16), tan, -0.18, -0.04, 0); // pump
      add(new THREE.BoxGeometry(0.28, 0.38, 0.16), tan, -0.28, -0.2, 0);  // stock
    } else if (type === 'ar') {
      add(new THREE.BoxGeometry(0.90, 0.24, 0.18), dark, 0.04, 0.06, 0);  // body
      add(new THREE.BoxGeometry(0.26, 0.14, 0.12), grey, -0.38, 0.06, 0);  // carry handle
      add(new THREE.CylinderGeometry(0.045, 0.045, 0.42, 8), grey, 0.52, 0.09, 0, Math.PI / 2, 0, 0); // barrel
      add(new THREE.BoxGeometry(0.18, 0.36, 0.12), dark, -0.05, -0.18, 0); // mag
      add(new THREE.BoxGeometry(0.12, 0.08, 0.18), blk, -0.06, 0.18, 0);   // top rail
      add(new THREE.BoxGeometry(0.28, 0.34, 0.14), tan, -0.25, -0.11, 0); // stock
    } else if (type === 'sniper') {
      add(new THREE.BoxGeometry(1.10, 0.22, 0.18), dark, 0.04, 0.06, 0);  // long body
      add(new THREE.CylinderGeometry(0.04, 0.04, 0.60, 8), grey, 0.66, 0.07, 0, Math.PI / 2, 0, 0); // barrel
      add(new THREE.BoxGeometry(0.36, 0.42, 0.14), tan, -0.36, -0.12, 0);  // stock
      // Scope
      add(new THREE.CylinderGeometry(0.05, 0.05, 0.44, 8), blk, 0.1, 0.19, 0, Math.PI / 2, 0, 0);
      add(new THREE.CylinderGeometry(0.07, 0.05, 0.06, 8), blk, 0.33, 0.19, 0, Math.PI / 2, 0, 0); // scope front
      add(new THREE.BoxGeometry(0.12, 0.06, 0.12), blk, -0.08, -0.2, 0);   // mag
    }

    return g;
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
    s.camera.top = 150; s.camera.bottom = -150;
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
    this.gore = new GoreManager(this.scene);
    // Give GoreManager access to terrain height for ground-snapped blood pools
    this.scene.userData.getHeight = (x, z) => this._height(x, z);
    this.traces = new BulletTrace(this.scene);
  }

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
    const geo = new THREE.PlaneGeometry(this.WORLD_SIZE, this.WORLD_SIZE, SEGS, SEGS);
    const pos = geo.attributes.position;
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
      const x = Math.random() * S, y = Math.random() * S, r = Math.random() * 3 + 0.5;
      const g = Math.floor(Math.random() * 35 + 50), b = Math.floor(Math.random() * 20 + 32);
      c.fillStyle = `rgb(${b},${g},${Math.floor(b * 0.55)})`;
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
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
      const wx = (Math.random() - 0.5) * (this.WORLD_SIZE - 40);
      const wz = (Math.random() - 0.5) * (this.WORLD_SIZE - 40);
      if (Math.abs(wx) < 18 && Math.abs(wz) < 18) continue;
      const h = Math.random() * 5 + 5, g = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.48, h, 7), trunkMat);
      trunk.position.y = h / 2; trunk.castShadow = true; g.add(trunk);
      for (let j = 0; j < 3; j++) {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(2.8 - j * 0.45, h * 0.55, 7), leafMats[j % 3]);
        cone.position.y = h * 0.75 + j * h * 0.22; cone.castShadow = true; g.add(cone);
      }
      g.position.set(wx, this._height(wx, wz), wz);
      this.scene.add(g);
      this.trees.push({ x: wx, z: wz });
    }
  }

  _buildRocks(count) {
    const mat = new THREE.MeshLambertMaterial({ color: 0x888880 });
    for (let i = 0; i < count; i++) {
      const wx = (Math.random() - 0.5) * 460, wz = (Math.random() - 0.5) * 460;
      const s = Math.random() * 1.5 + 0.4;
      const geo = new THREE.DodecahedronGeometry(s, 0);
      geo.scale(1, 0.5 + Math.random() * 0.4, 0.8 + Math.random() * 0.4);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(wx, this._height(wx, wz) + s * 0.3, wz);
      mesh.rotation.y = Math.random() * Math.PI;
      mesh.castShadow = mesh.receiveShadow = true;
      this.scene.add(mesh);
    }
  }

  _buildClouds(count) {
    this.clouds = [];
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.88 });
    for (let i = 0; i < count; i++) {
      const g = new THREE.Group();
      for (let j = 0; j < Math.floor(Math.random() * 4 + 3); j++) {
        const s = new THREE.Mesh(new THREE.SphereGeometry(Math.random() * 5 + 3, 7, 5), mat);
        s.position.set((Math.random() - 0.5) * 16, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 9);
        g.add(s);
      }
      g.position.set((Math.random() - 0.5) * 500, 110 + Math.random() * 50, (Math.random() - 0.5) * 500);
      g.userData.speed = 0.4 + Math.random() * 0.6;
      this.scene.add(g); this.clouds.push(g);
    }
  }

  // ── Buildings — ground-anchored foundation ───────────────────
  _buildBuildings() {
    const wallMat = new THREE.MeshLambertMaterial({ color: 0xc8b88a });
    const roofMat = new THREE.MeshLambertMaterial({ color: 0x7a4f2d });
    const floorMat = new THREE.MeshLambertMaterial({ color: 0xa0916e });
    const foundMat = new THREE.MeshLambertMaterial({ color: 0x9a8060 }); // foundation

    BUILDING_DEFS.forEach(b => {
      // Sample terrain at all 4 corners + center to find lowest point
      const corners = [
        [b.x - b.w / 2, b.z - b.d / 2],
        [b.x + b.w / 2, b.z - b.d / 2],
        [b.x - b.w / 2, b.z + b.d / 2],
        [b.x + b.w / 2, b.z + b.d / 2],
        [b.x, b.z],
      ];
      let minY = Infinity, maxY = -Infinity;
      corners.forEach(([cx, cz]) => {
        const h = this._height(cx, cz);
        if (h < minY) minY = h;
        if (h > maxY) maxY = h;
      });
      // Place building floor at maxY so it's always above ground
      const gy = maxY;
      // Store floor height for ground-snap override (player walks on floor inside buildings)
      this.buildingFloors.push({ x: b.x, z: b.z, hw: b.w / 2, hd: b.d / 2, floorY: gy + 0.22 });
      const g = new THREE.Group();
      const H = 4.5; // wall height
      const T = 0.42;
      const DW = 2.0; // door width
      const foundDepth = Math.max(0.5, maxY - minY + 0.6); // extend down to ground

      const add = (geo, mat, x, y, z) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, z);
        m.castShadow = m.receiveShadow = true;
        g.add(m);
      };

      // Foundation slab that extends down to lowest terrain point
      add(new THREE.BoxGeometry(b.w + 0.1, foundDepth, b.d + 0.1), foundMat, 0, -foundDepth / 2 + 0.05, 0);
      // Floor
      add(new THREE.BoxGeometry(b.w, 0.2, b.d), floorMat, 0, 0.1, 0);
      // Back wall
      add(new THREE.BoxGeometry(b.w, H, T), wallMat, 0, H / 2, -b.d / 2);
      // Side walls
      add(new THREE.BoxGeometry(T, H, b.d), wallMat, -b.w / 2, H / 2, 0);
      add(new THREE.BoxGeometry(T, H, b.d), wallMat, b.w / 2, H / 2, 0);
      // Front wall — two pieces with door gap
      const sw = (b.w - DW) / 2;
      add(new THREE.BoxGeometry(sw, H, T), wallMat, -(DW / 2 + sw / 2), H / 2, b.d / 2);
      add(new THREE.BoxGeometry(sw, H, T), wallMat, (DW / 2 + sw / 2), H / 2, b.d / 2);
      // Door header (just above 3 units, covering the gap)
      add(new THREE.BoxGeometry(DW, H - 3.0, T), wallMat, 0, 3.0 + (H - 3.0) / 2, b.d / 2);
      // Roof
      add(new THREE.BoxGeometry(b.w + 0.6, 0.4, b.d + 0.6), roofMat, 0, H + 0.2, 0);

      g.position.set(b.x, gy, b.z);
      this.scene.add(g);
    });
  }

  // ── Loot (guns) ───────────────────────────────────────────────
  _spawnLoots() {
    BUILDING_DEFS.forEach((b, i) => {
      const lx = b.x + 1, lz = b.z + 1;
      const mesh = this._makeLootMesh(b.gun);
      const gy = this._height(lx, lz);
      mesh.position.set(lx, gy + 1.1, lz);
      this.scene.add(mesh);
      this.loots.push({ id: i, mesh, available: true, x: lx, z: lz, gunType: b.gun });
    });
  }

  _makeLootMesh(type = 'pistol') {
    const g = new THREE.Group();
    const gun = this._makeGunModel(type, false);
    gun.scale.setScalar(1.1);
    gun.rotation.y = Math.PI / 2;
    g.add(gun);
    // Glow ring
    const colors = { pistol: 0xffdd00, shotgun: 0xff6600, ar: 0x44ff88, sniper: 0x44ccff };
    const glow = new THREE.Mesh(
      new THREE.TorusGeometry(0.52, 0.04, 6, 14),
      new THREE.MeshBasicMaterial({ color: colors[type] || 0xffdd00 })
    );
    glow.rotation.x = Math.PI / 2;
    g.add(glow);
    g.userData.glow = glow;
    return g;
  }

  _setLootAvailable(id, available, gunType) {
    const l = this.loots.find(l => l.id === id);
    if (!l) return;
    l.available = available;
    l.mesh.visible = available;
    if (gunType && gunType !== l.gunType) {
      // Gun type changed (swap) — rebuild mesh
      l.gunType = gunType;
      this.scene.remove(l.mesh);
      l.mesh = this._makeLootMesh(gunType);
      l.mesh.position.set(l.x, this._height(l.x, l.z) + 1.1, l.z);
      l.mesh.visible = available;
      this.scene.add(l.mesh);
    }
  }

  // ── FPS Input ─────────────────────────────────────────────────
  _setupInput() {
    const canvas = this.renderer.domElement;

    // Pointer lock — listen on both canvas AND the overlay (overlay is z-index:50 and blocks canvas clicks)
    const requestLock = () => { if (!this.chatOpen) canvas.requestPointerLock(); };
    canvas.addEventListener('click', requestLock);
    document.getElementById('lock-overlay').addEventListener('click', requestLock);
    document.addEventListener('pointerlockchange', () => {
      this.isLocked = document.pointerLockElement === canvas;
      // Only show re-lock prompt when actually in-game and not in shop/chat
      document.getElementById('lock-overlay').style.display =
        (this.isLocked || this.shopOpen || !this.alive) ? 'none' : 'flex';
    });

    // Mouse look
    document.addEventListener('mousemove', e => {
      if (!this.isLocked || this.chatOpen) return;
      const sens = this.isADS ? 0.0018 : 0.0028;
      this.yaw -= e.movementX * sens;
      this.pitch = Math.max(-1.3, Math.min(1.3, this.pitch - e.movementY * sens));
    });

    // Shoot / ADS
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('mousedown', e => {
      if (!this.isLocked) return;
      if (e.button === 0) { // LMB
        this.mouseDown = true;
        if (this.hasGun) {
          // Armed: shoot
          this._doShoot();
          if (GUN_INFO[this.gunType]?.auto) {
            clearInterval(this.autoFireInterval);
            this.autoFireInterval = setInterval(() => {
              if (!this.mouseDown || !this.alive) return;
              this._doShoot();
            }, GUN_INFO[this.gunType].fireRate);
          }
        } else {
          // Unarmed: punch with left click
          this._doPunch();
        }
      }
      if (e.button === 2) { // RMB — ADS
        this.isADS = true;
        document.getElementById('crosshair').classList.add('ads');
      }
    });
    canvas.addEventListener('mouseup', e => {
      if (e.button === 0) {
        this.mouseDown = false;
        clearInterval(this.autoFireInterval);
        this.autoFireInterval = null;
      }
      if (e.button === 2) {
        this.isADS = false;
        document.getElementById('crosshair').classList.remove('ads');
      }
    });

    // Keyboard
    document.addEventListener('keydown', e => {
      if (this.chatOpen) {
        if (e.key === 'Enter') this._sendChat();
        if (e.key === 'Escape') this._closeChat();
        return;
      }
      this.keys[e.code] = true;

      if (e.code === 'KeyF') this._doPunch();
      if (e.code === 'KeyE') this._doPickup();
      if (e.code === 'KeyR') this._doReload();
      if (e.code === 'KeyG') this._doDropWeapon();
      if (e.code === 'KeyT') { e.preventDefault(); this._openChat(); }
      if (e.code === 'KeyB') {
        if (this.shopOpen) this._closeShop();
        else this._openShop();
      }
    });
    document.addEventListener('keyup', e => {
      this.keys[e.code] = false;
    });
  }

  _openChat() {
    this.chatOpen = true;
    const ci = document.getElementById('chat-input');
    ci.classList.add('open'); ci.focus();
    // Release pointer lock so user can type
    document.exitPointerLock();
  }

  _closeChat() {
    const ci = document.getElementById('chat-input');
    ci.value = ''; ci.classList.remove('open'); ci.blur();
    this.chatOpen = false;
  }

  _sendChat() {
    const ci = document.getElementById('chat-input');
    const txt = ci.value.trim();
    if (txt && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'chat', text: txt }));
    }
    this._closeChat();
  }

  // ── Combat ────────────────────────────────────────────────────
  _doPunch() {
    if (!this.alive || this.chatOpen) return;
    const now = performance.now();
    if (now - this.lastPunch < 700) return;
    this.lastPunch = now;
    this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ type: 'punch' }));
    // Viewmodel punch swing
    this.vmPunchAnim = 1.0;
  }

  _doShoot() {
    if (!this.alive || !this.hasGun || this.ammo <= 0 || this.chatOpen || this.isReloading) return;
    const now = performance.now();
    const gun = GUN_INFO[this.gunType];
    if (!gun) return;
    if (now - this.lastShoot < gun.fireRate) return;
    this.lastShoot = now;

    this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({
      type: 'shoot',
    }));
    this._muzzleFlash();
    // Viewmodel recoil kick
    this.vmRecoil = 1.0;
    // Screen recoil — pitch INCREASES = camera tilts UP (mouse-up = pitch increases in this game)
    const recoilStrength = { pistol: 0.022, ar: 0.011, shotgun: 0.065, sniper: 0.085 };
    this.pitch = Math.max(-1.3, Math.min(1.3, this.pitch + (recoilStrength[this.gunType] ?? 0.022)));
    // Reduce local ammo immediately for responsiveness
    this.ammo = Math.max(0, this.ammo - 1);
    this._updateHUD();

    // Bullet trace — cast from eye in view direction
    this._castBulletTrace();
  }

  _castBulletTrace() {
    // Direction from yaw/pitch
    const dir = new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      -Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch)
    );
    const from = this.camera.position.clone();
    // Trace against zombies and players for visual endpoint
    let nearest = null, nearestDist = (GUN_INFO[this.gunType]?.maxAmmo === 5) ? 250 : 90;

    this.zombies.forEach(z => {
      const ep = z.mesh.position.clone().add(new THREE.Vector3(0, 0.8, 0));
      const toZ = ep.clone().sub(from);
      const dot = toZ.dot(dir) / toZ.length();
      if (dot < 0.9) return;
      const dist = from.distanceTo(ep);
      if (dist < nearestDist) { nearestDist = dist; nearest = ep; }
    });
    this.others.forEach(o => {
      const ep = o.mesh.position.clone().add(new THREE.Vector3(0, 1.0, 0));
      const toP = ep.clone().sub(from);
      const dot = toP.dot(dir) / toP.length();
      if (dot < 0.9) return;
      const dist = from.distanceTo(ep);
      if (dist < nearestDist) { nearestDist = dist; nearest = ep; }
    });

    const to = nearest || from.clone().addScaledVector(dir, 120);
    this.traces.spawn(from, to);

    // Small blood burst at hit point if we hit something
    if (nearest) {
      this.gore.spawnBlood(to, 18, true);
      this._showHitMarker();
    }
  }

  _showHitMarker() {
    const hm = document.getElementById('hit-marker');
    hm.classList.add('show');
    clearTimeout(this._hitMarkerTimeout);
    this._hitMarkerTimeout = setTimeout(() => hm.classList.remove('show'), 160);
  }

  _doPickup() {
    if (!this.alive || this.chatOpen) return;
    this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ type: 'pickup' }));
  }

  _doDropWeapon() {
    if (!this.alive || !this.hasGun || this.chatOpen) return;
    this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ type: 'drop' }));
  }

  _doReload() {
    if (!this.alive || !this.hasGun || this.isReloading || this.chatOpen) return;
    const gun = GUN_INFO[this.gunType];
    if (!gun || this.ammo >= gun.maxAmmo) return;

    this.isReloading = true;
    // Animation: vmReloadAnim goes 0→1 over the reload duration, driving a sin-curve gun drop
    this.vmReloadAnim = 0;

    const reloadTime = this.gunType === 'sniper' ? 2800 :
      this.gunType === 'shotgun' ? 2200 :
        this.gunType === 'ar' ? 2000 : 1500;
    this.reloadDuration = reloadTime / 1000; // store in seconds for _updateViewmodel

    document.getElementById('reload-ring').classList.add('visible');

    setTimeout(() => {
      if (!this.alive) return;
      this.isReloading = false;
      this.vmReloadAnim = 0;
      document.getElementById('reload-ring').classList.remove('visible');
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'reload' }));
      }
    }, reloadTime);
  }

  _muzzleFlash() {
    const flash = new THREE.PointLight(0xffaa00, 8, 12);
    flash.position.copy(this.camera.position)
      .addScaledVector(new THREE.Vector3(
        Math.sin(this.yaw), -Math.sin(this.pitch), Math.cos(this.yaw)
      ), 0.8);
    this.scene.add(flash);
    setTimeout(() => this.scene.remove(flash), 60);
  }

  _flashDamage() {
    const o = document.getElementById('damage-overlay');
    o.classList.add('flash');
    setTimeout(() => o.classList.remove('flash'), 280);
  }

  // ── Death / Respawn ───────────────────────────────────────────
  _onDied(penalty = 0) {
    this.alive = false;
    clearInterval(this.autoFireInterval);
    this.autoFireInterval = null;
    if (this.shopOpen) this._closeShop();
    setTimeout(() => {
      const penaltyEl = document.getElementById('death-penalty');
      if (penaltyEl) {
        penaltyEl.textContent = penalty > 0
          ? `Lost $${penalty} on death  ·  Balance: $${this.balance}`
          : `Balance: $${this.balance}`;
      }
      document.getElementById('death-screen').style.display = 'flex';
    }, 900);
  }

  _respawn() {
    document.getElementById('death-screen').style.display = 'none';
    this.hasGun = false; this.ammo = 0; this.gunType = null;
    this.isReloading = false; this.isADS = false;
    document.getElementById('reload-ring').classList.remove('visible');
    document.getElementById('crosshair').classList.remove('ads');
    this._showFists();
    this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ type: 'respawn' }));
    // Re-acquire pointer lock (button click = valid user gesture)
    this.renderer.domElement.requestPointerLock();
  }

  // ── WebSocket ─────────────────────────────────────────────────
  _connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws.addEventListener('open', () => {
      // Send name + JWT so server can link wallet/kills to account
      const token = (typeof getToken === 'function') ? (getToken() || '') : '';
      this.ws.send(JSON.stringify({ type: 'setName', name: this.myName, token }));
      this._addChat(null, 'Connected to world!', 'system');
    });
    this.ws.addEventListener('message', ({ data }) => {
      try { this._onMsg(JSON.parse(data)); } catch { }
    });
    this.ws.addEventListener('close', () => {
      this._addChat(null, 'Disconnected — refresh to reconnect.', 'system');
    });
  }

  _onMsg(msg) {
    switch (msg.type) {

      case 'welcome':
        this.myId = msg.id;
        this.myColor = msg.color || '#00ccff';
        msg.players.forEach(p => { if (p.id !== this.myId) this._spawnOther(p); });
        msg.zombies.forEach(z => this._spawnZombie(z));
        msg.loots.forEach(l => this._setLootAvailable(l.id, l.available, l.gunType));
        if (msg.balance !== undefined) this.balance = msg.balance;
        if (msg.kills !== undefined) this.zombieKills = msg.kills;
        if (msg.upgradeDefs) this.upgradeDefs = msg.upgradeDefs;
        this._updatePlayerCount();
        this._updateHUD();
        break;

      case 'playerStats':
        this.balance = msg.balance;
        this.zombieKills = msg.kills;
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
        if (o) {
          // Remote player ragdoll — drop them
          o.mesh.rotation.z = Math.PI / 2;
          this.gore.spawnRagdoll(o.mesh.position.clone(), null);
          this.gore.spawnBlood(o.mesh.position.clone(), 35, true);
        }
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
        if (msg.shieldHp !== undefined) this.shieldHp = msg.shieldHp;
        this._updateHUD();
        this._flashDamage();
        this.vmRecoil = Math.max(this.vmRecoil, 0.5); // flinch
        break;

      case 'hpRegen':
        this.hp = msg.hp;
        this._updateHUD();
        break;

      case 'youDied':
        this.hp = 0;
        this._updateHUD();
        this._onDied(msg.penalty || 0);
        break;

      case 'respawned':
        this.alive = true;
        this.maxHp = msg.maxHp || this.maxHp;
        this.hp = this.maxHp;
        if (msg.balance !== undefined) this.balance = msg.balance;
        if (msg.kills !== undefined) this.zombieKills = msg.kills;
        if (msg.shieldHp !== undefined) this.shieldHp = msg.shieldHp;
        this.footPos.set(msg.x, this._height(msg.x, msg.z), msg.z);
        this.velocity.set(0, 0, 0);
        this._updateHUD();
        break;

      case 'balanceUpdate':
        this._showKillReward(msg.balance - this.balance);
        this.balance = msg.balance;
        this.zombieKills = msg.kills;
        this._updateHUD();
        break;

      case 'upgradeResult':
        if (msg.ok) {
          this.balance = msg.balance;
          if (msg.maxHp !== undefined) this.maxHp = msg.maxHp;
          if (msg.shieldHp !== undefined) this.shieldHp = msg.shieldHp;
          if (msg.upgradeId && msg.level !== undefined) this.upgrades[msg.upgradeId] = msg.level;
          if (msg.upgradeId === 'fast_regen') this.upgrades.fast_regen = true;
          this._updateHUD();
          this._renderShopUI();
          this._addChat(null, `Bought: ${this.upgradeDefs[msg.upgradeId]?.label || msg.upgradeId}!`, 'system');
        } else {
          this._showShopError(msg.error || 'Purchase failed');
        }
        break;

      case 'ammoUpdate':
        this.ammo = msg.ammo;
        if (msg.gunType) this.gunType = msg.gunType;
        this._updateHUD();
        break;

      case 'pickedUpGun':
        this.hasGun = true;
        this.ammo = msg.ammo;
        this.gunType = msg.gunType;
        this.isReloading = false;
        this._addChat(null, `You picked up a ${msg.gunType.toUpperCase()}!`, 'system');
        this._buildViewmodelGun(msg.gunType); // rebuild mesh for new gun type
        this._showGun();                      // trigger pull-out animation
        this._updateHUD();
        break;

      case 'dropped':
        // Server confirms drop — go back to fists
        this.hasGun = false; this.ammo = 0; this.gunType = null;
        this.isReloading = false; this.isADS = false;
        document.getElementById('crosshair').classList.remove('ads');
        document.getElementById('reload-ring').classList.remove('visible');
        this._showFists();
        this._updateHUD();
        break;

      case 'lootUpdate':
        this._setLootAvailable(msg.id, msg.available, msg.gunType);
        break;

      case 'lootSpawn': {
        // Dynamically dropped weapon — create mesh on the fly
        const mesh = this._makeLootMesh(msg.gunType);
        const lx = msg.x, lz = msg.z;
        mesh.position.set(lx, this._height(lx, lz) + 1.1, lz);
        this.scene.add(mesh);
        this.loots.push({ id: msg.id, mesh, available: true, x: lx, z: lz, gunType: msg.gunType });
        break;
      }

      case 'zombieUpdate':
        this._updateZombies(msg.zombies);
        break;

      case 'zombieHit':
        this._onZombieHit(msg.id, msg.hp, msg.maxHp);
        break;

      case 'zombieDied':
        this._onZombieDied(msg);
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
    const color = data.color || '#ff4444';
    const mesh = this._makeCharMesh(new THREE.Color(color).getHex());
    const nameSpr = this._makeNameSprite(data.name || `Player${data.id}`, color);
    mesh.add(nameSpr);
    const gy = this._height(data.x || 0, data.z || 0);
    mesh.position.set(data.x || 0, gy + FOOT_OFFSET, data.z || 0);
    if (!data.alive) mesh.rotation.z = Math.PI / 2;
    this.scene.add(mesh);
    this.others.set(data.id, {
      mesh, nameSpr,
      name: data.name, color,
      hp: data.hp || 100,
      targetPos: new THREE.Vector3(data.x || 0, gy + FOOT_OFFSET, data.z || 0),
    });
  }

  _removeOther(id) {
    const o = this.others.get(id);
    if (o) { this.scene.remove(o.mesh); this.others.delete(id); }
  }

  _moveOther(msg) {
    const o = this.others.get(msg.id);
    if (o) {
      o.targetPos.set(msg.x, msg.y + FOOT_OFFSET, msg.z);
      o.mesh.rotation.y = msg.rotY || 0;
    }
  }

  _updatePlayerCount() {
    const n = this.others.size + 1;
    document.getElementById('player-count').textContent = `👥 ${n} player${n !== 1 ? 's' : ''}`;
  }

  // ── Character mesh (for remote players) ──────────────────────
  _makeCharMesh(hexColor) {
    const g = new THREE.Group();
    const col = new THREE.Color(hexColor);
    const mat = new THREE.MeshLambertMaterial({ color: col });
    const drk = new THREE.MeshLambertMaterial({ color: col.clone().multiplyScalar(0.65) });
    // Also Adidas stripe for other players
    const wht = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const blkSleeve = new THREE.MeshLambertMaterial({ color: 0x111111 });

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
    // Arms — black sleeve with 3 white stripes
    const makeCharArm = (isLeft) => {
      const ag = new THREE.Group();
      const upper = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.55, 0.27), blkSleeve);
      upper.position.y = 0.2; ag.add(upper);
      [-0.07, 0, 0.07].forEach(ox => {
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.52, 0.005), wht);
        stripe.position.set(ox, 0.2, isLeft ? -0.136 : 0.136);
        ag.add(stripe);
      });
      const lower = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.32, 0.23), mat);
      lower.position.y = -0.18; ag.add(lower);
      return ag;
    };
    const aL = makeCharArm(true); aL.position.set(-0.56, 0.44, 0); g.add(aL); g.armL = aL;
    const aR = makeCharArm(false); aR.position.set(0.56, 0.44, 0); g.add(aR); g.armR = aR;
    // Legs
    g.legL = add(new THREE.BoxGeometry(0.32, 0.82, 0.32), drk, -0.22, -0.42, 0);
    g.legR = add(new THREE.BoxGeometry(0.32, 0.82, 0.32), mat, 0.22, -0.42, 0);

    return g;
  }

  _makeNameSprite(name, colorHex = '#ffffff') {
    const W = 256, H = 64, cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    c.fillStyle = 'rgba(0,0,0,0.6)';
    c.beginPath(); c.roundRect(4, 4, W - 8, H - 8, 8); c.fill();
    c.fillStyle = colorHex;
    c.font = 'bold 26px "Segoe UI", Arial';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(name.slice(0, 18), W / 2, H / 2);
    const tex = new THREE.CanvasTexture(cv);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    spr.scale.set(2.8, 0.7, 1);
    spr.position.y = 2.1;
    return spr;
  }

  // ── Zombies ───────────────────────────────────────────────────
  _spawnZombie(data) {
    if (this.zombies.has(data.id)) return;
    const zType = data.zType || 'medium';
    const typeDef = CertaGame.ZOMBIE_TYPE_DEFS[zType] || CertaGame.ZOMBIE_TYPE_DEFS.medium;
    const mesh = this._makeZombieMesh(zType);
    const gy = this._height(data.x, data.z);
    mesh.position.set(data.x, gy + FOOT_OFFSET, data.z);
    this.scene.add(mesh);

    // HP sprite lives in world space (not child of scaled mesh) so it has consistent size
    const hpSprite = this._makeZombieHpSprite(data.hp, data.maxHp);
    const spriteY = gy + FOOT_OFFSET + typeDef.scale * 2.1 + 0.3;
    hpSprite.position.set(data.x, spriteY, data.z);
    this.scene.add(hpSprite);

    this.zombies.set(data.id, {
      mesh, hpSprite, zType,
      scale: typeDef.scale,
      hp: data.hp, maxHp: data.maxHp,
      targetPos: new THREE.Vector3(data.x, gy + FOOT_OFFSET, data.z),
    });
  }

  // Per-type visual configs — easy to tune
  static get ZOMBIE_TYPE_DEFS() {
    return {
      small:  { skinColor: 0x8fb84e, darkColor: 0x5a8a2e, eyeColor: 0xff2200, scale: 0.72 },
      medium: { skinColor: 0x6b8f4e, darkColor: 0x3a5a2e, eyeColor: 0xff2200, scale: 1.0  },
      large:  { skinColor: 0x3a6a20, darkColor: 0x1a4010, eyeColor: 0xff6600, scale: 1.55 },
      boss:   { skinColor: 0x1a2a10, darkColor: 0x0f1a08, eyeColor: 0xff0000, scale: 2.2  },
    };
  }

  _makeZombieMesh(zType = 'medium') {
    const g = new THREE.Group();
    const def = CertaGame.ZOMBIE_TYPE_DEFS[zType] || CertaGame.ZOMBIE_TYPE_DEFS.medium;

    const skin = new THREE.MeshLambertMaterial({ color: def.skinColor });
    const dark = new THREE.MeshLambertMaterial({ color: def.darkColor });
    const eyes = new THREE.MeshBasicMaterial({ color: def.eyeColor });

    const add = (geo, m, x, y, z) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      g.add(mesh);
      return mesh;
    };

    add(new THREE.BoxGeometry(0.82, 1.05, 0.52), skin, 0, 0.52, 0);
    add(new THREE.BoxGeometry(0.72, 0.72, 0.72), skin, 0, 1.38, 0);
    [-0.14, 0.14].forEach(ex => add(new THREE.BoxGeometry(0.1, 0.1, 0.04), eyes, ex, 1.48, 0.37));
    g.armL = add(new THREE.BoxGeometry(0.26, 0.84, 0.27), dark, -0.56, 0.62, 0.14);
    g.armR = add(new THREE.BoxGeometry(0.26, 0.84, 0.27), skin, 0.56, 0.62, 0.14);
    g.legL = add(new THREE.BoxGeometry(0.32, 0.82, 0.32), skin, -0.22, -0.42, 0);
    g.legR = add(new THREE.BoxGeometry(0.32, 0.82, 0.32), dark, 0.22, -0.42, 0);

    // Outstretched zombie arms
    g.armL.rotation.x = -1.1;
    g.armR.rotation.x = -1.1;

    // Boss gets bone crown
    if (zType === 'boss') {
      const boneMat = new THREE.MeshLambertMaterial({ color: 0xddccaa });
      [-0.22, 0, 0.22].forEach(hx => {
        const horn = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.35, 5), boneMat);
        horn.position.set(hx, 1.92, 0);
        g.add(horn);
      });
    }

    g.scale.setScalar(def.scale);
    g.userData.isZombie = true;
    g.userData.zType = zType;
    return g;
  }

  _makeZombieHpSprite(hp, maxHp) {
    const W = 128, H = 20, cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    this._drawZombieHpBar(ctx, hp, maxHp, W, H);
    const tex = new THREE.CanvasTexture(cv);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    spr.scale.set(2, 0.32, 1);
    spr.position.y = 2.3;
    spr.userData.cv = cv;
    spr.userData.ctx = ctx;
    spr.userData.tex = tex;
    return spr;
  }

  _drawZombieHpBar(ctx, hp, maxHp, W, H) {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.beginPath(); ctx.roundRect(0, 0, W, H, 4); ctx.fill();
    const pct = Math.max(0, hp / maxHp);
    const col = pct > 0.6 ? '#44ff44' : pct > 0.3 ? '#ffcc00' : '#ff2222';
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.roundRect(2, 2, (W - 4) * pct, H - 4, 3); ctx.fill();
  }

  _updateZombieHp(id, hp) {
    const z = this.zombies.get(id);
    if (!z || !z.hpSprite) return;
    const { cv, ctx, tex } = z.hpSprite.userData;
    this._drawZombieHpBar(ctx, hp, z.maxHp, cv.width, cv.height);
    tex.needsUpdate = true;
    z.hp = hp;
  }

  _removeZombie(id) {
    const z = this.zombies.get(id);
    if (z) {
      this.scene.remove(z.mesh);
      this.scene.remove(z.hpSprite); // hp sprite is a separate scene object
      this.zombies.delete(id);
    }
  }

  _updateZombies(data) {
    data.forEach(zd => {
      const z = this.zombies.get(zd.id);
      if (!z) return;
      const gy = this._height(zd.x, zd.z);
      z.targetPos.set(zd.x, gy + FOOT_OFFSET, zd.z);
      // Update HP bar if changed
      if (z.hp !== zd.hp) this._updateZombieHp(zd.id, zd.hp);
    });
  }

  _onZombieHit(id, hp, maxHp) {
    this._updateZombieHp(id, hp);
    this._flashZombie(id);
    // Blood splat at zombie position
    const z = this.zombies.get(id);
    if (z) this.gore.spawnBlood(z.mesh.position.clone().add(new THREE.Vector3(0, 0.8, 0)), 14, false);
    this._showHitMarker();
  }

  _onZombieDied(msg) {
    const z = this.zombies.get(msg.id);
    if (z && msg.gore) {
      const pos = z.mesh.position.clone();
      this.gore.spawnBlood(pos.clone().add(new THREE.Vector3(0, 0.8, 0)), 40, true);
      this.gore.spawnRagdoll(pos, null);
    }
    this._removeZombie(msg.id);
    this._showHitMarker();
  }

  _flashZombie(id) {
    const z = this.zombies.get(id);
    if (!z) return;
    z.mesh.children.forEach(c => {
      if (c.material && c.material.color) {
        const orig = c.material.color.clone();
        c.material.color.set(0xffaaaa);
        setTimeout(() => { if (c.material) c.material.color.copy(orig); }, 100);
      }
    });
  }

  _remoteGunshot(msg) {
    const flash = new THREE.PointLight(0xffaa00, 6, 12);
    flash.position.set(msg.x, this._height(msg.x, msg.z) + 1.5, msg.z);
    this.scene.add(flash);
    setTimeout(() => this.scene.remove(flash), 70);
    // Bullet trace from remote player
    const from = new THREE.Vector3(msg.x, this._height(msg.x, msg.z) + 1.5, msg.z);
    const dir = new THREE.Vector3(Math.sin(msg.rotY), -Math.sin(msg.pitch || 0), Math.cos(msg.rotY));
    const to = from.clone().addScaledVector(dir, 80);
    this.traces.spawn(from, to);
  }

  // ── HUD ───────────────────────────────────────────────────────
  _updateHUD() {
    // Health bar
    const pct = Math.max(0, this.hp / this.maxHp);
    const bar = document.getElementById('hp-bar');
    bar.style.width = (pct * 100) + '%';
    bar.style.background = pct > 0.5 ? '#44ff44' : pct > 0.25 ? '#ffaa00' : '#ff2222';
    document.getElementById('hp-text').textContent = `${Math.round(this.hp)} / ${this.maxHp}`;

    // Shield bar
    const shieldContainer = document.getElementById('shield-container');
    if (shieldContainer) {
      shieldContainer.style.display = this.shieldHp > 0 ? 'block' : 'none';
      const shieldBar = document.getElementById('shield-bar');
      const shieldText = document.getElementById('shield-text');
      if (shieldBar) shieldBar.style.width = Math.min(100, (this.shieldHp / 80) * 100) + '%';
      if (shieldText) shieldText.textContent = `SHIELD ${this.shieldHp}`;
    }

    // Money + kills
    const moneyEl = document.getElementById('money-display');
    if (moneyEl) moneyEl.textContent = `$${this.balance}`;
    const killsEl = document.getElementById('kills-display');
    if (killsEl) killsEl.textContent = `💀 ${this.zombieKills} kills`;

    // Ammo
    const ammoEl = document.getElementById('ammo-display');
    const gunName = document.getElementById('gun-name');
    if (this.hasGun && this.gunType) {
      const info = GUN_INFO[this.gunType];
      gunName.textContent = info.label;
      gunName.style.color = info.color;
      ammoEl.textContent = `${this.ammo} / ${info.maxAmmo}`;
      ammoEl.style.color = (this.ammo === 0) ? '#ff4444' : '#fff';
    } else {
      gunName.textContent = '';
      ammoEl.textContent = '[ no gun ]';
      ammoEl.style.color = '#888';
    }
  }

  // ── Kill reward popup ─────────────────────────────────────────
  _showKillReward(amount) {
    if (!amount || amount <= 0) return;
    const el = document.getElementById('kill-reward');
    if (!el) return;
    el.textContent = `+$${amount}`;
    el.classList.remove('show');
    void el.offsetWidth; // force reflow to restart animation
    el.classList.add('show');
  }

  // ── Upgrade Shop ──────────────────────────────────────────────
  _openShop() {
    if (this.chatOpen || !this.alive) return;
    this.shopOpen = true;
    document.exitPointerLock();
    document.getElementById('shop-overlay').classList.add('open');
    this._renderShopUI();
  }

  _closeShop() {
    this.shopOpen = false;
    document.getElementById('shop-overlay').classList.remove('open');
    // Prompt player to re-lock
    if (this.alive) document.getElementById('lock-overlay').style.display = 'flex';
  }

  _renderShopUI() {
    const balEl = document.getElementById('shop-balance-val');
    if (balEl) balEl.textContent = this.balance;

    const container = document.getElementById('shop-items');
    if (!container) return;
    container.innerHTML = '';

    Object.entries(this.upgradeDefs).forEach(([uid, def]) => {
      const isConsumable = uid === 'ammo_refill' || uid === 'shield';
      const curLevel = this.upgrades[uid] || 0;
      const isMaxed = !isConsumable && curLevel >= def.maxLevel;
      const levelCost = isConsumable ? def.cost : def.cost * (curLevel + 1);
      const canAfford = this.balance >= levelCost;

      let extraInfo = '';
      if (!isConsumable && def.maxLevel < 999) extraInfo = `<div class="shop-item-level">Level ${curLevel}/${def.maxLevel}</div>`;
      if (uid === 'shield' && this.shieldHp > 0) extraInfo = `<div class="shop-item-level">Current shield: ${this.shieldHp} HP</div>`;

      const item = document.createElement('div');
      item.className = 'shop-item' + (isMaxed ? ' maxed' : '');
      item.innerHTML = `
        <div class="shop-item-name">${def.label}</div>
        <div class="shop-item-desc">${def.desc}</div>
        ${extraInfo}
        <button class="shop-buy-btn" data-uid="${uid}" ${isMaxed || !canAfford ? 'disabled' : ''}>
          ${isMaxed ? 'MAXED' : `Buy  $${levelCost}`}
        </button>`;
      item.querySelector('button').addEventListener('click', () => this._buyUpgrade(uid));
      container.appendChild(item);
    });
  }

  _buyUpgrade(uid) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'buyUpgrade', upgradeId: uid }));
    }
  }

  _refreshShopUI() {
    if (this.shopOpen) this._renderShopUI();
  }

  _showShopError(msg) {
    const el = document.getElementById('shop-error');
    if (!el) return;
    el.textContent = msg;
    clearTimeout(this._shopErrorTimeout);
    this._shopErrorTimeout = setTimeout(() => { el.textContent = ''; }, 2500);
  }

  // ── Chat ──────────────────────────────────────────────────────
  _addChat(name, text, cls = '') {
    const box = document.getElementById('chat-messages');
    const d = document.createElement('div');
    d.className = 'msg ' + cls;
    d.textContent = name ? `${name}: ${text}` : text;
    box.appendChild(d);
    while (box.children.length > 12) box.removeChild(box.firstChild);
  }

  // ── Minimap ───────────────────────────────────────────────────
  _drawMinimap() {
    const cv = document.getElementById('minimap-canvas');
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height, cx = W / 2, cy = H / 2;
    const scale = W / 160;
    const px = this.footPos.x, pz = this.footPos.z;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(15,35,15,0.9)';
    ctx.beginPath(); ctx.arc(cx, cy, cx, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = '#2a6a2a';
    this.trees.forEach(t => {
      const mx = cx + (t.x - px) * scale, my = cy + (t.z - pz) * scale;
      ctx.beginPath(); ctx.arc(mx, my, 2, 0, Math.PI * 2); ctx.fill();
    });

    ctx.fillStyle = '#b8a070';
    BUILDING_DEFS.forEach(b => {
      const mx = cx + (b.x - px) * scale, my = cy + (b.z - pz) * scale;
      ctx.fillRect(mx - b.w * scale / 2, my - b.d * scale / 2, b.w * scale, b.d * scale);
    });

    this.zombies.forEach(z => {
      const mx = cx + (z.mesh.position.x - px) * scale, my = cy + (z.mesh.position.z - pz) * scale;
      // Different colors and sizes per zombie type
      const dotColors = { small: '#ff6644', medium: '#cc2222', large: '#aa1100', boss: '#ff0066' };
      const dotSizes  = { small: 2, medium: 3, large: 4, boss: 6 };
      ctx.fillStyle = dotColors[z.zType] || '#cc2222';
      ctx.beginPath(); ctx.arc(mx, my, dotSizes[z.zType] || 3, 0, Math.PI * 2); ctx.fill();
    });

    this.others.forEach(o => {
      ctx.fillStyle = o.color || '#ff4444';
      const mx = cx + (o.mesh.position.x - px) * scale, my = cy + (o.mesh.position.z - pz) * scale;
      ctx.beginPath(); ctx.arc(mx, my, 4, 0, Math.PI * 2); ctx.fill();
    });

    // Self dot
    ctx.fillStyle = this.myColor || '#00ccff';
    ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill();
    // Direction arrow — forward world dir = (-sin(yaw), -cos(yaw)) → canvas (-sin, -cos) because canvas +Y = south
    const arrowX = -Math.sin(this.yaw) * 9;
    const arrowZ = -Math.cos(this.yaw) * 9;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + arrowX, cy + arrowZ); ctx.stroke();

    ctx.globalCompositeOperation = 'destination-in';
    ctx.beginPath(); ctx.arc(cx, cy, cx, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  // ── Collision resolution (buildings + trees) ─────────────────
  _resolveCollisions() {
    const r = 0.45;  // player capsule radius
    const T = 0.45;  // wall thickness (slightly padded)
    const DW = 2.0;  // door width
    const px = this.footPos.x, pz = this.footPos.z;

    // Helper: push player out of an AABB (2D, ignoring Y)
    const pushOut = (cx, cz, hw, hd) => {
      // Find closest point on box to player circle center
      const nearX = Math.max(cx - hw, Math.min(this.footPos.x, cx + hw));
      const nearZ = Math.max(cz - hd, Math.min(this.footPos.z, cz + hd));
      const dx = this.footPos.x - nearX;
      const dz = this.footPos.z - nearZ;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > 0 && dist < r) {
        this.footPos.x += (dx / dist) * (r - dist);
        this.footPos.z += (dz / dist) * (r - dist);
      }
    };

    // Buildings — each wall is a separate AABB so the door gap is preserved
    for (const b of BUILDING_DEFS) {
      const hw2 = T / 2;
      // Back wall (full width)
      pushOut(b.x, b.z - b.d / 2, b.w / 2, hw2);
      // Left wall
      pushOut(b.x - b.w / 2, b.z, hw2, b.d / 2);
      // Right wall
      pushOut(b.x + b.w / 2, b.z, hw2, b.d / 2);
      // Front wall left piece (from -w/2 to -DW/2)
      if (b.w > DW) {
        const pieceW = (b.w - DW) / 4;  // half-width of each front piece
        pushOut(b.x - (b.w + DW) / 4, b.z + b.d / 2, pieceW, hw2);
        // Front wall right piece (from +DW/2 to +w/2)
        pushOut(b.x + (b.w + DW) / 4, b.z + b.d / 2, pieceW, hw2);
      }
    }

    // Trees — cylinder check (trunk radius ~0.48)
    const treeR = 0.48 + r;
    for (const t of this.trees) {
      const dx = this.footPos.x - t.x;
      const dz = this.footPos.z - t.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < treeR && dist > 0.001) {
        this.footPos.x += (dx / dist) * (treeR - dist);
        this.footPos.z += (dz / dist) * (treeR - dist);
      }
    }
  }

  // ── Walk animation ────────────────────────────────────────────
  _animateCharacter(mesh, moving, t) {
    const { armL, armR, legL, legR } = mesh;
    if (!armL) return;
    if (moving) {
      const s = Math.sin(t * 8) * 0.45;
      // For zombie mesh, arms are already rotated forward; just swing legs
      if (mesh.userData.isZombie) {
        legL.rotation.x = -s; legR.rotation.x = s;
      } else {
        armL.rotation.x = s; armR.rotation.x = -s;
        legL.rotation.x = -s; legR.rotation.x = s;
      }
    } else {
      if (mesh.userData.isZombie) {
        legL.rotation.x *= 0.85; legR.rotation.x *= 0.85;
      } else {
        [armL, armR, legL, legR].forEach(p => { p.rotation.x *= 0.85; });
      }
    }
  }

  // ── Viewmodel animation ───────────────────────────────────────
  _updateViewmodel(dt, t) {
    if (!this.vmRoot || !this.alive) return;

    const hipX = 0.18, hipY = -0.26, hipZ = -0.55;
    const adsX = 0.00, adsY = -0.10, adsZ = -0.48;
    const tx = this.isADS ? adsX : hipX;
    const ty = this.isADS ? adsY : hipY;
    const tz = this.isADS ? adsZ : hipZ;

    // Idle bob
    this.vmIdleBob += dt * 1.2;
    const bob = Math.sin(this.vmIdleBob) * 0.004;

    // ── Pull-out animation: vmRoot slides up from below (Y starts -0.55 below hip) ──
    if (this.vmPullingOut) {
      this.vmPullout = Math.min(1, this.vmPullout + dt * 3.5); // ~0.28s to fully draw
      const pullY = (1 - this.vmPullout) * -0.55; // starts low, reaches 0 at completion
      this.vmRoot.position.set(tx, ty + pullY + bob, tz);
      if (this.vmPullout >= 1) this.vmPullingOut = false;
      return;
    }

    // ── Punch animation — swings the active arm forward in -Z ──
    const activeArmR = this.hasGun ? this.vmArmR : this.vmFistR;
    const activeArmL = this.hasGun ? this.vmArmL : this.vmFistL;
    if (this.vmPunchAnim > 0) {
      this.vmPunchAnim -= dt * 5.0;
      if (this.vmPunchAnim < 0) this.vmPunchAnim = 0;
      const punch = Math.sin(this.vmPunchAnim * Math.PI);
      if (activeArmR) activeArmR.position.z = -punch * 0.22;
      if (activeArmL) activeArmL.position.z = (this.hasGun ? -0.15 : -0.08) - punch * 0.06;
    } else {
      if (activeArmR) activeArmR.position.z = 0.0;
      if (activeArmL) activeArmL.position.z = this.hasGun ? -0.15 : -0.08;
    }

    // ── Reload animation ──
    if (this.isReloading) {
      const dur = this.reloadDuration || 1.5;
      this.vmReloadAnim = Math.min(1, this.vmReloadAnim + dt / dur);
      const dropY = Math.sin(this.vmReloadAnim * Math.PI) * -0.42;
      this.vmRoot.position.set(tx, ty + dropY + bob, tz);
      return;
    }

    // ── Recoil: kick vmRoot back (+Z) and UP (+Y) — matches screen kick direction ──
    let recoilZ = 0, recoilY = 0;
    if (this.vmRecoil > 0) {
      this.vmRecoil -= dt * 8;
      if (this.vmRecoil < 0) this.vmRecoil = 0;
      const k = Math.sin(this.vmRecoil * Math.PI);
      recoilZ = k * 0.045;   // gun pushes back toward camera
      recoilY = k * 0.014;   // gun kicks upward (matches screen pitch up)
    }

    // Smooth lerp to target
    this.vmRoot.position.x += (tx - this.vmRoot.position.x) * Math.min(1, dt * 14);
    this.vmRoot.position.y += (ty + bob + recoilY - this.vmRoot.position.y) * Math.min(1, dt * 14);
    this.vmRoot.position.z += (tz + recoilZ - this.vmRoot.position.z) * Math.min(1, dt * 14);
  }

  // ── Main Update ───────────────────────────────────────────────
  _update(dt) {
    const now = performance.now();
    const t = now * 0.001;

    if (this.alive) {
      // ── FPS movement ──
      const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const dir = new THREE.Vector3();
      const speed = 9.5 * dt;

      if (this.keys['KeyW'] || this.keys['ArrowUp']) dir.addScaledVector(forward, 1);
      if (this.keys['KeyS'] || this.keys['ArrowDown']) dir.addScaledVector(forward, -1);
      if (this.keys['KeyA'] || this.keys['ArrowLeft']) dir.addScaledVector(right, -1);
      if (this.keys['KeyD'] || this.keys['ArrowRight']) dir.addScaledVector(right, 1);

      const isMoving = dir.lengthSq() > 0;
      if (isMoving) {
        dir.normalize();
        this.footPos.x += dir.x * speed;
        this.footPos.z += dir.z * speed;
      }

      // Jump
      if (this.keys['Space'] && this.onGround) {
        this.velocity.y = 9;
        this.onGround = false;
      }

      // Gravity + vertical movement
      this.velocity.y -= 22 * dt;
      this.footPos.y += this.velocity.y * dt;

      // Ground snap — use building floor height when inside a building
      let effectiveGY = this._height(this.footPos.x, this.footPos.z);
      for (const bf of this.buildingFloors) {
        if (Math.abs(this.footPos.x - bf.x) < bf.hw &&
            Math.abs(this.footPos.z - bf.z) < bf.hd) {
          effectiveGY = Math.max(effectiveGY, bf.floorY);
          break;
        }
      }
      if (this.footPos.y <= effectiveGY) {
        this.footPos.y = effectiveGY;
        this.velocity.y = 0;
        this.onGround = true;
      }

      // Bounds
      const B = this.WORLD_SIZE / 2 - 10;
      this.footPos.x = Math.max(-B, Math.min(B, this.footPos.x));
      this.footPos.z = Math.max(-B, Math.min(B, this.footPos.z));

      // ── Collision ──
      this._resolveCollisions();

      // ── Camera = eye position ──
      this.camera.position.set(
        this.footPos.x,
        this.footPos.y + EYE_HEIGHT,
        this.footPos.z
      );
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.y = this.yaw;
      this.camera.rotation.x = this.pitch;

      // ADS FOV lerp
      const targetFOV = this.isADS
        ? (this.gunType === 'sniper' ? 22 : 45)
        : 75;
      this.camera.fov += (targetFOV - this.camera.fov) * Math.min(1, dt * 10);
      this.camera.updateProjectionMatrix();

      // ── Send position ──
      if (now - this.lastSendMs > this.SEND_RATE && this.ws?.readyState === WebSocket.OPEN) {
        this.lastSendMs = now;
        this.ws.send(JSON.stringify({
          type: 'move',
          x: +this.footPos.x.toFixed(2),
          y: +this.footPos.y.toFixed(2),
          z: +this.footPos.z.toFixed(2),
          rotY: +this.yaw.toFixed(3),
          pitch: +this.pitch.toFixed(3),
        }));
      }

      // ── HUD coords ──
      document.getElementById('coords').textContent =
        `X: ${this.footPos.x.toFixed(0)}  Z: ${this.footPos.z.toFixed(0)}  [B] Shop`;

      // ── Pickup prompt ──
      let nearLoot = false, nearLootType = '';
      this.loots.forEach(l => {
        if (!l.available) return;
        const dx = l.x - this.footPos.x, dz = l.z - this.footPos.z;
        if (Math.sqrt(dx * dx + dz * dz) < 4.5) { nearLoot = true; nearLootType = l.gunType; }
      });
      const prompt = document.getElementById('pickup-prompt');
      if (nearLoot) {
        prompt.textContent = `🔫 [E] Pick up ${(nearLootType || '').toUpperCase()}`;
        prompt.style.display = 'block';
      } else {
        prompt.style.display = 'none';
      }

      // ── Viewmodel ──
      this._updateViewmodel(dt, t);
    }

    // ── Interpolate other players ──
    this.others.forEach(o => {
      const prev = o.mesh.position.clone();
      o.mesh.position.lerp(o.targetPos, 0.22);
      const gy = this._height(o.mesh.position.x, o.mesh.position.z);
      if (o.mesh.position.y < gy + FOOT_OFFSET) o.mesh.position.y = gy + FOOT_OFFSET;
      this._animateCharacter(o.mesh, o.mesh.position.distanceTo(prev) > 0.01, t);
    });

    // ── Interpolate zombies ──
    this.zombies.forEach(z => {
      const prev = z.mesh.position.clone();
      z.mesh.position.lerp(z.targetPos, 0.2);
      const gy = this._height(z.mesh.position.x, z.mesh.position.z);
      if (z.mesh.position.y < gy + FOOT_OFFSET) z.mesh.position.y = gy + FOOT_OFFSET;
      const moved = z.mesh.position.distanceTo(prev);
      if (moved > 0.01) {
        const dx = z.mesh.position.x - prev.x, dz = z.mesh.position.z - prev.z;
        z.mesh.rotation.y = Math.atan2(dx, dz);
      }
      z.mesh.userData.isZombie = true;
      this._animateCharacter(z.mesh, moved > 0.01, t);
      // Keep HP sprite above zombie head (accounts for different zombie scales)
      z.hpSprite.position.set(
        z.mesh.position.x,
        z.mesh.position.y + (z.scale || 1.0) * 2.1 + 0.3,
        z.mesh.position.z
      );
    });

    // ── Floating loot ──
    this.loots.forEach(l => {
      if (!l.available) return;
      l.mesh.position.y = this._height(l.x, l.z) + 1.1 + Math.sin(t * 2) * 0.22;
      l.mesh.rotation.y += dt * 1.4;
    });

    // ── Clouds ──
    this.clouds.forEach(c => {
      c.position.x += c.userData.speed * dt;
      if (c.position.x > 260) c.position.x = -260;
    });

    // ── Gore + traces ──
    if (this.gore) this.gore.update(dt, (x, z) => this._height(x, z));
    if (this.traces) this.traces.update(dt);

    // ── Minimap ──
    this._drawMinimap();
  }

  // ── Render loop (two-pass) ────────────────────────────────────
  _loop() {
    requestAnimationFrame(() => this._loop());
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this._update(dt);

    this.renderer.clear();
    // Pass 1: World
    this.renderer.render(this.scene, this.camera);
    // Pass 2: Viewmodel on top (clear depth only so it renders over world)
    this.renderer.clearDepth();
    this.renderer.render(this.vmScene, this.vmCamera);
  }
}

window.addEventListener('load', () => { window._game = new CertaGame(); });
