// ====================================================================
// js/systems/graphics.js — v2.66 PICTURE: the graphics settings panel
// behind the Help tab's GRAPHICS button. The ask: "I can't see the
// graphics button in the help tab." There wasn't one — now the Help
// modal carries a GRAPHICS button that opens four real levers, all
// saved with the world (STATE.gfx, an optional v5 pack field):
//   SHADOWS      renderer.shadowMap + one material-needsUpdate pass
//   TREES        WF.setShown — hides the world forest, gates new chunks
//   RENDER SCALE 100 / 75 / 50% of the device's own pixel ratio
//   DETAIL       FULL / LITE — LITE forces the touch-device densities
//                on the NEXT city build (city.js reads STATE.gfx.lite)
// Additive: boot.js imports this last, passes GFX into night.js's late
// binding (the Help button) and applies the saved picture after the
// save loaded. window.GFX is the QA surface.
// ====================================================================
import { GAME_VERSION } from '../config.js';
import { STATE } from '../state.js';
import { saveGame } from '../save.js';
import { openModal, closeModal, toast } from '../ui/dom.js';
import { renderer, worldScene } from '../render/main.js';
import { WF } from '../world/worldforest.js';

// the same base the renderer booted with (render/main.js line 1 of setup)
const DPR0 = Math.min(2, window.deviceRatio || window.devicePixelRatio || 1);

// ---- the levers ------------------------------------------------------
function setShadows(on) {
  renderer.shadowMap.enabled = on !== false;
  // three.js: flipping shadowMap at runtime asks every compiled material
  // to recompile once — one traversal marks them all. Only the world
  // scene ever casts (the globe view has no shadow lights at all).
  if (worldScene) worldScene.traverse(o => {
    const m = o.material;
    if (!m) return;
    if (Array.isArray(m)) { for (const x of m) x.needsUpdate = true; }
    else m.needsUpdate = true;
  });
}
// v2.70 MOODY tone: the second reference picture is a darker, higher-
// contrast city. The lights are found in the world scene by type (their
// v2.67 base intensities are remembered the first time) — MOODY eases
// the sky fill down and the sun up, so shadows and tower faces separate.
let _base = null;
let _toneWait = null;
function setTone(t) {
  if (!worldScene) {   // the world scene is built lazily on the first enterWorld — apply the saved tone the moment it exists
    if (!_toneWait) _toneWait = setInterval(() => { if (worldScene) { clearInterval(_toneWait); _toneWait = null; setTone(norm(STATE.gfx || {}).tone); } }, 400);
    return;
  }
  const lights = [];
  worldScene.traverse(o => { if (o.isHemisphereLight || o.isDirectionalLight) lights.push(o); });
  if (!_base) _base = new Map(lights.map(l => [l, { i: l.intensity, c: l.color.getHex() }]));
  for (const l of lights) {
    const b = _base.get(l) || (_base.set(l, { i: l.intensity, c: l.color.getHex() }), _base.get(l));
    const moody = t !== 'classic';
    l.intensity = b.i * (moody ? (l.isHemisphereLight ? .8 : 1.14) : 1);
    if (l.isDirectionalLight) l.color.setHex(moody ? 0xffe9d0 : b.c);
  }
}
function setScale(f) { renderer.setPixelRatio(DPR0 * (f === .75 || f === .5 ? f : 1)); }
function setTrees(on) { try { WF.setShown(on !== false); } catch (e) { } }
const norm = g => ({ shadows: g.shadows !== false, trees: g.trees !== false, scale: g.scale === .75 || g.scale === .5 ? g.scale : 1, lite: !!g.lite, tone: g.tone === 'classic' ? 'classic' : 'moody' });

export const GFX = {
  // boot (after loadGame) + DEFAULTS — push STATE.gfx into the renderer/forest
  apply() {
    const g = norm(STATE.gfx || {});
    setShadows(g.shadows);
    setScale(g.scale);
    setTrees(g.trees);
    setTone(g.tone);
    return g;
  },
  open() {
    STATE.gfx = norm(STATE.gfx || {});
    const draw = () => {
      const g = STATE.gfx;
      const seg = (cur, opts) => opts.map(o =>
        `<button class="btn${o.v === cur ? ' primary' : ''}" data-v="${o.v}" style="flex:0 0 auto;padding:7px 13px">${o.label}</button>`).join(' ');
      openModal('Graphics — ' + GAME_VERSION, `
        <p>Five levers on the picture. The first four apply the moment you press them; DETAIL applies the next time a city builds (leave and re-enter, or travel). Saved with your world.</p>
        <div class="kv"><span class="k">SHADOWS</span><span class="v" id="gf-sh">${seg(g.shadows ? 1 : 0, [{ v: 1, label: 'ON' }, { v: 0, label: 'OFF' }])}</span></div>
        <div class="kv"><span class="k">TREES</span><span class="v" id="gf-tr">${seg(g.trees ? 1 : 0, [{ v: 1, label: 'ON' }, { v: 0, label: 'OFF' }])}</span></div>
        <div class="kv"><span class="k">RENDER SCALE</span><span class="v" id="gf-sc">${seg(g.scale, [{ v: 1, label: '100%' }, { v: .75, label: '75%' }, { v: .5, label: '50%' }])}</span></div>
        <div class="kv"><span class="k">TONE</span><span class="v" id="gf-tn">${seg(g.tone, [{ v: 'moody', label: 'MOODY' }, { v: 'classic', label: 'CLASSIC' }])}</span></div>
        <div class="kv"><span class="k">DETAIL</span><span class="v" id="gf-dt">${seg(g.lite ? 1 : 0, [{ v: 0, label: 'FULL' }, { v: 1, label: 'LITE' }])}</span></div>
        <p style="font-size:11px;color:var(--dim);margin-top:10px">LITE detail halves the street props — the densities phones already ship. TREES covers the world forest outside the cities; street trees stay.</p>
        <div style="display:flex;gap:8px;margin-top:14px">
          <button class="btn" id="gf-def" style="flex:1">DEFAULTS</button>
          <button class="btn" id="gf-x" style="flex:1">CLOSE</button>
        </div>`);
      const wire = (id, fn) => document.getElementById(id).querySelectorAll('button').forEach(b => b.onclick = () => { fn(b.dataset.v); saveGame(); draw(); });
      wire('gf-sh', v => { STATE.gfx.shadows = v === '1'; setShadows(STATE.gfx.shadows); toast(STATE.gfx.shadows ? 'Shadows on.' : 'Shadows off — a flatter, faster picture.'); });
      wire('gf-tr', v => { STATE.gfx.trees = v === '1'; setTrees(STATE.gfx.trees); toast(STATE.gfx.trees ? 'The world forest is back.' : 'World forest hidden — open country reads as parkland.'); });
      wire('gf-sc', v => { STATE.gfx.scale = +v; setScale(STATE.gfx.scale); toast('Render scale ' + Math.round(STATE.gfx.scale * 100) + '%.'); });
      wire('gf-tn', v => { STATE.gfx.tone = v === 'classic' ? 'classic' : 'moody'; setTone(STATE.gfx.tone); toast(STATE.gfx.tone === 'moody' ? 'Moody tone — deeper shadows, a warmer sun.' : 'Classic tone — the bright v2.69 picture.'); });
      wire('gf-dt', v => { STATE.gfx.lite = v === '1'; toast(STATE.gfx.lite ? 'LITE detail — the next city you enter builds light.' : 'FULL detail — the next city you enter builds full.'); });
      document.getElementById('gf-x').onclick = closeModal;
      document.getElementById('gf-def').onclick = () => { STATE.gfx = { shadows: true, trees: true, scale: 1, lite: false, tone: 'moody' }; GFX.apply(); saveGame(); toast('Picture reset to defaults.'); draw(); };
    };
    draw();
  },
  // QA / console surface
  state() { return norm(STATE.gfx || {}); },
  dpr() { return renderer.getPixelRatio(); },
  shadows() { return renderer.shadowMap.enabled; },
  tone() { return norm(STATE.gfx || {}).tone; },
};
window.GFX = GFX;
