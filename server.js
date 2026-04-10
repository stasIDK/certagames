const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// Serve game files
app.use(express.static(path.join(__dirname, 'public')));

// ── Player state ──────────────────────────────────────────────
const players = new Map(); // id -> playerData
let   nextId  = 1;

const COLORS = [
  '#ff4444','#44ff88','#ffcc00','#ff44ff',
  '#44ccff','#ff8844','#88ff44','#cc44ff',
];

// ── WebSocket connection ──────────────────────────────────────
wss.on('connection', (ws, req) => {
  const id     = nextId++;
  const colorIndex = (id - 1) % COLORS.length;

  const player = {
    id,
    name   : `Adventurer${id}`,
    color  : COLORS[colorIndex],
    x      : (Math.random() - 0.5) * 30,
    y      : 0,
    z      : (Math.random() - 0.5) * 30,
    rotY   : 0,
    moving : false,
    ip     : req.socket.remoteAddress,
  };

  players.set(id, player);
  console.log(`[+] Player ${id} (${player.name}) connected. Total: ${players.size}`);

  // ── Welcome: send the new player their ID + all existing players ──
  ws.send(JSON.stringify({
    type    : 'welcome',
    id,
    players : [...players.values()].map(safePlayer),
  }));

  // ── Announce join to everyone else ──
  broadcast({ type: 'playerJoin', player: safePlayer(player) }, ws);

  // ── Handle incoming messages ──
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'move': {
        const p = players.get(id);
        if (!p) break;
        // Basic bounds check – prevent teleporting
        const dx = Math.abs(msg.x - p.x);
        const dz = Math.abs(msg.z - p.z);
        if (dx < 20 && dz < 20) {
          p.x    = msg.x;
          p.y    = msg.y;
          p.z    = msg.z;
          p.rotY = msg.rotY;
        }
        broadcast({ type: 'playerMove', id, x: p.x, y: p.y, z: p.z, rotY: p.rotY }, ws);
        break;
      }

      case 'setName': {
        const p = players.get(id);
        if (!p) break;
        const name = String(msg.name).replace(/[<>]/g, '').slice(0, 20).trim() || p.name;
        p.name = name;
        broadcast({ type: 'playerName', id, name });
        console.log(`[~] Player ${id} renamed to "${name}"`);
        break;
      }

      case 'chat': {
        const p = players.get(id);
        if (!p) break;
        const text = String(msg.text).replace(/[<>]/g, '').slice(0, 120).trim();
        if (!text) break;
        broadcast({ type: 'chat', id, name: p.name, text });
        console.log(`[chat] ${p.name}: ${text}`);
        break;
      }
    }
  });

  ws.on('close', () => {
    const p = players.get(id);
    players.delete(id);
    console.log(`[-] Player ${id} (${p?.name}) disconnected. Total: ${players.size}`);
    broadcast({ type: 'playerLeave', id, name: p?.name });
  });

  ws.on('error', (err) => {
    console.error(`[!] WS error for player ${id}:`, err.message);
  });
});

// ── Helpers ───────────────────────────────────────────────────
function safePlayer(p) {
  return { id: p.id, name: p.name, color: p.color, x: p.x, y: p.y, z: p.z, rotY: p.rotY };
}

function broadcast(msg, exclude = null) {
  const str = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(str);
    }
  });
}

// ── Heartbeat: ping clients every 30s to keep connections alive ──
setInterval(() => {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.ping();
  });
}, 30_000);

// ── Start ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════╗
  ║   ⚔  CERTA.GAMES SERVER  ⚔  ║
  ║   http://localhost:${PORT}      ║
  ╚══════════════════════════════╝
  `);
});
