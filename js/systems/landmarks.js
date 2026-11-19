// ====================================================================
// js/systems/landmarks.js — v2.69 REGIONAL CHARACTER: landmarks.
// The ask: "I want every city to be uniquely different." The streets
// and blocks come from OpenStreetMap, so a skyline made of anonymous
// boxes looked like any other. This system stands real, recognizable
// landmarks at their true lat/lon — One World Trade, the Willis Tower,
// Burj Khalifa, Taipei 101, Hagia Sophia, the Sky Towers, the Spire of
// Dublin... — built from a handful of primitives at true height.
//
// Only landmarks inside the imported map square (catalog center ±350 m,
// see PLATE_HALF) are placed: a landmark that lies farther out simply
// isn't part of that city's map (Eiffel Tower, Colosseum, CN Tower...),
// and nothing is faked closer. The table lists more than it places on
// purpose — it switches on if the import ever grows.
//
// It rides the AGENTS.md additive pattern with ZERO edits to city.js
// or the render layer: CITY.build is wrapped. BEFORE the city builds,
// the plain extruded OSM footprint under each landmark is dropped (a
// real tall tower is already a tagged box there — the landmark replaces
// it, so the two never z-fight). AFTER the build, the landmark meshes
// join the returned city group, positioned at anchor + local offset in
// double precision like every other city mesh, so CITY.dispose frees
// them with everything else. Only real OSM imports get landmarks (not
// the procedural fallback grid). Nothing saves — landmarks are scenery.
// QA surface: window.LANDMARKS (list / placed / near).
// ====================================================================
import * as THREE from 'three';
import { CITY } from '../world/city.js';

// ---- the same projection the OSM import uses (osm.js proj) -------------
const M_LAT = 110540;
const mLon = lat => 111320 * Math.cos(lat * Math.PI / 180);
// osm.js fetches a bbox of center ± HALF/2 = ±360 m (the HALF=720 comment
// there says "half-extent", the code halves it), so real map data — and the
// buildings a landmark must stand among — only exists inside that square.
// A landmark outside it would stand alone in the suburb ring, so it is not
// placed. Entries outside the box stay listed: they switch on by themselves
// if the import ever grows (PLATE_HALF is the one number to change).
const PLATE_HALF = 350;

// ---- part builders ------------------------------------------------------
const B = (x, z, w, d, y, h, c) => ({ k: 'box', x, z, w, d, y, h, c });             // box w×d, base y, height h
const C = (x, z, rb, rt, y, h, c) => ({ k: 'cyl', x, z, rb, rt, y, h, c });          // cylinder / cone: bottom r, top r
const F = (x, z, wb, wt, y, h, c) => ({ k: 'fr', x, z, wb, wt, y, h, c });           // square frustum: bottom w, top w
const D = (x, z, r, y, c) => ({ k: 'dome', x, z, r, y, c });                         // hemisphere on y
const S = (x, z, r, y, c) => ({ k: 'sph', x, z, r, y, c });                          // sphere centered at y
const G = (x, z, w, len, y, h, c) => ({ k: 'gable', x, z, w, len, y, h, c });        // gable roof, ridge along z

const minaret = (x, z, h, wall = 0xd8d4c8, cap = 0x8e9aa0) => [
  C(x, z, 2.8, 2.0, 0, h - 12, wall), C(x, z, 3.7, 3.7, h * .68, 1.4, wall), C(x, z, 2.4, .1, h - 12, 12, cap)];
// stacked setback tiers: [[wBottom, wTop, h], ...] from the ground up
const tiers = (spec, c, x = 0, z = 0) => { let y = 0; return spec.map(([wb, wt, h]) => { const p = F(x, z, wb, wt, y, h, c); y += h; return p; }); };
// nave + roof + towers: twins at the front, or a single central tower
const cathedral = (len, wid, hn, tw, th, capH, wall, roof, cap, twins = true) => {
  const zf = -len / 2 + tw / 2, out = [B(0, 0, wid, len, 0, hn, wall), G(0, 0, wid + 1.5, len + 1.5, hn, wid * .3, roof)];
  const xs = twins ? [-(wid / 2 - tw / 2), wid / 2 - tw / 2] : [0];
  for (const x of xs) out.push(B(x, zf, tw, tw, 0, th, wall), F(x, zf, tw, .5, th, capH, cap));
  return out;
};

const GLASS = 0x9fb4c4, STONE = 0xd8cfae, SLATE = 0x46505c;

// lat, lon, name, parts, clear (m): OSM footprints with a centroid within
// `clear` of the landmark are dropped; rot: degrees clockwise from north
export const LANDMARKS = {
  newyork: [
    { name: 'One World Trade Center', lat: 40.7127, lon: -74.0134, clear: 55, parts: [B(0, 0, 61, 61, 0, 60, GLASS), ...tiers([[61, 52, 300]], GLASS, 0, 0).map(p => ({ ...p, y: 60 })), C(0, 0, 2.2, .2, 360, 181, 0xd0d4d6)] },
    { name: 'Woolworth Building', lat: 40.7123, lon: -74.0083, clear: 40, parts: [B(0, 0, 60, 60, 0, 36, STONE), B(0, 0, 28, 28, 36, 130, STONE), F(0, 0, 28, 3, 166, 60, 0x5a8f7c)] },
  ],
  chicago: [
    { name: 'Willis Tower', lat: 41.8789, lon: -87.6359, clear: 60, parts: (() => { const hs = [[270, 442, 330], [330, 330, 442], [270, 330, 270]], o = []; hs.forEach((row, i) => row.forEach((h, j) => o.push(B((j - 1) * 23, (i - 1) * 23, 23, 23, 0, h, 0x2b2e33)))); o.push(C(-12, 0, 1.6, .3, 442, 108, 0xcfd4d8), C(12, 0, 1.6, .3, 442, 108, 0xcfd4d8)); return o; })() },
    { name: 'Chicago Board of Trade', lat: 41.8779, lon: -87.6324, clear: 35, parts: [B(0, 0, 40, 50, 0, 120, 0xcfc2a8), F(0, 0, 30, 16, 120, 50, 0xcfc2a8), F(0, 0, 16, 3, 170, 22, 0x6a7a80)] },
    { name: 'Aon Center', lat: 41.8848, lon: -87.6217, clear: 45, parts: [B(0, 0, 55, 55, 0, 346, 0xe8e8e6)] },
  ],
  toronto: [
    { name: 'First Canadian Place', lat: 43.6486, lon: -79.3815, clear: 50, parts: [B(0, 0, 95, 42, 0, 298, 0xe6e4dc)] },
  ],
  mexicocity: [
    { name: 'Metropolitan Cathedral', lat: 19.4340, lon: -99.1330, clear: 70, rot: 90, parts: [...cathedral(110, 60, 30, 14, 67, 14, 0xb0a68e, SLATE, 0x8e9aa0), D(0, 8, 14, 30, 0x8e9aa0)] },
  ],
  losangeles: [
    { name: 'Los Angeles City Hall', lat: 34.0537, lon: -118.2428, clear: 45, parts: [B(0, 0, 70, 34, 0, 40, 0xe8e0cc), B(0, 0, 36, 28, 40, 60, 0xe8e0cc), B(0, 0, 24, 20, 100, 24, 0xe8e0cc), F(0, 0, 24, 3, 124, 14, 0xe8e0cc)] },
  ],
  houston: [
    { name: 'JPMorgan Chase Tower', lat: 29.7604, lon: -95.3659, clear: 55, parts: [B(0, 0, 52, 52, 0, 305, 0xbdb8aa)] },
  ],
  vancouver: [
    { name: 'Harbour Centre Lookout', lat: 49.2843, lon: -123.1115, clear: 40, parts: [B(0, 0, 40, 40, 0, 60, 0xc8c8c4), C(0, 0, 9, 7, 60, 100, 0xcfcfcf), C(0, 0, 14, 24, 160, 6, 0xcfd6d8), C(0, 0, 24, 24, 166, 8, 0x9fb4c4), C(0, 0, 24, 3, 174, 8, 0xcfcfcf)] },
  ],
  montreal: [
    { name: 'Place Ville Marie', lat: 45.5017, lon: -73.5692, clear: 50, parts: [B(0, 0, 52, 24, 0, 188, 0xb8c8d8), B(0, 0, 24, 52, 0, 188, 0xb8c8d8), B(0, 0, 40, 40, 0, 20, 0xa8b4c2)] },
  ],
  saopaulo: [
    { name: 'Catedral da Sé', lat: -23.5503, lon: -46.6339, clear: 60, parts: [...cathedral(110, 50, 30, 14, 65, 18, 0xc8c4b4, 0x6a7a70, 0x6a7a70), D(0, 6, 16, 32, 0x6a7a70), C(0, 6, 8, 5, 48, 10, 0x6a7a70)] },
  ],
  buenosaires: [
    { name: 'Obelisco', lat: -34.6037, lon: -58.3816, clear: 20, parts: [F(0, 0, 10, 7, 0, 3, 0xe8e4da), F(0, 0, 7, 3, 3, 59, 0xe8e4da), F(0, 0, 3, .3, 62, 5.5, 0xe8e4da)] },
  ],
  london: [
    { name: "Nelson's Column", lat: 51.5080, lon: -0.1281, clear: 25, parts: [B(0, 0, 10, 10, 0, 5, 0xb8b4a8), C(0, 0, 2.1, 1.7, 5, 45.7, 0xb8b4a8), C(0, 0, 3, 2.4, 50.7, 1.8, 0xa8a49a), S(0, 0, 1.5, 54, 0x7a8a7c)] },
  ],
  berlin: [
    { name: 'Berliner Fernsehturm', lat: 52.5208, lon: 13.4094, clear: 40, parts: [B(0, 0, 60, 60, 0, 6, 0xb8b8b0), C(0, 0, 5.5, 3.2, 0, 200, 0xc8c8c8), S(0, 0, 16, 212, 0xd4d4d0), C(0, 0, 3.4, 3.4, 224, 14, 0xb8b8b0), C(0, 0, 2.2, .3, 238, 130, 0xc03a2e)] },
  ],
  madrid: [
    { name: 'Edificio Telefónica', lat: 40.4200, lon: -3.7053, clear: 35, parts: [B(0, 0, 34, 24, 0, 60, 0xc8c0b0), B(0, 0, 24, 16, 60, 18, 0xc8c0b0), F(0, 0, 16, 4, 78, 11, SLATE)] },
    { name: 'Edificio Metrópolis', lat: 40.4195, lon: -3.6975, clear: 30, parts: [B(0, 0, 32, 32, 0, 38, 0xe8e4da), C(0, 0, 8, 7, 38, 6, 0xe8e4da), C(0, 0, 8, .5, 44, 12, SLATE), S(0, 0, 1.6, 58, 0xd8b040)] },
  ],
  istanbul: [
    { name: 'Hagia Sophia', lat: 41.0086, lon: 28.9802, clear: 60, rot: 30, parts: [B(0, 0, 70, 75, 0, 36, 0xd8b48a), D(0, 0, 15.5, 36, 0x9aa8a0), D(0, -26, 12, 28, 0x9aa8a0), D(0, 26, 12, 28, 0x9aa8a0), ...minaret(-46, -44, 55), ...minaret(46, -44, 55), ...minaret(-46, 44, 55), ...minaret(46, 44, 55)] },
    { name: 'Blue Mosque', lat: 41.0054, lon: 28.9768, clear: 55, rot: 30, parts: [B(0, 0, 64, 64, 0, 20, 0xc8c4bc), D(0, 0, 13.5, 20, 0x8e9aa0), D(0, -22, 9, 17, 0x8e9aa0), D(0, 22, 9, 17, 0x8e9aa0), D(-22, 0, 9, 17, 0x8e9aa0), D(22, 0, 9, 17, 0x8e9aa0), ...minaret(-38, -38, 64), ...minaret(38, -38, 64), ...minaret(-38, 38, 64), ...minaret(38, 38, 64), ...minaret(-46, 0, 64), ...minaret(46, 0, 64)] },
  ],
  vienna: [
    { name: "St. Stephen's Cathedral", lat: 48.2084, lon: 16.3731, clear: 60, rot: 90, parts: [B(0, 0, 34, 107, 0, 30, 0xcfc8b8), G(0, 0, 36, 108, 30, 26, 0xc77a3c), B(-1, 30, 14, 14, 0, 70, 0xcfc8b8), F(-1, 30, 14, 2, 70, 66, 0xc8c0a8), B(-1, -30, 14, 14, 0, 60, 0xcfc8b8), D(-1, -30, 8, 60, 0xc8c0a8)] },
  ],
  stockholm: [
    { name: 'Royal Palace', lat: 59.3268, lon: 18.0717, clear: 70, parts: [B(0, 0, 120, 110, 0, 30, 0xd8c8a0), F(0, 0, 100, 60, 30, 8, 0x55603f), B(0, 0, 30, 30, 0, 38, 0xd0c098)] },
  ],
  kyiv: [
    { name: 'Independence Monument', lat: 50.4501, lon: 30.5236, clear: 25, parts: [C(0, 0, 8, 6, 0, 6, 0xd8d4c8), C(0, 0, 2.5, 1.8, 6, 48, 0xe8e4da), S(0, 0, 2.2, 58, 0xd8b040)] },
    { name: "St. Sophia's Cathedral", lat: 50.4529, lon: 30.5143, clear: 50, parts: [B(0, 0, 40, 50, 0, 22, 0xf0ece0), D(0, 0, 9, 22, 0x2f7a55), D(-13, -14, 5, 20, 0x2f7a55), D(13, -14, 5, 20, 0x2f7a55), D(-13, 14, 5, 20, 0x2f7a55), D(13, 14, 5, 20, 0x2f7a55), S(0, 0, 1.4, 32, 0xd8b040)] },
  ],
  dublin: [
    { name: 'Spire of Dublin', lat: 53.3498, lon: -6.2603, clear: 12, parts: [C(0, 0, 1.5, .15, 0, 121.2, 0xd0d4d6)] },
  ],
  zurich: [
    { name: 'Grossmünster', lat: 47.3702, lon: 8.5441, clear: 45, rot: 90, parts: cathedral(60, 24, 24, 10, 52, 8, 0xc8c0a8, 0x8a6f58, 0x8e9aa0) },
  ],
  nairobi: [
    { name: 'Kenyatta International Conference Centre', lat: -1.2884, lon: 36.8233, clear: 45, parts: [B(0, 0, 60, 60, 0, 14, 0xd8d0c0), C(0, 0, 11, 11, 14, 86, 0xe0dcd0), C(0, 0, 14, 3, 100, 14, 0xc8c4b8)] },
  ],
  dubai: [
    { name: 'Burj Khalifa', lat: 25.1972, lon: 55.2744, clear: 90, parts: [...(() => { let y = 0; return [[58, 52, 120], [46, 40, 100], [38, 32, 100], [30, 26, 100], [24, 20, 100], [18, 15, 80], [14, 10, 60], [9, 5, 40]].map(([wb, wt, h]) => { const p = F(0, 0, wb, wt, y, h, 0xb8c8d8); y += h; return p; }); })(), C(0, 0, 1.8, .15, 700, 128, 0xd0d4d6)] },
  ],
  riyadh: [
    { name: 'Kingdom Centre', lat: 24.7114, lon: 46.6744, clear: 55, parts: [B(0, 0, 64, 34, 0, 230, 0x9fb4c4), B(-22, 0, 20, 34, 230, 72, 0x9fb4c4), B(22, 0, 20, 34, 230, 72, 0x9fb4c4), B(0, 0, 64, 34, 296, 6, 0x9fb4c4)] },
  ],
  tokyo: [
    { name: 'NTT Docomo Yoyogi Building', lat: 35.6833, lon: 139.6946, clear: 40, parts: [F(0, 0, 52, 40, 0, 120, 0xcfc8b8), F(0, 0, 40, 30, 120, 100, 0xcfc8b8), F(0, 0, 30, 6, 220, 20, 0x8e9aa0), C(0, 0, 1.5, .2, 240, 12, 0xd0d4d6)] },
  ],
  bangkok: [
    { name: 'Democracy Monument', lat: 13.7567, lon: 100.5018, clear: 25, parts: [C(0, 0, 14, 14, 0, 2, 0xd8c8a0), F(0, 0, 10, 6, 2, 22, 0xd8b060), F(0, 0, 4, .3, 24, 6, 0xd8b060)] },
  ],
  taipei: [
    { name: 'Taipei 101', lat: 25.0339, lon: 121.5645, clear: 55, parts: [B(0, 0, 62, 62, 0, 40, 0xa8bcc8), F(0, 0, 54, 40, 40, 30, 0x7aa5a8), ...Array.from({ length: 8 }, (_, i) => F(0, 0, 34, 40, 70 + i * 36, 36, i % 2 ? 0x7aa5a8 : 0x6f9a9c)), F(0, 0, 34, 20, 358, 30, 0x7aa5a8), F(0, 0, 20, 10, 388, 40, 0x8ab5b8), C(0, 0, 3, .3, 428, 80, 0xd0d4d6)] },
  ],
  sydney: [
    { name: 'Sydney Tower', lat: -33.8704, lon: 151.2089, clear: 30, parts: [B(0, 0, 40, 40, 0, 20, 0xc8c4b8), C(0, 0, 6, 4.5, 0, 215, 0xcfcfcf), C(0, 0, 14, 22, 215, 18, 0xd8b040), C(0, 0, 22, 22, 233, 12, 0xd8b040), C(0, 0, 2, .3, 245, 64, 0xd0d4d6)] },
  ],
  auckland: [
    { name: 'Sky Tower', lat: -36.8485, lon: 174.7622, clear: 35, parts: [B(0, 0, 50, 50, 0, 14, 0xc8c4b8), C(0, 0, 7, 4.5, 0, 190, 0xd8d8d8), C(0, 0, 13, 15, 190, 10, 0x9fb4c4), C(0, 0, 11, 6, 200, 10, 0xd8d8d8), C(0, 0, 2.5, .3, 210, 118, 0xd0d4d6)] },
  ],
  perth: [
    { name: 'Central Park', lat: -31.9524, lon: 115.8588, clear: 40, parts: [B(0, 0, 40, 40, 0, 249, 0xb8c8d8)] },
  ],
};

// ---- geometry for one part -------------------------------------------
function gableGeo(w, len, h) {
  const a = w / 2, b = len / 2;
  const v = [[-a, 0, -b], [a, 0, -b], [a, 0, b], [-a, 0, b], [0, h, -b], [0, h, b]];
  const tri = [[0, 4, 5], [0, 5, 3], [1, 2, 5], [1, 5, 4], [0, 1, 4], [3, 5, 2]];   // two slopes + two gable ends
  const pos = []; for (const t of tri) for (const i of t) pos.push(...v[i]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
function meshOf(p, mat) {
  let g, m;
  switch (p.k) {
    case 'box': g = new THREE.BoxGeometry(p.w, p.h, p.d); m = new THREE.Mesh(g, mat(p.c)); m.position.set(p.x, p.y + p.h / 2, p.z); break;
    case 'cyl': g = new THREE.CylinderGeometry(p.rt, p.rb, p.h, 24); m = new THREE.Mesh(g, mat(p.c)); m.position.set(p.x, p.y + p.h / 2, p.z); break;
    case 'fr': g = new THREE.CylinderGeometry(p.wt * Math.SQRT1_2, p.wb * Math.SQRT1_2, p.h, 4); g.rotateY(Math.PI / 4); m = new THREE.Mesh(g, mat(p.c)); m.position.set(p.x, p.y + p.h / 2, p.z); break;
    case 'dome': g = new THREE.SphereGeometry(p.r, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2); m = new THREE.Mesh(g, mat(p.c)); m.position.set(p.x, p.y, p.z); break;
    case 'sph': g = new THREE.SphereGeometry(p.r, 18, 12); m = new THREE.Mesh(g, mat(p.c)); m.position.set(p.x, p.y, p.z); break;
    case 'gable': {   // hand-wound roof: draw both faces so no slope can cull to black
      g = gableGeo(p.w, p.len, p.h);
      const gm = mat(p.c).clone(); gm.side = THREE.DoubleSide;
      m = new THREE.Mesh(g, gm); m.position.set(p.x, p.y, p.z); break;
    }
    default: return null;
  }
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

const matCache = () => {
  const mats = new Map();
  return c => { let m = mats.get(c); if (!m) { m = new THREE.MeshLambertMaterial({ color: c }); mats.set(c, m); } return m; };
};
function groupOf(L, mat) {
  const grp = new THREE.Group();
  grp.name = 'landmark:' + L.name;
  for (const part of L.parts) { const m = meshOf(part, mat); if (m) grp.add(m); }
  return grp;
}

// ---- placement -------------------------------------------------------
// local meters east/south of the catalog center — exactly osm.js proj
const offsetOf = (L, meta) => [(L.lon - meta.lon) * mLon(meta.lat), -(L.lat - meta.lat) * M_LAT];
const inPlate = (L, meta) => { const [dx, dz] = offsetOf(L, meta); return Math.abs(dx) <= PLATE_HALF && Math.abs(dz) <= PLATE_HALF; };
const listFor = meta => (meta && !meta.pasture && LANDMARKS[meta.key] || []).filter(L => inPlate(L, meta));

let placed = [];   // QA: what the standing city carries

function centroid(poly) { let x = 0, z = 0; for (const p of poly) { x += p[0]; z += p[1]; } return [x / poly.length, z / poly.length]; }

const _build = CITY.build;
CITY.build = async function (cityData, cityMeta, anchor, onStatus) {
  const lms = cityData && cityData.source === 'osm' ? listFor(cityMeta) : [];
  placed = [];
  if (lms.length && cityData.buildings) {
    // the landmark REPLACES the plain extruded footprint under it
    const spots = lms.map(L => ({ L, p: offsetOf(L, cityMeta) }));
    cityData = {
      ...cityData,
      buildings: cityData.buildings.filter(b => {
        if (!b.poly || !b.poly.length) return true;
        const [cx, cz] = centroid(b.poly);
        return !spots.some(s => Math.hypot(cx - s.p[0], cz - s.p[1]) < (s.L.clear || 40));
      }),
    };
  }
  const g = await _build.call(CITY, cityData, cityMeta, anchor, onStatus);
  try {
    if (g && lms.length) {
      const mat = matCache();
      const ax = (anchor && anchor.x) || 0, az = (anchor && anchor.z) || 0;
      for (const L of lms) {
        const [dx, dz] = offsetOf(L, cityMeta);
        const grp = groupOf(L, mat);
        grp.position.set(ax + dx, 0, az + dz);   // anchor + local offset in double precision, like every city mesh
        grp.rotation.y = -(L.rot || 0) * Math.PI / 180;
        g.add(grp);
        placed.push({ name: L.name, dx: Math.round(dx), dz: Math.round(dz) });
      }
    }
  } catch (e) { console.error('[landmarks]', e); }
  return g;
};

export const LANDMARKS_API = {
  list() { return Object.entries(LANDMARKS).flatMap(([key, a]) => a.map(L => ({ key, name: L.name, lat: L.lat, lon: L.lon }))); },
  placed() { return placed.slice(); },
  listFor,
  group(L) { return groupOf(L, matCache()); },   // QA: one landmark as a standalone group
};
window.LANDMARKS = LANDMARKS_API;
