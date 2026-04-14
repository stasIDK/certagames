'use strict';
require('dotenv').config();

const express    = require('express');
const http       = require('http');
const path       = require('path');
const cors       = require('cors');
const WebSocket  = require('ws');
const { Server } = require('socket.io');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');

// pg is optional — app still runs without a database
let Pool;
try { Pool = require('pg').Pool; } catch(e) { Pool = null; }

// ── Config ────────────────────────────────────
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'certa-games-dev-secret-changeme';

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' }, destroyUpgrade: false });
const PUBLIC  = path.join(__dirname, 'public');

app.use(express.json());
app.use(cors({ origin: '*', methods: ['GET','POST','DELETE','PUT'] }));

// ── Static: card games in /public/cards/, shooter in /public/ ──
app.get('/',          (_, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
app.get('/game',      (_, res) => res.sendFile(path.join(PUBLIC, 'game.html')));
app.get('/solitaire', (_, res) => res.sendFile(path.join(PUBLIC, 'cards', 'solitaire.html')));
app.get('/durak',     (_, res) => res.sendFile(path.join(PUBLIC, 'cards', 'durak.html')));
app.get('/poker',     (_, res) => res.sendFile(path.join(PUBLIC, 'cards', 'poker.html')));
// Static assets (game.js, three.js, etc)
app.use(express.static(PUBLIC));

// ── Database (optional) ───────────────────────
let pool = null;
let dbReady = false;

async function initDB() {
  if (!Pool) { console.warn('⚠️  pg not installed — running without database'); return; }
  const connStr = process.env.DATABASE_URL || 'postgresql://postgres:2019Stephen@localhost:5432/solitaire';
  pool = new Pool({
    connectionString: connStr,
    ssl: (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')) ? { rejectUnauthorized: false } : false,
  });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scores (
        id SERIAL PRIMARY KEY, auth_sub VARCHAR(128) NOT NULL,
        name VARCHAR(80) NOT NULL, time INTEGER NOT NULL,
        date TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_scores_time ON scores(time ASC);
      CREATE TABLE IF NOT EXISTS users (
        auth_sub VARCHAR(128) PRIMARY KEY, name VARCHAR(80) NOT NULL,
        balance INTEGER NOT NULL DEFAULT 100, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS durak_history (
        id SERIAL PRIMARY KEY, room_id VARCHAR(32) NOT NULL,
        winner_sub VARCHAR(128), bet INTEGER NOT NULL,
        players JSONB, finished_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(40);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(128);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS zombies_killed INTEGER NOT NULL DEFAULT 0;
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);`).catch(()=>{});
    dbReady = true;
    console.log('✅  Database ready');
  } catch(e) {
    console.warn('⚠️  Database unavailable — auth/scores disabled:', e.message);
    pool = null;
  }
}

// DB helpers — all no-op when db unavailable
async function dbQuery(sql, params=[]) {
  if (!pool) throw new Error('No database');
  return pool.query(sql, params);
}
async function ensureUser(sub, name) {
  if (!pool) return;
  await dbQuery(
    `INSERT INTO users (auth_sub, name, balance) VALUES ($1, $2, 100)
     ON CONFLICT (auth_sub) DO UPDATE SET
       name = EXCLUDED.name,
       balance = CASE WHEN users.balance <= 0 THEN 100 ELSE users.balance END`,
    [sub, name]
  ).catch(()=>{});
}
async function getBalance(sub) {
  if (!pool) return 100;
  const r = await dbQuery('SELECT balance FROM users WHERE auth_sub=$1', [sub]).catch(()=>null);
  return r?.rows[0]?.balance ?? 100;
}

// ── Rate limiter ──────────────────────────────
const rl = new Map();
function rateLimit(key, max=5, windowMs=60000) {
  const now = Date.now();
  let d = rl.get(key);
  if (!d || now > d.reset) d = { count:0, reset: now+windowMs };
  d.count++; rl.set(key, d);
  return d.count > max;
}

// ── Auth helpers ──────────────────────────────
function signToken(payload) { return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' }); }
function verifyToken(token) { return jwt.verify(token, JWT_SECRET); }
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try { req.user = verifyToken(auth.slice(7)); next(); }
  catch(e) { res.status(401).json({ error: e.message }); }
}

// ── Auth routes ───────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not available — auth disabled' });
  const { username, password } = req.body || {};
  if (!username || typeof username !== 'string') return res.status(400).json({ error: 'Username required' });
  if (!password || typeof password !== 'string') return res.status(400).json({ error: 'Password required' });
  const u = username.trim().toLowerCase().replace(/[^a-z0-9_]/g,'');
  if (u.length < 2 || u.length > 30) return res.status(400).json({ error: 'Username must be 2-30 alphanumeric chars' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  const displayName = username.trim().slice(0,40);
  const sub = 'usr:' + u;
  try {
    const hash = await bcrypt.hash(password, 10);
    await dbQuery(
      `INSERT INTO users (auth_sub, name, balance, username, password_hash) VALUES ($1,$2,100,$3,$4)`,
      [sub, displayName, u, hash]
    );
    res.json({ token: signToken({ sub, name: displayName }), user: { sub, name: displayName, balance: 100 } });
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Username already taken' });
    console.error('Register error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not available — auth disabled' });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const u = username.trim().toLowerCase().replace(/[^a-z0-9_]/g,'');
  const sub = 'usr:' + u;
  try {
    const r = await dbQuery('SELECT * FROM users WHERE auth_sub=$1 OR username=$2', [sub, u]);
    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });
    if (!user.password_hash) return res.status(401).json({ error: 'Account has no password set' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid username or password' });
    res.json({ token: signToken({ sub: user.auth_sub, name: user.name }), user: { sub: user.auth_sub, name: user.name, balance: user.balance } });
  } catch(e) { console.error('Login error:', e.message); res.status(500).json({ error: 'Server error' }); }
});

// ── User / balance routes ─────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', db: dbReady }));
app.get('/api/me', requireAuth, async (req, res) => {
  const name = (req.user.name||'Player').slice(0,80);
  await ensureUser(req.user.sub, name);
  const bal = await getBalance(req.user.sub);
  res.json({ sub: req.user.sub, name, balance: bal });
});
app.post('/api/me/reset', requireAuth, async (req, res) => {
  if (!pool) return res.json({ ok:true, balance: 100 });
  await dbQuery('UPDATE users SET balance=balance+100 WHERE auth_sub=$1', [req.user.sub]).catch(()=>{});
  res.json({ ok:true, balance: await getBalance(req.user.sub) });
});
app.get('/api/leaderboard', async (_, res) => {
  if (!pool) return res.json([]);
  try { const r = await dbQuery('SELECT name, balance FROM users ORDER BY balance DESC LIMIT 50'); res.json(r.rows); }
  catch(e) { res.status(500).json({ error: 'DB error' }); }
});

// ── Leaderboard routes ────────────────────────
// Money / richest players
app.get('/api/leaderboard/money', async (_, res) => {
  if (!pool) return res.json([]);
  try { const r = await dbQuery('SELECT name, balance FROM users ORDER BY balance DESC LIMIT 50'); res.json(r.rows); }
  catch(e) { res.status(500).json({ error: 'DB error' }); }
});
// Zombie kills
app.get('/api/leaderboard/zombies', async (_, res) => {
  if (!pool) return res.json([]);
  try { const r = await dbQuery('SELECT name, COALESCE(zombies_killed,0) AS kills FROM users ORDER BY zombies_killed DESC NULLS LAST LIMIT 50'); res.json(r.rows); }
  catch(e) { res.status(500).json({ error: 'DB error' }); }
});
// Solitaire fastest — alias of /api/scores
app.get('/api/leaderboard/solitaire', async (_, res) => {
  if (!pool) return res.json([]);
  try { const r = await dbQuery('SELECT id,name,time,date FROM scores ORDER BY time ASC LIMIT 50'); res.json(r.rows); }
  catch(e) { res.status(500).json({ error: 'DB error' }); }
});

// ── Solitaire score routes ────────────────────
const MIN_TIME=30, MAX_TIME=86400;
app.get('/api/scores', async (_, res) => {
  if (!pool) return res.json([]);
  try { const r = await dbQuery('SELECT id,name,time,date FROM scores ORDER BY time ASC LIMIT 100'); res.json(r.rows); }
  catch(e) { res.status(500).json({ error: 'DB error' }); }
});
app.post('/api/scores', requireAuth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'DB unavailable' });
  if (rateLimit(req.user.sub)) return res.status(429).json({ error: 'Too many requests' });
  const name = (req.user.name||'Player').slice(0,80);
  const { time } = req.body;
  if (typeof time!=='number'||!Number.isInteger(time)) return res.status(400).json({ error: 'Invalid time' });
  if (time < MIN_TIME) return res.status(400).json({ error: 'Too fast' });
  if (time > MAX_TIME) return res.status(400).json({ error: 'Too large' });
  try {
    await dbQuery('INSERT INTO scores(auth_sub,name,time) VALUES($1,$2,$3)', [req.user.sub,name,time]);
    res.status(201).json({ ok:true, name });
  } catch(e) { res.status(500).json({ error: 'DB error' }); }
});
app.delete('/api/scores/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'DB unavailable' });
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try { await dbQuery('DELETE FROM scores WHERE id=$1', [id]); res.json({ ok:true }); }
  catch(e) { res.status(500).json({ error: 'DB error' }); }
});

// ══════════════════════════════════════════════
//  SHOOTER WEBSOCKET (raw WS on same http server)
//  Upgrade path: /ws  — all other WS goes to socket.io
// ══════════════════════════════════════════════
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  // socket.io hijacks its own upgrades; raw WS gets /ws path
  if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  }
  // else socket.io handles it
});

// ══════════════════════════════════════════════
//  SHOOTER — TUNABLE CONSTANTS (easy to adjust)
// ══════════════════════════════════════════════

// ── Player ────────────────────────────────────
const PLAYER_HP            = 100;    // base max HP
const PLAYER_REGEN_RATE    = 1.5;   // HP/sec while out of combat
const PLAYER_REGEN_DELAY   = 8.0;   // seconds after last hit before regen
const PLAYER_DEATH_PENALTY = 50;    // $ lost on death (never below 0)
const PLAYER_START_BALANCE = 100;   // starting wallet
const PUNCH_RANGE          = 3.0;   // melee reach (units)
const PUNCH_DAMAGE         = 20;    // fist damage
const LOOT_RESPAWN_TIME    = 300000;// 5 min gun respawn

// ── Zombie types ──────────────────────────────
// All values here — change freely to tune difficulty
const ZOMBIE_TYPES = {
  small:  { hp:  40, speed: 3.8, damage:  6, reward:  5, aggroRange: 35, deaggroRange: 55, regenRate: 3.0, punchCd: 1100, punchRange: 2.4 },
  medium: { hp:  80, speed: 2.8, damage: 12, reward: 10, aggroRange: 42, deaggroRange: 65, regenRate: 1.8, punchCd: 1400, punchRange: 2.8 },
  large:  { hp: 180, speed: 1.8, damage: 20, reward: 20, aggroRange: 45, deaggroRange: 70, regenRate: 1.2, punchCd: 1800, punchRange: 3.2 },
  boss:   { hp: 600, speed: 1.3, damage: 35, reward: 65, aggroRange: 55, deaggroRange: 85, regenRate: 0.8, punchCd: 2200, punchRange: 3.5 },
};
// How many of each type to spawn (edit counts here)
const ZOMBIE_SPAWN_TABLE = [
  ...Array(25).fill('small'),
  ...Array(20).fill('medium'),
  ...Array(8).fill('large'),
  ...Array(3).fill('boss'),
];
const ZOMBIE_RESPAWN_DELAY = 30000; // ms before a killed zombie respawns

// ── Upgrade shop ──────────────────────────────
// cost scales per level: level 1 costs cost, level 2 costs cost*2, etc.
const UPGRADE_DEFS = {
  dmg_boost:  { cost: 150, label: '+ Gun Damage',  desc: '+30% gun damage per level', maxLevel: 3 },
  extra_hp:   { cost: 175, label: '+ Max Health',  desc: '+50 max HP per level',      maxLevel: 2 },
  fast_regen: { cost: 125, label: 'Adrenaline',    desc: '3× health regen rate',      maxLevel: 1 },
  shield:     { cost: 200, label: 'Energy Shield', desc: '+80 HP shield buffer',      maxLevel: 999 }, // stackable consumable
  ammo_refill:{ cost:  60, label: 'Ammo Refill',   desc: 'Instantly refill ammo',     maxLevel: 999 }, // always available
};

const GUN_DEFS = {
  pistol:  { damage:35,  ammo:12, maxAmmo:12, range:60,  pellets:1, fireRate:450  },
  shotgun: { damage:14,  ammo:6,  maxAmmo:6,  range:28,  pellets:8, fireRate:900  },
  ar:      { damage:22,  ammo:30, maxAmmo:30, range:90,  pellets:1, fireRate:110  },
  sniper:  { damage:120, ammo:5,  maxAmmo:5,  range:250, pellets:1, fireRate:1800 },
};

const BUILDING_DEFS = [
  { x:25,  z:25,   w:8,  d:6, gun:'pistol'  },
  { x:-45, z:35,   w:8,  d:6, gun:'pistol'  },
  { x:60,  z:-40,  w:8,  d:6, gun:'pistol'  },
  { x:-60, z:-50,  w:8,  d:6, gun:'pistol'  },
  { x:90,  z:70,   w:9,  d:7, gun:'shotgun' },
  { x:-80, z:90,   w:9,  d:7, gun:'shotgun' },
  { x:30,  z:-90,  w:11, d:8, gun:'ar'      },
  { x:-100,z:-30,  w:12, d:8, gun:'sniper'  },
];

const COLORS = ['#4488ff','#ff4444','#44ff88','#ffcc00','#ff44ff','#44ccff','#ff8844','#88ff44','#cc8844','#44ffcc'];

function gh(x, z) {
  return (
    Math.sin(x*0.048)*Math.cos(z*0.048)*3.0 +
    Math.sin(x*0.10+1.2)*Math.sin(z*0.09)*1.8 +
    Math.sin(x*0.022)*Math.sin(z*0.022)*5.0 +
    Math.cos(x*0.035+0.5)*Math.cos(z*0.028+1.0)*2.0
  );
}

// ── Loot ─────────────────────────────────────
const loots = BUILDING_DEFS.map((b,i) => ({ id:i, x:b.x+1, z:b.z+1, gunType:b.gun, available:true }));

// ── Zombies ───────────────────────────────────
let zid = 0;
const zombies = new Map();
function spawnZombie(forcedType) {
  const i = zid++;
  const zType = forcedType || ZOMBIE_SPAWN_TABLE[i % ZOMBIE_SPAWN_TABLE.length];
  const typeDef = ZOMBIE_TYPES[zType] || ZOMBIE_TYPES.medium;
  const a = Math.random()*Math.PI*2, d = 50+Math.random()*180;
  zombies.set(i, {
    id:i, zType, typeDef,
    x:Math.cos(a)*d, z:Math.sin(a)*d, y:0,
    hp:typeDef.hp, maxHp:typeDef.hp,
    alive:true, state:'idle',
    lastPunch:0, wanderAngle:Math.random()*Math.PI*2, wanderTimer:0,
  });
}
// Spawn all zombies according to ZOMBIE_SPAWN_TABLE
ZOMBIE_SPAWN_TABLE.forEach(t => spawnZombie(t));
const sz = z => ({ id:z.id, x:+z.x.toFixed(2), z:+z.z.toFixed(2), hp:z.hp, maxHp:z.maxHp, zType:z.zType });

// ── Players ───────────────────────────────────
const shooterPlayers = new Map();
const shooterSockets = new Map();
let nextShooterId = 1;

const sp = p => ({ id:p.id, name:p.name, color:p.color, x:p.x, y:p.y, z:p.z, rotY:p.rotY, pitch:p.pitch, hp:p.hp, maxHp:p.maxHp, alive:p.alive, hasGun:p.hasGun, gunType:p.gunType });

function shooterSendTo(id, msg) {
  const ws = shooterSockets.get(id);
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function shooterBroadcast(msg, excludeId=-1) {
  const s = JSON.stringify(msg);
  shooterSockets.forEach((ws, id) => {
    if (id !== excludeId && ws.readyState === WebSocket.OPEN) ws.send(s);
  });
}
function killShooterPlayer(p, killerName) {
  p.alive=false; p.hp=0; p.hasGun=false; p.gunType=null; p.ammo=0;
  const penalty = Math.min(p.balance, PLAYER_DEATH_PENALTY);
  p.balance = Math.max(0, p.balance - penalty);
  shooterSendTo(p.id, { type:'youDied', killedBy:killerName||'Zombie', penalty });
  shooterBroadcast({ type:'playerDied', id:p.id, name:p.name, killedBy:killerName||'Zombie' });
  if (p.sub && penalty > 0) {
    dbQuery('UPDATE users SET balance=GREATEST(balance-$1,0) WHERE auth_sub=$2', [penalty, p.sub]).catch(()=>{});
  }
}
function scheduleZRespawn(z) {
  setTimeout(() => {
    const a=Math.random()*Math.PI*2, d=60+Math.random()*150;
    z.x=Math.cos(a)*d; z.z=Math.sin(a)*d;
    z.hp=z.typeDef.hp; z.alive=true; z.state='idle';
    shooterBroadcast({ type:'zombieRespawn', zombie:sz(z) });
  }, ZOMBIE_RESPAWN_DELAY);
}

// ── Zombie AI + player regen tick ─────────────
setInterval(() => {
  const now=Date.now(), dt=0.1;
  const alivePlayers=[...shooterPlayers.values()].filter(p=>p.alive);

  zombies.forEach(z => {
    if (!z.alive) return;
    z.y = gh(z.x, z.z);
    const t = z.typeDef;

    let nearest=null, nd=Infinity;
    alivePlayers.forEach(p=>{ const d=Math.hypot(p.x-z.x,p.z-z.z); if(d<nd){nd=d;nearest=p;} });

    if (z.state === 'aggro') {
      // Deaggro if player moved far enough away
      if (!nearest || nd > t.deaggroRange) {
        z.state = 'idle';
      } else {
        // Chase or punch
        const dx=nearest.x-z.x, dz=nearest.z-z.z, d=Math.hypot(dx,dz);
        if (d > t.punchRange) {
          z.x += (dx/d)*t.speed*dt;
          z.z += (dz/d)*t.speed*dt;
        } else if (now - z.lastPunch > t.punchCd) {
          z.lastPunch = now;
          let dmg = t.damage;
          // Shield absorbs damage first
          if (nearest.upgrades.shield > 0) {
            const absorb = Math.min(nearest.upgrades.shield, dmg);
            dmg -= absorb;
            nearest.upgrades.shield = Math.max(0, nearest.upgrades.shield - absorb);
          }
          nearest.hp = Math.max(0, nearest.hp - dmg);
          nearest.lastHitTime = now;
          shooterSendTo(nearest.id, { type:'selfHit', hp:nearest.hp, attacker:'Zombie', shieldHp:nearest.upgrades.shield });
          shooterBroadcast({ type:'playerHp', id:nearest.id, hp:nearest.hp });
          if (nearest.hp <= 0) killShooterPlayer(nearest, 'Zombie');
        }
      }
    } else {
      // Idle — check if player enters aggro range
      if (nearest && nd < t.aggroRange) {
        z.state = 'aggro';
      } else {
        // Wander + health regen
        z.wanderTimer -= dt;
        if (z.wanderTimer <= 0) { z.wanderAngle=Math.random()*Math.PI*2; z.wanderTimer=2+Math.random()*3; }
        z.x += Math.cos(z.wanderAngle)*t.speed*0.35*dt;
        z.z += Math.sin(z.wanderAngle)*t.speed*0.35*dt;
        const B=240; z.x=Math.max(-B,Math.min(B,z.x)); z.z=Math.max(-B,Math.min(B,z.z));
        if (z.hp < z.maxHp) z.hp = Math.min(z.maxHp, z.hp + t.regenRate*dt);
      }
    }
  });

  // Player health regen (slow, only while out of combat)
  shooterPlayers.forEach(p => {
    if (!p.alive || p.hp >= p.maxHp) return;
    const timeSinceHit = (now - (p.lastHitTime||0)) / 1000;
    if (timeSinceHit >= PLAYER_REGEN_DELAY) {
      const rate = PLAYER_REGEN_RATE * (p.upgrades.fast_regen ? 3 : 1);
      const prev = Math.round(p.hp);
      p.hp = Math.min(p.maxHp, p.hp + rate*dt);
      if (Math.round(p.hp) !== prev) {
        shooterSendTo(p.id, { type:'hpRegen', hp:Math.round(p.hp) });
      }
    }
  });

  shooterBroadcast({ type:'zombieUpdate', zombies:[...zombies.values()].filter(z=>z.alive).map(sz) });
}, 100);

// ── Shooter WS handler ────────────────────────
wss.on('connection', ws => {
  const id = nextShooterId++;
  shooterSockets.set(id, ws);
  const p = {
    id, name:`Player${id}`, color:COLORS[(id-1)%COLORS.length],
    sub: null,   // linked account (set via JWT token in setName)
    x:(Math.random()-0.5)*20, y:0, z:(Math.random()-0.5)*20,
    rotY:0, pitch:0, hp:PLAYER_HP, maxHp:PLAYER_HP,
    alive:true, hasGun:false, gunType:null, ammo:0, lastShot:0,
    lastHitTime: 0,
    balance: PLAYER_START_BALANCE,
    zombiesKilled: 0,
    upgrades: { dmg_boost:0, extra_hp:0, fast_regen:false, shield:0 },
  };
  shooterPlayers.set(id, p);
  console.log(`[+] Shooter player ${id}. Online: ${shooterPlayers.size}`);

  ws.send(JSON.stringify({
    type:'welcome', id, color:p.color,
    players:[...shooterPlayers.values()].map(sp),
    zombies:[...zombies.values()].filter(z=>z.alive).map(sz),
    loots:loots.map(l=>({id:l.id,available:l.available,gunType:l.gunType})),
    balance: p.balance,
    kills: p.zombiesKilled,
    upgradeDefs: UPGRADE_DEFS,
  }));
  shooterBroadcast({type:'playerJoin',player:sp(p)}, id);

  ws.on('message', async raw => {
    let msg; try{msg=JSON.parse(raw);}catch{return;}

    switch(msg.type) {
      case 'move': {
        if (!p.alive) break;
        if (Math.abs(msg.x-p.x)<22&&Math.abs(msg.z-p.z)<22){p.x=msg.x;p.y=msg.y;p.z=msg.z;p.rotY=msg.rotY||0;p.pitch=msg.pitch||0;}
        shooterBroadcast({type:'playerMove',id,x:p.x,y:p.y,z:p.z,rotY:p.rotY,pitch:p.pitch},id);
        break;
      }
      case 'setName': {
        p.name = String(msg.name).replace(/[<>]/g,'').slice(0,20).trim() || p.name;
        // Link account via JWT to persist balance + kills
        if (msg.token) {
          try {
            const payload = verifyToken(msg.token);
            p.sub = payload.sub;
            const r = await dbQuery(
              'SELECT balance, COALESCE(zombies_killed,0) AS zk FROM users WHERE auth_sub=$1',
              [p.sub]
            );
            if (r.rows[0]) { p.balance = r.rows[0].balance; p.zombiesKilled = r.rows[0].zk; }
          } catch(e) { /* DB unavailable or invalid token — use session defaults */ }
          shooterSendTo(id, { type:'playerStats', balance:p.balance, kills:p.zombiesKilled });
        }
        shooterBroadcast({type:'playerName',id,name:p.name});
        break;
      }
      case 'chat': {
        const t=String(msg.text).replace(/[<>]/g,'').slice(0,120).trim();
        if(t) shooterBroadcast({type:'chat',id,name:p.name,text:t});
        break;
      }
      case 'punch': {
        if (!p.alive) break;
        const punchMult = 1.0 + (p.upgrades.dmg_boost||0) * 0.30;
        const punchDmg = Math.round(PUNCH_DAMAGE * punchMult);
        zombies.forEach(z=>{
          if(!z.alive||Math.hypot(z.x-p.x,z.z-p.z)>PUNCH_RANGE) return;
          z.hp -= punchDmg;
          shooterSendTo(id,{type:'hitConfirm'});
          if(z.hp<=0){
            z.alive=false;
            p.balance += z.typeDef.reward; p.zombiesKilled++;
            shooterSendTo(id,{type:'balanceUpdate',balance:p.balance,kills:p.zombiesKilled});
            if(p.sub) dbQuery('UPDATE users SET balance=balance+$1, zombies_killed=COALESCE(zombies_killed,0)+1 WHERE auth_sub=$2',[z.typeDef.reward,p.sub]).catch(()=>{});
            shooterBroadcast({type:'zombieDied',id:z.id,x:z.x,z:z.z,gore:true});
            scheduleZRespawn(z);
          } else {
            shooterBroadcast({type:'zombieHit',id:z.id,hp:z.hp,maxHp:z.maxHp});
          }
        });
        shooterPlayers.forEach(t=>{
          if(t.id===id||!t.alive||Math.hypot(t.x-p.x,t.z-p.z)>PUNCH_RANGE) return;
          let dmg = punchDmg;
          if(t.upgrades.shield>0){const a=Math.min(t.upgrades.shield,dmg);dmg-=a;t.upgrades.shield=Math.max(0,t.upgrades.shield-a);}
          t.hp=Math.max(0,t.hp-dmg); t.lastHitTime=Date.now();
          shooterSendTo(t.id,{type:'selfHit',hp:t.hp,attacker:p.name,shieldHp:t.upgrades.shield});
          shooterBroadcast({type:'playerHp',id:t.id,hp:t.hp});
          shooterSendTo(id,{type:'hitConfirm'});
          if(t.hp<=0) killShooterPlayer(t,p.name);
        });
        break;
      }
      case 'shoot': {
        if(!p.alive||!p.hasGun||p.ammo<=0) break;
        const gun=GUN_DEFS[p.gunType]; if(!gun) break;
        const now2=Date.now(); if(now2-p.lastShot<gun.fireRate) break;
        p.lastShot=now2; p.ammo--;
        shooterSendTo(id,{type:'ammoUpdate',ammo:p.ammo});
        const dmgMult = 1.0 + (p.upgrades.dmg_boost||0) * 0.30;
        const pitch=p.pitch||0;
        const sdx=-Math.sin(p.rotY)*Math.cos(pitch), sdy=-Math.sin(pitch), sdz=-Math.cos(p.rotY)*Math.cos(pitch);
        for(let pel=0;pel<gun.pellets;pel++){
          let dx=sdx,dy=sdy,dz=sdz;
          if(gun.pellets>1){const spread=(Math.random()-0.5)*0.28,c=Math.cos(spread),s=Math.sin(spread);const ndx=dx*c-dz*s;dz=dx*s+dz*c;dx=ndx;}
          let hitZ=null,hitZd=gun.range;
          zombies.forEach(z=>{
            if(!z.alive) return;
            const ex=z.x-p.x,ey=(z.y+1)-p.y,ez=z.z-p.z;
            const dist=Math.sqrt(ex*ex+ey*ey+ez*ez);
            if(dist>hitZd) return;
            if((ex/dist)*dx+(ey/dist)*dy+(ez/dist)*dz<0.82) return;
            if(Math.abs(ex*dz-ez*dx)>2.0) return;
            hitZd=dist; hitZ=z;
          });
          if(hitZ){
            const dmg = Math.round(gun.damage * dmgMult);
            hitZ.hp -= dmg;
            shooterSendTo(id,{type:'hitConfirm'});
            if(hitZ.hp<=0){
              hitZ.alive=false;
              p.balance += hitZ.typeDef.reward; p.zombiesKilled++;
              shooterSendTo(id,{type:'balanceUpdate',balance:p.balance,kills:p.zombiesKilled});
              if(p.sub) dbQuery('UPDATE users SET balance=balance+$1, zombies_killed=COALESCE(zombies_killed,0)+1 WHERE auth_sub=$2',[hitZ.typeDef.reward,p.sub]).catch(()=>{});
              shooterBroadcast({type:'zombieDied',id:hitZ.id,x:hitZ.x,z:hitZ.z,gore:true});
              scheduleZRespawn(hitZ);
            } else {
              shooterBroadcast({type:'zombieHit',id:hitZ.id,hp:hitZ.hp,maxHp:hitZ.maxHp});
            }
            continue;
          }
          let hitP=null,hitPd=gun.range;
          shooterPlayers.forEach(t=>{
            if(t.id===id||!t.alive) return;
            const ex=t.x-p.x,ey=(t.y+1)-p.y,ez=t.z-p.z;
            const dist=Math.sqrt(ex*ex+ey*ey+ez*ez);
            if(dist>hitPd) return;
            if((ex/dist)*dx+(ey/dist)*dy+(ez/dist)*dz<0.82) return;
            if(Math.abs(ex*dz-ez*dx)>1.2) return;
            hitPd=dist; hitP=t;
          });
          if(hitP){
            let dmg = Math.round(gun.damage * dmgMult);
            if(hitP.upgrades.shield>0){const a=Math.min(hitP.upgrades.shield,dmg);dmg-=a;hitP.upgrades.shield=Math.max(0,hitP.upgrades.shield-a);}
            hitP.hp=Math.max(0,hitP.hp-dmg); hitP.lastHitTime=now2;
            shooterSendTo(hitP.id,{type:'selfHit',hp:hitP.hp,attacker:p.name,shieldHp:hitP.upgrades.shield});
            shooterBroadcast({type:'playerHp',id:hitP.id,hp:hitP.hp});
            shooterSendTo(id,{type:'hitConfirm'});
            if(hitP.hp<=0) killShooterPlayer(hitP,p.name);
          }
        }
        shooterBroadcast({type:'gunshot',id,x:p.x,y:p.y,z:p.z,rotY:p.rotY,pitch:p.pitch,gunType:p.gunType});
        break;
      }
      case 'buyUpgrade': {
        const uid = msg.upgradeId;
        const def = UPGRADE_DEFS[uid];
        if (!def) { shooterSendTo(id,{type:'upgradeResult',ok:false,error:'Unknown upgrade'}); break; }
        // Consumables — flat cost, always available
        if (uid === 'ammo_refill') {
          if (p.balance < def.cost) { shooterSendTo(id,{type:'upgradeResult',ok:false,error:'Need $'+def.cost}); break; }
          if (!p.hasGun) { shooterSendTo(id,{type:'upgradeResult',ok:false,error:'No gun equipped'}); break; }
          p.balance -= def.cost;
          p.ammo = GUN_DEFS[p.gunType]?.maxAmmo || 12;
          shooterSendTo(id,{type:'upgradeResult',ok:true,upgradeId:uid,balance:p.balance});
          shooterSendTo(id,{type:'ammoUpdate',ammo:p.ammo,gunType:p.gunType});
          if(p.sub) dbQuery('UPDATE users SET balance=$1 WHERE auth_sub=$2',[p.balance,p.sub]).catch(()=>{});
          break;
        }
        if (uid === 'shield') {
          if (p.balance < def.cost) { shooterSendTo(id,{type:'upgradeResult',ok:false,error:'Need $'+def.cost}); break; }
          p.balance -= def.cost;
          p.upgrades.shield = (p.upgrades.shield||0) + 80;
          shooterSendTo(id,{type:'upgradeResult',ok:true,upgradeId:uid,balance:p.balance,shieldHp:p.upgrades.shield});
          if(p.sub) dbQuery('UPDATE users SET balance=$1 WHERE auth_sub=$2',[p.balance,p.sub]).catch(()=>{});
          break;
        }
        // Leveled upgrades
        const curLevel = p.upgrades[uid]||0;
        if (curLevel >= def.maxLevel) { shooterSendTo(id,{type:'upgradeResult',ok:false,error:'Max level reached'}); break; }
        const levelCost = def.cost * (curLevel + 1);
        if (p.balance < levelCost) { shooterSendTo(id,{type:'upgradeResult',ok:false,error:'Need $'+levelCost}); break; }
        p.balance -= levelCost;
        p.upgrades[uid] = curLevel + 1;
        if (uid === 'extra_hp') p.maxHp = PLAYER_HP + p.upgrades.extra_hp * 50;
        if (uid === 'fast_regen') p.upgrades.fast_regen = true;
        shooterSendTo(id,{type:'upgradeResult',ok:true,upgradeId:uid,level:p.upgrades[uid],balance:p.balance,maxHp:p.maxHp,shieldHp:p.upgrades.shield});
        if(p.sub) dbQuery('UPDATE users SET balance=$1 WHERE auth_sub=$2',[p.balance,p.sub]).catch(()=>{});
        break;
      }
      case 'pickup': {
        if (!p.alive) break;
        let picked=false;
        loots.forEach(l=>{
          if(picked||!l.available) return;
          const dx=l.x-p.x,dz=l.z-p.z;
          if(Math.sqrt(dx*dx+dz*dz)>3.5) return;
          picked=true;
          const oldGun=p.hasGun?p.gunType:null;
          const newGun=l.gunType;
          if(oldGun){ l.gunType=oldGun; l.available=true; shooterBroadcast({type:'lootUpdate',id:l.id,available:true,gunType:l.gunType}); }
          else {
            l.available=false; shooterBroadcast({type:'lootUpdate',id:l.id,available:false,gunType:l.gunType});
            setTimeout(()=>{ if(!l.available){l.available=true;l.gunType=BUILDING_DEFS[l.id]?.gun||'pistol';shooterBroadcast({type:'lootUpdate',id:l.id,available:true,gunType:l.gunType});} },LOOT_RESPAWN_TIME);
          }
          p.hasGun=true; p.gunType=newGun; p.ammo=GUN_DEFS[p.gunType]?.ammo||12;
          shooterSendTo(id,{type:'pickedUpGun',ammo:p.ammo,gunType:p.gunType});
        });
        break;
      }
      case 'drop': {
        if(!p.alive||!p.hasGun) break;
        const dropGun=p.gunType;
        p.hasGun=false; p.gunType=null; p.ammo=0;
        shooterSendTo(id,{type:'dropped'});
        let placed=false;
        loots.forEach(l=>{
          if(placed||l.available) return;
          const dx=l.x-p.x,dz=l.z-p.z;
          if(Math.sqrt(dx*dx+dz*dz)>8) return;
          placed=true; l.gunType=dropGun; l.available=true;
          shooterBroadcast({type:'lootUpdate',id:l.id,available:true,gunType:l.gunType});
        });
        if(!placed){
          const tid=loots.length, lx=p.x+(Math.random()-0.5)*1.5, lz=p.z+(Math.random()-0.5)*1.5;
          const tmp={id:tid,x:lx,z:lz,gunType:dropGun,available:true};
          loots.push(tmp);
          shooterBroadcast({type:'lootSpawn',id:tid,x:lx,z:lz,gunType:dropGun});
          setTimeout(()=>{if(tmp.available){tmp.available=false;shooterBroadcast({type:'lootUpdate',id:tid,available:false});}},LOOT_RESPAWN_TIME);
        }
        break;
      }
      case 'reload': {
        if(!p.alive||!p.hasGun||!p.gunType) break;
        p.ammo=GUN_DEFS[p.gunType]?.maxAmmo||12;
        shooterSendTo(id,{type:'ammoUpdate',ammo:p.ammo,gunType:p.gunType});
        break;
      }
      case 'respawn': {
        if(p.alive) break;
        p.hp=p.maxHp; p.alive=true; p.hasGun=false; p.gunType=null; p.ammo=0;
        p.x=(Math.random()-0.5)*20; p.z=(Math.random()-0.5)*20;
        shooterSendTo(id,{type:'respawned',x:p.x,z:p.z,balance:p.balance,kills:p.zombiesKilled,maxHp:p.maxHp,shieldHp:p.upgrades.shield});
        shooterBroadcast({type:'playerRespawn',id,x:p.x,z:p.z,hp:p.hp});
        break;
      }
    }
  });

  ws.on('close', ()=>{
    shooterPlayers.delete(id); shooterSockets.delete(id);
    shooterBroadcast({type:'playerLeave',id,name:p.name});
    console.log(`[-] Shooter player ${id} disconnected. Online: ${shooterPlayers.size}`);
  });
  ws.on('error', e=>console.error('[WS]',e.message));
});

setInterval(()=>{ wss.clients.forEach(c=>{ if(c.readyState===WebSocket.OPEN) c.ping(); }); },30000);

// ══════════════════════════════════════════════
//  CARD GAMES — socket.io (durak + poker)
//  Full engine from server2.js follows below
// ══════════════════════════════════════════════

const RANKS=['6','7','8','9','10','J','Q','K','A'];
const SUITS=['♠','♥','♦','♣'];
function rankVal(r){return RANKS.indexOf(r);}
function buildDeck(){const d=[];for(const s of SUITS)for(const r of RANKS)d.push({r,s});return d;}
function shuffle(arr){for(let i=arr.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];}return arr;}
function beats(a,d,trump){if(a.s===d.s)return rankVal(d.r)>rankVal(a.r);if(d.s===trump&&a.s!==trump)return true;return false;}
const rooms=new Map();
function makeRoomId(){return Math.random().toString(36).slice(2,8).toUpperCase();}
function publicRoom(r){return{id:r.id,name:r.name,hostName:r.hostName,bet:r.bet,maxPlayers:r.maxPlayers,playerCount:r.players.filter(p=>!p.isBot).length,botCount:r.players.filter(p=>p.isBot).length,totalPlayers:r.players.length,status:r.status,hasPassword:!!r.password};}
function createRoom({id,hostSub,hostName,name,bet,maxPlayers=4,password=''}){return{id,name,hostSub,hostName,bet,maxPlayers,password,status:'waiting',players:[],game:null};}
function addPlayer(room,{sub,name,socketId,isBot=false,difficulty='medium'}){room.players.push({sub,name,socketId,isBot,difficulty,ready:false});}
function botMove(difficulty,hand,table,trump,role){if(difficulty==='easy'){const v=validMoves(hand,table,trump,role);if(!v.length)return null;return v[Math.floor(Math.random()*v.length)];}if(difficulty==='cheater'){return optimalMove(hand,table,trump,role);}const v=validMoves(hand,table,trump,role);if(!v.length)return null;if(role==='defend')return v.sort((a,b)=>{const av=rankVal(a.r)+(a.s===trump?13:0),bv=rankVal(b.r)+(b.s===trump?13:0);return av-bv;})[0];if(role==='attack'||role==='pile-on'){if(difficulty==='hard'){const nt=v.filter(c=>c.s!==trump);return(nt.length?nt:v).sort((a,b)=>rankVal(a.r)-rankVal(b.r))[0];}return v[Math.floor(Math.random()*v.length)];}return v[0]||null;}
function validMoves(hand,table,trump,role){if(role==='attack'){if(!table.length)return[...hand];const ranks=new Set(table.flatMap(p=>[p.attack?.r,p.defense?.r].filter(Boolean)));return hand.filter(c=>ranks.has(c.r));}if(role==='pile-on'){if(!table.length)return[];const ranks=new Set(table.flatMap(p=>[p.attack?.r,p.defense?.r].filter(Boolean)));return hand.filter(c=>ranks.has(c.r));}if(role==='defend'){const u=table.filter(p=>!p.defense);if(!u.length)return[];const att=u[0].attack;return hand.filter(c=>beats(att,c,trump));}return[];}
function optimalMove(hand,table,trump,role){const v=validMoves(hand,table,trump,role);if(!v.length)return null;return v.sort((a,b)=>{const score=c=>rankVal(c.r)+(c.s===trump?9:0);return score(a)-score(b);})[0];}
function startDurakGame(room){const deck=shuffle(buildDeck());const trump=deck[deck.length-1].s;const hands={};for(const p of room.players)hands[p.sub]=deck.splice(0,6);room.game={deck,trump,trumpCard:deck[deck.length-1],hands,table:[],attackerIdx:0,defenderIdx:1%room.players.length,phase:'attack',finishOrder:[],loser:null,preTakeToken:0,passCount:0,turnCount:0,winner:null};room.status='playing';}
function gameState(room,forSub){const g=room.game;if(!g)return null;const players=room.players.map(p=>({sub:p.sub,name:p.name,isBot:p.isBot,cardCount:g.hands[p.sub]?.length??0,cards:p.sub===forSub?(g.hands[p.sub]||[]):undefined}));return{trump:g.trump,trumpCard:g.deck.length>0?g.trumpCard:null,deckCount:g.deck.length,table:g.table,attackerIdx:g.attackerIdx,defenderIdx:g.defenderIdx,phase:g.phase,players,myCards:g.hands[forSub]||[],winner:g.winner,finishOrder:g.finishOrder||[]};}
function refillHands(room){const g=room.game;const order=[];const n=room.players.length;for(let i=0;i<n;i++){const idx=(g.attackerIdx+i)%n;if(idx!==g.defenderIdx)order.push(idx);}order.push(g.defenderIdx);for(const idx of order){const p=room.players[idx];const hand=g.hands[p.sub];while(hand.length<6&&g.deck.length>0)hand.push(g.deck.shift());}}
function checkGameOver(room){const g=room.game;if(g.deck.length>0)return false;const stillIn=room.players.filter(p=>(g.hands[p.sub]?.length??0)>0);if(stillIn.length<=1){g.phase='done';g.loser=stillIn.length===1?stillIn[0].sub:null;return true;}return false;}
function advancePastFinished(room){const g=room.game;if(g.deck.length>0||g.phase==='done')return;const n=room.players.length;for(const p of room.players)if(!g.finishOrder.includes(p.sub)&&(g.hands[p.sub]?.length??0)===0)g.finishOrder.push(p.sub);let safety=0;while(safety++<n&&(g.hands[room.players[g.attackerIdx].sub]?.length??0)===0)g.attackerIdx=(g.attackerIdx+1)%n;safety=0;g.defenderIdx=(g.attackerIdx+1)%n;while(safety++<n&&(g.hands[room.players[g.defenderIdx].sub]?.length??0)===0)g.defenderIdx=(g.defenderIdx+1)%n;}
function broadcastGameState(room){for(const p of room.players){if(p.isBot)continue;const s=io.sockets.sockets.get(p.socketId);if(s)s.emit('game:state',gameState(room,p.sub));}}
function roomSnapshot(room){return{...publicRoom(room),players:room.players.map(p=>({sub:p.sub,name:p.name,isBot:p.isBot,difficulty:p.difficulty})),hostSub:room.hostSub};}
function executeTake(room){const g=room.game;const defender=room.players[g.defenderIdx];const allCards=g.table.flatMap(p=>[p.attack,p.defense].filter(Boolean));g.hands[defender.sub].push(...allCards);g.table=[];const n=room.players.length;const na=(g.defenderIdx+1)%n;g.attackerIdx=na;g.defenderIdx=(na+1)%n;g.phase='attack';refillHands(room);advancePastFinished(room);if(!checkGameOver(room)){broadcastGameState(room);setTimeout(()=>processBotTurns(room),4500);}else{endGame(room);}}
function leaveRoom(socket){const roomId=socket.data.roomId;if(!roomId)return;const room=rooms.get(roomId);if(!room)return;socket.leave(roomId);socket.data.roomId=null;if(room.status==='playing'){const p=room.players.find(pp=>pp.sub===socket.data.sub);if(p){p.isBot=true;p.difficulty='medium';p.socketId=null;}broadcastGameState(room);return;}room.players=room.players.filter(p=>p.sub!==socket.data.sub);if(room.players.length===0){rooms.delete(roomId);io.emit('rooms:updated');return;}if(room.hostSub===socket.data.sub){const nh=room.players.find(p=>!p.isBot);if(nh){room.hostSub=nh.sub;room.hostName=nh.name;}else{rooms.delete(roomId);io.emit('rooms:updated');return;}}io.to(roomId).emit('room:state',roomSnapshot(room));io.emit('rooms:updated');}
async function endGame(room){const g=room.game;g.phase='done';const loserSub=g.loser;const allPlayers=room.players;const humanPlayers=allPlayers.filter(p=>!p.isBot);const finishOrder=[...(g.finishOrder||[])];for(const p of allPlayers)if(p.sub!==loserSub&&!finishOrder.includes(p.sub)&&(g.hands[p.sub]?.length??0)===0)finishOrder.push(p.sub);const orderedWinners=finishOrder.filter(s=>allPlayers.some(p=>p.sub===s));const nTotal=allPlayers.length;const totalPot=room.bet*nTotal;const RATIOS={2:[1.00],3:[0.70,0.30],4:[0.50,0.30,0.20]};const ratios=RATIOS[nTotal]||orderedWinners.map(()=>1/orderedWinners.length);const payouts={};const dbCredits={};if(loserSub)payouts[loserSub]=-room.bet;for(let i=0;i<orderedWinners.length;i++){const s=orderedWinners[i];const ratio=ratios[i]??0;const payout=Math.floor(totalPot*ratio);const isHuman=humanPlayers.some(p=>p.sub===s);payouts[s]=isHuman?payout-room.bet:0;if(isHuman)dbCredits[s]=payout;}const medals=['🥇','🥈','🥉','4th'];const rankings=[...orderedWinners.map((s,i)=>({sub:s,name:allPlayers.find(p=>p.sub===s)?.name||'?',place:i+1,delta:payouts[s]??0,isBot:allPlayers.find(p=>p.sub===s)?.isBot||false})),... (loserSub&&!orderedWinners.includes(loserSub)?[{sub:loserSub,name:allPlayers.find(p=>p.sub===loserSub)?.name||'Durak',place:orderedWinners.length+1,delta:-room.bet,isBot:allPlayers.find(p=>p.sub===loserSub)?.isBot||false}]:[])];try{for(const[s,credit]of Object.entries(dbCredits))await dbQuery('UPDATE users SET balance=balance+$1 WHERE auth_sub=$2',[credit,s]).catch(()=>{});await dbQuery('INSERT INTO durak_history(room_id,winner_sub,bet,players) VALUES($1,$2,$3,$4)',[room.id,orderedWinners.find(s=>humanPlayers.some(p=>p.sub===s))||null,room.bet,JSON.stringify(allPlayers.map(p=>({sub:p.sub,name:p.name,isBot:p.isBot})))]).catch(()=>{});}catch(e){}room.status='finished';for(const p of allPlayers){if(p.isBot)continue;const sock=io.sockets.sockets.get(p.socketId);if(sock)sock.emit('game:over',{loserSub,winners:orderedWinners,pot:totalPot,bet:room.bet,rankings,gameState:gameState(room,p.sub)});}setTimeout(()=>rooms.delete(room.id),30000);io.emit('rooms:updated');}
function processBotTurns(room){if(!room?.game||room.game.phase==='done')return;const g=room.game;// Handle pre-take phase: bot attacker may pile on then execute take
if(g.phase==='pre-take'){const attacker=room.players[g.attackerIdx];if(!attacker?.isBot)return;const hand=g.hands[attacker.sub];const ranks=new Set(g.table.flatMap(p=>[p.attack?.r,p.defense?.r].filter(Boolean)));const pileCard=hand.find(c=>ranks.has(c.r));if(pileCard){const idx=hand.indexOf(pileCard);hand.splice(idx,1);g.table.push({attack:pileCard,defense:null});broadcastGameState(room);setTimeout(()=>processBotTurns(room),2000);}else{g.preTakeToken=(g.preTakeToken||0)+1;executeTake(room);}return;}const currentIdx=g.phase==='defend'?g.defenderIdx:g.attackerIdx;const currentBot=room.players[currentIdx];if(!currentBot?.isBot)return;const hand=g.hands[currentBot.sub];const role=g.phase==='defend'?'defend':(g.table.length===0?'attack':'attack-more');if(role==='attack'||role==='attack-more'){const defender=room.players[g.defenderIdx];const defHandSize=g.hands[defender.sub]?.length??0;const undefended=g.table.filter(p=>!p.defense).length;if(undefended>=defHandSize){if(g.table.length>0){g.table=[];const n=room.players.length;g.attackerIdx=g.defenderIdx;g.defenderIdx=(g.defenderIdx+1)%n;g.phase='attack';refillHands(room);advancePastFinished(room);if(checkGameOver(room)){endGame(room);return;}broadcastGameState(room);setTimeout(()=>processBotTurns(room),4500);}return;}const moveRole=role==='attack'?'attack':'pile-on';const card=botMove(currentBot.difficulty,hand,g.table,g.trump,moveRole);if(!card){if(g.table.length>0){g.table=[];const n=room.players.length;g.attackerIdx=g.defenderIdx;g.defenderIdx=(g.defenderIdx+1)%n;g.phase='attack';refillHands(room);advancePastFinished(room);if(checkGameOver(room)){endGame(room);return;}broadcastGameState(room);setTimeout(()=>processBotTurns(room),4500);}return;}const idx=hand.findIndex(c=>c.r===card.r&&c.s===card.s);if(idx===-1)return;hand.splice(idx,1);g.table.push({attack:card,defense:null});g.phase='defend';broadcastGameState(room);setTimeout(()=>processBotTurns(room),5000);return;}if(role==='defend'){const card=botMove(currentBot.difficulty,hand,g.table,g.trump,'defend');if(!card){const allCards=g.table.flatMap(p=>[p.attack,p.defense].filter(Boolean));g.hands[currentBot.sub].push(...allCards);g.table=[];const n=room.players.length;const na=(g.defenderIdx+1)%n;g.attackerIdx=na;g.defenderIdx=(na+1)%n;g.phase='attack';refillHands(room);advancePastFinished(room);if(checkGameOver(room)){endGame(room);return;}broadcastGameState(room);setTimeout(()=>processBotTurns(room),4500);return;}const idx=hand.findIndex(c=>c.r===card.r&&c.s===card.s);if(idx===-1)return;hand.splice(idx,1);const pair=g.table.find(p=>!p.defense);if(pair)pair.defense=card;const allDefended=g.table.every(p=>p.defense);if(allDefended){g.phase='attack';broadcastGameState(room);setTimeout(()=>processBotTurns(room),4500);}else{broadcastGameState(room);setTimeout(()=>processBotTurns(room),5000);}return;}}

// ── Poker engine (copy from server2.js) ───────
const POKER_RANKS=['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
function pVal(r){return POKER_RANKS.indexOf(r);}
function buildPokerDeck(){const d=[];for(const s of SUITS)for(const r of POKER_RANKS)d.push({r,s});return d;}
function combos5(arr){const out=[];const n=arr.length;for(let a=0;a<n-4;a++)for(let b=a+1;b<n-3;b++)for(let c=b+1;c<n-2;c++)for(let d=c+1;d<n-1;d++)for(let e=d+1;e<n;e++)out.push([arr[a],arr[b],arr[c],arr[d],arr[e]]);return out;}
function evalFive(cards){const vs=cards.map(c=>pVal(c.r)).sort((a,b)=>b-a);const ss=cards.map(c=>c.s);const fl=ss.every(s=>s===ss[0]);let st=false,sh=0;if([...new Set(vs)].length===5){if(vs[0]-vs[4]===4){st=true;sh=vs[0];}if(vs[0]===12&&vs[1]===3&&vs[2]===2&&vs[3]===1&&vs[4]===0){st=true;sh=3;}}const cnt={};for(const v of vs)cnt[v]=(cnt[v]||0)+1;const gr=Object.entries(cnt).map(([v,c])=>({v:+v,c})).sort((a,b)=>b.c-a.c||b.v-a.v);const[g1,g2]=gr;const w=cards.map(c=>({...c}));if(fl&&st)return{rank:vs[0]===12&&sh===12?9:8,name:vs[0]===12&&sh===12?'Royal Flush':'Straight Flush',tb:[sh],win:w};if(g1.c===4)return{rank:7,name:'Four of a Kind',tb:[g1.v,g2?.v??0],win:w.filter(c=>pVal(c.r)===g1.v)};if(g1.c===3&&g2?.c===2)return{rank:6,name:'Full House',tb:[g1.v,g2.v],win:w};if(fl)return{rank:5,name:'Flush',tb:vs,win:w};if(st)return{rank:4,name:'Straight',tb:[sh],win:w};if(g1.c===3)return{rank:3,name:'Three of a Kind',tb:[g1.v,...vs.filter(v=>v!==g1.v)],win:w.filter(c=>pVal(c.r)===g1.v)};if(g1.c===2&&g2?.c===2){const hi=Math.max(g1.v,g2.v),lo=Math.min(g1.v,g2.v);return{rank:2,name:'Two Pair',tb:[hi,lo,...vs.filter(v=>v!==g1.v&&v!==g2.v)],win:w.filter(c=>pVal(c.r)===g1.v||pVal(c.r)===g2.v)};}if(g1.c===2)return{rank:1,name:'One Pair',tb:[g1.v,...vs.filter(v=>v!==g1.v)],win:w.filter(c=>pVal(c.r)===g1.v)};return{rank:0,name:'High Card',tb:vs,win:[w[0]]};}
function bestPokerHand(hole,comm){const all=[...hole,...comm];if(all.length<5)return{rank:-1,name:'—',tb:[],win:[]};return combos5(all).reduce((best,c)=>{const ev=evalFive(c);return!best||cmpH(ev,best)>0?ev:best;},null);}
function cmpH(a,b){if(a.rank!==b.rank)return a.rank-b.rank;for(let i=0;i<Math.max(a.tb.length,b.tb.length);i++){const av=a.tb[i]??-1,bv=b.tb[i]??-1;if(av!==bv)return av-bv;}return 0;}
const pokerRooms=new Map();
function makePokerId(){return'P'+Math.random().toString(36).slice(2,7).toUpperCase();}
function createPokerRoom({id,hostSub,hostName,name,bet,maxPlayers=6,password='',tvMode=false}){return{id,name,hostSub,hostName,bet:Math.max(10,+bet),maxPlayers:Math.min(6,+maxPlayers||6),password,tvMode,hostSocketId:null,status:'waiting',players:[],game:null};}
function pubPokerRoom(r){return{id:r.id,name:r.name,hostName:r.hostName,bet:r.bet,maxPlayers:r.maxPlayers,playerCount:r.players.filter(p=>!p.isBot).length,botCount:r.players.filter(p=>p.isBot).length,totalPlayers:r.players.length,status:r.status,hasPassword:!!r.password,tvMode:r.tvMode};}
function pokerRoomSnap(r){return{id:r.id,name:r.name,hostSub:r.hostSub,hostName:r.hostName,bet:r.bet,maxPlayers:r.maxPlayers,status:r.status,tvMode:r.tvMode,players:r.players.map(p=>({sub:p.sub,name:p.name,isBot:p.isBot,chips:r.game?r.game.chips[p.sub]??0:r.bet}))};}
function pokerStateFor(room,forSub){const g=room.game;if(!g)return null;const isTv=forSub===null;const showAllHands=isTv||g.phase==='showdown';return{phase:g.phase,community:g.community,pot:g.pot,currentBet:g.currentBet,bets:{...g.bets},chips:{...g.chips},folded:[...g.folded],allIn:[...g.allIn],toAct:g.toAct.slice(),dealerIdx:g.dealerIdx,sbIdx:g.sbIdx,bbIdx:g.bbIdx,bigBlind:g.bigBlind,smallBlind:g.smallBlind,handNum:g.handNum,players:room.players.map(p=>({sub:p.sub,name:p.name,isBot:p.isBot,chips:g.chips[p.sub]??0})),myHand:isTv?[]:g.hands[forSub]||[],allHands:showAllHands?g.hands:null,handNames:showAllHands?Object.fromEntries(Object.entries(g.hands).map(([s,h])=>[s,bestPokerHand(h,g.community)])):null,winners:g.winners||null,isTv,tvRoom:room.tvMode};}
function broadcastPokerState(room){for(const p of room.players){if(p.isBot)continue;const s=io.sockets.sockets.get(p.socketId);if(s)s.emit('poker:state',pokerStateFor(room,p.sub));}if(room.tvMode&&room.hostSocketId){const hs=io.sockets.sockets.get(room.hostSocketId);if(hs)hs.emit('poker:state',pokerStateFor(room,null));}}
function initPokerGame(room){const bigBlind=Math.max(1,Math.floor(room.bet/50));room.game={phase:'waiting',community:[],pot:0,bets:{},chips:{},folded:new Set(),allIn:new Set(),currentBet:0,toAct:[],dealerIdx:-1,sbIdx:0,bbIdx:0,bigBlind,smallBlind:Math.max(1,Math.floor(bigBlind/2)),hands:{},winners:null,handNum:0,deck:[],activePlayers:[],lastRaiser:null};for(const p of room.players)room.game.chips[p.sub]=room.bet;}
function startPokerHand(room){const g=room.game;const alive=room.players.filter(p=>(g.chips[p.sub]??0)>0);if(alive.length<2){endPokerGame(room);return;}g.dealerIdx=(g.dealerIdx+1)%alive.length;g.handNum++;const n=alive.length,sbIdx=(g.dealerIdx+1)%n,bbIdx=(g.dealerIdx+2)%n;const sb=alive[sbIdx],bb=alive[bbIdx];g.community=[];g.bets={};g.folded=new Set();g.allIn=new Set();g.pot=0;g.hands={};g.winners=null;g.lastRaiser=null;g.activePlayers=alive.map(p=>p.sub);for(const p of alive)g.bets[p.sub]=0;g.currentBet=g.bigBlind;g.phase='preflop';g.deck=shuffle(buildPokerDeck());for(const p of alive)g.hands[p.sub]=[g.deck.shift(),g.deck.shift()];const sbAmt=Math.min(g.smallBlind,g.chips[sb.sub]);const bbAmt=Math.min(g.bigBlind,g.chips[bb.sub]);g.chips[sb.sub]-=sbAmt;g.bets[sb.sub]=sbAmt;g.pot+=sbAmt;if(g.chips[sb.sub]===0)g.allIn.add(sb.sub);g.chips[bb.sub]-=bbAmt;g.bets[bb.sub]=bbAmt;g.pot+=bbAmt;if(g.chips[bb.sub]===0)g.allIn.add(bb.sub);g.currentBet=bbAmt;g.sbIdx=sbIdx;g.bbIdx=bbIdx;g.toAct=[];for(let i=0;i<n;i++){const p=alive[(bbIdx+1+i)%n];if(!g.allIn.has(p.sub))g.toAct.push(p.sub);}broadcastPokerState(room);setTimeout(()=>processPokerBots(room),1500);}
function pokerAct(room,sub,action,amount){const g=room.game;if(!g||!['preflop','flop','turn','river'].includes(g.phase))return false;if(g.toAct[0]!==sub)return false;const toCall=Math.max(0,(g.currentBet||0)-(g.bets[sub]||0));const chips=g.chips[sub]||0;if(action==='fold'){g.folded.add(sub);g.toAct.shift();}else if(action==='check'){if(toCall>0)return false;g.toAct.shift();}else if(action==='call'){const amt=Math.min(toCall,chips);g.chips[sub]-=amt;g.bets[sub]=(g.bets[sub]||0)+amt;g.pot+=amt;if(g.chips[sub]===0)g.allIn.add(sub);g.toAct.shift();}else if(action==='raise'){const minTotal=g.currentBet*2;const raiseTotal=Math.max(minTotal,Math.min(+amount,(g.bets[sub]||0)+chips));const addedChips=raiseTotal-(g.bets[sub]||0);if(addedChips<=0||addedChips>chips)return false;g.chips[sub]-=addedChips;g.pot+=addedChips;g.bets[sub]=raiseTotal;g.currentBet=raiseTotal;g.lastRaiser=sub;if(g.chips[sub]===0)g.allIn.add(sub);const others=g.activePlayers.filter(s=>!g.folded.has(s)&&!g.allIn.has(s)&&s!==sub);g.toAct=g.toAct.slice(1);for(const s of others)if(!g.toAct.includes(s))g.toAct.push(s);}else if(action==='allin'){const amt=chips;g.chips[sub]=0;const total=(g.bets[sub]||0)+amt;g.bets[sub]=total;g.pot+=amt;if(total>g.currentBet){g.currentBet=total;g.lastRaiser=sub;const others=g.activePlayers.filter(s=>!g.folded.has(s)&&!g.allIn.has(s)&&s!==sub);g.toAct=g.toAct.slice(1);for(const s of others)if(!g.toAct.includes(s))g.toAct.push(s);}else{g.toAct.shift();}g.allIn.add(sub);}else return false;while(g.toAct.length>0&&(g.folded.has(g.toAct[0])||g.allIn.has(g.toAct[0])))g.toAct.shift();const active=g.activePlayers.filter(s=>!g.folded.has(s));if(active.length<=1){collectPokerBets(room);doPokerShowdown(room);return true;}if(g.toAct.length===0){collectPokerBets(room);advancePokerPhase(room);return true;}broadcastPokerState(room);setTimeout(()=>processPokerBots(room),800);return true;}
function collectPokerBets(room){const g=room.game;for(const sub of Object.keys(g.bets)){g.bets[sub]=0;}g.currentBet=0;g.lastRaiser=null;}
function advancePokerPhase(room){const g=room.game;const active=g.activePlayers.filter(s=>!g.folded.has(s));if(active.length<=1||g.phase==='river'){doPokerShowdown(room);return;}if(g.phase==='preflop'){g.phase='flop';g.community=[g.deck.shift(),g.deck.shift(),g.deck.shift()];}else if(g.phase==='flop'){g.phase='turn';g.community.push(g.deck.shift());}else if(g.phase==='turn'){g.phase='river';g.community.push(g.deck.shift());}for(const s of active)g.bets[s]=0;g.currentBet=0;g.toAct=[];for(let i=1;i<=room.players.length;i++){const p=room.players[(g.dealerIdx+i)%room.players.length];if(active.includes(p.sub)&&!g.allIn.has(p.sub))g.toAct.push(p.sub);}if(g.toAct.length===0){doPokerShowdown(room);return;}broadcastPokerState(room);setTimeout(()=>processPokerBots(room),1000);}
function doPokerShowdown(room){const g=room.game;g.phase='showdown';const active=g.activePlayers.filter(s=>!g.folded.has(s));let winners;if(active.length===1){g.chips[active[0]]=(g.chips[active[0]]||0)+g.pot;winners=[{sub:active[0],amount:g.pot,handName:'Winner'}];}else{const evaled=active.map(s=>({sub:s,ev:bestPokerHand(g.hands[s]||[],g.community)})).sort((a,b)=>cmpH(b.ev,a.ev));const bestEv=evaled[0].ev;const tied=evaled.filter(p=>cmpH(p.ev,bestEv)===0);const share=Math.floor(g.pot/tied.length);winners=tied.map(p=>{g.chips[p.sub]=(g.chips[p.sub]||0)+share;return{sub:p.sub,amount:share,handName:p.ev.name,winCards:p.ev.win};});const rem=g.pot-share*tied.length;if(rem>0)g.chips[tied[0].sub]+=rem;}g.winners=winners;broadcastPokerState(room);setTimeout(()=>{if(!room.game)return;const stillAlive=room.players.filter(p=>(room.game.chips[p.sub]??0)>0);if(stillAlive.length>=2)startPokerHand(room);else endPokerGame(room);},5000);}
function endPokerGame(room){room.status='waiting';const g=room.game;for(const p of room.players){if(!p.isBot&&(g?.chips[p.sub]||0)>0)dbQuery('UPDATE users SET balance=balance+$1 WHERE auth_sub=$2',[g.chips[p.sub],p.sub]).catch(()=>{});}room.game=null;io.to('poker:'+room.id).emit('poker:room:state',pokerRoomSnap(room));io.to('poker:'+room.id).emit('poker:game:over',{});io.emit('poker:rooms:updated');}
function pokerBotMove(room,botSub){const g=room.game;if(!g)return;const hand=g.hands[botSub]||[];const toCall=Math.max(0,(g.currentBet||0)-(g.bets[botSub]||0));const chips=g.chips[botSub]||0;let strength=0;if(g.phase==='preflop'&&hand.length===2){const[c1,c2]=hand;const v1=pVal(c1.r),v2=pVal(c2.r),suited=c1.s===c2.s,pair=v1===v2;const hi=Math.max(v1,v2),lo=Math.min(v1,v2);if(pair&&hi>=10)strength=9;else if(pair&&hi>=7)strength=7;else if(pair)strength=5;else if(hi===12&&lo>=9)strength=9;else if(hi===12&&suited)strength=7;else if(hi===12)strength=5;else if(hi>=10&&lo>=8&&suited)strength=6;else if(Math.abs(hi-lo)<=1&&suited)strength=5;else if(hi>=10&&lo>=8)strength=4;else strength=Math.max(1,hi-7);}else{const ev=bestPokerHand(hand,g.community);strength=Math.min(10,ev.rank*1.4);}const callRatio=chips>0?toCall/chips:1;if(toCall===0){if(strength>=6){const bet=Math.min(chips,Math.floor(g.pot*0.6||g.bigBlind*2));if(bet>0)pokerAct(room,botSub,'raise',(g.bets[botSub]||0)+bet);else pokerAct(room,botSub,'check',0);}else pokerAct(room,botSub,'check',0);}else{if(strength>=8||chips<=toCall){if(strength>=9&&chips>toCall*2)pokerAct(room,botSub,'raise',(g.bets[botSub]||0)+Math.min(chips,toCall*2+Math.floor(g.pot*0.3)));else pokerAct(room,botSub,'call',0);}else if(strength>=5&&callRatio<0.3)pokerAct(room,botSub,'call',0);else pokerAct(room,botSub,'fold',0);}}
function processPokerBots(room){const g=room.game;if(!g||!['preflop','flop','turn','river'].includes(g.phase)||!g.toAct.length)return;const actSub=g.toAct[0];const bot=room.players.find(p=>p.sub===actSub);if(!bot?.isBot)return;setTimeout(()=>{if(room.game&&room.game.toAct[0]===actSub)pokerBotMove(room,actSub);},1000+Math.random()*1000);}
async function leavePokerRoom(socket){const roomId=socket.data.pokerRoomId;if(!roomId)return;const room=pokerRooms.get(roomId);if(!room)return;socket.leave('poker:'+roomId);socket.data.pokerRoomId=null;const sub=socket.data.sub;if(room.status==='playing'&&room.game){const chips=room.game.chips[sub]||0;if(chips>0)await dbQuery('UPDATE users SET balance=balance+$1 WHERE auth_sub=$2',[chips,sub]).catch(()=>{});room.game.folded.add(sub);room.game.activePlayers=room.game.activePlayers.filter(s=>s!==sub);room.players=room.players.filter(p=>p.sub!==sub);if(room.players.filter(p=>!p.isBot).length===0){pokerRooms.delete(roomId);return;}broadcastPokerState(room);return;}if(!room.players.find(p=>p.sub===sub)?.isBot)await dbQuery('UPDATE users SET balance=balance+$1 WHERE auth_sub=$2',[room.bet,sub]).catch(()=>{});room.players=room.players.filter(p=>p.sub!==sub);if(room.hostSub===sub&&room.tvMode){pokerRooms.delete(roomId);io.to('poker:'+roomId).emit('poker:room:kicked');io.emit('poker:rooms:updated');return;}if(room.players.length===0){pokerRooms.delete(roomId);io.emit('poker:rooms:updated');return;}if(room.hostSub===sub){const newHost=room.players.find(p=>!p.isBot);if(newHost){room.hostSub=newHost.sub;room.hostName=newHost.name;}else{pokerRooms.delete(roomId);io.emit('poker:rooms:updated');return;}}io.to('poker:'+roomId).emit('poker:room:state',pokerRoomSnap(room));io.emit('poker:rooms:updated');}

// ── Socket.io middleware + handlers ───────────
io.use((socket,next)=>{
  try{const token=socket.handshake.auth?.token;if(!token)return next(new Error('No token'));const payload=verifyToken(token);socket.data.sub=payload.sub;socket.data.name=(payload.name||'Player').slice(0,40);next();}catch(e){next(new Error('Auth failed: '+e.message));}
});

io.on('connection', async socket => {
  const{sub,name}=socket.data;
  console.log('Socket connected:',name);
  try{await ensureUser(sub,name);}catch(e){}

  socket.on('rooms:list',(cb)=>{const list=[...rooms.values()].filter(r=>r.status==='waiting').map(publicRoom);cb({rooms:list});});
  socket.on('room:create',async({name:rName,bet,maxPlayers,password},cb)=>{try{const bal=await getBalance(sub);if(bet<10)return cb({error:'Minimum bet is $10'});if(bet>bal)return cb({error:'Insufficient balance'});const id=makeRoomId();const room=createRoom({id,hostSub:sub,hostName:name,name:rName||`${name}'s Room`,bet,maxPlayers:Math.min(maxPlayers||4,4),password});addPlayer(room,{sub,name,socketId:socket.id});rooms.set(id,room);socket.data.roomId=id;socket.join(id);cb({ok:true,room:publicRoom(room),roomId:id});io.emit('rooms:updated');}catch(e){cb({error:e.message});}});
  socket.on('room:join',async({roomId,password},cb)=>{try{const room=rooms.get(roomId);if(!room)return cb({error:'Room not found'});if(room.status!=='waiting')return cb({error:'Game already started'});if(room.players.length>=room.maxPlayers)return cb({error:'Room full'});if(room.password&&room.password!==password)return cb({error:'Wrong password'});const bal=await getBalance(sub);if(room.bet>bal)return cb({error:'Insufficient balance'});if(room.players.find(p=>p.sub===sub))return cb({error:'Already in room'});addPlayer(room,{sub,name,socketId:socket.id});socket.data.roomId=roomId;socket.join(roomId);io.to(roomId).emit('room:state',roomSnapshot(room));cb({ok:true});io.emit('rooms:updated');}catch(e){cb({error:e.message});}});
  socket.on('room:addBot',({difficulty},cb)=>{const room=rooms.get(socket.data.roomId);if(!room)return cb?.({error:'Not in a room'});if(room.hostSub!==sub)return cb?.({error:'Only host can add bots'});if(room.players.length>=room.maxPlayers)return cb?.({error:'Room full'});const allBotNames=['Ivan','Masha','Dmitri','Olga','Boris','Natasha','Kolya','Sasha','Vanya','Lena','Petya','Katya'];const usedNames=new Set(room.players.map(p=>p.name.replace(' (Bot)','')));const available=allBotNames.filter(n=>!usedNames.has(n));const baseName=available.length?available[Math.floor(Math.random()*available.length)]:'Bot'+(room.players.length+1);const botName=baseName+' (Bot)';const botSub='bot:'+Math.random().toString(36).slice(2);addPlayer(room,{sub:botSub,name:botName,socketId:null,isBot:true,difficulty});io.to(room.id).emit('room:state',roomSnapshot(room));cb?.({ok:true});});
  socket.on('room:removeBot',({botSub},cb)=>{const room=rooms.get(socket.data.roomId);if(!room||room.hostSub!==sub)return cb?.({error:'Not allowed'});room.players=room.players.filter(p=>p.sub!==botSub);io.to(room.id).emit('room:state',roomSnapshot(room));cb?.({ok:true});});
  socket.on('room:leave',(cb)=>{leaveRoom(socket);cb?.({ok:true});});
  socket.on('room:kick',({targetSub},cb)=>{const room=rooms.get(socket.data.roomId);if(!room||room.hostSub!==sub)return cb?.({error:'Not allowed'});const target=room.players.find(p=>p.sub===targetSub);if(target?.socketId){const ts=io.sockets.sockets.get(target.socketId);if(ts){ts.data.roomId=null;ts.leave(room.id);ts.emit('room:kicked');}}room.players=room.players.filter(p=>p.sub!==targetSub);io.to(room.id).emit('room:state',roomSnapshot(room));cb?.({ok:true});});
  socket.on('room:start',async(cb)=>{const room=rooms.get(socket.data.roomId);if(!room)return cb?.({error:'Not in a room'});if(room.hostSub!==sub)return cb?.({error:'Only host can start'});if(room.players.length<2)return cb?.({error:'Need at least 2 players'});try{for(const p of room.players.filter(p=>!p.isBot)){const bal=await getBalance(p.sub);if(bal<room.bet)return cb?.({error:`${p.name} has insufficient balance`});await dbQuery('UPDATE users SET balance=balance-$1 WHERE auth_sub=$2',[room.bet,p.sub]).catch(()=>{});}}catch(e){return cb?.({error:'Balance error'});}startDurakGame(room);for(const p of room.players){if(p.isBot)continue;const s=io.sockets.sockets.get(p.socketId);if(s)s.emit('game:started',gameState(room,p.sub));}cb?.({ok:true});io.emit('rooms:updated');setTimeout(()=>processBotTurns(room),5000);});
  socket.on('game:attack',({card},cb)=>{const room=rooms.get(socket.data.roomId);if(!room?.game)return cb?.({error:'No game'});if(!card?.r||!card?.s)return cb?.({error:'Invalid card'});const g=room.game;if(g.phase!=='attack')return cb?.({error:'Not attack phase'});const attacker=room.players[g.attackerIdx];if(attacker.sub!==sub)return cb?.({error:'Not your turn to attack'});const hand=g.hands[sub];const cardIdx=hand.findIndex(c=>c.r===card.r&&c.s===card.s);if(cardIdx===-1)return cb?.({error:'Card not in hand'});if(g.table.length>0){const ranks=new Set(g.table.flatMap(p=>[p.attack?.r,p.defense?.r].filter(Boolean)));if(!ranks.has(card.r))return cb?.({error:'Rank not on table'});}const defender=room.players[g.defenderIdx];const defHandSize=g.hands[defender.sub]?.length??0;if(defHandSize===0)return cb?.({error:'Defender has no cards left'});const undefendedCount=g.table.filter(p=>!p.defense).length;if(undefendedCount>=defHandSize)return cb?.({error:'Too many cards for defender'});hand.splice(cardIdx,1);g.table.push({attack:card,defense:null});g.phase='defend';broadcastGameState(room);cb?.({ok:true});setTimeout(()=>processBotTurns(room),4000);});
  socket.on('game:defend',({attackCard,defenseCard},cb)=>{const room=rooms.get(socket.data.roomId);if(!room?.game)return cb?.({error:'No game'});if(!attackCard?.r||!defenseCard?.r)return cb?.({error:'Invalid card'});const g=room.game;if(g.phase!=='defend')return cb?.({error:'Not defend phase'});const defender=room.players[g.defenderIdx];if(defender.sub!==sub)return cb?.({error:'Not your turn to defend'});const pair=g.table.find(p=>p.attack.r===attackCard.r&&p.attack.s===attackCard.s&&!p.defense);if(!pair)return cb?.({error:'Attack card not found'});if(!beats(attackCard,defenseCard,g.trump))return cb?.({error:'Cannot beat that card'});const hand=g.hands[sub];const idx=hand.findIndex(c=>c.r===defenseCard.r&&c.s===defenseCard.s);if(idx===-1)return cb?.({error:'Card not in hand'});hand.splice(idx,1);pair.defense=defenseCard;const allDefended=g.table.every(p=>p.defense);if(allDefended)g.phase='attack';broadcastGameState(room);cb?.({ok:true});if(allDefended)setTimeout(()=>processBotTurns(room),4000);});
  socket.on('game:endAttack',(cb)=>{const room=rooms.get(socket.data.roomId);if(!room?.game)return cb?.({error:'No game'});const g=room.game;if(g.phase!=='attack')return cb?.({error:'Not attack phase'});const attacker=room.players[g.attackerIdx];if(attacker.sub!==sub)return cb?.({error:'Not your turn'});if(g.table.length===0)return cb?.({error:'No cards on table'});if(!g.table.every(p=>p.defense))return cb?.({error:'Not all cards defended yet'});g.table=[];const n=room.players.length;g.attackerIdx=g.defenderIdx;g.defenderIdx=(g.defenderIdx+1)%n;g.phase='attack';refillHands(room);advancePastFinished(room);if(!checkGameOver(room)){broadcastGameState(room);cb?.({ok:true});setTimeout(()=>processBotTurns(room),4500);}else{endGame(room);cb?.({ok:true});}});
  socket.on('game:take',(cb)=>{const room=rooms.get(socket.data.roomId);if(!room?.game)return cb?.({error:'No game'});const g=room.game;if(g.phase!=='defend'&&g.phase!=='pre-take')return cb?.({error:'Not defend phase'});const defender=room.players[g.defenderIdx];if(defender.sub!==sub)return cb?.({error:'Not defender'});if(g.phase==='defend'){g.phase='pre-take';broadcastGameState(room);cb?.({ok:true});const preTakeToken=++g.preTakeToken;setTimeout(()=>{if(room.game&&room.game.preTakeToken===preTakeToken&&room.game.phase==='pre-take')executeTake(room);},8000);setTimeout(()=>processBotTurns(room),4000);return;}executeTake(room);cb?.({ok:true});});
  socket.on('game:preTakeAdd',({card},cb)=>{const room=rooms.get(socket.data.roomId);if(!room?.game)return cb?.({error:'No game'});const g=room.game;if(g.phase!=='pre-take')return cb?.({error:'Not pre-take phase'});const attacker=room.players[g.attackerIdx];if(attacker.sub!==sub)return cb?.({error:'Only attacker can add cards now'});const ranks=new Set(g.table.flatMap(p=>[p.attack?.r,p.defense?.r].filter(Boolean)));if(!ranks.has(card.r))return cb?.({error:'Rank not on table'});const hand=g.hands[sub];const idx=hand.findIndex(c=>c.r===card.r&&c.s===card.s);if(idx===-1)return cb?.({error:'Card not in hand'});hand.splice(idx,1);g.table.push({attack:card,defense:null});broadcastGameState(room);cb?.({ok:true});});
  socket.on('game:preTakeDone',(cb)=>{const room=rooms.get(socket.data.roomId);if(!room?.game)return cb?.({error:'No game'});const g=room.game;if(g.phase!=='pre-take')return cb?.({error:'Not pre-take phase'});const attacker=room.players[g.attackerIdx];if(attacker.sub!==sub)return cb?.({error:'Only attacker can end this'});g.preTakeToken=(g.preTakeToken||0)+1;executeTake(room);cb?.({ok:true});});
  socket.on('game:transfer',({card},cb)=>{const room=rooms.get(socket.data.roomId);if(!room?.game)return cb?.({error:'No game'});if(!card?.r||!card?.s)return cb?.({error:'Invalid card'});const g=room.game;if(g.phase!=='defend')return cb?.({error:'Wrong phase'});const defender=room.players[g.defenderIdx];if(defender.sub!==sub)return cb?.({error:'Not defender'});if(g.table.some(p=>p.defense))return cb?.({error:'Cannot transfer after defending'});const tableRank=g.table[0]?.attack.r;if(!tableRank||card.r!==tableRank)return cb?.({error:'Transfer card rank mismatch'});if(g.table.some(p=>p.attack.r!==tableRank))return cb?.({error:'All attack cards must be same rank to transfer'});const hand=g.hands[sub];const idx=hand.findIndex(c=>c.r===card.r&&c.s===card.s);if(idx===-1)return cb?.({error:'Card not in hand'});const n=room.players.length;let nextDefIdx=(g.defenderIdx+1)%n;let safety=0;while(safety++<n&&(g.hands[room.players[nextDefIdx].sub]?.length??0)===0)nextDefIdx=(nextDefIdx+1)%n;if(nextDefIdx===g.defenderIdx)return cb?.({error:'No valid player to transfer to'});const nextHandSize=g.hands[room.players[nextDefIdx].sub]?.length??0;if(nextHandSize<g.table.length+1)return cb?.({error:`Next player only has ${nextHandSize} card(s)`});hand.splice(idx,1);g.table.push({attack:card,defense:null});g.attackerIdx=g.defenderIdx;g.defenderIdx=nextDefIdx;g.phase='defend';broadcastGameState(room);cb?.({ok:true});setTimeout(()=>processBotTurns(room),4000);});
  socket.on('room:get',(cb)=>{const room=rooms.get(socket.data.roomId);if(!room)return cb?.({error:'Not in a room'});cb?.({room:roomSnapshot(room)});});
  socket.on('game:forfeit',()=>{const room=rooms.get(socket.data.roomId);if(!room?.game||room.game.phase==='done')return;room.game.loser=socket.data.sub;endGame(room);});

  // Poker handlers
  socket.on('poker:rooms:list',(cb)=>{const list=[...pokerRooms.values()].filter(r=>r.status==='waiting').map(pubPokerRoom);cb({rooms:list});});
  socket.on('poker:room:create',async({name:rName,bet,maxPlayers,password,tvMode},cb)=>{try{const bal=await getBalance(sub);if(+bet<10)return cb({error:'Minimum buy-in is $10'});if(!tvMode&&+bet>bal)return cb({error:'Insufficient balance'});const id=makePokerId();const room=createPokerRoom({id,hostSub:sub,hostName:name,name:rName||`${name}'s Poker`,bet:+bet,maxPlayers:+maxPlayers||6,password,tvMode:!!tvMode});if(!tvMode){room.players.push({sub,name,socketId:socket.id,isBot:false});await dbQuery('UPDATE users SET balance=balance-$1 WHERE auth_sub=$2',[+bet,sub]).catch(()=>{});}else{room.hostSocketId=socket.id;}pokerRooms.set(id,room);socket.data.pokerRoomId=id;socket.join('poker:'+id);cb({ok:true,roomId:id,role:tvMode?'tv':'player',room:pokerRoomSnap(room)});io.emit('poker:rooms:updated');}catch(e){cb({error:e.message});}});
  socket.on('poker:room:join',async({roomId,password},cb)=>{try{const room=pokerRooms.get(roomId);if(!room)return cb({error:'Room not found'});if(room.status!=='waiting')return cb({error:'Game already started'});if(room.players.length>=room.maxPlayers)return cb({error:'Room full'});if(room.password&&room.password!==password)return cb({error:'Wrong password'});if(room.players.find(p=>p.sub===sub))return cb({error:'Already in room'});const bal=await getBalance(sub);if(+room.bet>bal)return cb({error:'Insufficient balance'});await dbQuery('UPDATE users SET balance=balance-$1 WHERE auth_sub=$2',[room.bet,sub]).catch(()=>{});room.players.push({sub,name,socketId:socket.id,isBot:false});socket.data.pokerRoomId=roomId;socket.join('poker:'+roomId);io.to('poker:'+roomId).emit('poker:room:state',pokerRoomSnap(room));cb({ok:true,role:'player',room:pokerRoomSnap(room)});io.emit('poker:rooms:updated');}catch(e){cb({error:e.message});}});
  socket.on('poker:room:addBot',({difficulty},cb)=>{const room=pokerRooms.get(socket.data.pokerRoomId);if(!room)return cb?.({error:'Not in a room'});if(room.hostSub!==sub)return cb?.({error:'Only host can add bots'});if(room.players.length>=room.maxPlayers)return cb?.({error:'Room full'});const names=['Viktor','Misha','Anya','Grisha','Dasha','Senya','Zhenya','Roma','Kolya','Vera'];const used=new Set(room.players.map(p=>p.name.replace(' (Bot)','')));const avail=names.filter(n=>!used.has(n));const bname=(avail[0]||'Bot'+(room.players.length+1))+' (Bot)';const bsub='pbot:'+Math.random().toString(36).slice(2);room.players.push({sub:bsub,name:bname,socketId:null,isBot:true,difficulty:difficulty||'medium'});io.to('poker:'+room.id).emit('poker:room:state',pokerRoomSnap(room));cb?.({ok:true});});
  socket.on('poker:room:removeBot',({botSub},cb)=>{const room=pokerRooms.get(socket.data.pokerRoomId);if(!room||room.hostSub!==sub)return cb?.({error:'Not allowed'});room.players=room.players.filter(p=>p.sub!==botSub);io.to('poker:'+room.id).emit('poker:room:state',pokerRoomSnap(room));cb?.({ok:true});});
  socket.on('poker:room:leave',async(cb)=>{await leavePokerRoom(socket);cb?.({ok:true});});
  socket.on('poker:room:start',async(cb)=>{const room=pokerRooms.get(socket.data.pokerRoomId);if(!room)return cb?.({error:'Not in a room'});if(room.hostSub!==sub)return cb?.({error:'Only host can start'});if(room.players.length<2)return cb?.({error:'Need at least 2 players'});if(room.status==='playing')return cb?.({error:'Already playing'});room.status='playing';initPokerGame(room);io.to('poker:'+room.id).emit('poker:game:started',{bigBlind:room.game.bigBlind,tvMode:room.tvMode});cb?.({ok:true});io.emit('poker:rooms:updated');setTimeout(()=>startPokerHand(room),2000);});
  socket.on('poker:action',({action,amount},cb)=>{const room=pokerRooms.get(socket.data.pokerRoomId);if(!room?.game)return cb?.({error:'No game'});const ok=pokerAct(room,sub,action,+amount||0);cb?.(ok?{ok:true}:{error:'Invalid action'});});
  socket.on('poker:room:get',(cb)=>{const room=pokerRooms.get(socket.data.pokerRoomId);if(!room)return cb?.({room:null});if(room.tvMode&&room.hostSub===sub)room.hostSocketId=socket.id;cb?.({room:pokerRoomSnap(room)});});

  socket.on('disconnect',()=>{leaveRoom(socket);leavePokerRoom(socket);});
});

// ── Start ─────────────────────────────────────
initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`
  ╔══════════════════════════════════════╗
  ║   ⚔  CERTA.GAMES UNIFIED SERVER  ⚔  ║
  ║   http://localhost:${PORT}              ║
  ║   /          → Card game lobby       ║
  ║   /game       → FPS shooter          ║
  ║   /solitaire  → Solitaire            ║
  ║   /durak      → Durak                ║
  ║   /poker      → Poker                ║
  ╚══════════════════════════════════════╝
    `);
  });
}).catch(err => {
  console.warn('DB init error (continuing without DB):', err.message);
  server.listen(PORT, () => console.log(`⚔  Certa.games running on port ${PORT} (no DB)`));
});
