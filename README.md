# ⚔ CertaGames

A browser-based multiplayer gaming platform — no downloads, no installs. Sign in and play instantly.

---

## Games

### Certa: Open World
A first-person shooter set in a shared open world. Every player is in the same map at the same time.

- **56 zombies** roaming the map — small, medium, large, and boss variants
- Zombies **aggro** when you get close and **deaggro** (with health regen) when you escape
- Kill zombies to earn **money** — small $5 / medium $10 / large $20 / boss $65
- Spend money at the **upgrade shop** (press `B`) — gun damage, max HP, adrenaline regen, energy shield, ammo refill
- **Die and lose $50** off your balance
- Pick up **guns** scattered in buildings — Pistol, Shotgun, AR, Sniper
- Health **regenerates slowly** when out of combat
- Full FPS controls: aim down sights, reload, punch, drop weapons, chat
- **Minimap**, hit markers, gore effects, bullet tracers, muzzle flash
- Balance is shared with card games — earn money in poker, spend it in the shooter

### Solitaire
Classic Klondike solitaire. Beat the clock and land on the leaderboard.

### Durak
Russian card game. Multiplayer rooms with real money stakes, bots, and a full deck engine.

### Poker
Texas Hold'em. Bluff, raise, and outlast the table. Supports up to 6 players, bots, and TV spectator mode.

---

## Leaderboards

Three global leaderboards on the main page, updated live:
- **Zombie Kills** — total zombies eliminated across all sessions
- **Richest Players** — current account balance
- **Fastest Solitaire** — best completion time

---

## Controls (Shooter)

| Key | Action |
|---|---|
| **WASD** | Move |
| **Mouse** | Look |
| **Left click** | Shoot / punch |
| **Right click** | Aim down sights |
| **E** | Pick up gun |
| **R** | Reload |
| **G** | Drop weapon |
| **F** | Punch |
| **B** | Open upgrade shop |
| **Space** | Jump |
| **T** | Chat |
| **Escape** | Close chat / exit shop |

---

## Running Locally

```bash
npm install
npm start
```

Open **http://localhost:3000** in your browser. Open a second tab to see multiplayer working.

Requires Node.js 18+. A PostgreSQL database is optional — the app runs without one (auth and scores are disabled without DB).

### Environment variables (`.env`)

```
PORT=3000
DATABASE_URL=postgresql://user:pass@localhost:5432/certadb
JWT_SECRET=your-secret-here
ADMIN_KEY=your-admin-key
```

---

## Deploying

### VPS setup (Ubuntu)

```bash
# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs nginx

# Install PM2 (keeps server alive)
npm install -g pm2

# Clone and start
cd /var/www/certagames
npm install --production
pm2 start server.js --name certagames
pm2 startup && pm2 save
```

### Cloudflare DNS

Point an `A` record at your server IP with the orange cloud (proxied).  
Go to **Network → WebSockets** and make sure it is **ON** — required for real-time multiplayer.  
Set SSL/TLS to **Flexible** if running on port 80 behind nginx.

### Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

---

## File Structure

```
certagames/
├── server.js              ← Unified server: HTTP, WebSocket shooter, Socket.io card games
├── package.json
├── .env                   ← Secrets (not committed)
└── public/
    ├── index.html         ← Main lobby + leaderboards
    ├── game.html          ← FPS shooter shell + HUD
    ├── game.js            ← Three.js shooter engine
    └── cards/
        ├── solitaire.html
        ├── durak.html
        └── poker.html
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| 3D rendering | Three.js (r128) |
| Realtime shooter | Raw WebSockets |
| Card game rooms | Socket.io |
| Auth | JWT + bcrypt |
| Database | PostgreSQL (optional) |
| Server | Node.js + Express |
| Hosting | Any VPS + Cloudflare |

---

## Monitoring

```bash
pm2 status
pm2 logs certagames
pm2 monit
```
