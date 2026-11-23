// ====================================================================
// js/systems/proplod.js — v2.97 PROP LOD. The v2.85-v2.96 variety releases added small instanced props
// (street furniture, parked and moving cars, rooftop units, shoreline reeds and rocks, road wear) and
// more trees. From a high camera they are a pixel or less across, yet each is a draw call and a shadow
// caster. city.js now parents them to two child groups (CITY.propGroup, CITY.treeGroup); this system
// flips their `visible` flag by camera distance, with hysteresis so nothing flickers at the threshold:
//   props  hide above 450 m, show again below 380 m
//   trees  hide above 800 m, show again below 700 m
// Mid and close views (under ~400 m) are untouched. Hidden groups are skipped by both the color pass
// and the shadow pass, and the traffic fleet skips its per-frame update while its group is hidden.
// ADDITIVE: wraps WORLD.update like the forest / suburb gates. QA surface: window.PROPLOD.
// ====================================================================
import { WORLD } from '../world/world.js';
import { CITY } from '../world/city.js';

export const PROPLOD = (() => {
  const T = { props: { hide: 450, show: 380 }, trees: { hide: 800, show: 700 } };
  let enabled = true;   // QA: PROPLOD.enable(false) shows everything, for before/after measurements
  const state = { props: true, trees: true };

  function gate(g, key, d) {
    if (!g) return;
    const t = T[key];
    let vis = state[key];
    if (!enabled) vis = true;
    else if (vis && d > t.hide) vis = false;
    else if (!vis && d < t.show) vis = true;
    state[key] = vis;
    if (g.visible !== vis) g.visible = vis;
  }

  function tick(camDist) {
    if (!isFinite(camDist)) return;
    gate(CITY.propGroup, 'props', camDist);
    gate(CITY.treeGroup, 'trees', camDist);
  }

  return {
    tick, enable(on) { enabled = !!on; tick(0); return enabled; },
    get thresholds() { return T; }, get state() { return { ...state, enabled }; },
  };
})();

const __plOrigUpdate = WORLD.update.bind(WORLD);
WORLD.update = function (dt, px, pz, camDist) {
  const req = __plOrigUpdate(dt, px, pz, camDist);
  try { PROPLOD.tick(camDist); } catch (e) { console.error('[proplod]', e); }
  return req;
};
window.PROPLOD = PROPLOD;   // QA surface
