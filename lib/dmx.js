// Réception DMX sur le réseau : Art-Net (UDP 6454) et sACN / E1.31 (UDP 5568).
// Chaque univers reçu est gardé (512 valeurs) et transmis au navigateur au plus 50 fois par seconde.

const dgram = require('dgram');

const ARTNET_PORT = 6454;
const SACN_PORT = 5568;
const ARTNET_ID = Buffer.from('Art-Net\0', 'ascii');
const SACN_ID = Buffer.from('ASC-E1.17\0\0\0', 'ascii');

class DmxInput {
  /** @param {{ log(level, msg): void }} hooks */
  constructor(hooks) {
    this.hooks = hooks;
    this.universes = new Map(); // "proto:univers" → { proto, universe, data, from, count, dirty, t }
    this.sockets = [];
  }

  start() {
    this.listen(ARTNET_PORT, (msg, rinfo) => this.onArtNet(msg, rinfo), 'Art-Net');
    const s = this.listen(SACN_PORT, (msg, rinfo) => this.onSacn(msg, rinfo), 'sACN');
    // sACN est souvent envoyé en multicast (239.255.<univers>) : on s'abonne aux 32 premiers univers.
    s.once('listening', () => {
      for (let u = 1; u <= 32; u++) {
        try { s.addMembership(`239.255.${u >> 8}.${u & 255}`); } catch {}
      }
    });
  }

  listen(port, handler, name) {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('message', handler);
    s.on('error', (e) => this.hooks.log('warn', `${name} : impossible d'écouter le port ${port} (${e.message})`));
    s.bind(port, '0.0.0.0', () => this.hooks.log('info', `${name} : en écoute sur le port ${port}`));
    this.sockets.push(s);
    return s;
  }

  store(proto, universe, data, from) {
    const key = `${proto}:${universe}`;
    let u = this.universes.get(key);
    if (!u) {
      u = { proto, universe, data: new Uint8Array(512), from, count: 0, dirty: false, t: Date.now(), hz: 0 };
      this.universes.set(key, u);
      this.hooks.log('ok', `${proto === 'artnet' ? 'Art-Net' : 'sACN'} : réception de l'univers ${universe} depuis ${from}`);
    }
    u.data.fill(0);
    u.data.set(data.subarray(0, 512));
    u.from = from;
    u.count++;
    u.dirty = true;
    u.lastSeen = Date.now();
  }

  onArtNet(msg, rinfo) {
    // ArtDmx : "Art-Net\0", OpCode 0x5000 (LE), version, séquence, physique, SubUni, Net, longueur (BE), données
    if (msg.length < 18 || !msg.subarray(0, 8).equals(ARTNET_ID)) return;
    if (msg.readUInt16LE(8) !== 0x5000) return;
    const universe = ((msg[15] & 0x7f) << 8) | msg[14];
    const len = Math.min(msg.readUInt16BE(16), msg.length - 18);
    this.store('artnet', universe, msg.subarray(18, 18 + len), rinfo.address);
  }

  onSacn(msg, rinfo) {
    // E1.31 : identifiant ACN à l'octet 4, univers (BE) à 113, nombre de valeurs à 123, start code à 125.
    if (msg.length < 126 || !msg.subarray(4, 16).equals(SACN_ID)) return;
    if (msg[125] !== 0) return; // seulement le start code DMX standard
    const universe = msg.readUInt16BE(113);
    const count = Math.min(msg.readUInt16BE(123) - 1, msg.length - 126);
    this.store('sacn', universe, msg.subarray(126, 126 + count), rinfo.address);
  }

  /** Paquets binaires des univers modifiés : [3, proto, univers u16, données 512]. */
  takeUpdates() {
    const out = [];
    for (const u of this.universes.values()) {
      if (!u.dirty) continue;
      u.dirty = false;
      const b = Buffer.alloc(4 + 512);
      b[0] = 3;
      b[1] = u.proto === 'artnet' ? 0 : 1;
      b.writeUInt16LE(u.universe, 2);
      Buffer.from(u.data.buffer, u.data.byteOffset, 512).copy(b, 4);
      out.push(b);
    }
    return out;
  }

  status() {
    const now = Date.now();
    return [...this.universes.values()].map((u) => {
      const dt = (now - u.t) / 1000;
      if (dt >= 1) { u.hz = Math.round(u.count / dt); u.count = 0; u.t = now; }
      return { proto: u.proto, universe: u.universe, from: u.from, hz: u.hz, age: now - u.lastSeen };
    });
  }
}

module.exports = { DmxInput };
