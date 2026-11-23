// ====================================================================
// js/systems/sky.js — v2.95 SKY: drifting clouds and a sun glow.
// ADDITIVE (AGENTS.md pattern): render/main.js is not touched. Once the world scene exists this
// system (1) swaps the sky dome's 2 px gradient for a wider canvas with the EXACT same gradient
// stops — the horizon row is still the water blue (#3479bd), so the far-plane clip still melts
// into the dome with no fog, no haze and no pale band (the v2.35 rule) — and paints a soft sun
// glow at the sun's true azimuth/elevation; (2) adds one transparent inner dome of flat-bottomed
// low-poly clouds that drifts slowly. Clouds live ABOVE the horizon only (elevation 3-40 deg),
// so nothing here ever touches the sea/sky join. The camera pitch is clamped at 0.28 rad, so the
// sky is a thin band that shows when the player tilts the view; from the usual top-down view
// nothing changes and nothing costs anything. Per frame: one rotation + one position copy.
// QA surface: window.SKY.
// ====================================================================
import * as THREE from 'three';
import { CAM_FAR } from '../config.js';
import { _mulberry } from '../util.js';
import { camera, skyDome, sun } from '../render/main.js';
import { WORLD } from '../world/world.js';

export const SKY = (() => {
  let cloudDome = null, built = false, glowAt = null;
  const W = 1024, H = 256;                       // 1024 px = 360 deg of azimuth, 256 px = 180 deg (top = zenith)
  const yOf = deg => H / 2 - deg * (H / 180);    // elevation (deg above the horizon) -> row

  // the same gradient as render/main.js skyTexture(), plus the sun glow
  function skyCanvas(sunU, sunV) {
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    const gr = ctx.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, '#6f9fc6'); gr.addColorStop(.34, '#8fb2ca'); gr.addColorStop(.46, '#75a0c2');
    gr.addColorStop(.5, '#3479bd'); gr.addColorStop(1, '#3479bd');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
    // sun glow: a soft warm ellipse (2:1 because the texture is twice as dense horizontally)
    const cx = sunU * W, cy = sunV * H;
    ctx.save(); ctx.translate(cx, cy); ctx.scale(2, 1);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 34);
    g.addColorStop(0, 'rgba(255,244,214,.75)'); g.addColorStop(.35, 'rgba(255,238,200,.32)'); g.addColorStop(1, 'rgba(255,238,200,0)');
    ctx.fillStyle = g; ctx.fillRect(-40, -40, 80, 80); ctx.restore();
    // keep the horizon row and everything below it exactly the water blue
    ctx.fillStyle = '#3479bd'; ctx.fillRect(0, H / 2, W, H / 2);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping;
    return t;
  }

  // flat-bottomed low-poly cumulus on a thin 0-46 deg cap: 4096 x 256 px = ~11 px per degree, so the
  // puffs stay crisp (the full-sphere version magnified every pixel ~5x and smeared)
  const CW = 4096, CH_ = 256, EMAX = 46, EMAXR = EMAX * Math.PI / 180;
  const cyOf = deg => CH_ * (1 - deg / EMAX);
  function cloudCanvas() {
    const cv = document.createElement('canvas'); cv.width = CW; cv.height = CH_;
    const ctx = cv.getContext('2d'), rnd = _mulberry(95);
    ctx.filter = 'blur(1.2px)';                       // soften the edges a touch
    const nC = 46;
    for (let c = 0; c < nC; c++) {
      const cx = (c + rnd() * .8) / nC * CW, deg = 5 + rnd() * rnd() * 30, base = cyOf(deg);
      const size = (.45 + rnd() * .55) * (1 - deg / 120), puffs = 3 + Math.floor(rnd() * 4);
      const P = [];
      for (let k = 0; k < puffs; k++) P.push([cx + (k - puffs / 2) * 34 * size + (rnd() - .5) * 10, base - (k % 2 ? 10 : rnd() * 5) * size, (15 + rnd() * 12) * size]);
      const draw = (dy, col) => {
        ctx.fillStyle = col;
        for (const [px, py, pr] of P) { ctx.beginPath(); ctx.ellipse(px, py + dy, pr * 1.5, pr * .95, 0, 0, 6.2832); ctx.fill(); }   // round puffs
      };
      draw(3, 'rgb(190,208,226)');           // the shaded underside
      draw(-1.5, 'rgb(248,250,252)');          // the lit top
      ctx.save(); ctx.globalCompositeOperation = 'destination-out';
      ctx.fillRect(cx - 300, base + 7 * size, 600, 40);   // slice the bottoms flat
      ctx.restore();
    }
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping;
    t.anisotropy = 4; return t;
  }

  function build() {
    if (built || !skyDome || !skyDome.parent) return;
    built = true;
    // the sun's true direction on the dome: three's sphere maps u = phi/2pi with x = -cos(phi) sin(theta), z = sin(phi) sin(theta)
    const d = sun ? sun.position.clone().sub(sun.target ? sun.target.position : new THREE.Vector3()).normalize() : new THREE.Vector3(-.66, .7, .37);
    const hor = Math.hypot(d.x, d.z) || 1;
    let phi = Math.atan2(d.z, -d.x); if (phi < 0) phi += Math.PI * 2;
    const elev = Math.atan2(d.y, hor);                       // radians above the horizon
    glowAt = { u: phi / (Math.PI * 2), v: .5 - elev / Math.PI };
    const old = skyDome.material.map;
    skyDome.material.map = skyCanvas(glowAt.u, glowAt.v); skyDome.material.needsUpdate = true;
    if (old) { try { old.dispose(); } catch (e) { } }
    cloudDome = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 6, 0, Math.PI * 2, Math.PI / 2 - EMAXR, EMAXR),
      new THREE.MeshBasicMaterial({ map: cloudCanvas(), transparent: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    cloudDome.scale.setScalar(CAM_FAR * .86);               // just inside the sky dome (.88)
    cloudDome.renderOrder = -.5;
    cloudDome.frustumCulled = false;
    skyDome.parent.add(cloudDome);
  }

  function tick(dt) {
    try {
      if (!built) build();
      if (!cloudDome) return;
      if (!cloudDome.parent || !skyDome || cloudDome.parent !== skyDome.parent) {   // the world scene was rebuilt: free the old cloud band
        try { cloudDome.geometry.dispose(); cloudDome.material.map && cloudDome.material.map.dispose(); cloudDome.material.dispose(); } catch (e) { }
        cloudDome = null; built = false; return;
      }
      cloudDome.position.copy(camera.position);
      cloudDome.rotation.y += (dt || 0.016) * .0025;         // one lap in ~42 minutes
    } catch (e) { console.error('[sky]', e); }
  }

  return { tick, build, get built() { return built; }, get glow() { return glowAt; }, get cloudDome() { return cloudDome; } };
})();

const __skyOrigUpdate = WORLD.update.bind(WORLD);
WORLD.update = function (dt, px, pz, camDist) {
  const req = __skyOrigUpdate(dt, px, pz, camDist);
  SKY.tick(dt);
  return req;
};
window.SKY = SKY;   // QA surface
