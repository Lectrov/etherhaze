// Projecteurs DMX : profils de canaux, décodage des valeurs, rendu (faisceau dans la fumée,
// flaque de lumière au sol via une SpotLight, corps du projecteur).
import * as THREE from 'three';

const D2R = Math.PI / 180;

// Profils génériques : l'ordre des canaux doit correspondre au patch dans TouchDesigner.
export const FIXTURE_PROFILES = {
  par3: { label: 'PAR RGB (3 canaux)', channels: ['Rouge', 'Vert', 'Bleu'], moving: false, zoom: [25, 25] },
  par5: { label: 'PAR dimmer + RGBW (5 canaux)', channels: ['Dimmer', 'Rouge', 'Vert', 'Bleu', 'Blanc'], moving: false, zoom: [25, 25] },
  wash: { label: 'Lyre wash (9 canaux)', channels: ['Pan', 'Tilt', 'Dimmer', 'Rouge', 'Vert', 'Bleu', 'Blanc', 'Zoom', 'Strobe'], moving: true, zoom: [10, 45] },
  beam: { label: 'Lyre beam (8 canaux)', channels: ['Pan', 'Tilt', 'Dimmer', 'Rouge', 'Vert', 'Bleu', 'Zoom', 'Strobe'], moving: true, zoom: [2, 8] },
};

export const fixtureDefaults = (i = 0, roomH = 8, nextAddress = 1) => ({
  profile: 'wash', universe: 0, address: nextAddress, mount: 'hang',
  px: -7.5 + (i % 6) * 3, py: Math.min(roomH - 0.5, 6), pz: -9, pitch: 90, yaw: 0,
  power: 1, visible: true,
});

/** Valeurs lues dans l'univers DMX (0..1) par nom de canal. */
export function readChannels(profile, dmx, address) {
  const p = FIXTURE_PROFILES[profile];
  const v = {};
  p.channels.forEach((name, k) => {
    const a = address - 1 + k;
    v[name] = dmx && a >= 0 && a < 512 ? dmx[a] / 255 : 0;
  });
  return v;
}

// Cône unitaire : sommet à l'origine, base (rayon 1) à z = 1, ouvert.
const coneGeo = new THREE.CylinderGeometry(1, 0.0001, 1, 48, 12, true);
coneGeo.translate(0, 0.5, 0);
coneGeo.rotateX(Math.PI / 2);

export class Fixture {
  /**
   * @param {object} cfg réglages du projecteur (modifiés par l'interface)
   * @param {object} ctx { scene, beamUniforms, noise } — uniforms de fumée partagés avec les lasers
   */
  constructor(cfg, ctx) {
    this.cfg = cfg;
    this.values = {};
    this.dir = new THREE.Vector3(0, -1, 0);
    this.color = new THREE.Color();
    this.level = 0;

    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...ctx.beamUniforms, uColor: { value: new THREE.Color() }, uApex: { value: new THREE.Vector3() }, uDir: { value: new THREE.Vector3() } },
      vertexShader: /* glsl */`
        varying vec3 vWorld; varying vec3 vNormalV; varying vec3 vViewV;
        void main(){
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vec4 mv = viewMatrix * wp;
          vNormalV = normalize(normalMatrix * normal);
          vViewV = -mv.xyz;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uTime, uHaze, uSmoke, uSmokeSize, uSmokeHeight, uSwirl, uForward, uSpotGain;
        uniform vec3 uOffset, uColor, uApex, uDir;
        varying vec3 vWorld; varying vec3 vNormalV; varying vec3 vViewV;
        ${ctx.noise}
        float fbm(vec3 p){ return noise(p) * 0.55 + noise(p * 2.03 + 1.7) * 0.3 + noise(p * 4.1 + 4.3) * 0.15; }
        void main(){
          vec3 d = vWorld - uApex;
          float dist = length(d);
          // Épaisseur apparente : le milieu du cône (vu de face) traverse plus de fumée que les bords.
          float thick = abs(dot(normalize(vNormalV), normalize(vViewV)));
          float haze = uHaze * (0.85 + 0.3 * noise(vWorld * 0.15 + vec3(uTime * 0.02, 0.0, uTime * 0.015)));
          float smoke = 0.0;
          if (uSmoke > 0.001) {
            vec3 q = (vWorld - uOffset) / uSmokeSize;
            vec3 warp = uSwirl > 0.001 ? vec3(noise(q * 0.5 + vec3(0.0, uTime, 0.0)), noise(q * 0.5 + vec3(5.2, 1.3, uTime)), noise(q * 0.5 + vec3(uTime, 9.1, 2.4))) : vec3(0.5);
            float n = fbm(q + (warp - 0.5) * 2.5 * uSwirl + vec3(0.0, 0.0, uTime * 0.15));
            smoke = uSmoke * smoothstep(0.38, 0.78, n) * exp(-max(vWorld.y, 0.0) / uSmokeHeight) * 3.0;
          }
          float c = dot(d / max(dist, 1e-4), normalize(cameraPosition - vWorld));
          float g = uForward;
          float phase = pow(1.0 + g * g, 1.5) / pow(1.0 + g * g - 2.0 * g * c, 1.5);
          float falloff = 1.0 / (1.0 + dist * dist * 0.015);
          float nearFade = smoothstep(0.0, 0.4, dist);
          gl_FragColor = vec4(uColor * thick * (haze + smoke) * phase * falloff * nearFade * uSpotGain, 1.0);
        }`,
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    this.cone = new THREE.Mesh(coneGeo, this.mat);
    this.cone.frustumCulled = false;

    this.light = new THREE.SpotLight(0xffffff, 0, 45, 0.3, 0.45, 1.5);
    this.light.target = new THREE.Object3D();

    this.body = new THREE.Group();
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2a33, roughness: 0.5, metalness: 0.4 });
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.17, 0.3, 16), dark);
    head.rotation.x = Math.PI / 2;
    head.position.z = -0.1;
    this.head = new THREE.Group();
    this.head.add(head);
    this.lens = new THREE.Mesh(new THREE.CircleGeometry(0.13, 20), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    this.lens.position.z = 0.051;
    this.head.add(this.lens);
    this.base = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.12, 0.3), dark);
    this.body.add(this.base, this.head);

    this.group = new THREE.Group();
    this.group.add(this.cone, this.light, this.light.target, this.body);
    ctx.scene.add(this.group);
  }

  dispose(scene) {
    scene.remove(this.group);
    this.mat.dispose();
    this.light.dispose();
  }

  /** Met à jour direction, couleur et intensité à partir de l'univers DMX. */
  update(dmx, timeSec, roomH) {
    const c = this.cfg;
    const p = FIXTURE_PROFILES[c.profile] || FIXTURE_PROFILES.par3;
    const v = (this.values = readChannels(c.profile, dmx, c.address));
    this.group.visible = c.visible;
    c.py = Math.min(c.py, roomH - 0.15);
    const pos = new THREE.Vector3(c.px, c.py, c.pz);

    // Direction du faisceau
    if (p.moving) {
      // Lyre : pan autour de la verticale (540°), tilt depuis l'axe de montage (270°).
      const pan = ((v.Pan ?? 0.5) - 0.5) * 540 * D2R + c.yaw * D2R;
      const tilt = ((v.Tilt ?? 0.5) - 0.5) * 270 * D2R;
      const s = c.mount === 'floor' ? 1 : -1;
      this.dir.set(Math.sin(tilt) * Math.sin(pan), s * Math.cos(tilt), Math.sin(tilt) * Math.cos(pan)).normalize();
      this.base.position.set(0, c.mount === 'floor' ? -0.26 : 0.26, 0);
      this.base.rotation.set(0, c.yaw * D2R, 0);
    } else {
      // PAR fixe : orienté comme un laser (inclinaison + = vers le bas, rotation).
      const e = new THREE.Euler(c.pitch * D2R, c.yaw * D2R, 0, 'YXZ');
      this.dir.set(0, 0, 1).applyEuler(e);
      this.base.position.set(0, 0.26, 0);
      this.base.rotation.set(0, c.yaw * D2R, 0);
    }

    // Couleur et intensité
    const white = v.Blanc ?? 0;
    this.color.setRGB(Math.min(1, (v.Rouge ?? 0) + white), Math.min(1, (v.Vert ?? 0) + white), Math.min(1, (v.Bleu ?? 0) + white));
    let level = v.Dimmer ?? 1;
    if (v.Strobe > 0.05) {
      const hz = 1 + v.Strobe * 19;
      if ((timeSec * hz) % 1 > 0.25) level = 0;
    }
    level *= c.power;
    this.level = level;

    const zoom = p.zoom[0] + (p.zoom[1] - p.zoom[0]) * (v.Zoom ?? 0.5);
    const half = (zoom / 2) * D2R;
    const len = 30;
    const r = Math.tan(half) * len;

    this.group.position.copy(pos);
    this.head.lookAt(pos.clone().add(this.dir));
    this.cone.scale.set(r, r, len);
    this.cone.lookAt(pos.clone().add(this.dir));
    this.mat.uniforms.uApex.value.copy(pos);
    this.mat.uniforms.uDir.value.copy(this.dir);
    // Plus le faisceau est serré, plus il est lumineux dans la fumée (même puissance, surface plus petite).
    const narrow = Math.min(6, 25 / Math.max(2, zoom));
    this.mat.uniforms.uColor.value.copy(this.color).multiplyScalar(level * 0.12 * narrow);
    this.cone.visible = level > 0.001 && this.color.getHex() !== 0;

    this.light.color.copy(this.color);
    this.light.intensity = level * 400 * narrow;
    this.light.angle = Math.min(Math.PI / 2.2, half * 1.15);
    this.light.target.position.copy(this.dir).multiplyScalar(10);
    this.lens.material.color.copy(this.color).multiplyScalar(level * 2);
  }
}
