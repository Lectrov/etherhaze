// Émetteur Art-Net de test : anime N lyres wash (profil 9 canaux, adresses 1, 10, 19...).
// Usage : node tools/dmx-test.js [--ip 127.0.0.1] [--universe 0] [--count 4] [--seconds 0]

const dgram = require('dgram');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const IP = arg('--ip', '127.0.0.1');
const UNIVERSE = Number(arg('--universe', 0));
const COUNT = Number(arg('--count', 4));
const SECONDS = Number(arg('--seconds', 0));

const sock = dgram.createSocket('udp4');
sock.bind(() => sock.setBroadcast(true));

function artDmx(data, seq) {
  const b = Buffer.alloc(18 + 512);
  b.write('Art-Net\0', 0, 'ascii');
  b.writeUInt16LE(0x5000, 8);   // OpDmx
  b.writeUInt16BE(14, 10);      // version du protocole
  b[12] = seq;
  b[14] = UNIVERSE & 0xff;
  b[15] = (UNIVERSE >> 8) & 0x7f;
  b.writeUInt16BE(512, 16);
  Buffer.from(data).copy(b, 18);
  return b;
}

const hsv = (h) => {
  const f = (n) => { const k = (n + h * 6) % 6; return Math.max(0, Math.min(1, Math.min(k, 4 - k))); };
  return [f(5), f(3), f(1)];
};

let seq = 1;
const t0 = Date.now();
console.log(`Art-Net vers ${IP}, univers ${UNIVERSE}, ${COUNT} lyres wash (adresses ${Array.from({ length: COUNT }, (_, i) => 1 + i * 9).join(', ')})`);
const timer = setInterval(() => {
  const t = (Date.now() - t0) / 1000;
  if (SECONDS && t > SECONDS) { clearInterval(timer); sock.close(); return; }
  const data = new Uint8Array(512);
  for (let i = 0; i < COUNT; i++) {
    const a = i * 9;
    const ph = t * 0.6 + i * 0.8;
    const [r, g, b] = hsv((t * 0.08 + i / COUNT) % 1);
    data[a] = 128 + Math.round(40 * Math.sin(ph));            // Pan
    data[a + 1] = 128 + Math.round(45 * Math.sin(ph * 1.3));   // Tilt
    data[a + 2] = 255;                                         // Dimmer
    data[a + 3] = Math.round(r * 255);
    data[a + 4] = Math.round(g * 255);
    data[a + 5] = Math.round(b * 255);
    data[a + 6] = 0;                                           // Blanc
    data[a + 7] = 90;                                          // Zoom
    data[a + 8] = 0;                                           // Strobe
  }
  sock.send(artDmx(data, seq), 6454, IP);
  seq = (seq % 255) + 1;
}, 25);
