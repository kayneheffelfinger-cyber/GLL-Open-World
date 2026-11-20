// ====================================================================
// js/systems/traffic.js — v2.68 RUSH HOUR: the streets finally move.
// The ask: "Make a moving traffic." Cities already had parked cars
// (city.js props, instanced body+cab+wheels) and citizens walking
// real sidewalks (actors.js) — but nothing ever drove. This system
// runs ambient cars on the SAME road polylines the citizens patrol:
// right-lane discipline (offset flips with travel direction), class
// speeds (motorway 12.5 / secondary 9 / residential 6.5 m/s, ±12%
// per car), smooth heading (4/s), and at a polyline end it looks
// for a continuation road via roadsNear(26 m) and only U-turns
// when the street dead-ends. Cars keep 4-8 m following distance,
// queue bumper-to-bumper below that, and stop politely for the
// player figure — then relax back to cruise.
//
// It rides the AGENTS.md additive pattern with ZERO edits to the
// render layer: spawn hooks wrap ACTORS.spawnCitizens (both call
// sites in render/main.js spawn traffic with the citizens), teardown
// wraps ACTORS.reset (all five sites), and the per-frame tick wraps
// ACTORS.updateCitizens (the night.js loop calls it every frame in
// city mode). Meshes are one instanced body/cab/wheels trio in the
// CITY.group family — same dimensions and palette as the parked
// cars so a curb row and a moving row read as one fleet — and
// update() self-heals (city stamped at spawn; parent/identity
// mismatch = someone tore the city down without reset → clear).
// Nothing saves: like citizens, traffic is ambience, not state.
// QA surface: window.TRAFFIC (count / car(i) / state()).
// ====================================================================
import * as THREE from 'three';
import { _mulberry, hashStr, VEH, VEH_PAL, VEH_VAN, VEH_BUS, pickVeh, vehLen } from '../util.js';
import { STATE } from '../state.js';
import { CITY } from '../world/city.js';
import { ACTORS } from '../world/actors.js';

export const TRAFFIC = (() => {

  // class speeds in m/s (motorway/trunk/primary 3, secondary/tertiary 2,
  // residential & friends 1) — ~46/32/23 km/h reads right at game scale
  const SPEED = { 3: 12.5, 2: 9, 1: 6.5 };
  const PALETTE = VEH_PAL;   // v2.92: the shared, wider palette
  const TAXI = 0xd9b53a;

  let cars = [];
  let body = null, cab = null, wheels = null;
  let recStamp = null;   // CITY.rec identity this fleet was built for
  let rnd = _mulberry(1);

  // scratch — never allocate per frame
  const ROT = new THREE.Matrix4(), MAT = new THREE.Matrix4();
  const TMP = new THREE.Matrix4();
  // v2.92: per-kind local matrices (body scale, cab offset+scale, four wheels) — built once
  const BODY_M = VEH.map(v => new THREE.Matrix4().makeScale(v.bs[0], v.bs[1], v.bs[2]));
  const CAB_M = VEH.map(v => new THREE.Matrix4().makeTranslation(v.ct[0], v.ct[1], v.ct[2]).multiply(new THREE.Matrix4().makeScale(v.cs[0], v.cs[1], v.cs[2])));
  const WHEEL_M = VEH.map(v => [v.wx, -v.wx, v.wx, -v.wx].map((x, k) =>
    new THREE.Matrix4().makeTranslation(x, .3 * v.wr, k % 2 ? v.wz : -v.wz).multiply(new THREE.Matrix4().makeScale(v.wr, v.wr, v.wr))));

  function drivable() {
    return (CITY.roads || []).filter(r => !r.ped && r.pts && r.pts.length > 1);
  }

  // ---- fleet --------------------------------------------------------
  function spawn() {
    clear();
    const rec = CITY.rec, group = CITY.group;
    if (!rec || !group) return 0;
    const roads = drivable();
    if (!roads.length) return 0;

    // count: tier-capped, phones and the LITE detail lever halve it,
    // and a hamlet with 300 m of lane never gets a fleet of forty
    const tier = rec.tier || 2;
    const phone = matchMedia('(pointer:coarse)').matches;
    const lite = !!(STATE.gfx && STATE.gfx.lite);
    let n = [0, 20, 30, 40][tier] || 26;
    if (phone) n = Math.ceil(n * .5);
    if (lite) n = Math.ceil(n * .5);
    let total = 0;
    for (const rd of roads) for (let i = 0; i < rd.pts.length - 1; i++)
      total += Math.hypot(rd.pts[i + 1][0] - rd.pts[i][0], rd.pts[i + 1][1] - rd.pts[i][1]);
    n = Math.min(n, Math.max(4, Math.floor(total / 85)));

    // length-weighted road choice — busy arterials, quiet lanes
    const cum = [];
    let acc = 0;
    for (const rd of roads) {
      let L = 0;
      for (let i = 0; i < rd.pts.length - 1; i++)
        L += Math.hypot(rd.pts[i + 1][0] - rd.pts[i][0], rd.pts[i + 1][1] - rd.pts[i][1]);
      acc += L; cum.push(acc);
    }
    const pickRoad = () => {
      const r = rnd() * acc;
      let lo = 0, hi = cum.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < r) lo = m + 1; else hi = m; }
      return roads[lo];
    };

    // the fleet — same family as the parked cars (city.js props)
    const bodyGeo = new THREE.BoxGeometry(4.05, 1.0, 1.76); bodyGeo.translate(0, .58, 0);
    const cabGeo = new THREE.BoxGeometry(2.35, .66, 1.5); cabGeo.translate(-.26, 1.36, 0);
    const whGeo = new THREE.CylinderGeometry(.3, .3, .2, 10); whGeo.rotateZ(Math.PI / 2);
    body = new THREE.InstancedMesh(bodyGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), n);
    cab = new THREE.InstancedMesh(cabGeo, new THREE.MeshLambertMaterial({ color: 0x15181d }), n);
    wheels = new THREE.InstancedMesh(whGeo, new THREE.MeshLambertMaterial({ color: 0x1d2024 }), n * 4);
    for (const m of [body, cab, wheels]) {
      m.frustumCulled = false;   // matrices move every frame — one bounding sphere would lie
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
    body.castShadow = true;

    const tier3 = tier === 3;
    const col = new THREE.Color();
    rnd = _mulberry(hashStr('traf' + (rec.key || rec.name || 'x')));
    cars = [];
    for (let i = 0; i < n; i++) {
      const rd = pickRoad();
      const seg = Math.floor(rnd() * (rd.pts.length - 1));
      const c = {
        rd, seg, t: rnd(), dir: rnd() < .5 ? 1 : -1,
        spd: (SPEED[rd.cls] || 6.5) * (.88 + rnd() * .24),
        v: 0, h: 0,
        x: 0, z: 0, blend: 1, wait: 0,
      };
      // face down the road immediately, no spin-up pose
      const a = rd.pts[c.seg], b = rd.pts[c.seg + 1];
      const fx = (b[0] - a[0]) * c.dir, fz = (b[1] - a[1]) * c.dir;
      c.h = Math.atan2(-fz, fx);
      lane(c, a, b);
      cars.push(c);
      const taxi = tier3 && rnd() < .18;
      const pc = PALETTE[Math.floor(rnd() * PALETTE.length)];                  // same rnd draws as before
      // v2.92: the kind comes from its own hash, so the fleet's roads / speeds / colors above are unchanged
      const vk = taxi ? 0 : pickVeh((hashStr('vk' + (rec.key || rec.name || 'x') + i) % 1000) / 1000, tier >= 2 && rd.cls >= 2);
      c.kind = vk;
      body.setColorAt(i, col.set(taxi ? TAXI : vk === 5 ? VEH_BUS[i % VEH_BUS.length] : vk === 4 ? VEH_VAN[i % VEH_VAN.length] : pc));
      stampCar(i);
    }
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
    for (const m of [body, cab, wheels]) m.instanceMatrix.needsUpdate = true;
    // v2.27 city-local frame: instances carry world-minus-anchor, so the
    // meshes themselves must sit AT the anchor — same trick as the parked
    // rows (without this the whole fleet renders at the world origin)
    const A = CITY.anchor || { x: 0, z: 0 };
    body.position.set(A.x, 0, A.z);
    cab.position.set(A.x, 0, A.z);
    wheels.position.set(A.x, 0, A.z);
    recStamp = rec;
    group.add(body, cab, wheels);
    return n;
  }

  // lane point for a car mid-segment — right-hand side of travel:
  // forward f=(fx,fz) UNIT puts the driver's right at (-fz, fx)
  function lane(c, a, b) {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz) || 1;
    const fx = dx * c.dir / L, fz = dz * c.dir / L;
    const off = c.rd.w / 4;
    c.x = a[0] + dx * c.t - fz * off;
    c.z = a[1] + dz * c.t + fx * off;
  }

  // write instance matrices for car i at its current x/z/heading
  function stampCar(i) {
    const c = cars[i];
    const A = CITY.anchor || { x: 0, z: 0 };
    ROT.makeRotationY(c.h);
    MAT.copy(ROT); MAT.setPosition(c.x - A.x, 0, c.z - A.z);
    const k = c.kind | 0;
    body.setMatrixAt(i, TMP.multiplyMatrices(MAT, BODY_M[k]));
    cab.setMatrixAt(i, TMP.multiplyMatrices(MAT, CAB_M[k]));
    for (let w = 0; w < 4; w++)
      wheels.setMatrixAt(i * 4 + w, TMP.multiplyMatrices(MAT, WHEEL_M[k][w]));
  }

  // polyline end: hop to a nearby street when one exists, U-turn if not
  function hopRoad(c) {
    const rd = c.rd;
    const x = c.dir > 0 ? rd.pts[rd.pts.length - 1][0] : rd.pts[0][0];
    const z = c.dir > 0 ? rd.pts[rd.pts.length - 1][1] : rd.pts[0][1];
    const all = CITY.roads || [];
    const cand = (CITY.roadsNear(x, z, 26) || [])
      .map(i => all[i])
      .filter(r => r && r !== rd && !r.ped && r.pts.length > 1);
    if (!cand.length) {   // dead end — turn the car around
      c.dir = -c.dir;
      c.seg = c.dir > 0 ? 0 : rd.pts.length - 2;
      c.t = c.dir > 0 ? 0 : 1;
      c.blend = .25;
      return;
    }
    const r2 = cand[Math.floor(rnd() * cand.length)];
    // enter the new street at the end nearest where we are
    const d0 = Math.hypot(r2.pts[0][0] - x, r2.pts[0][1] - z);
    const dn = Math.hypot(r2.pts[r2.pts.length - 1][0] - x, r2.pts[r2.pts.length - 1][1] - z);
    if (d0 <= dn) { c.rd = r2; c.seg = 0; c.t = 0; c.dir = 1; }
    else { c.rd = r2; c.seg = r2.pts.length - 2; c.t = 1; c.dir = -1; }
    c.blend = 0;   // sweep from the old lane into the new one
  }

  // ---- per-frame tick ----------------------------------------------
  function update(dt) {
    if (!body || !cars.length) return;
    // self-heal: the city was torn down (or replaced) under us
    if (!CITY.group || CITY.rec !== recStamp || body.parent !== CITY.group) { clear(); return; }

    const player = ACTORS.player;
    const pv = player && player.group ? player.group.position : null;

    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      const rd = c.rd;
      if (!rd || rd.pts.length < 2) { clear(); return; }

      // --- target speed: cruise, unless blocked ------------------
      let want = c.spd;
      const L = Math.hypot(rd.pts[c.seg + 1][0] - rd.pts[c.seg][0], rd.pts[c.seg + 1][1] - rd.pts[c.seg][1]) || 1;
      // progress along this polyline, in meters, + in road order
      const P = segBase(rd, c.seg) + c.t * L;
      for (let j = 0; j < cars.length; j++) {
        if (j === i) continue;
        const o = cars[j];
        if (o.rd !== rd || o.dir !== c.dir) continue;
        const Lo = Math.hypot(rd.pts[o.seg + 1][0] - rd.pts[o.seg][0], rd.pts[o.seg + 1][1] - rd.pts[o.seg][1]) || 1;
        const gap = (segBase(rd, o.seg) + o.t * Lo) - P;
        const ahead = gap * c.dir;
        const ext = (vehLen(o.kind | 0) + vehLen(c.kind | 0)) / 2 - 4.05;   // v2.92: a bus needs a longer gap than a hatchback
        if (ahead > 0 && ahead < 8 + ext) {
          if (ahead < 4.2 + ext) want = 0;
          else want = Math.min(want, Math.max(0, o.v) + (ahead - 4.2 - ext) * 1.2);
        }
      }
      // the player steps into the lane — hold, don't clip the chibi
      if (pv) {
        const a = rd.pts[c.seg], b = rd.pts[c.seg + 1];
        const fx = (b[0] - a[0]) * c.dir / L, fz = (b[1] - a[1]) * c.dir / L;
        const dx = pv.x - c.x, dz = pv.z - c.z;
        const along = dx * fx + dz * fz, side = Math.abs(dx * fz - dz * fx);
        if (along > 0 && along < 5.5 && side < 2.2) want = 0;
      }
      c.wait = want === 0 ? Math.min(c.wait + dt, 2.5) : 0;
      c.v += Math.max(-9 * dt, Math.min(6 * dt, want - c.v));   // brake harder than you accelerate
      if (c.v < 0) c.v = 0;

      // --- advance along the polyline ---------------------------
      c.t += c.dir * (c.v / L) * dt;
      while (c.t > 1) { c.seg++; c.t = 0; if (c.seg >= rd.pts.length - 1) { hopRoad(c); break; } }
      while (c.t < 0) { c.seg--; c.t = 1; if (c.seg < 0) { hopRoad(c); break; } }

      // --- place: lane + blend + heading -------------------------
      const r = c.rd, a = r.pts[c.seg], b = r.pts[c.seg + 1];
      const keepX = c.x, keepZ = c.z;
      lane(c, a, b);
      if (c.blend < 1) {   // sweeping from the old lane into the new street
        c.blend = Math.min(1, c.blend + dt * 1.8);
        const k = c.blend * c.blend * (3 - 2 * c.blend);   // smoothstep
        c.x = keepX + (c.x - keepX) * k;
        c.z = keepZ + (c.z - keepZ) * k;
      }
      const fx = (b[0] - a[0]) * c.dir, fz = (b[1] - a[1]) * c.dir;
      const th = Math.atan2(-fz, fx);
      let dh = th - c.h;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      c.h += dh * Math.min(1, dt * 4);
      stampCar(i);
    }
    body.instanceMatrix.needsUpdate = true;
    cab.instanceMatrix.needsUpdate = true;
    wheels.instanceMatrix.needsUpdate = true;
  }

  // cumulative meters to the start of segment s (built lazily per road)
  function segBase(rd, s) {
    let cum = rd._tCum;
    if (!cum) {
      cum = rd._tCum = [0];
      for (let i = 0; i < rd.pts.length - 1; i++)
        cum.push(cum[i] + Math.hypot(rd.pts[i + 1][0] - rd.pts[i][0], rd.pts[i + 1][1] - rd.pts[i][1]));
    }
    return cum[s];
  }

  // ---- teardown -----------------------------------------------------
  function clear() {
    if (body) { try { CITY.group && CITY.group.remove(body, cab, wheels); } catch (e) { } }
    for (const m of [body, cab, wheels]) {
      if (!m) continue;
      try { m.geometry && m.geometry.dispose(); m.material && m.material.dispose(); m.dispose(); } catch (e) { }
    }
    body = cab = wheels = null;
    cars = [];
    recStamp = null;
  }

  // ---- the patch chain (AGENTS.md additive pattern) ------------------
  // render/main.js never learns traffic exists: it keeps calling
  // ACTORS.spawnCitizens / ACTORS.reset / ACTORS.updateCitizens, and
  // those calls now carry the fleet with them.
  const _spawnCitizens = ACTORS.spawnCitizens;
  ACTORS.spawnCitizens = function (c, key) {
    const r = _spawnCitizens(c, key);
    try { spawn(); } catch (e) { console.error('[traffic]', e); }
    return r;
  };
  const _reset = ACTORS.reset;
  ACTORS.reset = function () {
    try { clear(); } catch (e) { }
    return _reset();
  };
  const _updateCitizens = ACTORS.updateCitizens;
  ACTORS.updateCitizens = function (dt) {
    _updateCitizens(dt);
    try { update(dt); } catch (e) { console.error('[traffic]', e); }
  };

  return {
    spawn, clear, update,
    get count() { return cars.length; },
    car(i) {
      const c = cars[i];
      if (!c) return null;
      return {
        x: +c.x.toFixed(1), z: +c.z.toFixed(1), v: +c.v.toFixed(1),
        hx: +Math.cos(c.h).toFixed(3), hz: -Math.sin(c.h).toFixed(3),   // heading unit vector (world)
        road: c.rd && c.rd.name || '', dir: c.dir, kind: VEH[c.kind | 0].n,   // v2.92: QA — the vehicle kind
      };
    },
    state() {
      return { n: cars.length, stamped: !!recStamp, tier: (CITY.rec && CITY.rec.tier) || 0, moving: cars.filter(c => c.v > .5).length };
    },
  };
})();

window.TRAFFIC = TRAFFIC;
