import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LaserSim } from './sim.js';
import { makeProceduralAtlas, loadPhotoAtlas } from './crowd.js';

// ================================================================ préréglages
// Les profils sont des ordres de grandeur réalistes, pas des modèles précis.
const PROFILES = {
  cheap:   { label: 'Entrée de gamme (~15 kpps)', perfect: false, kpps: 15, damping: 0.45, fov: 30, colorMode: 'analog', threshold: 0.18, gamma: 1.5, pR: 300, pG: 150, pB: 500, modDelay: 150 },
  mid:     { label: 'Milieu de gamme (~30 kpps)', perfect: false, kpps: 30, damping: 0.6, fov: 40, colorMode: 'analog', threshold: 0.08, gamma: 1.2, pR: 800, pG: 500, pB: 800, modDelay: 80 },
  pro:     { label: 'Pro (~45 kpps)', perfect: false, kpps: 45, damping: 0.72, fov: 60, colorMode: 'analog', threshold: 0.03, gamma: 1.0, pR: 2000, pG: 1300, pB: 1900, modDelay: 30 },
  ttl:     { label: 'RGB TTL (couleurs on/off)', perfect: false, kpps: 12, damping: 0.4, fov: 30, colorMode: 'ttl', threshold: 0.5, gamma: 1, pR: 200, pG: 100, pB: 300, modDelay: 200 },
  perfect: { label: 'Parfait (aucune erreur)', perfect: true },
};
const PROFILE_KEYS = Object.keys(PROFILES.mid).filter((k) => k !== 'label');

const PLACES = {
  stage:   { label: 'Scène → au-dessus du public', py: 3.5, pz: -10, pitch: -15, yaw: 0 },
  ceiling: { label: 'Plafond → forme au sol', py: 7.5, pz: 2, pitch: 90, yaw: 0 },
  screen:  { label: 'Fond de salle → mur', py: 2.2, pz: 10, pitch: 0, yaw: 180 },
  floor:   { label: 'Au sol → vers le haut', py: 0.2, pz: -8, pitch: -90, yaw: 0 },
};

const TAG_COLORS = ['#ff3ea5', '#00e5ff', '#ffd23f', '#7cff6b', '#b36bff', '#ff7a3d', '#3d8bff', '#ff4d5e'];
const spread = (i, n) => (n > 1 ? (i - (n - 1) / 2) * 2.5 : 0);

const laserDefaults = (i = 0, n = 1) => ({
  profile: 'mid', ...stripLabel(PROFILES.mid), invX: false, invY: false,
  place: 'stage', ...stripLabel(PLACES.stage), px: spread(i, n), visible: true,
});
function stripLabel(o) { const { label, ...rest } = o; return rest; }

const G_DEFAULTS = {
  roomH: 8, walls: true, people: true, crowd: 'billboard', audience: true, audH: 3,
  haze: 0.5, smoke: 0.8, smokeSize: 1.5, smokeHeight: 4, smokeRise: 0.1, windSpeed: 0.3, windDir: 90, swirl: 0.6,
  exposure: 1.4, beamGain: 2.5, spotGain: 2.5, roomLight: 0.5, persist: 40, bloom: 1.2, quality: 'mid',
  beamWidth: 1.6, forward: 0.35, look: 'neon',
};

// ================================================================ état sauvegardé
let G = { ...G_DEFAULTS };
let L = [laserDefaults()];
let sel = 0;
(function load() {
  try {
    const saved = JSON.parse(localStorage.getItem('etherhaze') || 'null');
    if (saved) {
      Object.assign(G, saved.G);
      if (Array.isArray(saved.L) && saved.L.length) L = saved.L.map((l, i) => ({ ...laserDefaults(i), ...l }));
      sel = saved.sel || 0;
      return;
    }
    // Reprise des réglages de l'ancienne version (laserSim, un seul laser).
    const old = JSON.parse(localStorage.getItem('laserSim') || 'null');
    if (old) {
      for (const k of Object.keys(G)) if (k in old) G[k] = old[k];
      for (const k of Object.keys(L[0])) if (k in old) L[0][k] = old[k];
      if (old.laser) L[0].profile = old.laser;
    }
  } catch {}
})();
const save = () => { try { localStorage.setItem('etherhaze', JSON.stringify({ G, L, sel })); } catch {} };
const cfgOf = (i) => { while (L.length <= i) L.push(laserDefaults(L.length, i + 1)); return L[i]; };

// ================================================================ schéma de l'interface
// [portée, type, clé, libellé, ...] — portée 'L' = laser sélectionné, 'G' = scène globale.
const opt = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.label]));
const pct = (v) => Math.round(v * 100) + ' %';
const m1 = (v) => v.toFixed(1) + ' m';
const SCHEMA = [
  ['L', 'h', 'Défauts du laser'],
  ['L', 'check', 'visible', 'Affiché dans la scène'],
  ['L', 'select', 'profile', 'Profil', { ...opt(PROFILES), custom: 'Personnalisé' }],
  ['L', 'check', 'perfect', 'Mode parfait (aucune erreur)'],
  ['L', 'range', 'kpps', 'Vitesse des galvos', 5, 60, 1, (v) => v + ' kpps'],
  ['L', 'range', 'damping', 'Réglage des galvos', 0.2, 1.2, 0.01, (v) => (v < 0.5 ? 'oscille' : v > 0.9 ? 'mou' : 'correct') + ` (${v.toFixed(2)})`],
  ['L', 'range', 'fov', 'Angle de scan max', 10, 80, 1, (v) => v + '°'],
  ['L', 'check', 'invX', 'Axe X inversé (câblage)'],
  ['L', 'check', 'invY', 'Axe Y inversé (câblage)'],
  ['L', 'h', 'Couleur'],
  ['L', 'select', 'colorMode', 'Modulation', { analog: 'Analogique', ttl: 'TTL (tout ou rien)' }],
  ['L', 'range', 'threshold', 'Seuil d\'allumage des diodes', 0, 0.5, 0.01, pct],
  ['L', 'range', 'gamma', 'Courbe de réponse (gamma)', 0.6, 2.5, 0.05, (v) => v.toFixed(2)],
  ['L', 'range', 'modDelay', 'Retard de la couleur', 0, 400, 5, (v) => v + ' µs'],
  ['L', 'range', 'pR', 'Puissance rouge', 0, 3000, 50, (v) => v + ' mW'],
  ['L', 'range', 'pG', 'Puissance verte', 0, 3000, 50, (v) => v + ' mW'],
  ['L', 'range', 'pB', 'Puissance bleue', 0, 3000, 50, (v) => v + ' mW'],
  ['L', 'swatches'],
  ['L', 'h', 'Position du laser'],
  ['L', 'select', 'place', 'Placement', { ...opt(PLACES), custom: 'Personnalisé' }],
  ['L', 'range', 'px', 'Position gauche / droite', -9.5, 9.5, 0.1, m1],
  ['L', 'range', 'py', 'Hauteur', 0.1, 29.9, 0.1, m1],
  ['L', 'range', 'pz', 'Profondeur (scène → fond)', -11.5, 17.5, 0.1, m1],
  ['L', 'range', 'pitch', 'Inclinaison', -90, 90, 1, (v) => v + '°' + (v === 90 ? ' (vers le sol)' : v === -90 ? ' (vers le plafond)' : v > 0 ? ' (vers le bas)' : v < 0 ? ' (vers le haut)' : ' (horizontal)')],
  ['L', 'range', 'yaw', 'Rotation', -180, 180, 1, (v) => v + '°'],
  ['G', 'h', 'Salle'],
  ['G', 'range', 'roomH', 'Hauteur de la salle (plafond)', 3, 30, 0.5, m1],
  ['G', 'check', 'walls', 'Murs et plafond'],
  ['G', 'check', 'people', 'Public (silhouettes 1,75 m)'],
  ['G', 'select', 'crowd', 'Style du public', { billboard: 'Silhouettes 2D (découpes)', lowpoly: 'Low-poly 3D' }],
  ['G', 'check', 'audience', 'Contrôle zone public'],
  ['G', 'range', 'audH', 'Hauteur mini au-dessus du public', 2, 4, 0.1, m1],
  ['G', 'h', 'Haze et fumée'],
  ['G', 'range', 'haze', 'Haze (fine, homogène)', 0, 2, 0.01, (v) => v.toFixed(2)],
  ['G', 'range', 'smoke', 'Fumée (nuages épais)', 0, 3, 0.01, (v) => v.toFixed(2)],
  ['G', 'range', 'smokeSize', 'Taille des nuages', 0.3, 4, 0.05, m1],
  ['G', 'range', 'smokeHeight', 'Hauteur de la fumée', 0.5, 15, 0.1, m1],
  ['G', 'range', 'smokeRise', 'Montée (+) / retombée (−)', -1, 1, 0.01, (v) => (v === 0 ? 'stable' : (v > 0 ? 'monte ' : 'retombe ') + Math.abs(v).toFixed(2) + ' m/s')],
  ['G', 'range', 'windSpeed', 'Vent', 0, 3, 0.01, (v) => (v === 0 ? 'aucun' : v.toFixed(2) + ' m/s')],
  ['G', 'range', 'windDir', 'Direction du vent', 0, 359, 1, (v) => v + '° ' + ['→ public', '→ côté cour', '→ scène', '→ côté jardin'][Math.round(v / 90) % 4]],
  ['G', 'range', 'swirl', 'Tourbillons', 0, 2, 0.01, (v) => (v === 0 ? 'aucun' : v.toFixed(2))],
  ['G', 'h', 'Rendu'],
  ['G', 'range', 'exposure', 'Luminosité générale', 0.2, 4, 0.05, (v) => v.toFixed(2)],
  ['G', 'range', 'beamGain', 'Faisceaux dans la fumée', 0.1, 8, 0.1, (v) => v.toFixed(1)],
  ['G', 'range', 'spotGain', 'Impacts sur les surfaces', 0.1, 8, 0.1, (v) => v.toFixed(1)],
  ['G', 'range', 'roomLight', 'Éclairage de la salle', 0, 2, 0.05, (v) => v.toFixed(2)],
  ['G', 'range', 'beamWidth', 'Épaisseur des faisceaux', 1, 5, 0.1, (v) => v.toFixed(1) + ' px'],
  ['G', 'range', 'forward', 'Diffusion vers l\'avant', 0, 0.8, 0.01, (v) => (v === 0 ? 'uniforme' : v.toFixed(2))],
  ['G', 'range', 'bloom', 'Halo', 0, 3, 0.05, (v) => v.toFixed(2)],
  ['G', 'select', 'look', 'Style de rendu', { neon: 'Néon (couleurs pures)', camera: 'Caméra (cœurs blancs)' }],
  ['G', 'range', 'persist', 'Persistance rétinienne', 10, 120, 1, (v) => v + ' ms'],
  ['G', 'select', 'quality', 'Qualité du rendu', { low: 'Légère (PC modeste)', mid: 'Normale', high: 'Haute' }],
];

// ================================================================ scène 3D
const ROOM = { x0: -10, x1: 10, y0: 0, y1: 8, z0: -12, z1: 18 };
const AUD = { x0: -8, x1: 8, z0: -4, z1: 16 };
const D2R = Math.PI / 180;
const MAXSEG = 24000;
const QUALITY = { low: 6000, mid: 14000, high: 30000 };
const LATENCY = 35; // ms : absorbe l'arrivée irrégulière des paquets

const view = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
view.append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05040a);
const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 200);
camera.position.set(13, 5, 17);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 2, 2);
orbit.enableDamping = true;

const ambient = new THREE.AmbientLight(0xb8b0ff, 0.5);
const hemi = new THREE.HemisphereLight(0x6a5cff, 0x10101a, 0.3);
scene.add(ambient, hemi);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(ROOM.x1 - ROOM.x0, ROOM.z1 - ROOM.z0),
  new THREE.MeshStandardMaterial({ color: 0x1d1e26, roughness: 0.9 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.set(0, 0, (ROOM.z0 + ROOM.z1) / 2);
scene.add(floor);

const grid = new THREE.GridHelper(30, 30, 0x3a2f66, 0x252238);
grid.position.set(0, 0.002, (ROOM.z0 + ROOM.z1) / 2);
scene.add(grid);

const roomSize = new THREE.Vector3(ROOM.x1 - ROOM.x0, ROOM.y1 - ROOM.y0, ROOM.z1 - ROOM.z0);
const walls = new THREE.Group();
const wallMesh = new THREE.Mesh(new THREE.BoxGeometry(roomSize.x, roomSize.y, roomSize.z), new THREE.MeshStandardMaterial({ color: 0x121320, side: THREE.BackSide, roughness: 1 }));
const wallEdges = new THREE.LineSegments(new THREE.EdgesGeometry(wallMesh.geometry), new THREE.LineBasicMaterial({ color: 0x3a3560 }));
walls.add(wallMesh, wallEdges);
walls.position.set((ROOM.x0 + ROOM.x1) / 2, roomSize.y / 2, (ROOM.z0 + ROOM.z1) / 2);
scene.add(walls);

// ---- public : silhouettes low-poly (jambes, torse, tête, bras), certaines mains levées
function personGeometry(pose) {
  const parts = [];
  const add = (geo, x, y, z = 0, rz = 0, sx = 1, sz = 1) => {
    geo.scale(sx, 1, sz);
    geo.rotateZ(rz);
    geo.translate(x, y, z);
    parts.push(geo);
  };
  const limb = (r, len) => new THREE.CapsuleGeometry(r, len, 3, 8);
  add(limb(0.075, 0.72), -0.1, 0.44, 0, 0.03);                        // jambes
  add(limb(0.075, 0.72), 0.1, 0.44, 0, -0.03);
  add(limb(0.17, 0.4), 0, 1.16, 0, 0, 1.05, 0.62);                     // torse
  add(new THREE.SphereGeometry(0.105, 12, 10), 0, 1.6, 0.01, 0, 0.92); // tête
  add(limb(0.045, 0.06), 0, 1.47);                                     // cou
  const armDown = (s) => add(limb(0.05, 0.52), s * 0.25, 1.06, 0, s * 0.1);
  const armUp = (s, tilt) => add(limb(0.05, 0.56), s * 0.26, 1.74, 0.02, -s * tilt);
  if (pose === 0) { armDown(-1); armDown(1); }
  if (pose === 1) { armDown(-1); armUp(1, 0.25); }
  if (pose === 2) { armUp(-1, 0.35); armUp(1, 0.35); }
  if (pose === 3) { armDown(-1); armUp(1, 0.05); }                     // bras tendu vers la scène
  const geo = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  return geo;
}

const people = new THREE.Group();
const personMat = new THREE.MeshStandardMaterial({ color: 0x2c2840, roughness: 0.7, metalness: 0.1 });
// Contre-jour venant de la scène : découpe les silhouettes comme les lumières d'un concert.
const rimStage = new THREE.DirectionalLight(0xff3ea5, 1.6);
rimStage.position.set(0, 1.2, -14); // rasante : éclaire les corps, presque pas le sol
const rimSide = new THREE.DirectionalLight(0x00b8ff, 0.8);
rimSide.position.set(14, 0.8, -4);
scene.add(rimStage, rimSide);
// Foule plus dense près de la scène, positions et tailles pseudo-aléatoires (stables).
const crowdSpots = (() => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const list = [];
  for (let z = AUD.z0 + 0.8; z < AUD.z1 - 1; z += 0.85 + (z - AUD.z0) * 0.06) {
    for (let x = AUD.x0 + 0.6; x < AUD.x1 - 0.6; x += 0.8 + rnd() * 0.5) {
      if (rnd() < 0.18 + (z - AUD.z0) * 0.025) continue; // clairsemé vers le fond
      list.push({ x: x + (rnd() - 0.5) * 0.35, z: z + (rnd() - 0.5) * 0.35, h: 0.9 + rnd() * 0.2, w: 0.92 + rnd() * 0.16, ry: Math.PI + (rnd() - 0.5) * 0.8, r1: rnd(), r2: rnd() });
    }
  }
  return list;
})();

// Style « low-poly 3D »
const lowPolyCrowd = new THREE.Group();
{
  const poses = [0, 0, 0, 1, 1, 2, 3];
  const byPose = new Map();
  for (const it of crowdSpots) {
    const pose = poses[Math.floor(it.r1 * poses.length)];
    if (!byPose.has(pose)) byPose.set(pose, []);
    byPose.get(pose).push(it);
  }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  for (const [pose, list] of byPose) {
    const mesh = new THREE.InstancedMesh(personGeometry(pose), personMat, list.length);
    list.forEach((it, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), it.ry);
      mesh.setMatrixAt(i, m.compose(p.set(it.x, 0, it.z), q, s.set(it.w, it.h, it.w)));
    });
    lowPolyCrowd.add(mesh);
  }
}

// Style « silhouettes 2D » : découpes planes fixes, tournées vers le fond de la salle
// (léger angle aléatoire), liseré de contre-jour calculé sur le bord de la découpe.
const billboardMat = new THREE.ShaderMaterial({
  uniforms: {
    uMap: { value: null }, uCols: { value: 1 }, uRows: { value: 1 }, uTexel: { value: new THREE.Vector2() },
    uTexGain: { value: 1 }, uRim: { value: 1 },
    uRimA: { value: new THREE.Color(0xff3ea5) }, uRimB: { value: new THREE.Color(0x00b8ff) },
  },
  vertexShader: /* glsl */`
    attribute vec3 iPos; attribute vec2 iSize; attribute float iTile; attribute float iFlip; attribute float iYaw;
    uniform float uCols, uRows;
    varying vec2 vUv; varying float vSide;
    void main(){
      vec3 right = vec3(cos(iYaw), 0.0, -sin(iYaw));
      vec3 p = iPos + right * position.x * iSize.x + vec3(0.0, position.y * iSize.y, 0.0);
      vec2 uv0 = uv;
      if (iFlip > 0.5) uv0.x = 1.0 - uv0.x;
      float col = mod(iTile, uCols), row = floor(iTile / uCols);
      vUv = vec2((col + uv0.x) / uCols, 1.0 - (row + 1.0 - uv0.y) / uRows);
      vSide = uv.x;
      gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D uMap; uniform vec2 uTexel; uniform float uTexGain, uRim; uniform vec3 uRimA, uRimB;
    varying vec2 vUv; varying float vSide;
    void main(){
      vec4 t = texture2D(uMap, vUv);
      if (t.a < 0.5) discard;
      // Contre-jour : fort sur les contours du haut (tête, épaules, bras levés), léger sur les côtés.
      vec2 d = uTexel * 2.5;
      float up = texture2D(uMap, vUv + vec2(0.0, d.y)).a;
      float side = min(texture2D(uMap, vUv + vec2(d.x, 0.0)).a, texture2D(uMap, vUv - vec2(d.x, 0.0)).a);
      float edge = (1.0 - up) * 0.55 + (1.0 - side) * 0.1;
      vec3 rim = mix(uRimB, uRimA, smoothstep(0.2, 0.8, vSide)) * edge * uRim;
      gl_FragColor = vec4(t.rgb * uTexGain + rim, 1.0);
    }`,
  side: THREE.DoubleSide,
});

const billboardCrowd = (() => {
  const geo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1);
  quad.translate(0, 0.5, 0);
  geo.index = quad.index;
  geo.setAttribute('position', quad.getAttribute('position'));
  geo.setAttribute('uv', quad.getAttribute('uv'));
  const n = crowdSpots.length;
  const pos = new Float32Array(n * 3), size = new Float32Array(n * 2), tile = new Float32Array(n), flip = new Float32Array(n), yaw = new Float32Array(n);
  crowdSpots.forEach((it, i) => {
    yaw[i] = it.ry - Math.PI;              // ±0,4 rad autour de « face au fond de salle »
    pos.set([it.x, 0, it.z], i * 3);
    const h = 1.75 * it.h / 0.93;          // la silhouette occupe 93 % de la hauteur de la case
    size.set([h * 0.5, h], i * 2);
    flip[i] = it.r2 > 0.5 ? 1 : 0;
  });
  geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(pos, 3));
  geo.setAttribute('iSize', new THREE.InstancedBufferAttribute(size, 2));
  geo.setAttribute('iTile', new THREE.InstancedBufferAttribute(tile, 1));
  geo.setAttribute('iFlip', new THREE.InstancedBufferAttribute(flip, 1));
  geo.setAttribute('iYaw', new THREE.InstancedBufferAttribute(yaw, 1));
  geo.instanceCount = n;
  const mesh = new THREE.Mesh(geo, billboardMat);
  mesh.frustumCulled = false;
  return mesh;
})();

let crowdAtlas = null;
function useAtlas(atlas) {
  crowdAtlas = atlas;
  const tex = new THREE.CanvasTexture(atlas.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  billboardMat.uniforms.uMap.value?.dispose();
  const u = billboardMat.uniforms;
  u.uMap.value = tex;
  u.uCols.value = atlas.cols;
  u.uRows.value = atlas.rows;
  u.uTexel.value.set(1 / atlas.canvas.width, 1 / atlas.canvas.height);
  const tiles = billboardCrowd.geometry.getAttribute('iTile');
  crowdSpots.forEach((it, i) => { tiles.array[i] = Math.floor(it.r1 * atlas.count) % atlas.count; });
  tiles.needsUpdate = true;
  applyCrowdLook();
}
function applyCrowdLook() {
  lowPolyCrowd.visible = G.crowd === 'lowpoly';
  billboardCrowd.visible = G.crowd !== 'lowpoly';
  // Photos déposées : éclairées par la salle ; silhouettes dessinées : noires, écrans émissifs.
  billboardMat.uniforms.uTexGain.value = crowdAtlas?.photos ? 0.25 + G.roomLight * 0.6 : 1;
  billboardMat.uniforms.uRim.value = G.roomLight * 0.5;
  // Les lumières de contre-jour ne servent qu'aux silhouettes 3D (sinon elles teintent le sol).
  const k = G.crowd === 'lowpoly' && G.people ? 1 : 0;
  rimStage.intensity = G.roomLight * 3.2 * k;
  rimSide.intensity = G.roomLight * 1.6 * k;
}
useAtlas(makeProceduralAtlas());
loadPhotoAtlas().then((a) => { if (a) useAtlas(a); });

people.add(lowPolyCrowd, billboardCrowd);
scene.add(people);

const audBox = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(AUD.x1 - AUD.x0, 1, AUD.z1 - AUD.z0)),
  new THREE.LineBasicMaterial({ color: 0x5a1c24, transparent: true, opacity: 0.12 }),
);
scene.add(audBox);

// ---- matériaux partagés par tous les lasers
const NOISE = /* glsl */`
float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}`;

// Uniforms communs à tous les lasers ; chaque laser ajoute son uOrigin.
const beamUniforms = {
  uTime: { value: 0 }, uGain: { value: 1 }, uHaze: { value: 0.5 },
  uSmoke: { value: 0.8 }, uSmokeSize: { value: 1.5 }, uSmokeHeight: { value: 4 },
  uOffset: { value: new THREE.Vector3() }, uSwirl: { value: 0.6 },
  uPixAngle: { value: 0.001 }, uMinPx: { value: 1.6 }, uForward: { value: 0.35 },
  uBeamBase: { value: 0.004 }, uBeamDiv: { value: 0.0015 },
};

// Chaque faisceau est un ruban tourné vers la caméra (instancié) : largeur physique
// (diamètre + divergence) ou largeur mini à l'écran, profil gaussien doux.
const beamShader = {
  vertexShader: /* glsl */`
    uniform vec3 uOrigin;
    uniform float uPixAngle, uMinPx, uBeamBase, uBeamDiv;
    attribute vec2 corner;          // x : 0 = sortie du laser, 1 = impact ; y : côté -1 / +1
    attribute vec3 iEnd;
    attribute vec3 iColor;
    varying vec3 vColor; varying vec3 vWorld; varying float vAlong; varying float vSide; varying vec3 vDir;
    void main(){
      vec3 seg = iEnd - uOrigin;
      float len = length(seg);
      vec3 dir = len > 1e-5 ? seg / len : vec3(0.0, 0.0, 1.0);
      vec3 P = uOrigin + seg * corner.x;
      vec3 toCam = cameraPosition - P;
      vec3 side = cross(dir, toCam);
      float sl = length(side);
      side = sl > 1e-6 ? side / sl : vec3(1.0, 0.0, 0.0);
      float along = len * corner.x;
      float phys = uBeamBase + uBeamDiv * along;
      float minW = uMinPx * uPixAngle * length(toCam);
      float w = max(phys, minW);
      vColor = iColor * (minW / w);   // même énergie, étalée si le faisceau est large à l'écran
      P += side * corner.y * w;
      vWorld = P; vAlong = along; vSide = corner.y; vDir = dir;
      gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform float uTime, uGain, uHaze, uSmoke, uSmokeSize, uSmokeHeight, uSwirl, uForward;
    uniform vec3 uOffset;
    varying vec3 vColor; varying vec3 vWorld; varying float vAlong; varying float vSide; varying vec3 vDir;
    ${NOISE}
    float fbm(vec3 p){ return noise(p) * 0.55 + noise(p * 2.03 + 1.7) * 0.3 + noise(p * 4.1 + 4.3) * 0.15; }
    void main(){
      float profile = exp(-vSide * vSide * 3.0);
      // Diffusion de Henyey-Greenstein : plus brillant quand on regarde vers le laser.
      float c = dot(vDir, normalize(cameraPosition - vWorld));
      float g = uForward;
      float phase = pow(1.0 + g * g, 1.5) / pow(1.0 + g * g - 2.0 * g * c, 1.5);

      // Haze : quasi homogène, légères variations lentes.
      float haze = uHaze * (0.85 + 0.3 * noise(vWorld * 0.15 + vec3(uTime * 0.02, 0.0, uTime * 0.015)));
      // Fumée : transportée par le vent et la montée (uOffset = déplacement cumulé en mètres),
      // déformée par des tourbillons (domain warping) qui évoluent avec uTime.
      vec3 q = (vWorld - uOffset) / uSmokeSize;
      vec3 warp = vec3(noise(q * 0.5 + vec3(0.0, uTime, 0.0)),
                       noise(q * 0.5 + vec3(5.2, 1.3, uTime)),
                       noise(q * 0.5 + vec3(uTime, 9.1, 2.4)));
      float n = fbm(q + (warp - 0.5) * 2.5 * uSwirl + vec3(0.0, 0.0, uTime * 0.15));
      float clouds = smoothstep(0.38, 0.78, n);
      float layer = exp(-max(vWorld.y, 0.0) / uSmokeHeight);
      float smoke = uSmoke * clouds * layer * 3.0;
      float fade = exp(-0.03 * vAlong);
      gl_FragColor = vec4(vColor * (haze + smoke) * fade * uGain * profile * phase, 1.0);
    }`,
};

// Halo radial pour la sortie du laser.
const glowTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.15, 'rgba(255,255,255,0.6)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();

const spotMat = new THREE.ShaderMaterial({
  uniforms: { uGain: { value: 1 } },
  vertexShader: /* glsl */`
    attribute vec3 color; varying vec3 vColor;
    void main(){ vColor = color; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = clamp(36.0 / -mv.z, 2.0, 7.0); }`,
  fragmentShader: /* glsl */`
    uniform float uGain; varying vec3 vColor;
    void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; gl_FragColor = vec4(vColor * exp(-d * d * 3.0) * uGain, 1.0); }`,
  blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
});

const traceMat = new THREE.ShaderMaterial({
  uniforms: { uGain: { value: 1 } },
  vertexShader: /* glsl */`attribute vec3 color; varying vec3 vColor; void main(){ vColor = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`uniform float uGain; varying vec3 vColor; void main(){ gl_FragColor = vec4(vColor * uGain, 1.0); }`,
  blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
});

function dynAttr(geo, name, arr, size) {
  geo.setAttribute(name, new THREE.BufferAttribute(arr, size).setUsage(THREE.DynamicDrawUsage));
}

/** Objets 3D d'un laser : projecteur + faisceaux + impacts + tracé au sol. */
function createLaserObjects(tag) {
  const o = {};
  o.beamEnd = new Float32Array(MAXSEG * 3); o.beamCol = new Float32Array(MAXSEG * 3);
  o.beamGeo = new THREE.InstancedBufferGeometry();
  o.beamGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3)); // inutilisé, requis par three.js
  o.beamGeo.setAttribute('corner', new THREE.Float32BufferAttribute([0, -1, 0, 1, 1, -1, 1, 1], 2));
  o.beamGeo.setIndex([0, 2, 1, 1, 2, 3]);
  o.beamGeo.setAttribute('iEnd', new THREE.InstancedBufferAttribute(o.beamEnd, 3).setUsage(THREE.DynamicDrawUsage));
  o.beamGeo.setAttribute('iColor', new THREE.InstancedBufferAttribute(o.beamCol, 3).setUsage(THREE.DynamicDrawUsage));
  o.beamGeo.instanceCount = 0;
  o.beamMat = new THREE.ShaderMaterial({
    ...beamShader,
    uniforms: { ...beamUniforms, uOrigin: { value: new THREE.Vector3() } },
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  o.spotPos = new Float32Array(MAXSEG * 3); o.spotCol = new Float32Array(MAXSEG * 3);
  o.spotGeo = new THREE.BufferGeometry();
  dynAttr(o.spotGeo, 'position', o.spotPos, 3); dynAttr(o.spotGeo, 'color', o.spotCol, 3);
  o.tracePos = new Float32Array(MAXSEG * 6); o.traceCol = new Float32Array(MAXSEG * 6);
  o.traceGeo = new THREE.BufferGeometry();
  dynAttr(o.traceGeo, 'position', o.tracePos, 3); dynAttr(o.traceGeo, 'color', o.traceCol, 3);

  o.group = new THREE.Group();
  for (const obj of [new THREE.Mesh(o.beamGeo, o.beamMat), new THREE.Points(o.spotGeo, spotMat), new THREE.LineSegments(o.traceGeo, traceMat)]) {
    obj.frustumCulled = false;
    o.group.add(obj);
  }
  o.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, color: 0x000000 }));
  o.glow.scale.setScalar(0.9);
  o.group.add(o.glow);
  o.projector = new THREE.Group();
  o.projector.rotation.order = 'YXZ';
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.18, 0.4), new THREE.MeshStandardMaterial({ color: 0x4a5064, roughness: 0.5 }));
  body.position.z = -0.2;
  o.aperture = new THREE.Mesh(new THREE.CircleGeometry(0.035, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(tag) }));
  o.aperture.position.z = 0.001;
  o.projector.add(body, o.aperture);
  scene.add(o.group, o.projector);
  return o;
}

function disposeLaserObjects(o) {
  scene.remove(o.group, o.projector);
  o.beamGeo.dispose(); o.spotGeo.dispose(); o.traceGeo.dispose(); o.beamMat.dispose(); o.glow.material.dispose();
}

// ---- post-traitement
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), G.bloom, 0.6, 0.0);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

function resize() {
  // Pixel ratio 1 hors qualité haute : les faisceaux de 1 px restent visibles et c'est plus léger.
  renderer.setPixelRatio(G.quality === 'high' ? Math.min(2, devicePixelRatio) : 1);
  renderer.setSize(innerWidth, innerHeight);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  // Taille d'un pixel écran à 1 m de la caméra (pour la largeur mini des faisceaux).
  beamUniforms.uPixAngle.value = (2 * Math.tan((camera.fov * D2R) / 2)) / innerHeight;
}
addEventListener('resize', resize);

// ---- vues rapides
const VIEWS = {
  public: { label: 'Public', key: '1', get: () => [[0, 2.3, 17.5], [0, 3.2, -8]] },
  stage:  { label: 'Scène', key: '2', get: () => [[0, 3, -11.5], [0, 2.5, 8]] },
  top:    { label: 'Dessus', key: '3', get: () => [[0, G.roomH + 16, 3.5], [0, 0, 3]] },
  side:   { label: 'Côté', key: '4', get: () => [[19, 4.5, 3], [0, 3, 3]] },
  laser:  { label: 'Derrière le laser', key: '5', get: () => {
    const l = lasers[sel];
    if (!l) return null;
    const e = l.obj.projector.matrixWorld.elements;
    const p = l.obj.projector.position;
    return [[p.x - e[8] * 1.5, p.y - e[9] * 1.5 + 0.35, p.z - e[10] * 1.5], [p.x + e[8] * 10, p.y + e[9] * 10, p.z + e[10] * 10]];
  } },
  free:   { label: 'Libre', key: '0', get: () => [[13, 5, 17], [0, 2, 2]] },
};
let tween = null;
function goView(name) {
  const v = VIEWS[name]?.get();
  if (!v) return;
  tween = { start: performance.now(), p0: camera.position.clone(), t0: orbit.target.clone(), p1: new THREE.Vector3(...v[0]), t1: new THREE.Vector3(...v[1]) };
}
const viewsEl = document.getElementById('views');
viewsEl.innerHTML = Object.entries(VIEWS).map(([k, v]) => `<button data-v="${k}" title="Touche ${v.key}">${v.label}</button>`).join('') +
  '<button data-v="hide" title="Touche H">Masquer les panneaux</button>';
viewsEl.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.v === 'hide') togglePanels(); else goView(b.dataset.v);
});
function togglePanels() {
  document.body.classList.toggle('bare');
  viewsEl.querySelector('[data-v="hide"]').textContent = document.body.classList.contains('bare') ? 'Afficher les panneaux' : 'Masquer les panneaux';
}
addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.key === 'h' || e.key === 'H') return togglePanels();
  const v = Object.entries(VIEWS).find(([, x]) => x.key === e.key);
  if (v) goView(v[0]);
});

// ================================================================ lasers
const lasers = [];   // { index, cfg, sim, obj, status, hist, recentT, level }
let serverCount = 0;

function ensureLasers(n) {
  while (lasers.length < n) {
    const i = lasers.length;
    const cfg = cfgOf(i);
    lasers.push({
      index: i, cfg, sim: new LaserSim(cfg), obj: createLaserObjects(TAG_COLORS[i % TAG_COLORS.length]),
      status: null, hist: {}, recentT: {}, level: 'idle', alerts: [],
    });
    placeProjector(lasers[i]);
  }
  while (lasers.length > n) disposeLaserObjects(lasers.pop().obj);
  if (sel >= lasers.length) sel = lasers.length - 1;
}

function placeProjector(l) {
  const c = l.cfg;
  c.py = Math.min(c.py, G.roomH - 0.1);
  l.obj.projector.position.set(c.px, c.py, c.pz);
  l.obj.projector.rotation.set(c.pitch * D2R, c.yaw * D2R, 0);
  l.obj.projector.updateMatrixWorld(true);
  l.obj.group.visible = l.obj.projector.visible = c.visible;
}

function updateScene() {
  ROOM.y1 = G.roomH;
  walls.scale.y = G.roomH / roomSize.y;
  walls.position.y = G.roomH / 2;
  walls.visible = G.walls;
  people.visible = G.people;
  applyCrowdLook();
  audBox.visible = G.audience;
  audBox.scale.y = G.audH;
  audBox.position.set((AUD.x0 + AUD.x1) / 2, G.audH / 2, (AUD.z0 + AUD.z1) / 2);
  bloomPass.strength = G.bloom;
  renderer.toneMapping = G.look === 'camera' ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
  ambient.intensity = G.roomLight;
  hemi.intensity = G.roomLight * 0.6;
  for (const l of lasers) placeProjector(l);
}

// ================================================================ interface
const ui = {};
const controlsEl = document.getElementById('controls');
const tabsEl = document.getElementById('tabs');
let swatchesEl;
const target = (scope) => (scope === 'L' ? cfgOf(sel) : G);

function buildUI() {
  for (const [scope, type, key, label, a, b, step, fmt] of SCHEMA) {
    if (type === 'h') {
      const h = document.createElement('h3');
      h.textContent = key;
      if (scope === 'L') h.classList.add('per-laser');
      controlsEl.append(h);
      continue;
    }
    if (type === 'swatches') {
      swatchesEl = document.createElement('div');
      swatchesEl.innerHTML = '<p class="hint">Rendu réel des couleurs envoyées :</p><div class="swatches"></div>';
      controlsEl.append(swatchesEl);
      continue;
    }
    const wrap = document.createElement('div');
    wrap.className = 'ctl' + (type === 'check' ? ' check' : '');
    const lab = document.createElement('label');
    let input, out;
    if (type === 'range') {
      // Slider + champ de saisie toujours visible (Entrée ou clic ailleurs pour valider,
      // Échap pour annuler, flèches haut/bas pour ajuster d'un cran).
      input = Object.assign(document.createElement('input'), { type: 'range', min: a, max: b, step });
      const field = Object.assign(document.createElement('input'), { type: 'text', className: 'num', inputMode: 'decimal', title: `Entre ${a} et ${b}` });
      out = document.createElement('output');
      const right = document.createElement('span');
      right.className = 'val';
      right.append(field, out);
      lab.append(label, right);
      wrap.append(lab, input);
      const decimals = (String(step).split('.')[1] || '').length;
      const show = (v) => {
        if (document.activeElement !== field) field.value = Number(v).toFixed(decimals).replace('.', ',');
        // Unité ou description : le texte formaté sans le nombre de tête, sauf s'il
        // n'est pas la même valeur (pourcentages : 0,08 → « 8 % »).
        const txt = fmt(v);
        const lead = txt.match(/^-?[\d.,]+/);
        const same = lead && Math.abs(parseFloat(lead[0].replace(',', '.')) - v) < 1e-6 + 0.5 * 10 ** -decimals;
        out.textContent = same ? txt.slice(lead[0].length).trim() : txt;
      };
      const setValue = (v) => {
        const t = target(scope);
        t[key] = v;
        if (scope === 'L' && PROFILE_KEYS.includes(key)) t.profile = 'custom';
        if (scope === 'L' && ['px', 'py', 'pz', 'pitch', 'yaw'].includes(key)) t.place = 'custom';
        changed(scope, key);
      };
      const apply = () => {
        const v = parseFloat(field.value.replace(',', '.'));
        if (Number.isFinite(v)) {
          const clamped = Math.min(b, Math.max(a, v));
          input.value = clamped;
          setValue(clamped);
        }
        field.blur();
        show(target(scope)[key]);
      };
      input.addEventListener('input', () => setValue(Number(input.value)));
      field.addEventListener('focus', () => field.select());
      field.addEventListener('change', apply);
      field.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') apply();
        else if (e.key === 'Escape') { field.blur(); show(target(scope)[key]); }
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const cur = parseFloat(field.value.replace(',', '.')) || 0;
          field.value = String(+(cur + (e.key === 'ArrowUp' ? step : -step) * (e.shiftKey ? 10 : 1)).toFixed(decimals));
          apply();
          field.focus();
        }
      });
      ui[key] = { scope, input, out, fmt, type, show };
      controlsEl.append(wrap);
      continue;
    } else if (type === 'check') {
      input = Object.assign(document.createElement('input'), { type: 'checkbox' });
      lab.append(input, ' ', label);
      wrap.append(lab);
      input.addEventListener('change', () => {
        const t = target(scope);
        t[key] = input.checked;
        if (key === 'perfect') t.profile = 'custom';
        changed(scope, key);
        refreshUI();
      });
    } else {
      input = document.createElement('select');
      for (const [v, t] of Object.entries(a)) input.append(new Option(t, v));
      lab.append(label);
      wrap.append(lab, input);
      input.addEventListener('change', () => {
        const t = target(scope);
        t[key] = input.value;
        if (key === 'profile' && PROFILES[input.value]) Object.assign(t, stripLabel(PROFILES[input.value]));
        if (key === 'place' && PLACES[input.value]) {
          Object.assign(t, stripLabel(PLACES[input.value]));
          t.px = spread(sel, lasers.length);
        }
        changed(scope, key);
        refreshUI();
      });
    }
    ui[key] = { scope, input, out, fmt, type };
    controlsEl.append(wrap);
  }
}

function refreshUI() {
  for (const [key, c] of Object.entries(ui)) {
    const t = target(c.scope);
    if (c.type === 'check') c.input.checked = !!t[key];
    else c.input.value = t[key];
    if (c.show) c.show(t[key]);
  }
  const dis = cfgOf(sel).perfect;
  for (const k of ['kpps', 'damping', 'colorMode', 'threshold', 'gamma', 'modDelay', 'pR', 'pG', 'pB']) ui[k].input.disabled = dis;
  document.documentElement.style.setProperty('--tag', TAG_COLORS[sel % TAG_COLORS.length]);
  drawSwatches();
  renderTabs();
}

function changed(scope, key) {
  const c = ui[key];
  const t = target(scope);
  if (c?.show) c.show(t[key]);
  if (ui.profile) ui.profile.input.value = cfgOf(sel).profile;
  if (ui.place) ui.place.input.value = cfgOf(sel).place;
  if (scope === 'L' && lasers[sel]) lasers[sel].sim.updateColor();
  if (key === 'quality') resize();
  updateScene();
  if (key === 'roomH' && ui.py) refreshUI();
  drawSwatches();
  save();
}

function drawSwatches() {
  const l = lasers[sel];
  if (!swatchesEl || !l) return;
  const list = [['Blanc', [1, 1, 1]], ['Jaune', [1, 1, 0]], ['Orange', [1, 0.5, 0]], ['Rose', [1, 0.4, 0.7]], ['Blanc 25 %', [0.25, 0.25, 0.25]]];
  swatchesEl.querySelector('.swatches').innerHTML = list.map(([n, c]) => {
    const o = l.sim.render(c);
    const m = Math.max(1, ...o);
    const css = o.map((v) => Math.round(Math.pow(Math.min(1, v / m), 1 / 2.2) * 255)).join(',');
    return `<div><i style="background:rgb(${css})"></i>${n}</div>`;
  }).join('');
}

let ws = null;
function renderTabs() {
  const max = lastStatus?.maxLasers || 8;
  tabsEl.innerHTML = lasers.map((l, i) =>
    `<button class="tab ${i === sel ? 'active' : ''} lvl-${l.level}" data-i="${i}" style="--c:${TAG_COLORS[i % TAG_COLORS.length]}">` +
    `<i></i>L${i + 1}<small>${l.status?.port ?? ''}</small></button>`).join('') +
    `<button class="tab add" data-act="add" ${lasers.length >= max ? 'disabled' : ''} title="Ajouter un laser">+</button>` +
    `<button class="tab add" data-act="remove" ${lasers.length <= 1 ? 'disabled' : ''} title="Retirer le dernier laser">−</button>`;
}
tabsEl.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  if (b.dataset.act === 'add' || b.dataset.act === 'remove') {
    const n = lasers.length + (b.dataset.act === 'add' ? 1 : -1);
    if (b.dataset.act === 'add') {
      const c = cfgOf(n - 1);
      if (!c._placed) { c.px = spread(n - 1, n); c._placed = true; }
    }
    ws?.send(JSON.stringify({ type: 'setLasers', count: n }));
    return;
  }
  sel = Number(b.dataset.i);
  save();
  refreshUI();
  renderDac();
  renderLog();
});

// ================================================================ rendu par image
function rayHit(ox, oy, oz, dx, dy, dz) {
  let t = 60, surf = false;
  if (dy < 0) { const u = (ROOM.y0 - oy) / dy; if (u < t) { t = u; surf = true; } }
  if (G.walls) {
    if (dy > 0) { const u = (ROOM.y1 - oy) / dy; if (u < t) { t = u; surf = true; } }
    if (dx > 0) { const u = (ROOM.x1 - ox) / dx; if (u < t) { t = u; surf = true; } }
    else if (dx < 0) { const u = (ROOM.x0 - ox) / dx; if (u < t) { t = u; surf = true; } }
    if (dz > 0) { const u = (ROOM.z1 - oz) / dz; if (u < t) { t = u; surf = true; } }
    else if (dz < 0) { const u = (ROOM.z0 - oz) / dz; if (u < t) { t = u; surf = true; } }
  }
  return surf ? t : -t;
}

// Le faisceau traverse-t-il le volume du public (sous audH) avant l'impact ?
function hitsAudience(ox, oy, oz, dx, dy, dz, tMax) {
  let t0 = 0, t1 = tMax;
  const slab = (o, d, lo, hi) => {
    if (Math.abs(d) < 1e-9) return o >= lo && o <= hi;
    let a = (lo - o) / d, b = (hi - o) / d;
    if (a > b) [a, b] = [b, a];
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    return t0 <= t1;
  };
  return slab(ox, dx, AUD.x0, AUD.x1) && slab(oy, dy, -1, G.audH) && slab(oz, dz, AUD.z0, AUD.z1);
}

let audienceFlag = 0;

function buildBeams(l, now, budget) {
  const { sim, obj: o, cfg } = l;
  if (!cfg.visible) return false;
  const { first, last, count } = sim.sampleRange(now - LATENCY - G.persist, now - LATENCY);
  const step = Math.max(1, Math.ceil(count / budget));
  const { sx, sy, sr, sg, sb, sw } = sim;
  const R = sim.RING - 1;
  const e = o.projector.matrixWorld.elements;
  const ox = cfg.px, oy = cfg.py, oz = cfg.pz;
  let seg = 0, tr = 0, litN = 0, audHits = 0;
  let sumR = 0, sumG = 0, sumB = 0;
  let prevHit = false, prevK = -1, phx = 0, phy = 0, phz = 0;
  for (let k = first; k <= last; k += step) {
    const j = k & R;
    const w = (sw[j] * step) / G.persist;
    const r = sr[j] * w, g = sg[j] * w, b = sb[j] * w;
    if (r + g + b < 1e-7) { prevHit = false; continue; }
    const lx = -Math.tan(sx[j] * D2R), ly = Math.tan(sy[j] * D2R);
    let dx = e[0] * lx + e[4] * ly + e[8], dy = e[1] * lx + e[5] * ly + e[9], dz = e[2] * lx + e[6] * ly + e[10];
    const inv = 1 / Math.hypot(dx, dy, dz);
    dx *= inv; dy *= inv; dz *= inv;
    const th = rayHit(ox, oy, oz, dx, dy, dz);
    const t = Math.abs(th);
    const p3 = seg * 3;
    o.beamEnd[p3] = ox + dx * t; o.beamEnd[p3 + 1] = oy + dy * t; o.beamEnd[p3 + 2] = oz + dz * t;
    o.beamCol[p3] = r; o.beamCol[p3 + 1] = g; o.beamCol[p3 + 2] = b;
    sumR += r; sumG += g; sumB += b;
    if (th > 0) {
      const ts = t - 0.01;
      const hx = ox + dx * ts, hy = oy + dy * ts, hz = oz + dz * ts;
      o.spotPos[p3] = hx; o.spotPos[p3 + 1] = hy; o.spotPos[p3 + 2] = hz;
      o.spotCol[p3] = r; o.spotCol[p3 + 1] = g; o.spotCol[p3 + 2] = b;
      // Tracé continu : l'énergie par mètre dépend de la vitesse de balayage.
      if (prevHit && k - prevK === step) {
        const ds = Math.hypot(hx - phx, hy - phy, hz - phz);
        if (ds > 0.002 && ds < 0.6) {
          const f = Math.min(40, 1 / ds);
          const q = tr * 6;
          o.tracePos[q] = phx; o.tracePos[q + 1] = phy; o.tracePos[q + 2] = phz;
          o.tracePos[q + 3] = hx; o.tracePos[q + 4] = hy; o.tracePos[q + 5] = hz;
          o.traceCol[q] = o.traceCol[q + 3] = r * f; o.traceCol[q + 1] = o.traceCol[q + 4] = g * f; o.traceCol[q + 2] = o.traceCol[q + 5] = b * f;
          tr++;
        }
      }
      prevHit = true; prevK = k; phx = hx; phy = hy; phz = hz;
    } else {
      prevHit = false;
      o.spotCol[p3] = o.spotCol[p3 + 1] = o.spotCol[p3 + 2] = 0;
    }
    litN++;
    if (G.audience && (litN & 3) === 0 && hitsAudience(ox, oy, oz, dx, dy, dz, t)) audHits++;
    if (++seg >= MAXSEG) break;
  }
  o.beamMat.uniforms.uOrigin.value.set(ox, oy, oz);
  o.beamGeo.instanceCount = seg;
  o.spotGeo.setDrawRange(0, seg);
  o.traceGeo.setDrawRange(0, tr * 2);
  o.beamGeo.attributes.iEnd.needsUpdate = o.beamGeo.attributes.iColor.needsUpdate = true;
  // Sortie du laser : brille de la couleur moyenne émise (la somme des poids ≈ 1 pour un tracé continu).
  o.glow.position.set(ox + e[8] * 0.03, oy + e[9] * 0.03, oz + e[10] * 0.03);
  o.glow.material.color.setRGB(sumR, sumG, sumB).multiplyScalar(1.5 * G.exposure);
  o.spotGeo.attributes.position.needsUpdate = o.spotGeo.attributes.color.needsUpdate = true;
  o.traceGeo.attributes.position.needsUpdate = o.traceGeo.attributes.color.needsUpdate = true;
  if (audHits > 0) sim.C.audience++;
  return audHits > 0;
}

// ---- vue galvos 2D du laser sélectionné : ce qui est envoyé vs ce que les galvos tracent
const scope = document.getElementById('scope');
const sc = scope.getContext('2d');

function drawScope(now) {
  const l = lasers[sel];
  const W = scope.width;
  sc.globalCompositeOperation = 'source-over';
  sc.fillStyle = '#000';
  sc.fillRect(0, 0, W, W);
  sc.strokeStyle = '#1d1a2e';
  sc.strokeRect(W * 0.03, W * 0.03, W * 0.94, W * 0.94);
  if (!l) return;
  const { sim, cfg } = l;
  const half = cfg.fov / 2, k = (W / 2) * 0.94 / half;
  const px = (v) => W / 2 + v * k, py = (v) => W / 2 - v * k;
  const tEnd = now - LATENCY, tStart = tEnd - Math.max(G.persist, 30);

  // entrée idéale
  const { ix, iy, it, il } = sim;
  const IR = sim.IRING - 1;
  let i = sim.iWrite - 1;
  const oldest = Math.max(0, sim.iWrite - sim.IRING);
  while (i >= oldest && it[i & IR] > tEnd) i--;
  sc.lineWidth = 1;
  sc.strokeStyle = 'rgba(170,170,210,0.45)';
  sc.beginPath();
  let started = false, prevLit = 0, n = 0;
  for (; i >= oldest && it[i & IR] >= tStart && n < 20000; i--, n++) {
    const j = i & IR;
    if (il[j] && prevLit && started) sc.lineTo(px(ix[j]), py(iy[j]));
    else sc.moveTo(px(ix[j]), py(iy[j]));
    started = true;
    prevLit = il[j];
  }
  sc.stroke();

  // tracé simulé
  sc.globalCompositeOperation = 'lighter';
  sc.lineWidth = 2;
  const { sx, sy, sr, sg, sb } = sim;
  const { first, last } = sim.sampleRange(tStart, tEnd);
  const R = sim.RING - 1;
  let key = '', lx = null, ly = null, m = 0;
  sc.beginPath();
  for (let s = last; s >= first && m < QUALITY[G.quality]; s -= 2, m++) {
    const j = s & R;
    const mx = Math.max(sr[j], sg[j], sb[j]);
    if (mx < 0.01) { lx = null; continue; }
    const x = px(sx[j]), y = py(sy[j]);
    const q = (v) => Math.min(255, Math.round((v / Math.max(1, mx)) * 15) * 17);
    const nk = `rgb(${q(sr[j])},${q(sg[j])},${q(sb[j])})`;
    if (nk !== key) { sc.stroke(); sc.beginPath(); sc.strokeStyle = nk; key = nk; if (lx !== null) sc.moveTo(lx, ly); }
    if (lx === null) sc.moveTo(x, y); else sc.lineTo(x, y);
    lx = x; ly = y;
  }
  sc.stroke();
}

// ================================================================ statut / alertes / journal
const dacEl = document.getElementById('dac');
const alertsEl = document.getElementById('alerts');
const logEl = document.getElementById('log');
const overviewEl = document.getElementById('overview');
const waitingEl = document.getElementById('waiting');
const selTitleEl = document.getElementById('seltitle');
const PB = ['À l\'arrêt', 'Préparé', 'En lecture'];
const CAPACITY_DAC = 1799;
let lastStatus = null;
let frameMs = 0;
const events = [];

function renderDac() {
  const l = lasers[sel];
  selTitleEl.innerHTML = l ? `<i style="background:${TAG_COLORS[sel % TAG_COLORS.length]}"></i>Laser ${sel + 1} <small>127.0.0.1 : ${l.status?.port ?? '…'}</small>` : '';
  const s = l?.status;
  if (!s) { dacEl.innerHTML = '<span class="badtxt">En attente du serveur Etherhaze…</span>'; return; }
  const row = (a, b) => `<div class="row"><span>${a}</span><span>${b}</span></div>`;
  dacEl.innerHTML =
    row('Logiciel', s.client ? `<span class="good">connecté (${s.client})</span>` : '<span class="badtxt">aucun</span>') +
    row('État', s.lightEngine === 3 ? '<span class="badtxt">Arrêt d\'urgence</span>' : PB[s.playback] || '?') +
    row('Point rate', s.rate ? s.rate.toLocaleString('fr') + ' pps' : '–') +
    row('Buffer', `${s.fullness} / ${s.capacity}`) +
    `<div class="bar"><i style="width:${(100 * s.fullness) / s.capacity}%"></i></div>` +
    row('Buffer vide (underflow)', s.underflows) +
    row('Commandes refusées (NAK)', s.naks) +
    row('Points reçus', s.pointsIn.toLocaleString('fr')) +
    row('Points perdus (buffer dépassé)', s.lostPoints ? `<span class="badtxt">${s.lostPoints.toLocaleString('fr')}</span>` : '0') +
    row('Temps de rendu', `<span class="${frameMs > 12 ? 'badtxt' : ''}">${frameMs.toFixed(1)} ms</span>`);
}

function renderOverview() {
  overviewEl.innerHTML = lasers.map((l, i) => {
    const s = l.status;
    const state = l.sim.streaming ? `${(s?.rate || 0).toLocaleString('fr')} pps` : s?.client ? 'connecté, sans flux' : 'aucun logiciel';
    return `<li class="lvl-${l.level} ${i === sel ? 'active' : ''}" data-i="${i}"><i style="background:${TAG_COLORS[i % TAG_COLORS.length]}"></i>` +
      `<b>L${i + 1}</b><span>port ${s?.port ?? '…'}</span><em>${state}</em></li>`;
  }).join('');
  const any = lasers.some((l) => l.sim.streaming);
  waitingEl.classList.toggle('hidden', any);
  document.getElementById('ports').innerHTML = lasers.map((l, i) =>
    `<div><i style="background:${TAG_COLORS[i % TAG_COLORS.length]}"></i>Laser ${i + 1} → <code>127.0.0.1</code> port <code>${l.status?.port ?? '…'}</code></div>`).join('');
}
overviewEl.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  sel = Number(li.dataset.i);
  save();
  refreshUI();
  renderDac();
  renderLog();
});

function renderLog() {
  logEl.innerHTML = '';
  for (let k = events.length - 1, shown = 0; k >= 0 && shown < 40; k--) {
    const e = events[k];
    if (e.laser !== null && e.laser !== sel) continue;
    const li = document.createElement('li');
    li.className = e.level;
    li.textContent = `${new Date(e.t).toLocaleTimeString()}  ${e.msg}`;
    logEl.append(li);
    shown++;
  }
}

function addEvent(e) {
  events.push(e);
  if (events.length > 300) events.shift();
  if (e.laser === null || e.laser === sel) renderLog();
}

function computeAlerts(l) {
  const A = [];
  const now = performance.now();
  const s = l.status;
  const { sim, cfg } = l;
  const C = sim.C;
  if (s) {
    for (const k of ['underflows', 'naks', 'overflows']) {
      if (l.hist[k] === undefined) l.hist[k] = s[k]; // ne pas alerter sur l'historique au chargement
      if (s[k] > l.hist[k]) l.recentT[k] = now;
      l.hist[k] = s[k];
    }
  }
  const recent = (k) => now - (l.recentT[k] ?? -Infinity) < 6000;
  if (recent('underflows')) A.push(['bad', 'Buffer vide (underflow)', 'Le logiciel n\'envoie pas les points assez vite : le laser coupe et ça saccade. Vérifie la charge CPU (mode Perform dans TouchDesigner) et évite le Wi-Fi.']);
  if (recent('overflows')) {
    const rate = s?.rate || sim.curRate;
    const rec = rate ? Math.floor(((CAPACITY_DAC * 0.8) / rate) * 1000) / 1000 : 0.03;
    A.push(['bad', `Points perdus : buffer du DAC dépassé (${(s?.lostPoints || 0).toLocaleString('fr')} au total)`,
      `Le logiciel envoie ${s?.lastBatch || '?'} points d'un coup, mais l'Ether Dream n'en garde que ${CAPACITY_DAC}. Le reste est jeté. ` +
      `Dans TouchDesigner, garde Queue Time × point rate sous ${CAPACITY_DAC} (≈ ${rec} s${rate ? ` à ${rate.toLocaleString('fr')} pps` : ''}).`]);
  } else if (recent('naks')) A.push(['warn', 'Commandes refusées', 'Voir le journal pour le détail.']);

  if (!sim.streaming) {
    A.push(['idle', 'Aucun flux', s?.client ? 'Le logiciel est connecté mais n\'envoie rien (sortie désactivée ?).' : `Aucun logiciel connecté sur le port ${s?.port ?? '…'}.`]);
  } else {
    const lit = Math.max(1, C.lit);
    if (!cfg.perfect && sim.curRate > cfg.kpps * 1000 * 1.05)
      A.push(['warn', `Point rate trop élevé : ${sim.curRate.toLocaleString('fr')} pps pour des galvos à ${cfg.kpps} kpps`, 'Les formes seront déformées. Baisse le point rate dans le logiciel.']);
    if (C.distorted / lit > 0.08)
      A.push(['warn', `Formes déformées (erreur max ${(C.maxErr * 100).toFixed(1)} % du champ)`, 'Les galvos ne suivent pas : coins arrondis, lignes qui se tordent. Ajoute des points, réduis la taille ou la vitesse du tracé.']);
    if (C.tails > 3)
      A.push(['warn', 'Traînées au début des formes', 'Le laser s\'allume avant que les galvos soient en place. Ajoute des points d\'attente au blanking, ou règle le color shift du logiciel.']);
    if (C.litJumps > 0)
      A.push(['bad', 'Saut allumé entre deux formes', 'Une ligne parasite relie deux formes. Il manque des points de blanking (laser éteint pendant le déplacement).']);
    if (C.ttlLoss / lit > 0.05)
      A.push(['warn', 'Dégradés perdus (laser TTL)', 'En TTL chaque couleur est tout ou rien : 7 couleurs possibles, pas de dégradé ni de fondu.']);
    if (C.below / lit > 0.05)
      A.push(['warn', 'Couleurs sombres invisibles', `Des niveaux sont sous le seuil des diodes (${Math.round(cfg.threshold * 100)} %) : ils ne s'allumeront pas.`]);
    if (C.audience > 0 && G.audience)
      A.push(['bad', `Faisceau dans la zone public (sous ${G.audH.toFixed(1)} m)`, 'Tir dans le public (audience scanning) : dangereux pour les yeux et encadré par la réglementation. Remonte le laser ou réduis l\'angle.']);
    const f = sim.estimateFps();
    if (f) {
      if (f.fps < 25) A.push(['bad', `Scintillement : ${f.fps.toFixed(0)} images/s (${f.ppf} points/image)`, 'L\'œil voit le tracé clignoter. Réduis le nombre de points par image ou augmente le point rate.']);
      else if (f.fps < 35) A.push(['warn', `Léger scintillement possible : ${f.fps.toFixed(0)} images/s`, `${f.ppf} points par image. Au-dessus de 40 images/s, c'est confortable.`]);
      else A.push(['ok', `${f.fps.toFixed(0)} images/s, ${f.ppf} points par image`, 'Rafraîchissement correct.']);
    }
    if (A.every((a) => a[0] === 'ok')) A.push(['ok', 'Rien à signaler', cfg.perfect ? 'Mode parfait : les défauts du laser ne sont pas simulés.' : 'Le flux passe bien sur ce profil de laser.']);
  }
  sim.resetCounters();
  l.alerts = A;
  l.level = A.some((a) => a[0] === 'bad') ? 'bad' : A.some((a) => a[0] === 'warn') ? 'warn' : sim.streaming ? 'ok' : 'idle';
}

function tickAlerts() {
  for (const l of lasers) computeAlerts(l);
  const l = lasers[sel];
  alertsEl.innerHTML = (l?.alerts || []).map(([lvl, t, d]) => `<li class="${lvl}"><b>${t}</b><small>${d}</small></li>`).join('');
  renderTabs();
  renderOverview();
}

// ================================================================ réseau
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (m) => {
    if (typeof m.data !== 'string') {
      const dv = new DataView(m.data);
      const l = lasers[dv.getUint8(1)];
      const n = dv.getUint16(2, true), rate = dv.getUint32(4, true);
      if (l && n && rate) l.sim.processChunk(dv, n, rate);
      return;
    }
    const msg = JSON.parse(m.data);
    if (msg.type === 'status') {
      lastStatus = msg;
      if (msg.lasers.length !== serverCount) {
        serverCount = msg.lasers.length;
        ensureLasers(serverCount);
        save();
        refreshUI();
      }
      msg.lasers.forEach((s, i) => { if (lasers[i]) lasers[i].status = s; });
      renderDac();
    } else if (msg.type === 'event') addEvent(msg);
    else if (msg.type === 'history') { events.length = 0; events.push(...msg.events); renderLog(); }
  };
  ws.onclose = () => {
    for (const l of lasers) { l.status = null; l.hist = {}; }
    renderDac();
    setTimeout(connect, 1000);
  };
}

// ================================================================ boucle
buildUI();
ensureLasers(1);
updateScene();
resize();
refreshUI();
renderLog();
connect();
setInterval(tickAlerts, 700);

const clock = new THREE.Clock();
let smokeT = 0;
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  // Déplacements intégrés : changer un réglage ne fait pas sauter la fumée.
  const dt = Math.min(0.1, clock.getDelta());
  const wd = G.windDir * D2R;
  const u = beamUniforms;
  const off = u.uOffset.value;
  off.x += Math.sin(wd) * G.windSpeed * dt;
  off.z += Math.cos(wd) * G.windSpeed * dt;
  off.y += G.smokeRise * dt;
  smokeT += dt * (0.1 + 0.5 * G.swirl);
  u.uTime.value = smokeT;
  u.uMinPx.value = G.beamWidth;
  u.uForward.value = G.forward;
  u.uSwirl.value = G.swirl;
  u.uHaze.value = G.haze;
  u.uSmoke.value = G.smoke;
  u.uSmokeSize.value = G.smokeSize;
  u.uSmokeHeight.value = G.smokeHeight;
  u.uGain.value = G.beamGain * G.exposure;
  spotMat.uniforms.uGain.value = traceMat.uniforms.uGain.value = G.spotGain * G.exposure;

  const active = lasers.filter((l) => l.cfg.visible && l.sim.streaming).length || 1;
  const budget = Math.max(3000, QUALITY[G.quality] / active);
  let aud = false;
  for (const l of lasers) aud = buildBeams(l, now, budget) || aud;
  audienceFlag = aud ? 1 : Math.max(0, audienceFlag - 0.05);
  audBox.material.opacity = 0.12 + audienceFlag * 0.4;
  audBox.material.color.setHex(audienceFlag > 0.5 ? 0xa02838 : 0x5a1c24);

  drawScope(now);
  if (tween) {
    const t = Math.min(1, (now - tween.start) / 700);
    const k = t * t * (3 - 2 * t);
    camera.position.lerpVectors(tween.p0, tween.p1, k);
    orbit.target.lerpVectors(tween.t0, tween.t1, k);
    if (t >= 1) tween = null;
  }
  orbit.update();
  composer.render();
  frameMs = frameMs * 0.95 + (performance.now() - now) * 0.05;
}
frame();
