// Etherhaze : émulateur Ether Dream multi-lasers + serveur du visualiseur.
//
// Chaque laser est un Ether Dream émulé sur son propre port TCP (7765, 7766, ...).
// Les DAC s'annoncent en broadcast UDP sur le port 7654, comme les vrais.
// Les points joués sont envoyés au navigateur par WebSocket pour la simulation et le rendu.

const http = require('http');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const os = require('os');
const { WebSocketServer } = require('ws');
const { Dac, CAPACITY, MAX_RATE } = require('./lib/dac');

const HTTP_PORT = Number(process.env.PORT) || 8080;
const BASE_PORT = Number(process.env.DAC_PORT) || 7765;
const BCAST_PORT = 7654;
const MAX_LASERS = 8;
const CONFIG_FILE = path.join(__dirname, 'config.json');

// ---------------------------------------------------------------- config
let config = { lasers: 1 };
try { Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch {}
const saveConfig = () => { try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch {} };

// ---------------------------------------------------------------- journal
const eventLog = [];
// Un logiciel qui boucle peut envoyer des milliers de commandes refusées par seconde :
// chaque type de message est limité à une ligne par seconde (les chiffres ne comptent pas),
// les répétitions sont résumées ensuite. Sinon le journal ralentirait l'émulateur.
const recentKeys = new Map(); // clé → { t, suppressed, level, msg, laser }

function logEvent(level, msg, laser = null) {
  const key = `${laser}|${msg.replace(/\d+/g, '#')}`;
  const now = Date.now();
  const r = recentKeys.get(key);
  if (r && now - r.t < 1000) {
    r.suppressed++;
    Object.assign(r, { level, msg });
    return;
  }
  recentKeys.set(key, { t: now, suppressed: 0, level, msg, laser });
  emit(level, msg, laser);
}

setInterval(() => {
  const now = Date.now();
  for (const [key, r] of recentKeys) {
    if (now - r.t < 1000) continue;
    if (r.suppressed) emit(r.level, `${r.msg} (+${r.suppressed} fois en 1 s)`, r.laser);
    recentKeys.delete(key);
  }
}, 500);

function emit(level, msg, laser) {
  const e = { t: Date.now(), level, msg, laser };
  eventLog.push(e);
  if (eventLog.length > 200) eventLog.shift();
  const tag = laser === null ? '' : `[L${laser + 1}] `;
  console.log(`[${new Date().toLocaleTimeString()}] ${tag}${msg}`);
  broadcastJSON({ type: 'event', ...e });
}

// Surveillance de la boucle : distingue un logiciel trop lent d'un PC surchargé.
const loop = { last: performance.now(), bigLag: 0, bigLagAt: 0 };

// ---------------------------------------------------------------- lasers
const dacs = [];

async function setLaserCount(n) {
  n = Math.max(1, Math.min(MAX_LASERS, Math.round(n) || 1));
  while (dacs.length < n) {
    const i = dacs.length;
    const d = new Dac(i, BASE_PORT + i, { log: logEvent, loop });
    try {
      await d.listen();
    } catch (e) {
      logEvent('warn', `Impossible d'ouvrir le port ${d.port} pour le laser ${i + 1} : ${e.message}`);
      break;
    }
    dacs.push(d);
    logEvent('info', `Laser ${i + 1} prêt sur le port ${d.port}`);
  }
  while (dacs.length > n) {
    const d = dacs.pop();
    d.close();
    logEvent('info', `Laser ${d.index + 1} retiré (port ${d.port} fermé)`);
  }
  config.lasers = dacs.length;
  saveConfig();
}

// ---------------------------------------------------------------- annonce UDP
// Une annonce par laser et par carte réseau. Les logiciels qui découvrent les DAC
// par broadcast (MadMapper...) se connectent au port standard 7765 : ils ne voient
// donc vraiment que le laser 1. TouchDesigner, lui, prend l'IP et le port à la main.
const ifaces = [];

function setupInterfaces() {
  let index = 0;
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      let dest;
      if (a.internal) dest = '127.0.0.1';
      else {
        const ip = a.address.split('.').map(Number);
        const mask = a.netmask.split('.').map(Number);
        dest = ip.map((v, i) => (v & mask[i]) | (~mask[i] & 255)).join('.');
      }
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const entry = { name, address: a.address, dest, index: index++, sock, ok: true, error: null };
      sock.on('error', (e) => { entry.ok = false; entry.error = e.message; });
      sock.bind(0, a.address, () => { try { sock.setBroadcast(true); } catch {} });
      ifaces.push(entry);
    }
  }
}

const macFor = (laser, iface) => [0x02, 0x45, 0x48, 0x5a, laser, iface]; // "EHZ"

function announce() {
  for (const d of dacs) {
    for (const a of ifaces) {
      const b = Buffer.alloc(36);
      Buffer.from(macFor(d.index, a.index)).copy(b, 0);
      b.writeUInt16LE(2, 6);
      b.writeUInt16LE(2, 8);
      b.writeUInt16LE(CAPACITY, 10);
      b.writeUInt32LE(MAX_RATE, 12);
      d.writeStatus(b, 16);
      a.sock.send(b, BCAST_PORT, a.dest, (e) => {
        if (e) { a.ok = false; a.error = e.message; } else { a.ok = true; a.error = null; }
      });
    }
  }
}

// ---------------------------------------------------------------- HTTP + WebSocket
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  let root = path.join(__dirname, 'public');
  if (url.startsWith('/three/')) { root = path.join(__dirname, 'node_modules', 'three'); url = url.slice(6); }
  if (url === '/') url = '/index.html';
  const file = path.normalize(path.join(root, url));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });

function broadcastJSON(obj) {
  const s = JSON.stringify(obj);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'history', events: eventLog }));
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'setLasers') setLaserCount(msg.count);
  });
});

// Boucle de lecture : consomme les points et les pousse au navigateur.
setInterval(() => {
  const t = performance.now();
  const lag = t - loop.last;
  loop.last = t;
  if (lag > 30) { loop.bigLag = lag; loop.bigLagAt = Date.now(); }
  for (const d of dacs) {
    for (const b of d.takeChunks()) {
      for (const c of wss.clients) if (c.readyState === 1 && c.bufferedAmount < 4e6) c.send(b);
    }
  }
}, 4);

setInterval(() => {
  broadcastJSON({
    type: 'status',
    lasers: dacs.map((d) => d.status()),
    maxLasers: MAX_LASERS,
    interfaces: ifaces.map((a) => ({ name: a.name, address: a.address, ok: a.ok, error: a.error })),
  });
}, 200);

// Priorité haute : l'émulateur doit tenir le rythme même si le rendu 3D charge le PC.
try { os.setPriority(os.constants.priority.PRIORITY_HIGH); } catch {
  try { os.setPriority(os.constants.priority.PRIORITY_ABOVE_NORMAL); } catch {}
}

// ---------------------------------------------------------------- démarrage
(async () => {
  setupInterfaces();
  await setLaserCount(config.lasers);
  if (!dacs.length) {
    console.error(`\n[ERREUR] Impossible d'ouvrir le port TCP ${BASE_PORT}. Un autre émulateur tourne peut-être déjà.`);
    process.exit(1);
  }
  setInterval(announce, 1000);

  server.on('error', (e) => {
    console.error(`\n[ERREUR] Port web ${HTTP_PORT} : ${e.message}`);
    process.exit(1);
  });
  server.listen(HTTP_PORT, () => {
    const url = `http://localhost:${HTTP_PORT}`;
    console.log('==============================================');
    console.log('  ETHERHAZE : émulateur Ether Dream');
    console.log('==============================================');
    console.log(`  Visualiseur : ${url}`);
    for (const d of dacs) console.log(`  Laser ${d.index + 1}     : 127.0.0.1 port ${d.port}`);
    console.log('  Cartes réseau :');
    for (const a of ifaces) console.log(`    ${a.address.padEnd(16)} (${a.name})`);
    console.log('  Nombre de lasers réglable dans le visualiseur.');
    console.log('==============================================');
    if (!process.argv.includes('--no-open') && process.platform === 'win32') {
      require('child_process').exec(`start "" "${url}"`);
    }
  });
})();
