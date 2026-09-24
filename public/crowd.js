// Silhouettes de public en 2D (billboards) : un atlas de silhouettes dessinées par programme,
// ou les PNG détourés que l'utilisateur dépose dans public/crowd/.
// Dans l'atlas, le corps est presque noir et les écrans de téléphone sont clairs (émissifs).

export const TILE_W = 256, TILE_H = 512;

const BODY = '#120f1c';
const SCREEN = '#dff0ff';

// Chaque variante : [bras gauche, bras droit, coiffure, carrure]
const VARIANTS = [
  ['down', 'down', 'long', 0.95],
  ['down', 'up', 'short', 1.1],
  ['up', 'up', 'bun', 0.95],
  ['down', 'phone', 'short', 1.05],
  ['down', 'down', 'cap', 1.15],
  ['up', 'down', 'afro', 1.0],
  ['up', 'up', 'short', 1.1],
  ['down', 'phone', 'long', 0.95],
  ['fist', 'down', 'cap', 1.05],
  ['down', 'down', 'short', 1.2],
  ['down', 'up', 'long', 0.9],
  ['up', 'phone', 'bun', 1.0],
];

function drawPerson(ctx, ox, variant) {
  const [armL, armR, hair, build] = variant;
  const H = TILE_H * 0.93;
  const cx = ox + TILE_W / 2;
  const foot = TILE_H - 6;
  const hip = foot - 0.47 * H;
  const sh = foot - 0.815 * H;          // épaules
  const headR = 0.062 * H;
  const headY = foot - 0.905 * H;
  const sw = 0.112 * H * build;         // demi-largeur des épaules
  const hw = 0.082 * H * (0.9 + 0.2 * (build - 0.9));
  ctx.fillStyle = BODY;
  ctx.strokeStyle = BODY;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // jambes
  ctx.lineWidth = 0.075 * H;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + s * hw * 0.55, hip);
    ctx.quadraticCurveTo(cx + s * hw * 0.62, hip + 0.25 * H, cx + s * hw * 0.7, foot - 0.03 * H);
    ctx.stroke();
  }
  // torse
  ctx.beginPath();
  ctx.moveTo(cx - sw, sh + 0.035 * H);
  ctx.quadraticCurveTo(cx - sw, sh, cx - sw * 0.55, sh - 0.004 * H);
  ctx.lineTo(cx + sw * 0.55, sh - 0.004 * H);
  ctx.quadraticCurveTo(cx + sw, sh, cx + sw, sh + 0.035 * H);
  ctx.quadraticCurveTo(cx + sw * 0.92, sh + 0.2 * H, cx + hw * 1.05, hip + 0.03 * H);
  ctx.lineTo(cx - hw * 1.05, hip + 0.03 * H);
  ctx.quadraticCurveTo(cx - sw * 0.92, sh + 0.2 * H, cx - sw, sh + 0.035 * H);
  ctx.fill();
  // cou + tête
  ctx.fillRect(cx - 0.028 * H, headY + headR * 0.6, 0.056 * H, sh - headY);
  ctx.beginPath();
  ctx.ellipse(cx, headY, headR * 0.86, headR, 0, 0, Math.PI * 2);
  ctx.fill();
  // coiffures
  ctx.beginPath();
  if (hair === 'long') {
    ctx.ellipse(cx, headY - headR * 0.1, headR * 1.02, headR * 1.08, 0, Math.PI, 0);
    ctx.lineTo(cx + headR * 1.05, sh + 0.06 * H);
    ctx.lineTo(cx - headR * 1.05, sh + 0.06 * H);
  } else if (hair === 'bun') {
    ctx.arc(cx + headR * 0.2, headY - headR * 1.15, headR * 0.45, 0, Math.PI * 2);
  } else if (hair === 'cap') {
    ctx.ellipse(cx, headY - headR * 0.35, headR * 0.98, headR * 0.72, 0, Math.PI, 0);
    ctx.rect(cx - headR * 0.2, headY - headR * 0.5, headR * 1.5, headR * 0.22);
  } else if (hair === 'afro') {
    ctx.arc(cx, headY - headR * 0.2, headR * 1.35, 0, Math.PI * 2);
  }
  ctx.fill();

  // bras
  ctx.lineWidth = 0.05 * H;
  for (const [s, kind] of [[-1, armL], [1, armR]]) {
    const x0 = cx + s * sw * 0.9, y0 = sh + 0.03 * H;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    if (kind === 'down') {
      ctx.quadraticCurveTo(cx + s * (sw + 0.025 * H), sh + 0.2 * H, cx + s * (sw + 0.005 * H), sh + 0.37 * H);
      ctx.stroke();
    } else if (kind === 'up' || kind === 'fist') {
      const hx = cx + s * (sw + (kind === 'fist' ? 0.02 : 0.08) * H), hy = sh - 0.33 * H;
      ctx.quadraticCurveTo(cx + s * (sw + 0.06 * H), sh - 0.14 * H, hx, hy);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(hx, hy - 0.012 * H, 0.03 * H, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'phone') {
      const ex = cx + s * (sw + 0.07 * H), ey = sh - 0.02 * H;
      const hx = cx + s * sw * 0.45, hy = sh - 0.2 * H;
      ctx.lineTo(ex, ey);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      // téléphone tenu en l'air, écran allumé
      const pw = 0.045 * H, ph = 0.08 * H;
      ctx.fillRect(hx - pw / 2 - 2, hy - ph - 2, pw + 4, ph + 4);
      ctx.fillStyle = SCREEN;
      ctx.fillRect(hx - pw / 2, hy - ph, pw, ph);
      ctx.fillStyle = BODY;
    }
  }
}

/** Atlas de silhouettes dessinées : { canvas, cols, rows, count }. */
export function makeProceduralAtlas() {
  const cols = 6, rows = 2;
  const c = document.createElement('canvas');
  c.width = cols * TILE_W;
  c.height = rows * TILE_H;
  const ctx = c.getContext('2d');
  VARIANTS.forEach((v, i) => {
    ctx.save();
    ctx.translate(0, Math.floor(i / cols) * TILE_H);
    drawPerson(ctx, (i % cols) * TILE_W, v);
    ctx.restore();
  });
  return { canvas: c, cols, rows, count: VARIANTS.length, photos: false };
}

/** Atlas à partir des PNG de public/crowd/ (jusqu'à 16), cadrés en bas et centrés. */
export async function loadPhotoAtlas() {
  let files = [];
  try { files = await (await fetch('/api/crowd')).json(); } catch { return null; }
  if (!files.length) return null;
  const imgs = (await Promise.all(files.slice(0, 16).map((src) => new Promise((res) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = src;
  })))).filter(Boolean);
  if (!imgs.length) return null;
  const cols = Math.min(8, imgs.length), rows = Math.ceil(imgs.length / cols);
  const c = document.createElement('canvas');
  c.width = cols * TILE_W;
  c.height = rows * TILE_H;
  const ctx = c.getContext('2d');
  imgs.forEach((im, i) => {
    const k = Math.min((TILE_W - 8) / im.width, (TILE_H - 4) / im.height);
    const w = im.width * k, h = im.height * k;
    const x = (i % cols) * TILE_W + (TILE_W - w) / 2;
    const y = Math.floor(i / cols) * TILE_H + TILE_H - h - 2;
    ctx.drawImage(im, x, y, w, h);
  });
  return { canvas: c, cols, rows, count: imgs.length, photos: true };
}
