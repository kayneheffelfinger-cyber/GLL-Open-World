// ====================================================================
// js/util.js — shared pure helpers, extracted VERBATIM from
// openworld.html v2.59 (Stage 3): deterministic RNG, geo math,
// formatters, projections. Depends only on three + config.
// ====================================================================
import * as THREE from 'three';
import { CITIES, DEG_M } from './config.js';
import { regionOf } from './regions.js';   // v2.69: pure data, no imports — keeps util a leaf

// ---- deterministic rng --------------------------------------------
export function _ihash(x, y, s) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function _mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const hashStr = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
// v2.92 VEHICLE VARIETY: one shared table for parked cars (city.js) and moving traffic (systems/traffic.js).
// Every kind reuses the single body/cab/wheel instanced geometry; a kind is a body scale, a cab scale +
// offset and a wheel layout (the sedan is the identity, i.e. exactly the old car).
export const VEH = [
  { n: 'sedan',  bs: [1, 1, 1],           cs: [1, 1, 1],        ct: [0, 0, 0],       wx: 1.32, wz: .79, wr: 1 },
  { n: 'hatch',  bs: [.82, 1, .95],       cs: [.9, 1.12, .95],  ct: [.05, -.09, 0],  wx: 1.05, wz: .76, wr: .95 },
  { n: 'suv',    bs: [1.04, 1.22, 1.06],  cs: [1.2, 1, 1.05],   ct: [0, .26, 0],     wx: 1.38, wz: .82, wr: 1.2 },
  { n: 'pickup', bs: [1.12, 1, 1.05],     cs: [.62, 1, .96],    ct: [.55, .03, 0],   wx: 1.45, wz: .82, wr: 1.2 },
  { n: 'van',    bs: [1.1, 1.5, 1.08],    cs: [1.3, .5, 1.32],  ct: [.3, .32, 0],    wx: 1.4,  wz: .84, wr: 1.15 },
  { n: 'bus',    bs: [2.6, 1.85, 1.45],   cs: [2.5, .5, 1.47],  ct: [.6, .62, 0],    wx: 3.4,  wz: 1.05, wr: 1.5 }];
export const VEH_PAL = [0xe8e8e6, 0xb9bdc1, 0x2e3134, 0x6f7479, 0x9e3b33, 0x39527a, 0x4a5560, 0x2f4f3a, 0x7a5a3a, 0xc9c2a8, 0xa8742e, 0x5a3a6a];
export const VEH_VAN = [0xe8e8e6, 0xe8e8e6, 0xb9bdc1, 0x39527a, 0x6f7479];
export const VEH_BUS = [0x2f6fa8, 0xb53a30, 0x2f7a4f, 0xd9b53a];
// pick a kind from a 0..1 roll: sedan 38 / hatch 18 / suv 20 / pickup 8 / van 9 / bus 7 (buses only where allowed)
export function pickVeh(r, allowBus) {
  const cut = allowBus ? [.38, .56, .76, .84, .93] : [.41, .60, .82, .90, 1.01];
  for (let k = 0; k < 5; k++) if (r < cut[k]) return k;
  return allowBus ? 5 : 4;
}
export const vehLen = k => 4.05 * VEH[k].bs[0];
// local matrices per kind (body scale, cab offset+scale, four wheels), built once by the caller
export function vehMatrices() {
  const S = (x, y, z) => new THREE.Matrix4().makeScale(x, y, z), T = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
  return {
    body: VEH.map(v => S(v.bs[0], v.bs[1], v.bs[2])),
    cab: VEH.map(v => T(v.ct[0], v.ct[1], v.ct[2]).multiply(S(v.cs[0], v.cs[1], v.cs[2]))),
    wheel: VEH.map(v => [[v.wx, -v.wz], [v.wx, v.wz], [-v.wx, -v.wz], [-v.wx, v.wz]].map(([x, z]) => T(x, .3 * v.wr, z).multiply(S(v.wr, v.wr, v.wr))))
  };
}
// great-circle distance in km + initial bearing in degrees (from north)
export function gcKmLL(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const s = Math.sin((lat2 - lat1) * r / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(s)));
}
export function bearingLL(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
// world position of a cityKey (catalog city or searched 'll…' site)
export function worldAnchorOf(key) {
  const c = CITIES.find(x => x.key === key);
  if (c) return { x: c.wx, z: c.wz, name: c.name };
  if (key && key.startsWith('ll')) {
    const m = key.match(/^ll(-?[\d.]+)_(-?[\d.]+)$/);
    if (m) {
      const p = latLonToWorld(+m[1], +m[2]);
      return { x: p.x, z: p.z, name: key };
    }
  }
  return null;
}
// ---- money helpers -------------------------------------------------
export const fmt$ = n => '$' + Math.round(n).toLocaleString('en-US');
export const fmt$2 = n => '$' + n.toFixed(2);
export const fmtK = n => n >= 1e9 ? '$' + (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K' : '$' + Math.round(n);
export function latLonToVec3(lat, lon, r = R) {
  const phi = (lon + 180) * Math.PI / 180;
  const theta = (90 - lat) * Math.PI / 180;
  return new THREE.Vector3(
    -r * Math.cos(phi) * Math.sin(theta),
    r * Math.cos(theta),
    r * Math.sin(phi) * Math.sin(theta));
}
// inverse of latLonToVec3 — a world point on the globe back to lat/lon
export function vec3ToLatLon(v) {
  const n = v.clone().normalize();
  const lat = 90 - Math.acos(THREE.MathUtils.clamp(n.y, -1, 1)) * 180 / Math.PI;
  let lon = Math.atan2(n.z, -n.x) * 180 / Math.PI - 180;
  lon = ((lon + 540) % 360) - 180;
  return { lat, lon };
}
export const coordStr = (lat, lon) =>
  Math.abs(lat).toFixed(1) + '°' + (lat >= 0 ? 'N' : 'S') + ' · ' +
  Math.abs(lon).toFixed(1) + '°' + (lon >= 0 ? 'E' : 'W');
export const frontierName = (lat, lon) =>
  'Frontier ' + Math.abs(lat).toFixed(1) + (lat >= 0 ? 'N ' : 'S ') +
  Math.abs(lon).toFixed(1) + (lon >= 0 ? 'E' : 'W');
// ---- lat/lon -> world coords -------------------------------------------
// v2.18 PLANET EARTH: a true equirectangular projection — one shared
// scale for the whole planet, so coastlines, cities, searched places
// and globe landings all land on the exact same spot. (DEG_M lives in
// 10_core next to the city catalog, where it is first needed.)
export function latLonToWorld(lat, lon) {
  return { x: lon * DEG_M, z: -lat * DEG_M };
}
export function worldToLatLon(x, z) {
  return { lat: -z / DEG_M, lon: x / DEG_M };
}
export function _polyArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const [x1, z1] = poly[i], [x2, z2] = poly[(i + 1) % n];
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
}
export const VNUM = s => { const m = String(s).match(/(\d+)\.(\d+)/); return m ? +m[1] * 1e4 + +m[2] : 0; };

// ---- v2.65 CITY DNA -------------------------------------------------
// Every city its own size and face. One deterministic identity per
// catalog city, drawn from its key + tier: the SIZE levers (distant-
// skyline spread, suburb ring scale, ring + radial counts) and the LOOK
// levers (palette bias, height character, facade style bias, greenery,
// suburb house scale, palette rotation). Tier sets the band, the city's
// own hash rolls inside it — a lucky tier-1 town sprawls for its band,
// a small-roll tier-3 metro stays comparatively tight, but no town
// out-sprawls a metro. Searched spots / frontiers (no tier) roll the
// tier-1 band.
//   ONE source of truth: city.js (suburb ring, facades, trees), osm.js
//   (building heights) and world.js (skyline spread, ground rings,
//   streaming distances, farm/mine keep-out) all read THESE numbers, so
//   the city you see from orbit is the city you walk into.
//   subR0/subR1 are absolute meters: ring 0 stays pinned at 880 (never
//   creeps inside the downtown plate — today's accepted envelope), the
//   radials and decals run out to subR1 = 2360 × sub (2360 = the v2.42
//   suburb edge every existing margin was tuned against, so sub=1
//   reproduces v2.64 exactly).
const _dnaMemo = new Map();
export function cityDNA(meta) {
  const key = (meta && (meta.key || meta.name)) || 'c';
  const memo = _dnaMemo.get(key);
  if (memo) return memo;
  const tier = (meta && meta.tier) || 1;   // searched wild spots roll the small band
  const rnd = _mulberry(hashStr('dna' + key));
  const r1 = rnd(), r2 = rnd(), r3 = rnd(), r4 = rnd();
  // SIZE — skyline metro spread (was flat 10; capped at 13 so the ×720 m
  // street reach stays inside the roads' 10.5 km junction-tail budget)
  const spread = tier === 3 ? 10.6 + r1 * 2.4
    : tier === 2 ? 8.2 + r1 * 2.6
      : 5.6 + r1 * 2.6;
  // SIZE — suburb ring scale (was flat 1.0)
  const sub = tier === 3 ? 1.06 + r2 * .34
    : tier === 2 ? .88 + r2 * .28
      : .62 + r2 * .3;
  // SIZE — street counts (were flat 6 rings / 16 radials)
  const rings = tier === 3 ? 6 + Math.round(r3 * 2)
    : tier === 2 ? 5 + Math.round(r3 * 2)
      : 4 + Math.round(r3 * 1.6);
  const radials = 9 + Math.round(r4 * (tier === 3 ? 11 : tier === 2 ? 9 : 7));
  // LOOK — warm↔cool palette bias (±.35 rides the existing warmP roll)
  const reg = regionOf(key, meta && meta.lat, meta && meta.lon);   // v2.69 REGIONAL CHARACTER (null = neutral, the v2.65 look)
  const warm = (rnd() - .5) * .7 + (reg ? reg.warmBias : 0);
  // LOOK — height character: untagged building heights × this
  const tall = (.82 + rnd() * .5) * (reg ? reg.tall : 1);
  // LOOK — facade style bias (+ = curtain glass downtown, − = classic)
  const glass = (rnd() - .5) * .5 + (reg ? reg.glass : 0);
  // LOOK — greenery: street-tree + park density
  const green = .6 + ((hashStr(key + 'g') % 1000) / 1000) * .9;
  // LOOK — suburb house scale: compact rows ↔ villas
  const villa = .86 + ((hashStr(key + 'v') % 1000) / 1000) * .42;
  // LOOK — palette rotation: each city draws from a rotated slice of
  // every shared palette, so no two downtowns wear the same colors
  const palOff = hashStr(key + 'p');
  const dna = {
    spread, sub, rings, radials, warm, tall, glass, green, villa, palOff, region: reg,
    subR0: 880,
    subR1: Math.round(2360 * sub),
  };
  _dnaMemo.set(key, dna);
  return dna;
}
