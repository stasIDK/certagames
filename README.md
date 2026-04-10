# ⚔ CERTA.GAMES — Setup Guide

## What this is
A browser-based 3D open-world MMO base frame built with:
- **Three.js** (3D rendering in the browser — no plugins needed)
- **Node.js + WebSockets** (real-time multiplayer: all players share one world)
- **Cloudflare** (DNS, DDoS protection, SSL)

---

## Step 1 — Run locally (Windows 11)

### Install Node.js
1. Go to https://nodejs.org and download the **LTS** version
2. Run the installer (just keep clicking Next)
3. Open **Windows Terminal** or **PowerShell**

### Run the game
```powershell
cd path\to\certa-games
npm install
npm start
```

Then open your browser to: **http://localhost:3000**

You'll see the splash screen. Open a second tab to the same URL and you'll see two players in the same world.

---

## Step 2 — Get a VPS (required for real hosting)

Cloudflare only handles DNS and CDN — you need a server to actually run the game.

**Recommended providers (cheapest options):**
| Provider | Plan | Cost | Link |
|---|---|---|---|
| Hetzner | CX22 (2 vCPU, 4GB RAM) | ~$4/mo | hetzner.com |
| DigitalOcean | Basic Droplet (1 vCPU, 1GB) | $6/mo | digitalocean.com |
| Linode/Akamai | Nanode (1 vCPU, 1GB) | $5/mo | linode.com |

Choose **Ubuntu 24.04 LTS** as the OS.

---

## Step 3 — Set up your VPS

SSH into your server:
```bash
ssh root@YOUR_SERVER_IP
```

### Install Node.js + PM2
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# PM2 keeps the server running after you disconnect
npm install -g pm2
```

### Install nginx
```bash
sudo apt install -y nginx
```

### Upload your game files
From your Windows machine, use [WinSCP](https://winscp.net) or run:
```powershell
# In PowerShell on your Windows machine
scp -r .\certa-games root@YOUR_SERVER_IP:/var/www/certa-games
```

### Install dependencies on the server
```bash
cd /var/www/certa-games
npm install --production
```

### Start with PM2
```bash
pm2 start server.js --name certa-games
pm2 startup     # makes it auto-restart on reboot
pm2 save
```

### Configure nginx
```bash
sudo cp /var/www/certa-games/nginx.conf /etc/nginx/sites-available/certa-games
sudo ln -s /etc/nginx/sites-available/certa-games /etc/nginx/sites-enabled/
sudo nginx -t          # test config
sudo systemctl reload nginx
```

---

## Step 4 — Cloudflare DNS

1. Log into **cloudflare.com** → select **certa.games**
2. Go to **DNS → Records**
3. Add:
   ```
   Type: A
   Name: @              (for certa.games)
   IPv4: YOUR_SERVER_IP
   Proxy: ✅ Proxied (orange cloud)
   TTL: Auto
   ```
   Also add:
   ```
   Type: A
   Name: www
   IPv4: YOUR_SERVER_IP
   Proxy: ✅ Proxied
   ```

4. Go to **SSL/TLS → Overview** → set to **"Flexible"** (since Node runs on port 80)

5. Go to **Network** → ensure **WebSockets** is **ON** ✅
   (It is on by default for all plans including Free)

6. Wait 1–5 minutes for DNS to propagate, then visit **https://certa.games**

---

## Step 5 — Firewall (important)

On your VPS, open only the needed ports:
```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

---

## File Structure

```
certa-games/
├── server.js          ← Node.js WebSocket + HTTP server
├── package.json
├── nginx.conf         ← Copy to /etc/nginx/sites-available/
└── public/
    ├── index.html     ← Game shell + HUD
    └── game.js        ← Three.js 3D game engine
```

---

## Controls

| Key | Action |
|---|---|
| **WASD** or **Arrow keys** | Move |
| **Right-click + drag** | Rotate camera |
| **Scroll wheel** | Zoom in/out |
| **Space** | Jump |
| **Enter** | Open/send chat |
| **Escape** | Close chat |

---

## What's built in

- **Open world terrain** — rolling hills with procedural grass texture
- **250 trees** with stacked cone foliage + trunks
- **60 rocks** scattered across the map
- **Lake** 
- **Drifting clouds**
- **Block-style player characters** with walk animation
- **Nametag sprites** above every player
- **Third-person camera** (WoW-style right-drag orbit + scroll zoom)
- **Real-time multiplayer** via WebSockets (20 updates/sec per player)
- **Circular minimap** showing all players + trees
- **Chat system** (press Enter)
- **Coordinates HUD**
- **Player count**

---

## Expanding the game (next steps)

Here are natural next steps to grow this into a real MMO:

1. **Database** — Add PostgreSQL or MongoDB to persist player accounts/positions
2. **Authentication** — Login system with hashed passwords
3. **Zones/chunks** — Only sync nearby players to reduce bandwidth at scale
4. **Terrain editor** — Use simplex-noise or a heightmap image for more realistic terrain
5. **Combat** — Add attack/health systems, hit detection
6. **NPCs** — Server-side AI mobs with pathfinding
7. **Items/inventory** — Drops, equipment, stats
8. **Larger world** — Load terrain in chunks as the player moves
9. **Docker** — Containerize for easy deployment and scaling

---

## Monitoring

```bash
pm2 status            # see if server is running
pm2 logs certa-games  # live server logs
pm2 monit             # CPU/memory dashboard
```

---

## Troubleshooting

**WebSocket not connecting?**
- Check Cloudflare: Network → WebSockets is ON
- Check nginx config has the Upgrade headers
- Run `pm2 logs` to see errors

**Players don't see each other?**
- Make sure only one server.js is running: `pm2 list`

**Lag/jitter on other players?**
- This is normal at low player counts — the interpolation smooths it out
- At scale, implement server-side zone partitioning
