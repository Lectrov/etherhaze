// Émetteur Ether Dream de test : trouve un DAC (vrai ou simulé) et envoie une mire.
// Usage : node tools/test-sender.js [--ip 192.168.0.50] [--port 7765] [--rate 30000] [--bad] [--seconds 20]
//   --bad : pas de blanking + point rate élevé, pour voir les erreurs dans le simulateur.

const dgram = require('dgram');
const net = require('net');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BAD = args.includes('--bad');
const RATE = Number(arg('--rate', BAD ? 60000 : 30000));
const SECONDS = Number(arg('--seconds', 0));
const PORT = Number(arg('--port', 7765));

function discover(timeoutMs) {
  return new Promise((resolve) => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const t = setTimeout(() => { s.close(); resolve(null); }, timeoutMs);
    s.on('message', (msg, rinfo) => {
      if (msg.length < 36) return;
      clearTimeout(t);
      const mac = [...msg.subarray(0, 6)].map((v) => v.toString(16).padStart(2, '0')).join(':');
      s.close();
      resolve({ ip: rinfo.address, mac });
    });
    s.on('error', () => { clearTimeout(t); resolve(null); });
    s.bind(7654);
  });
}

// Mire : cercle rouge, carré vert, dégradé bleu→blanc, avec blanking correct.
function buildFrame() {
  const pts = [];
  const add = (x, y, r, g, b) => pts.push([Math.round(x * 32000), Math.round(y * 32000), r, g, b]);
  const shape = (list, col, closed) => {
    const first = list[0];
    if (!BAD) for (let i = 0; i < 30; i++) add(first[0], first[1], 0, 0, 0);  // blank + attente que les galvos arrivent
    for (const p of list) { const c = typeof col === 'function' ? col(p) : col; add(p[0], p[1], ...c); }
    if (closed) add(first[0], first[1], ...(typeof col === 'function' ? col(first) : col));
    if (!BAD) { const l = closed ? first : list[list.length - 1]; for (let i = 0; i < 6; i++) add(l[0], l[1], 0, 0, 0); }
  };
  const circle = [];
  for (let i = 0; i < 120; i++) { const a = (i / 120) * Math.PI * 2; circle.push([-0.45 + Math.cos(a) * 0.35, 0.3 + Math.sin(a) * 0.35]); }
  shape(circle, [65535, 0, 0], true);

  const sq = [];
  const corners = [[0.15, 0.0], [0.85, 0.0], [0.85, 0.7], [0.15, 0.7]];
  for (let c = 0; c < 4; c++) {
    const a = corners[c], b = corners[(c + 1) % 4];
    for (let k = 0; k < (BAD ? 1 : 4); k++) sq.push(a);             // points répétés aux coins
    for (let k = 1; k < 25; k++) sq.push([a[0] + (b[0] - a[0]) * k / 25, a[1] + (b[1] - a[1]) * k / 25]);
  }
  shape(sq, [0, 65535, 0], true);

  const line = [];
  for (let i = 0; i <= 100; i++) line.push([-0.85 + i * 0.017, -0.6]);
  shape(line, (p) => { const t = (p[0] + 0.85) / 1.7; return [Math.round(t * 65535), Math.round(t * 65535), 65535]; }, false);
  return pts;
}

async function main() {
  let ip = arg('--ip');
  if (!ip) {
    console.log('Recherche d\'un Ether Dream (3 s)...');
    const d = await discover(3000);
    if (d) { ip = d.ip; console.log(`Trouvé : ${d.mac} sur ${ip}`); }
    else { ip = '127.0.0.1'; console.log('Aucune annonce reçue, essai sur 127.0.0.1'); }
  }
  const frame = buildFrame();
  console.log(`Mire : ${frame.length} points/frame à ${RATE} pps → ${(RATE / frame.length).toFixed(1)} images/s${BAD ? ' (mode --bad)' : ''}`);

  const sock = net.connect(PORT, ip);
  sock.setNoDelay(true);
  let rx = Buffer.alloc(0);
  const waiters = [];
  sock.on('data', (d) => {
    rx = Buffer.concat([rx, d]);
    while (rx.length >= 22) {
      const r = { code: String.fromCharCode(rx[0]), cmd: String.fromCharCode(rx[1]), playback: rx[4], fullness: rx.readUInt16LE(12), flags: rx.readUInt16LE(8) };
      rx = rx.subarray(22);
      const w = waiters.shift();
      if (w) w(r);
    }
  });
  sock.on('error', (e) => { console.error('Erreur TCP :', e.message); process.exit(1); });
  const reply = () => new Promise((res) => waiters.push(res));
  const send = (b) => { sock.write(b); return reply(); };

  await reply(); // statut initial
  let r = await send(Buffer.from('p'));
  if (r.code !== 'a') { await send(Buffer.from('s')); r = await send(Buffer.from('p')); }
  console.log('prepare :', r.code);

  let idx = 0;
  let fullness = 0;
  let started = false;
  const sendData = async (n) => {
    const b = Buffer.alloc(3 + n * 18);
    b[0] = 0x64; b.writeUInt16LE(n, 1);
    for (let k = 0; k < n; k++) {
      const p = frame[idx]; idx = (idx + 1) % frame.length;
      const o = 3 + k * 18;
      b.writeInt16LE(p[0], o + 2); b.writeInt16LE(p[1], o + 4);
      b.writeUInt16LE(p[2], o + 6); b.writeUInt16LE(p[3], o + 8); b.writeUInt16LE(p[4], o + 10);
    }
    return send(b);
  };

  const t0 = Date.now();
  for (;;) {
    if (SECONDS && Date.now() - t0 > SECONDS * 1000) break;
    const free = 1600 - fullness;
    if (free > 100) {
      r = await sendData(Math.min(free, 1000));
      if (r.code !== 'a') console.log('NAK data', r.code);
    } else {
      await new Promise((res) => setTimeout(res, 5));
      r = await send(Buffer.from('?'));
    }
    fullness = r.fullness;
    if (r.playback === 0 && started) { console.log('Underflow détecté, on relance'); r = await send(Buffer.from('p')); started = false; fullness = 0; continue; }
    if (!started && fullness > 800) {
      const b = Buffer.alloc(7); b[0] = 0x62; b.writeUInt32LE(RATE, 3);
      r = await send(b); console.log('begin :', r.code); started = true;
    }
  }
  await send(Buffer.from('s'));
  sock.end();
  console.log('Terminé.');
}

main();
