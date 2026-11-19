// ====================================================================
// js/suburbs.js — v2.73 NEIGHBORHOODS REDRAWN: pure layout data, imports
// only util.js (a leaf). The ask: "get rid of the old circle
// neighborhoods and make them look better and different in each
// city." Since v2.42 every city's suburbs were concentric polygonal
// rings plus radial spokes — the same wheel everywhere. This module
// replaces that with a street PATTERN per region (regions.js `layout`):
//
//   grid        a rotated square grid — numbered streets one way, named
//               avenues the other, a collector every 3-4 lines, the odd
//               missing street (merged blocks) and, in some cities, a
//               diagonal avenue — the US / Australian gridiron
//   winding     curvilinear collectors that meander outward, with local
//               streets grown off them that curl and die in cul-de-sacs
//               — the western-US / Canadian sprawl, the northern-European
//               suburb
//   lattice     a small-block lattice warped by a low-frequency field so
//               every street bends, with lanes that stop short and
//               T-junctions — the dense organic fabric of Mediterranean,
//               Latin, Middle-Eastern, African and South-Asian cities
//   superblock  large blocks bounded by wide arterials with short comb
//               stubs and cul-de-sacs inside — the East-Asian / Soviet /
//               Gulf pattern
//
// Everything is deterministic per city (the city key seeds it: its own
// angle, spacing, bends) and everything is clipped to the city's own
// ragged OUTLINE — outlineR(meta, angle) — instead of a circle. The
// outline always stays inside dna.subR1 (the radius the forest belt,
// farms and mines keep clear of) and outside the 880 m verge, and the
// green ground decal in world.js reads the SAME function, so the lawn
// ends where the streets end.
//
// suburbRoads(meta, ax, az) returns road records in the exact shape
// city.js's addSuburbRoads always returned ({pts,w,cls,sub:1,name}),
// so the dry-land clip, ONE NETWORK connector pass, houses, trees and
// traffic all work unchanged.
// ====================================================================
import { _mulberry, hashStr, cityDNA } from './util.js';

const TAU = Math.PI * 2;
export const SUB_R0 = 880;          // the verge — suburbs never creep inside it
const wrap = a => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };

const TREES = ['Maple', 'Oak', 'Cedar', 'Elm', 'Pine', 'Birch', 'Willow', 'Aspen', 'Rowan', 'Poplar', 'Hawthorn', 'Juniper'];
const KINDS = ['Lane', 'Street', 'Drive', 'Way', 'Terrace', 'Road'];
const END_KINDS = ['Court', 'Circle', 'Lane', 'Place', 'Close'];
const ordinal = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

// ---- the ragged outline ------------------------------------------------
const _outMemo = new Map();
function outlineOf(meta) {
  const key = (meta && (meta.key || meta.name)) || 'c';
  let o = _outMemo.get(key);
  if (!o) {
    const r = _mulberry(hashStr('outline' + key));
    o = { p: [r() * TAU, r() * TAU, r() * TAU, r() * TAU], w: [.5 + r() * .25, .28 + r() * .2, .18 + r() * .2, .1 + r() * .1], depth: .2 + r() * .14 };
    _outMemo.set(key, o);
  }
  return o;
}
// radius (m) of the city's suburb edge at angle a (radians, atan2(z, x)):
// always within [78%, 100%] of dna.subR1 and never inside the verge
export function outlineR(meta, a, r0) {
  const dna = cityDNA(meta), o = outlineOf(meta);
  const h = o.w[0] * Math.sin(2 * a + o.p[0]) + o.w[1] * Math.sin(3 * a + o.p[1]) + o.w[2] * Math.sin(5 * a + o.p[2]) + o.w[3] * Math.sin(8 * a + o.p[3]);
  const wsum = o.w[0] + o.w[1] + o.w[2] + o.w[3];
  const n = .5 + .5 * h / wsum;                    // 0..1
  return Math.max((r0 || SUB_R0) + 260, dna.subR1 * (1 - o.depth * (1 - n)));
}

// radius (m) at which the imported real-world data (a ±360 m SQUARE, 509 m
// at the corners) is trimmed: a ragged 340-430 m blob, so the downtown ends
// in an organic edge instead of the four straight sides of the import box
export function coreR(meta, a) {
  const o = outlineOf(meta);
  const h = o.w[0] * Math.sin(2 * a + o.p[1]) + o.w[1] * Math.sin(3 * a + o.p[2]) + o.w[2] * Math.sin(5 * a + o.p[3]) + o.w[3] * Math.sin(7 * a + o.p[0]);
  const n = .5 + .5 * h / (o.w[0] + o.w[1] + o.w[2] + o.w[3]);
  return 340 + 90 * n;
}

// ---- helpers -----------------------------------------------------------
function clip(pts, ok, minLen) {
  const out = []; let cur = [];
  const flush = () => {
    if (cur.length >= 2) {
      let L = 0; for (let i = 1; i < cur.length; i++) L += Math.hypot(cur[i][0] - cur[i - 1][0], cur[i][1] - cur[i - 1][1]);
      if (L >= minLen) out.push(cur);
    }
    cur = [];
  };
  for (const p of pts) { if (ok(p[0], p[1])) cur.push(p); else flush(); }
  flush();
  return out;
}
// samples along a straight line: lateral offset o, direction th, t in [t0,t1]
function line(th, o, t0, t1, step, warp) {
  const c = Math.cos(th), s = Math.sin(th), out = [];
  for (let t = t0; t <= t1 + 1e-6; t += step) {
    let x = c * t - s * o, z = s * t + c * o;
    if (warp) { const w = warp(x, z); x += w[0]; z += w[1]; }
    out.push([x, z]);
  }
  return out;
}

// a smooth low-frequency displacement field: every layout bends with it so
// no street is ever ruler-straight (amplitude A meters, wavelengths 280-900 m)
function makeWarp(rnd, A) {
  const l1 = 320 + rnd() * 260, l2 = 520 + rnd() * 380, l3 = 280 + rnd() * 240;
  const p1 = rnd() * TAU, p2 = rnd() * TAU, p3 = rnd() * TAU, p4 = rnd() * TAU;
  return (x, z) => [A * Math.sin(z / l1 + p1) + A * .6 * Math.sin(x / l2 + p2 + z / l3), A * Math.sin(x / l1 + p3) + A * .6 * Math.sin(z / l2 + p4 + x / l3)];
}

// ---- layouts (each returns [{pts, cls, w, name}] in center-local meters) -
function gridLayout(ctx) {
  const { rnd, dna, R, ok } = ctx, out = [];
  const warp = makeWarp(rnd, 40 + rnd() * 25);
  const rot = rnd() * (TAU / 4), S = (112 + rnd() * 46) * (.92 + .1 * dna.villa);
  const every = 3 + Math.floor(rnd() * 2);
  const skipP = .06 + rnd() * .1;
  let nStreet = 0, nAve = 0;
  for (let dir = 0; dir < 2; dir++) {
    const th = rot + dir * TAU / 4, phase = rnd() * S, N = Math.ceil(R / S) + 1;
    for (let i = -N; i <= N; i++) {
      const o = phase + i * S;
      if (Math.abs(o) > R) continue;
      const coll = ((i % every) + every) % every === 0;
      if (!coll && rnd() < skipP) continue;                    // a merged block
      for (const seg of clip(line(th, o, -R, R, 34, warp), ok, 60)) {
        out.push({ pts: seg, cls: coll ? 2 : 1, w: coll ? 12.5 : 9,
          name: dir === 0 ? ordinal(++nStreet) + ' Street' : TREES[(nAve++ + Math.floor(rnd() * 3)) % TREES.length] + ' Avenue' });
      }
    }
  }
  if (rnd() < .5) {                                            // a diagonal avenue through the grid
    const th = rot + TAU / 8 + (rnd() - .5) * .3, o = (rnd() - .5) * S * 2;
    for (const seg of clip(line(th, o, -R, R, 34, warp), ok, 100)) out.push({ pts: seg, cls: 2, w: 14, name: 'Grand Diagonal' });
  }
  return out;
}

function latticeLayout(ctx) {
  const { rnd, dna, R, ok } = ctx, out = [];
  const rot = rnd() * TAU, S = 98 + rnd() * 30;
  const A = 30 + rnd() * 20, l1 = 240 + rnd() * 180, l2 = 300 + rnd() * 200, l3 = 380 + rnd() * 200;
  const p1 = rnd() * TAU, p2 = rnd() * TAU, p3 = rnd() * TAU, p4 = rnd() * TAU;
  const warp = (x, z) => [A * Math.sin(z / l1 + p1) + A * .5 * Math.sin(x / l2 + p2 + z / l3), A * Math.sin(x / l1 + p3) + A * .5 * Math.sin(z / l2 + p4 + x / l3)];
  const every = 4 + Math.floor(rnd() * 2);
  for (let dir = 0; dir < 2; dir++) {
    const th = rot + dir * TAU / 4 + (dir ? (rnd() - .5) * .25 : 0), phase = rnd() * S, N = Math.ceil(R / S) + 1;
    for (let i = -N; i <= N; i++) {
      const o = phase + i * S + (rnd() - .5) * S * .3;
      if (Math.abs(o) > R) continue;
      const coll = ((i % every) + every) % every === 0;
      if (!coll && rnd() < .14) continue;
      let t0 = -R, t1 = R;
      if (!coll && rnd() < .22) { const len = 260 + rnd() * 700, mid = (rnd() * 2 - 1) * R * .8; t0 = mid - len / 2; t1 = mid + len / 2; }   // a lane that stops short
      for (const seg of clip(line(th, o, t0, t1, 30, warp), ok, 60)) {
        out.push({ pts: seg, cls: coll ? 2 : 1, w: coll ? 11 : 8,
          name: TREES[Math.floor(rnd() * TREES.length)] + ' ' + (coll ? (rnd() < .5 ? 'Road' : 'Street') : KINDS[Math.floor(rnd() * KINDS.length)]) });
      }
    }
  }
  return out;
}

function superblockLayout(ctx) {
  const { rnd, R, ok } = ctx, out = [];
  const warp = makeWarp(rnd, 45 + rnd() * 25);
  const rot = (rnd() - .5) * .4, S = 215 + rnd() * 70;
  const lines = [];
  for (let dir = 0; dir < 2; dir++) {
    const th = rot + dir * TAU / 4, phase = rnd() * S, N = Math.ceil(R / S) + 1;
    for (let i = -N; i <= N; i++) {
      const o = phase + i * S;
      if (Math.abs(o) > R) continue;
      lines.push({ th, o });
      let k = 0;
      for (const seg of clip(line(th, o, -R, R, 36, warp), ok, 80)) out.push({ pts: seg, cls: 2, w: 15, name: (dir === 0 ? 'Zhong ' : 'Tong ') + ordinal(((i + N) % 40) + 1 + k++ * 0) + ' Avenue' });
    }
  }
  // comb stubs: from a grid line, a short dead-end into the block behind it
  for (const L of lines) {
    const c = Math.cos(L.th), s = Math.sin(L.th), nx = -s, nz = c;
    for (let t = -R; t < R; t += S * (.5 + rnd() * .35)) {
      if (rnd() < .3) continue;
      const side = rnd() < .5 ? 1 : -1, len = 60 + rnd() * 70;
      const sx = c * t - s * L.o, sz = s * t + c * L.o;
      const pts = [];
      for (let d = 0; d <= len; d += 22) { const px = sx + nx * d * side, pz = sz + nz * d * side, w = warp(px, pz); pts.push([px + w[0], pz + w[1]]); }
      for (const seg of clip(pts, ok, 40)) out.push({ pts: seg, cls: 1, w: 8.5, name: TREES[Math.floor(rnd() * TREES.length)] + ' ' + END_KINDS[Math.floor(rnd() * END_KINDS.length)] });
    }
  }
  return out;
}

function windingLayout(ctx) {
  const { rnd, dna, R, ok, outR, r0 } = ctx, out = [];
  const CELL = 40, hash = new Map();
  const add = (x, z, id, hx, hz) => { const k = Math.floor(x / CELL) + ',' + Math.floor(z / CELL); let a = hash.get(k); if (!a) hash.set(k, a = []); a.push({ x, z, id, hx, hz }); };
  const nearest = (x, z, rad, skipId, skipR) => {   // true when some OTHER street sample lies within rad
    const g = Math.ceil(rad / CELL), cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let i = -g; i <= g; i++) for (let j = -g; j <= g; j++) {
      const a = hash.get((cx + i) + ',' + (cz + j)); if (!a) continue;
      for (const s of a) { const d = Math.hypot(s.x - x, s.z - z); if (d < rad && !(s.id === skipId && d < skipR)) return true; }
    }
    return false;
  };
  const samples = [];
  const rot = rnd() * TAU, nCol = 4 + Math.floor(rnd() * 3);
  let id = 0;
  // collectors: meander outward from the verge
  for (let k = 0; k < nCol; k++) {
    const a0 = rot + (k + rnd() * .6) / nCol * TAU;
    let x = Math.cos(a0) * (r0 + 8), z = Math.sin(a0) * (r0 + 8), h = a0 + (rnd() - .5) * .5;
    const pts = [[x, z]]; const my = id++;
    for (let st = 0; st < 170; st++) {
      const ang = Math.atan2(z, x);
      h += (rnd() - .5) * .3 + .09 * wrap(ang - h);
      x += Math.cos(h) * 36; z += Math.sin(h) * 36;
      if (Math.hypot(x, z) > outR(Math.atan2(z, x))) break;
      pts.push([x, z]);
    }
    if (pts.length < 6) continue;
    pts.forEach((p, i) => { const q = pts[Math.min(i + 1, pts.length - 1)], d = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1; add(p[0], p[1], my, (q[0] - p[0]) / d, (q[1] - p[1]) / d); samples.push({ x: p[0], z: p[1], hx: (q[0] - p[0]) / d, hz: (q[1] - p[1]) / d, id: my }); });
    out.push({ pts, cls: 2, w: 12.5, name: TREES[Math.floor(rnd() * TREES.length)] + ' ' + (rnd() < .5 ? 'Boulevard' : 'Parkway') });
  }
  // locals: grown off any existing street, curling, dying in cul-de-sacs
  const target = Math.round(300 + 420 * dna.sub);
  let made = 0;
  for (let tries = 0; tries < 9000 && made < target; tries++) {
    const s = samples[Math.floor(rnd() * samples.length)];
    if (!s) break;
    const side = rnd() < .5 ? 1 : -1;
    let h = Math.atan2(s.hz, s.hx) + side * (Math.PI / 2 + (rnd() - .5) * .5);
    let x = s.x + Math.cos(h) * 10, z = s.z + Math.sin(h) * 10;
    if (!ok(x, z) || nearest(x, z, 46, s.id, 70)) continue;
    const my = id++, pts = [[s.x, s.z], [x, z]], want = 130 + rnd() * 340, curl = (rnd() - .5) * .14;
    let len = 10;
    while (len < want) {
      h += curl + (rnd() - .5) * .22;
      x += Math.cos(h) * 24; z += Math.sin(h) * 24; len += 24;
      if (!ok(x, z) || nearest(x, z, 46, s.id, 90)) break;
      pts.push([x, z]);
    }
    if (len < 70 || pts.length < 4) continue;
    // register the new street so later ones keep their distance
    for (let i = 2; i < pts.length; i++) { const p = pts[i], q = pts[Math.min(i + 1, pts.length - 1)], d = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1; const rec = { x: p[0], z: p[1], hx: (q[0] - p[0]) / d, hz: (q[1] - p[1]) / d, id: my }; add(rec.x, rec.z, my, rec.hx, rec.hz); samples.push(rec); }
    out.push({ pts, cls: 1, w: 8.5, name: TREES[Math.floor(rnd() * TREES.length)] + ' ' + END_KINDS[Math.floor(rnd() * END_KINDS.length)] });
    made++;
  }
  return out;
}

const LAYOUTS = { grid: gridLayout, winding: windingLayout, lattice: latticeLayout, superblock: superblockLayout };
const ALL = ['grid', 'winding', 'lattice', 'superblock'];
export function layoutOf(meta) {
  const dna = cityDNA(meta);
  const l = dna.region && dna.region.layout;
  return LAYOUTS[l] ? l : ALL[hashStr('layout' + ((meta && (meta.key || meta.name)) || 'c')) % ALL.length];
}

// the city's whole suburban street list, world coordinates (anchor added)
// v2.76: optional `inner(angle)` = the inner radius at that bearing (r0 stays
// the smallest of them). city.js passes the downtown's own ragged edge so the
// streets begin where the core ends, at every angle, with no bare band.
export function suburbRoads(meta, ax, az, r0, inner) {
  r0 = r0 || SUB_R0;
  const dna = cityDNA(meta), layout = layoutOf(meta);
  const rnd = _mulberry(hashStr('sub' + layout + (meta.key || meta.name)));
  const outR = a => outlineR(meta, a, r0);
  const ok = (x, z) => { const r = Math.hypot(x, z), a = Math.atan2(z, x); return r >= (inner ? Math.max(r0, inner(a)) : r0) && r <= outR(a); };
  const R = dna.subR1 + 40;
  const roads = LAYOUTS[layout]({ rnd, dna, R, ok, outR, r0 });
  return roads.map(r => ({ pts: r.pts.map(p => [p[0] + ax, p[1] + az]), w: r.w, cls: r.cls, sub: 1, name: r.name }));
}
