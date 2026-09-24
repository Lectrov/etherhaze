// Simulation d'un projecteur laser : galvos (inertie, vitesse max), modulation couleur
// (seuil des diodes, gamma, TTL, retard), et mesures pour les alertes.
// Une instance par laser ; `cfg` est l'objet de réglages de ce laser (modifié par l'UI).

export const SIM_RATE = 120000;   // pas de simulation des galvos (Hz)
const RING = 1 << 16;             // échantillons simulés gardés (~0,5 s)
const IRING = 1 << 15;            // points reçus (vue "idéale")
const HIST = 1024;
const REF = [1.0, 0.6, 0.9];      // proportions R/G/B (mW) qui donnent un blanc à peu près neutre

export class LaserSim {
  constructor(cfg) {
    this.cfg = cfg;
    this.RING = RING;
    this.IRING = IRING;
    this.sx = new Float32Array(RING); this.sy = new Float32Array(RING);
    this.sr = new Float32Array(RING); this.sg = new Float32Array(RING); this.sb = new Float32Array(RING);
    this.st = new Float64Array(RING); this.sw = new Float32Array(RING);
    this.sWrite = 0;
    this.ix = new Float32Array(IRING); this.iy = new Float32Array(IRING);
    this.it = new Float64Array(IRING); this.il = new Uint8Array(IRING);
    this.iWrite = 0;
    this.hr = new Float32Array(HIST); this.hg = new Float32Array(HIST); this.hb = new Float32Array(HIST);
    this.inCount = 0;
    this.galvo = { x: 0, y: 0, vx: 0, vy: 0 };
    this.lastT = 0;
    this.lastPacket = -Infinity;
    this.curRate = 0;
    this.prevLit = false; this.prevTx = 0; this.prevTy = 0;
    this.gains = [1, 1, 1];
    this.C = {};
    this.resetCounters();
    this.updateColor();
  }

  resetCounters() {
    Object.assign(this.C, { pts: 0, lit: 0, distorted: 0, litJumps: 0, tails: 0, ttlLoss: 0, below: 0, audience: 0, maxErr: 0 });
  }

  get streaming() { return performance.now() - this.lastPacket < 500; }

  // ------------------------------------------------------------ couleur
  updateColor() {
    const S = this.cfg;
    if (S.perfect) { this.gains = [1, 1, 1]; return; }
    const raw = [S.pR / REF[0], S.pG / REF[1], S.pB / REF[2]];
    const m = Math.max(...raw) || 1;
    const bright = Math.min(2, Math.max(0.25, (S.pR + S.pG + S.pB) / 1800));
    this.gains = raw.map((v) => (v / m) * bright);
  }

  chan(c) {
    const S = this.cfg;
    if (S.perfect) return c;
    if (S.colorMode === 'ttl') return c >= 0.5 ? 1 : 0;
    if (c <= S.threshold) return 0;
    return Math.pow((c - S.threshold) / (1 - S.threshold), S.gamma);
  }

  /** Couleur réellement émise pour une couleur demandée (0..1), avant normalisation. */
  render(rgb) { return rgb.map((v, i) => this.chan(v) * this.gains[i]); }

  // ------------------------------------------------------------ flux de points
  processChunk(dv, n, rate) {
    const S = this.cfg;
    this.curRate = rate;
    const now = performance.now();
    this.lastPacket = now;
    const dtp = 1000 / rate;
    let t = this.lastT;
    if (now - t > 150 || t > now) t = now - n * dtp;
    else t = Math.max(t, now - n * dtp);

    const sub = Math.max(1, Math.round(SIM_RATE / rate));
    const h = 1 / (rate * sub);
    const hMs = dtp / sub;
    const half = S.fov / 2;
    const w = 2 * Math.PI * S.kpps * 60;          // fréquence propre des galvos
    const w2 = w * w, zw2 = 2 * S.damping * w;
    const vmax = S.kpps * 1000;                    // °/s
    const perfect = S.perfect;
    const delayPts = perfect ? 0 : Math.round(S.modDelay * 1e-6 * rate);
    const ttl = S.colorMode === 'ttl';
    const lagPts = perfect ? 0 : Math.round(((2 * S.damping) / w) * rate);
    const { sx, sy, sr, sg, sb, st, sw, ix, iy, it, il, hr, hg, hb, galvo, C } = this;
    const g0 = this.gains[0], g1 = this.gains[1], g2 = this.gains[2];

    for (let k = 0, o = 8; k < n; k++, o += 12) {
      let x = dv.getInt16(o, true), y = dv.getInt16(o + 2, true);
      if (S.invX) x = -x;
      if (S.invY) y = -y;
      const tx = (x / 32767) * half, ty = (y / 32767) * half;
      const cr = dv.getUint16(o + 4, true) / 65535, cg = dv.getUint16(o + 6, true) / 65535, cb = dv.getUint16(o + 8, true) / 65535;
      const hi = this.inCount & (HIST - 1);
      hr[hi] = cr; hg[hi] = cg; hb[hi] = cb;
      this.inCount++;
      const back = this.inCount - 1 - delayPts;
      const di = back & (HIST - 1);
      const or = back >= 0 ? this.chan(hr[di]) * g0 : 0;
      const og = back >= 0 ? this.chan(hg[di]) * g1 : 0;
      const ob = back >= 0 ? this.chan(hb[di]) * g2 : 0;

      const lit = cr + cg + cb > 0.004;
      C.pts++;
      if (lit) {
        C.lit++;
        if (!perfect) {
          if (ttl) { if ((cr > 0.06 && cr < 0.94) || (cg > 0.06 && cg < 0.94) || (cb > 0.06 && cb < 0.94)) C.ttlLoss++; }
          else if ((cr > 0.004 && cr <= S.threshold) || (cg > 0.004 && cg <= S.threshold) || (cb > 0.004 && cb <= S.threshold)) C.below++;
        }
        if (this.prevLit && Math.hypot(tx - this.prevTx, ty - this.prevTy) > 0.12 * S.fov) C.litJumps++;
      }

      const ii = this.iWrite & (IRING - 1);
      ix[ii] = tx; iy[ii] = ty; it[ii] = t; il[ii] = lit ? 1 : 0;
      this.iWrite++;

      for (let s = 0; s < sub; s++) {
        if (perfect) { galvo.x = tx; galvo.y = ty; }
        else {
          galvo.vx += (w2 * (tx - galvo.x) - zw2 * galvo.vx) * h;
          galvo.vy += (w2 * (ty - galvo.y) - zw2 * galvo.vy) * h;
          if (galvo.vx > vmax) galvo.vx = vmax; else if (galvo.vx < -vmax) galvo.vx = -vmax;
          if (galvo.vy > vmax) galvo.vy = vmax; else if (galvo.vy < -vmax) galvo.vy = -vmax;
          galvo.x += galvo.vx * h;
          galvo.y += galvo.vy * h;
        }
        const si = this.sWrite & (RING - 1);
        sx[si] = galvo.x; sy[si] = galvo.y;
        sr[si] = or; sg[si] = og; sb[si] = ob;
        st[si] = t + s * hMs; sw[si] = hMs;
        this.sWrite++;
      }

      if (lit) {
        // Écart au tracé voulu, en tenant compte du retard normal des galvos
        // (compensé par le color shift du logiciel) : seule la vraie déformation compte.
        let err = Infinity;
        for (let d = Math.max(0, lagPts - 2); d <= lagPts + 2; d++) {
          const j = (this.iWrite - 1 - d) & (IRING - 1);
          const e2 = Math.hypot(ix[j] - galvo.x, iy[j] - galvo.y);
          if (e2 < err) err = e2;
        }
        err /= S.fov;
        if (err > C.maxErr) C.maxErr = err;
        if (err > 0.02) C.distorted++;
        if (!this.prevLit && err > 0.03) C.tails++;
      }
      this.prevLit = lit; this.prevTx = tx; this.prevTy = ty;
      t += dtp;
    }
    this.lastT = t;
  }

  /** Fenêtre [first, last] d'échantillons simulés entre tStart et tEnd. */
  sampleRange(tStart, tEnd) {
    const { st } = this;
    let i = this.sWrite - 1;
    const oldest = Math.max(0, this.sWrite - RING);
    while (i >= oldest && st[i & (RING - 1)] > tEnd) i--;
    const last = i;
    while (i >= oldest && st[i & (RING - 1)] >= tStart) i--;
    return { first: i + 1, last, count: last - i };
  }

  /** Nombre d'images par seconde (périodicité du tracé) → scintillement. */
  estimateFps() {
    const { ix, iy, curRate } = this;
    if (!curRate || !this.streaming) return null;
    const fov = this.cfg.fov;
    const dec = Math.max(1, Math.round(curRate / 8000));
    const N = Math.min(Math.floor(IRING / dec) - 1, Math.floor((curRate * 0.3) / dec));
    const fs = curRate / dec;
    const ax = new Float32Array(N), ay = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      const i = (this.iWrite - 1 - k * dec) & (IRING - 1);
      ax[k] = ix[i]; ay[k] = iy[i];
    }
    const lagMin = Math.max(2, Math.floor(fs / 400)), lagMax = Math.min(Math.floor(N / 2), Math.floor(fs / 6));
    if (lagMax <= lagMin) return null;
    const diff = new Float32Array(lagMax + 2);
    let best = Infinity, mean = 0;
    for (let lag = lagMin; lag <= lagMax + 1; lag++) {
      let d = 0;
      const m = N - lag;
      for (let k = 0; k < m; k += 2) d += Math.abs(ax[k] - ax[k + lag]) + Math.abs(ay[k] - ay[k + lag]);
      diff[lag] = d / (m / 2);
      mean += diff[lag];
      if (diff[lag] < best) best = diff[lag];
    }
    mean /= lagMax + 2 - lagMin;
    if (best > 0.01 * fov) return null; // pas périodique (animation)
    // La période est le PREMIER creux net (les multiples sont aussi des creux, et le
    // sous-échantillonnage empêche un creux parfait sur la vraie période).
    const thr = Math.max(best * 2, 0.25 * mean);
    let lag = 0;
    for (let l = lagMin + 1; l <= lagMax; l++) {
      if (diff[l] <= thr && diff[l] <= diff[l - 1] && diff[l] <= diff[l + 1]) { lag = l; break; }
    }
    if (!lag) return null;
    let bestP = lag * dec, bestD = Infinity;
    for (let p = (lag - 1) * dec; p <= (lag + 1) * dec; p++) {
      let d = 0;
      for (let k = 0; k < 400; k++) {
        const a = (this.iWrite - 1 - k) & (IRING - 1), b = (this.iWrite - 1 - k - p) & (IRING - 1);
        d += Math.abs(ix[a] - ix[b]) + Math.abs(iy[a] - iy[b]);
      }
      if (d < bestD) { bestD = d; bestP = p; }
    }
    return { fps: curRate / bestP, ppf: bestP };
  }
}
