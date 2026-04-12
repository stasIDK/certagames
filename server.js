'use strict';
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.static(path.join(__dirname, 'public')));

// ── Constants ────────────────────────────────────────────────
const PLAYER_HP = 100;
const ZOMBIE_COUNT = 20;
const ZOMBIE_HP = 80;
const ZOMBIE_SPEED = 2.8;
const ZOMBIE_AGGRO_RANGE = 42;
const ZOMBIE_PUNCH_RANGE = 2.8;
const ZOMBIE_PUNCH_DAMAGE = 10;
const ZOMBIE_PUNCH_CD = 1400;
const ZOMBIE_RESPAWN_DELAY = 30000;
const PUNCH_RANGE = 3.0;
const PUNCH_DAMAGE = 20;
const LOOT_RESPAWN_TIME = 300000;

// ── Gun definitions ──────────────────────────────────────────
// type: 'pistol' | 'shotgun' | 'ar' | 'sniper'
const GUN_DEFS = {
  pistol: { damage: 35, ammo: 12, maxAmmo: 12, range: 60, pellets: 1, fireRate: 450, hitscan: true },
  shotgun: { damage: 14, ammo: 6, maxAmmo: 6, range: 28, pellets: 8, fireRate: 900, hitscan: true },
  ar: { damage: 22, ammo: 30, maxAmmo: 30, range: 90, pellets: 1, fireRate: 110, hitscan: true },
  sniper: { damage: 120, ammo: 5, maxAmmo: 5, range: 250, pellets: 1, fireRate: 1800, hitscan: true },
};

// ── Ground height — must match client exactly ────────────────
function groundHeight(x, z) {
  return (
    Math.sin(x * 0.048) * Math.cos(z * 0.048) * 3.0 +
    Math.sin(x * 0.10 + 1.2) * Math.sin(z * 0.09) * 1.8 +
    Math.sin(x * 0.022) * Math.sin(z * 0.022) * 5.0 +
    Math.cos(x * 0.035 + 0.5) * Math.cos(z * 0.028 + 1.0) * 2.0
  );
}

// ── Building / loot definitions ──────────────────────────────
// Sizes reduced: small=8x6, medium=9x7, large=11x8, largest=12x8
// Gun assignment: small=pistol, medium=shotgun, large=ar, largest=sniper
const BUILDING_DEFS = [
  { x: 25, z: 25, w: 8, d: 6, gun: 'pistol' }, // small
  { x: -45, z: 35, w: 8, d: 6, gun: 'pistol' }, // small
  { x: 60, z: -40, w: 8, d: 6, gun: 'pistol' }, // small
  { x: -60, z: -50, w: 8, d: 6, gun: 'pistol' }, // small
  { x: 90, z: 70, w: 9, d: 7, gun: 'shotgun' }, // medium
  { x: -80, z: 90, w: 9, d: 7, gun: 'shotgun' }, // medium
  { x: 30, z: -90, w: 11, d: 8, gun: 'ar' }, // large
  { x: -100, z: -30, w: 12, d: 8, gun: 'sniper' }, // largest
];

const loots = BUILDING_DEFS.map((b, i) => ({
  id: i, x: b.x + 1, z: b.z + 1,
  gunType: b.gun,
  available: true,
}));

// ── Zombies ──────────────────────────────────────────────────
let zombieIdCounter = 0;
const zombies = new Map();

function spawnZombie(existingId) {
  const id = existingId !== undefined ? existingId : zombieIdCounter++;
  const angle = Math.random() * Math.PI * 2;
  const dist = 50 + Math.random() * 180;
  zombies.set(id, {
    id,
    x: Math.cos(angle) * dist,
    z: Math.sin(angle) * dist,
    hp: ZOMBIE_HP, maxHp: ZOMBIE_HP,
    alive: true,
    lastPunch: 0,
    wanderAngle: Math.random() * Math.PI * 2,
    wanderTimer: 0,
  });
}
for (let i = 0; i < ZOMBIE_COUNT; i++) spawnZombie();

function safeZombie(z) {
  return { id: z.id, x: +z.x.toFixed(2), z: +z.z.toFixed(2), hp: z.hp, maxHp: z.maxHp };
}

// ── Players ──────────────────────────────────────────────────
const players = new Map();
const playerWs = new Map();
let nextId = 1;
const COLORS = [
  '#00ccff', '#ff3355', '#22ff88', '#ff9900',
  '#cc44ff', '#ffff00', '#ff44aa', '#44ffdd',
];

function safePlayer(p) {
  return {
    id: p.id, name: p.name, color: p.color,
    x: p.x, y: p.y, z: p.z, rotY: p.rotY,
    hp: p.hp, maxHp: p.maxHp,
    alive: p.alive, hasGun: p.hasGun,
    gunType: p.gunType,
  };
}

function sendTo(id, msg) {
  const ws = playerWs.get(id);
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function killPlayer(p) {
  p.alive = false;
  p.hp = 0;
  p.hasGun = false;
  p.ammo = 0;
  p.gunType = null;
  sendTo(p.id, { type: 'youDied' });
  broadcast({ type: 'playerDied', id: p.id });
}

// ── Zombie AI tick ───────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  const dt = 0.1;
  const alive = [...players.values()].filter(p => p.alive);

  zombies.forEach(z => {
    if (!z.alive) return;

    let nearest = null, nearestDist = Infinity;
    alive.forEach(p => {
      const dx = p.x - z.x, dz = p.z - z.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < nearestDist) { nearestDist = d; nearest = p; }
    });

    if (nearest && nearestDist < ZOMBIE_AGGRO_RANGE) {
      const dx = nearest.x - z.x, dz = nearest.z - z.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > ZOMBIE_PUNCH_RANGE) {
        z.x += (dx / d) * ZOMBIE_SPEED * dt;
        z.z += (dz / d) * ZOMBIE_SPEED * dt;
      } else if (now - z.lastPunch > ZOMBIE_PUNCH_CD) {
        z.lastPunch = now;
        nearest.hp = Math.max(0, nearest.hp - ZOMBIE_PUNCH_DAMAGE);
        sendTo(nearest.id, { type: 'selfHit', hp: nearest.hp });
        broadcast({ type: 'playerHp', id: nearest.id, hp: nearest.hp });
        if (nearest.hp <= 0) killPlayer(nearest);
        // Tell the victim about the zombie punch for flinch animation
        sendTo(nearest.id, { type: 'zombieAttack', zombieId: z.id });
      }
    } else {
      z.wanderTimer -= dt;
      if (z.wanderTimer <= 0) {
        z.wanderAngle = Math.random() * Math.PI * 2;
        z.wanderTimer = 2 + Math.random() * 3;
      }
      z.x += Math.cos(z.wanderAngle) * ZOMBIE_SPEED * 0.35 * dt;
      z.z += Math.sin(z.wanderAngle) * ZOMBIE_SPEED * 0.35 * dt;
      const B = 240;
      z.x = Math.max(-B, Math.min(B, z.x));
      z.z = Math.max(-B, Math.min(B, z.z));
    }
  });

  broadcast({
    type: 'zombieUpdate',
    zombies: [...zombies.values()].filter(z => z.alive).map(safeZombie),
  });
}, 100);

// ── WebSocket ────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const id = nextId++;
  playerWs.set(id, ws);

  const player = {
    id,
    name: `Adventurer${id}`,
    color: COLORS[(id - 1) % COLORS.length],
    x: (Math.random() - 0.5) * 20,
    y: 0,
    z: (Math.random() - 0.5) * 20,
    rotY: 0,
    hp: PLAYER_HP, maxHp: PLAYER_HP,
    alive: true, hasGun: false, ammo: 0, gunType: null,
    lastShot: 0,
  };
  players.set(id, player);
  console.log(`[+] Player ${id} connected. Online: ${players.size}`);

  ws.send(JSON.stringify({
    type: 'welcome',
    id,
    color: player.color,
    players: [...players.values()].map(safePlayer),
    zombies: [...zombies.values()].filter(z => z.alive).map(safeZombie),
    loots: loots.map(l => ({ id: l.id, available: l.available, gunType: l.gunType })),
  }));

  broadcast({ type: 'playerJoin', player: safePlayer(player) }, ws);

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const p = players.get(id);
    if (!p) return;

    switch (msg.type) {

      case 'move': {
        if (!p.alive) break;
        if (Math.abs(msg.x - p.x) < 20 && Math.abs(msg.z - p.z) < 20) {
          p.x = msg.x; p.y = msg.y; p.z = msg.z; p.rotY = msg.rotY;
          p.pitch = msg.pitch || 0;
        }
        broadcast({ type: 'playerMove', id, x: p.x, y: p.y, z: p.z, rotY: p.rotY, pitch: p.pitch || 0 }, ws);
        break;
      }

      case 'setName': {
        p.name = String(msg.name).replace(/[<>]/g, '').slice(0, 20).trim() || p.name;
        broadcast({ type: 'playerName', id, name: p.name });
        break;
      }

      case 'chat': {
        const text = String(msg.text).replace(/[<>]/g, '').slice(0, 120).trim();
        if (text) broadcast({ type: 'chat', id, name: p.name, text });
        break;
      }

      case 'punch': {
        if (!p.alive) break;
        const punchDmg = PUNCH_DAMAGE;

        zombies.forEach(z => {
          if (!z.alive) return;
          const dx = z.x - p.x, dz = z.z - p.z;
          if (Math.sqrt(dx * dx + dz * dz) > PUNCH_RANGE) return;
          z.hp -= punchDmg;
          if (z.hp <= 0) {
            z.alive = false;
            broadcast({ type: 'zombieDied', id: z.id, x: z.x, z: z.z, gore: true });
            setTimeout(() => {
              const a = Math.random() * Math.PI * 2, d = 60 + Math.random() * 150;
              z.x = Math.cos(a) * d; z.z = Math.sin(a) * d;
              z.hp = z.maxHp; z.alive = true;
              broadcast({ type: 'zombieRespawn', zombie: safeZombie(z) });
            }, ZOMBIE_RESPAWN_DELAY);
          } else {
            broadcast({ type: 'zombieHit', id: z.id, hp: z.hp, maxHp: z.maxHp });
          }
        });

        players.forEach(t => {
          if (t.id === id || !t.alive) return;
          const dx = t.x - p.x, dz = t.z - p.z;
          if (Math.sqrt(dx * dx + dz * dz) > PUNCH_RANGE) return;
          t.hp = Math.max(0, t.hp - punchDmg);
          sendTo(t.id, { type: 'selfHit', hp: t.hp });
          broadcast({ type: 'playerHp', id: t.id, hp: t.hp });
          if (t.hp <= 0) killPlayer(t);
        });
        break;
      }

      case 'shoot': {
        if (!p.alive || !p.hasGun || p.ammo <= 0) break;
        const now = Date.now();
        const gun = GUN_DEFS[p.gunType] || GUN_DEFS.pistol;
        if (now - p.lastShot < gun.fireRate) break;
        p.lastShot = now;

        p.ammo--;
        sendTo(id, { type: 'ammoUpdate', ammo: p.ammo, gunType: p.gunType });

        // Pitch from client (vertical aim)
        const pitch = p.pitch || 0;
        // Three.js camera forward = (-sin(yaw), 0, -cos(yaw)), so negate both
        const sdx = -Math.sin(p.rotY) * Math.cos(pitch);
        const sdy = -Math.sin(pitch);
        const sdz = -Math.cos(p.rotY) * Math.cos(pitch);

        // Shotgun fires multiple pellets
        const pellets = gun.pellets;
        let hitAny = false;

        for (let pel = 0; pel < pellets; pel++) {
          // Shotgun spread: rotate direction slightly in XZ plane
          const spreadAngle = pellets > 1 ? (Math.random() - 0.5) * 0.28 : 0;
          const cosS = Math.cos(spreadAngle), sinS = Math.sin(spreadAngle);
          const pdx = sdx * cosS - sdz * sinS;
          const pdz = sdx * sinS + sdz * cosS;

          let hitZ = null, hitZDist = gun.range;
          zombies.forEach(z => {
            if (!z.alive) return;
            const ex = z.x - p.x, ez = z.z - p.z;
            const dist = Math.sqrt(ex * ex + ez * ez);
            if (dist > hitZDist) return;
            if ((ex / dist) * pdx + (ez / dist) * pdz < 0.82) return;
            if (Math.abs(ex * pdz - ez * pdx) > 2.0) return;
            hitZDist = dist; hitZ = z;
          });

          if (hitZ) {
            hitAny = true;
            hitZ.hp -= gun.damage;
            if (hitZ.hp <= 0) {
              hitZ.alive = false;
              broadcast({ type: 'zombieDied', id: hitZ.id, x: hitZ.x, z: hitZ.z, gore: true });
              const zRef = hitZ;
              setTimeout(() => {
                const a = Math.random() * Math.PI * 2, d = 60 + Math.random() * 150;
                zRef.x = Math.cos(a) * d; zRef.z = Math.sin(a) * d;
                zRef.hp = zRef.maxHp; zRef.alive = true;
                broadcast({ type: 'zombieRespawn', zombie: safeZombie(zRef) });
              }, ZOMBIE_RESPAWN_DELAY);
            } else {
              broadcast({ type: 'zombieHit', id: hitZ.id, hp: hitZ.hp, maxHp: hitZ.maxHp });
            }
          } else {
            let hitP = null, hitPDist = gun.range;
            players.forEach(t => {
              if (t.id === id || !t.alive) return;
              const ex = t.x - p.x, ez = t.z - p.z;
              const dist = Math.sqrt(ex * ex + ez * ez);
              if (dist > hitPDist) return;
              if ((ex / dist) * pdx + (ez / dist) * pdz < 0.82) return;
              if (Math.abs(ex * pdz - ez * pdx) > 1.2) return;
              hitPDist = dist; hitP = t;
            });
            if (hitP) {
              hitAny = true;
              hitP.hp = Math.max(0, hitP.hp - gun.damage);
              sendTo(hitP.id, { type: 'selfHit', hp: hitP.hp });
              broadcast({ type: 'playerHp', id: hitP.id, hp: hitP.hp });
              if (hitP.hp <= 0) killPlayer(hitP);
            }
          }
        }

        broadcast({
          type: 'gunshot',
          id, x: p.x, z: p.z, rotY: p.rotY, pitch: p.pitch || 0,
          gunType: p.gunType,
        });
        break;
      }

      case 'pickup': {
        if (!p.alive) break;
        // Drop current gun first (handled client-side by 1-slot logic)
        loots.forEach(l => {
          if (!l.available) return;
          const dx = l.x - p.x, dz = l.z - p.z;
          if (Math.sqrt(dx * dx + dz * dz) > 3.5) return;
          // Drop existing gun back as loot if player has one
          if (p.hasGun && p.gunType) {
            // Find a nearby empty loot slot or just replace
            l.gunType = p.gunType;
          }
          l.available = false;
          p.hasGun = true;
          p.gunType = l.gunType;
          p.ammo = GUN_DEFS[p.gunType].ammo;
          sendTo(id, { type: 'pickedUpGun', ammo: p.ammo, gunType: p.gunType });
          broadcast({ type: 'lootUpdate', id: l.id, available: false, gunType: l.gunType });
          setTimeout(() => {
            l.available = true;
            l.gunType = BUILDING_DEFS[l.id] ? BUILDING_DEFS[l.id].gun : 'pistol';
            broadcast({ type: 'lootUpdate', id: l.id, available: true, gunType: l.gunType });
          }, LOOT_RESPAWN_TIME);
        });
        break;
      }

      case 'reload': {
        if (!p.alive || !p.hasGun) break;
        const gun = GUN_DEFS[p.gunType] || GUN_DEFS.pistol;
        p.ammo = gun.maxAmmo;
        sendTo(id, { type: 'ammoUpdate', ammo: p.ammo, gunType: p.gunType });
        break;
      }

      case 'respawn': {
        if (p.alive) break;
        p.hp = p.maxHp; p.alive = true;
        p.hasGun = false; p.ammo = 0; p.gunType = null;
        p.x = (Math.random() - 0.5) * 20;
        p.z = (Math.random() - 0.5) * 20;
        sendTo(id, { type: 'respawned', x: p.x, z: p.z });
        broadcast({ type: 'playerRespawn', id, x: p.x, z: p.z, hp: p.hp });
        break;
      }
    }
  });

  ws.on('close', () => {
    players.delete(id);
    playerWs.delete(id);
    console.log(`[-] Player ${id} disconnected. Online: ${players.size}`);
    broadcast({ type: 'playerLeave', id, name: player.name });
  });

  ws.on('error', err => console.error(`[!] WS error ${id}:`, err.message));
});

function broadcast(msg, exclude = null) {
  const str = JSON.stringify(msg);
  wss.clients.forEach(c => {
    if (c !== exclude && c.readyState === WebSocket.OPEN) c.send(str);
  });
}

setInterval(() => {
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.ping(); });
}, 30_000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════╗
  ║   ⚔  CERTA.GAMES SERVER  ⚔  ║
  ║   http://localhost:${PORT}      ║
  ╚══════════════════════════════╝
  `);
});
