// Un Ether Dream émulé : serveur TCP + buffer de points + lecture à la vitesse demandée.
// Le comportement suit le firmware officiel (j4cDAC, firmware/net/point-stream.c) :
//   - 'd' écrit les points qui rentrent dans le buffer (1799 places), jette le reste
//     et répond NAK 'I' une fois la commande entièrement lue ;
//   - 'b' est toujours acquitté, mais ne démarre que si le flux est préparé ;
//   - une commande inconnue ferme la connexion.

const net = require('net');

const CAPACITY = 1799;       // DAC_BUFFER_POINTS (1800) - 1
const MAX_RATE = 100000;
const POINT_SIZE = 18;

const LE_READY = 0, LE_ESTOP = 3;
const PB_IDLE = 0, PB_PREPARED = 1, PB_PLAYING = 2;
const PBF_SHUTTER = 1, PBF_UNDERFLOW = 2, PBF_ESTOP = 4;
const KNOWN = new Set([0x3f, 0x64, 0x70, 0x62, 0x71, 0x73, 0x00, 0xff, 0x63, 0x76]);

class Dac {
  /**
   * @param {number} index  numéro du laser (0 = laser 1)
   * @param {number} port   port TCP
   * @param {object} hooks  { log(level, msg), loop } — loop.bigLagAt/bigLag pour détecter un PC surchargé
   */
  constructor(index, port, hooks) {
    this.index = index;
    this.port = port;
    this.hooks = hooks;
    this.lightEngine = LE_READY;
    this.playback = PB_IDLE;
    this.playbackFlags = 0;
    this.rate = 0;
    this.pointCount = 0;
    this.rateQueue = [];
    this.ctrl = new Uint16Array(CAPACITY);
    this.x = new Int16Array(CAPACITY);
    this.y = new Int16Array(CAPACITY);
    this.r = new Uint16Array(CAPACITY);
    this.g = new Uint16Array(CAPACITY);
    this.b = new Uint16Array(CAPACITY);
    this.head = 0;
    this.count = 0;
    this.acc = 0;
    this.last = process.hrtime.bigint();
    this.stats = {
      client: null, cmds: 0, pointsIn: 0, naks: 0, overflows: 0, underflows: 0,
      lastCmdAt: 0, lostPoints: 0, lastBatch: 0, pcOverload: 0,
    };
    this.outPts = [];
    this.outRate = 0;
    this.chunks = [];
    this.sock = null;
    this.server = null;
  }

  log(level, msg) { this.hooks.log(level, msg, this.index); }

  listen() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((s) => this.onConnection(s));
      this.server.once('error', reject);
      this.server.listen(this.port, '0.0.0.0', () => resolve());
    });
  }

  close() {
    if (this.sock) this.sock.destroy();
    if (this.server) this.server.close();
  }

  // ------------------------------------------------------------ buffer / lecture
  clearBuffer() {
    this.head = 0;
    this.count = 0;
    this.acc = 0;
    this.rateQueue = [];
  }

  writeStatus(buf, o) {
    buf.writeUInt8(0, o);
    buf.writeUInt8(this.lightEngine, o + 1);
    buf.writeUInt8(this.playback, o + 2);
    buf.writeUInt8(0, o + 3);
    buf.writeUInt16LE(this.lightEngine === LE_ESTOP ? 1 : 0, o + 4);
    buf.writeUInt16LE(this.playbackFlags, o + 6);
    buf.writeUInt16LE(0, o + 8);
    buf.writeUInt16LE(this.count, o + 10);
    buf.writeUInt32LE(this.playback === PB_PLAYING ? this.rate : 0, o + 12);
    buf.writeUInt32LE(this.pointCount >>> 0, o + 16);
  }

  response(code, cmd) {
    const b = Buffer.alloc(22);
    b.writeUInt8(code.charCodeAt(0), 0);
    b.writeUInt8(cmd, 1);
    this.writeStatus(b, 2);
    return b;
  }

  flushOut() {
    if (!this.outPts.length) return;
    const n = this.outPts.length / 6;
    const b = Buffer.alloc(8 + n * 12);
    b.writeUInt8(1, 0);
    b.writeUInt8(this.index, 1);
    b.writeUInt16LE(n, 2);
    b.writeUInt32LE(this.outRate, 4);
    const p = this.outPts;
    for (let i = 0, o = 8; i < p.length; i += 6, o += 12) {
      b.writeInt16LE(p[i], o);
      b.writeInt16LE(p[i + 1], o + 2);
      b.writeUInt16LE(p[i + 2], o + 4);
      b.writeUInt16LE(p[i + 3], o + 6);
      b.writeUInt16LE(p[i + 4], o + 8);
      b.writeUInt16LE(p[i + 5], o + 10);
    }
    this.chunks.push(b);
    this.outPts = [];
  }

  /** Consomme les points à la vitesse demandée, exactement comme le DAC. */
  advance() {
    const now = process.hrtime.bigint();
    let dt = Number(now - this.last) / 1e9;
    this.last = now;
    if (this.playback !== PB_PLAYING) { this.acc = 0; return; }
    if (dt > 0.05) dt = 0.05; // une pause de Node n'est pas la faute de l'émetteur
    this.acc += dt * this.rate;
    let n = Math.floor(this.acc);
    this.acc -= n;
    while (n-- > 0) {
      if (this.count === 0) { this.underflow(); break; }
      const i = this.head;
      if ((this.ctrl[i] & 0x8000) && this.rateQueue.length) {
        this.flushOut();
        this.rate = this.rateQueue.shift();
      }
      if (this.outRate !== this.rate) { this.flushOut(); this.outRate = this.rate; }
      this.outPts.push(this.x[i], this.y[i], this.r[i], this.g[i], this.b[i], this.ctrl[i]);
      this.head = (i + 1) % CAPACITY;
      this.count--;
      this.pointCount++;
    }
  }

  underflow() {
    this.playback = PB_IDLE;
    this.playbackFlags = (this.playbackFlags | PBF_UNDERFLOW) & ~PBF_SHUTTER;
    this.clearBuffer();
    this.stats.underflows++;
    const silent = Date.now() - this.stats.lastCmdAt;
    let msg = `Buffer vide (underflow) : le logiciel n'a rien envoyé pendant ${silent} ms → le laser coupe`;
    const loop = this.hooks.loop;
    if (Date.now() - loop.bigLagAt < 1500) {
      this.stats.pcOverload++;
      msg += ` (attention : le PC était surchargé, l'émulateur lui-même a été bloqué ${Math.round(loop.bigLag)} ms. Ce n'est peut-être pas la faute de ton logiciel)`;
    }
    this.log('warn', msg);
  }

  /** Paquets de points joués depuis le dernier appel (pour le navigateur). */
  takeChunks() {
    this.advance();
    this.flushOut();
    const c = this.chunks;
    this.chunks = [];
    return c;
  }

  status() {
    return {
      index: this.index, port: this.port,
      playback: this.playback, lightEngine: this.lightEngine, flags: this.playbackFlags,
      rate: this.rate, fullness: this.count, capacity: CAPACITY, pointCount: this.pointCount,
      ...this.stats,
    };
  }

  // ------------------------------------------------------------ protocole TCP
  nak(sock, code, cmd, why) {
    this.stats.naks++;
    this.log('warn', `NAK '${code}' sur '${String.fromCharCode(cmd)}' : ${why}`);
    sock.write(this.response(code, cmd));
  }

  onConnection(sock) {
    sock.setNoDelay(true);
    const ip = (sock.remoteAddress || '').replace('::ffff:', '');
    if (this.sock) {
      this.log('warn', `Nouvelle connexion de ${ip} : l'ancienne est fermée (un vrai Ether Dream n'accepte qu'un logiciel à la fois)`);
      this.sock.destroy();
    }
    this.sock = sock;
    this.stats.client = ip;
    this.log('ok', `Logiciel connecté depuis ${ip}`);

    this.advance();
    sock.write(this.response('a', 0x3f)); // le DAC envoie un statut à la connexion

    let pending = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let o = 0;
      while (o < pending.length) {
        const cmd = pending[o];
        let need = 1;
        if (cmd === 0x62) need = 7;
        else if (cmd === 0x71) need = 5;
        else if (cmd === 0x64) {
          if (pending.length - o < 3) break;
          need = 3 + pending.readUInt16LE(o + 1) * POINT_SIZE;
        }
        if (pending.length - o < need) break;
        this.advance();
        this.stats.cmds++;
        this.stats.lastCmdAt = Date.now();
        this.handle(sock, cmd, pending, o);
        if (sock.destroyed || !KNOWN.has(cmd)) return;
        o += need;
      }
      pending = pending.subarray(o);
    });

    const bye = () => {
      if (this.sock !== sock) return;
      this.sock = null;
      this.log('info', `Logiciel déconnecté (${ip})`);
      this.stats.client = null;
      this.playback = PB_IDLE;
      this.playbackFlags &= ~PBF_SHUTTER;
      this.clearBuffer();
    };
    sock.on('close', bye);
    sock.on('error', bye);
  }

  handle(sock, cmd, buf, o) {
    switch (cmd) {
      case 0x70: // 'p' prepare
        if (this.lightEngine === LE_ESTOP) return this.nak(sock, '!', cmd, 'arrêt d\'urgence actif (envoyer \'c\')');
        if (this.playback !== PB_IDLE) return this.nak(sock, 'I', cmd, 'prepare alors que la lecture n\'est pas à l\'arrêt');
        this.clearBuffer();
        this.playback = PB_PREPARED;
        this.playbackFlags &= ~PBF_UNDERFLOW;
        this.log('info', 'Prepare stream');
        return sock.write(this.response('a', cmd));

      case 0x62: { // 'b' begin
        const rate = buf.readUInt32LE(o + 3);
        if (rate > MAX_RATE) return this.nak(sock, 'I', cmd, `point rate invalide (${rate})`);
        if (this.playback !== PB_PREPARED) {
          this.log('warn', 'Begin reçu sans prepare : ignoré par le DAC');
          return sock.write(this.response('a', cmd));
        }
        this.rate = rate;
        this.playback = PB_PLAYING;
        this.playbackFlags |= PBF_SHUTTER;
        this.last = process.hrtime.bigint();
        this.log('ok', `Lecture démarrée à ${rate} pps (buffer ${this.count}/${CAPACITY})`);
        return sock.write(this.response('a', cmd));
      }

      case 0x71: { // 'q' queue rate change
        const rate = buf.readUInt32LE(o + 1);
        if (this.playback === PB_IDLE) return this.nak(sock, 'I', cmd, 'changement de rate sans stream');
        if (rate === 0 || rate > MAX_RATE) return this.nak(sock, 'I', cmd, `point rate invalide (${rate})`);
        this.rateQueue.push(rate);
        return sock.write(this.response('a', cmd));
      }

      case 0x64: { // 'd' data
        const n = buf.readUInt16LE(o + 1);
        if (this.playback === PB_IDLE) return this.nak(sock, 'I', cmd, 'données envoyées sans prepare');
        const keep = Math.min(n, CAPACITY - this.count);
        let p = o + 3;
        for (let k = 0; k < keep; k++, p += POINT_SIZE) {
          const i = (this.head + this.count) % CAPACITY;
          this.ctrl[i] = buf.readUInt16LE(p);
          this.x[i] = buf.readInt16LE(p + 2);
          this.y[i] = buf.readInt16LE(p + 4);
          this.r[i] = buf.readUInt16LE(p + 6);
          this.g[i] = buf.readUInt16LE(p + 8);
          this.b[i] = buf.readUInt16LE(p + 10);
          this.count++;
        }
        this.stats.pointsIn += keep;
        if (keep < n) {
          this.stats.overflows++;
          this.stats.lostPoints += n - keep;
          this.stats.lastBatch = n;
          const ms = this.rate ? ` (${Math.round((n / this.rate) * 1000)} ms de points)` : '';
          return this.nak(sock, 'I', cmd, `buffer plein : ${n} points envoyés d'un coup${ms}, ${keep} gardés, ${n - keep} perdus`);
        }
        return sock.write(this.response('a', cmd));
      }

      case 0x73: // 's' stop
        if (this.playback === PB_IDLE) return this.nak(sock, 'I', cmd, 'stop alors que rien ne joue');
        this.playback = PB_IDLE;
        this.playbackFlags &= ~PBF_SHUTTER;
        this.clearBuffer();
        this.log('info', 'Stop');
        return sock.write(this.response('a', cmd));

      case 0x00:
      case 0xff: // arrêt d'urgence
        this.lightEngine = LE_ESTOP;
        this.playback = PB_IDLE;
        this.playbackFlags = (this.playbackFlags | PBF_ESTOP) & ~PBF_SHUTTER;
        this.clearBuffer();
        this.log('warn', 'Arrêt d\'urgence reçu');
        return sock.write(this.response('a', cmd));

      case 0x63: // 'c' clear e-stop
        this.lightEngine = LE_READY;
        this.playbackFlags &= ~(PBF_ESTOP | PBF_UNDERFLOW);
        return sock.write(this.response('a', cmd));

      case 0x3f: // '?' ping
        return sock.write(this.response('a', cmd));

      case 0x76: { // 'v' version
        const v = Buffer.alloc(32);
        v.write('etherhaze-emulator');
        return sock.write(v);
      }

      default:
        this.log('warn', `Commande inconnue 0x${cmd.toString(16)} : connexion fermée (comme le vrai DAC)`);
        return sock.destroy();
    }
  }
}

module.exports = { Dac, CAPACITY, MAX_RATE };
