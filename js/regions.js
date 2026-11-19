// ====================================================================
// js/regions.js — v2.69 REGIONAL CHARACTER: pure data, no imports.
// The ask: "I want every city to be uniquely different." v2.65's city
// DNA already rolls size and a color rotation per city, but every city
// still drew from the SAME pastel palettes with the SAME pitched-roof
// habit, so Cairo and Oslo wore the same clothes. This file gives each
// catalog city a REGION (how that part of the world builds: wall
// colors, roof habit, how glassy and how tall its downtown runs) plus
// a few per-city overrides (Miami pastel deco, Athens white boxes,
// Dubai glass, Hong Kong stacked towers...).
//
//   REGIONS   id -> { warm, cool, shingles, decks?, flat, glass, tall,
//                     warmBias }
//     warm/cool   wall palettes (hex ints) — replace PAL_WARM/PAL_COOL
//     shingles    pitched-roof colors
//     decks       flat-roof deck colors (optional; falls back to stock)
//     flat        0..1 — chance a low-rise that WOULD get a pitched
//                 roof is built flat-roofed instead (deterministic)
//     glass       added to dna.glass (+ = curtain-wall downtown)
//     tall        multiplies dna.tall (untagged building heights)
//     warmBias    added to dna.warm
//   CITY_REGION key -> region id, or [id, {overrides}]
//   regionOf(key, lat, lon) -> the merged style (memoized) or null
//
// cityDNA() in util.js folds the numeric levers into the DNA, and
// city.js reads the palettes/roof habit off dna.region. Searched spots
// (keys like ll51.5_-0.1) infer a region from their coordinates, so a
// town you search for in Kyoto doesn't dress like Kansas.
// ====================================================================

export const REGIONS = {
  // brick, stone and steel: the old-money US/Canada core
  nastern: {
    warm: [0x9c4a3c, 0xa05252, 0xb5654f, 0x8a6f58, 0xcfb37f, 0xd8c9a8, 0xc8beac, 0xb08d76, 0xe0dcd4],
    cool: [0x8e99a6, 0x6e7b86, 0x9a9c9e, 0x4f4f52, 0xb5bdc2, 0x7f8fa0, 0xa8b4c2],
    shingles: [0x46505c, 0x3d4043, 0x6b4a33, 0x55603f],
    flat: .7, glass: .15, tall: 1.1, warmBias: .05,
  },
  // stucco, glass and sun: the sprawl cities of the west and south
  nawest: {
    warm: [0xf2e6d0, 0xe8d8b8, 0xe6c9a8, 0xd9b8a3, 0xf0e0c8, 0xd8b878, 0xc4907f],
    cool: [0x7f8fa0, 0x8496a8, 0xa8b4c2, 0x5c6b7a, 0xb5bdc2, 0xe1e3e6],
    shingles: [0x9c4a3c, 0x7a4638, 0x6b4a33, 0x46505c],
    flat: .6, glass: .2, tall: .95, warmBias: .1,
  },
  // colorful stucco, terracotta tile, dense hillsides
  latin: {
    warm: [0xe3a05a, 0xd9776a, 0xe8c46a, 0x7fb5a5, 0x8aa7cf, 0xc88fb0, 0xf0e0c0, 0xd8a087, 0xc2766b, 0xb76b5e],
    cool: [0xa8b4c2, 0x8e99a6, 0xcfd6c8, 0x9a9c9e],
    shingles: [0xb5523a, 0x9c4a3c, 0xc2766b, 0x7a4638],
    flat: .55, glass: .05, tall: .95, warmBias: .2,
  },
  // ochre, terracotta and cream under low clay-tile roofs
  med: {
    warm: [0xd9a066, 0xc98a5a, 0xe0c08a, 0xcd9488, 0xf2e6d0, 0xe8dcc0, 0xd8b890, 0xc4907f],
    cool: [0xcfc6b2, 0xb5b0a0, 0xe0dcd4],
    shingles: [0xb5523a, 0xc2663f, 0x9c4a3c, 0x8a4a38],
    flat: .22, glass: -.1, tall: .85, warmBias: .25,
  },
  // cream limestone under grey zinc mansards
  weurope: {
    warm: [0xeee3c8, 0xe8dcc0, 0xe0d3b4, 0xd8c8a4, 0xf2ead0, 0xcfc2a8, 0xc8beac],
    cool: [0x9aa2a8, 0xb5bdc2, 0x8e99a6, 0x6e7b86, 0xe1e3e6],
    shingles: [0x5a6068, 0x46505c, 0x3d4043, 0x6b6f72],
    flat: .18, glass: -.05, tall: .9, warmBias: .15,
  },
  // dark brick, slate roofs, painted fronts in the cold north
  nweurope: {
    warm: [0x9c4a3c, 0x8a4a3a, 0xa05252, 0xb08d76, 0x7a5c48, 0xcfb37f, 0xe8c46a, 0xc2766b, 0xd8a087],
    cool: [0x6e7b86, 0x8e99a6, 0x9aa2a8, 0x4f4f52],
    shingles: [0x46505c, 0x3d4043, 0x6b4a33, 0x39424a],
    flat: .2, glass: .0, tall: .9, warmBias: .0,
  },
  // Soviet slab blocks and pastel baroque
  ee: {
    warm: [0xd9c9a8, 0xcfc2a8, 0xc8beac, 0xb8a890, 0xe8dcc0, 0x9db5a0, 0xd8c8a4],
    cool: [0x9a9c9e, 0x8e99a6, 0xb5b5b0, 0x7f8a86, 0x6e7b86],
    shingles: [0x55603f, 0x6b4a33, 0x3d4043, 0x7a4638],
    flat: .6, glass: .0, tall: 1.15, warmBias: -.05,
  },
  // sand, limestone and whitewash under flat roofs
  mena: {
    warm: [0xd9c29a, 0xcfb37f, 0xe0cfa8, 0xc8a878, 0xe8dcc0, 0xd8b890, 0xc4a070],
    cool: [0xb5b0a0, 0xc8beac, 0xd8d4c8],
    shingles: [0xb5523a, 0x9c6a4a, 0x8a4a38],
    flat: .85, glass: .05, tall: .95, warmBias: .3,
  },
  // the Gulf: glass supertowers rising out of the sand
  gulf: {
    warm: [0xe0cfa8, 0xd9c29a, 0xe8dcc0],
    cool: [0x8fb4d0, 0x6e8fae, 0xa8c4d8, 0x5c7a96, 0x7f8fa0, 0xb5cfe0],
    shingles: [0x9c6a4a, 0x8a4a38],
    flat: 1, glass: .45, tall: 1.35, warmBias: -.3,
  },
  // concrete, corrugated rust and bright paint
  africa: {
    warm: [0xd9b8a3, 0xcfb37f, 0xc4907f, 0xe0dcd4, 0x9db5a0, 0xb76b5e, 0xe8c46a],
    cool: [0x9a9c9e, 0xb5b0a0, 0x8e99a6],
    shingles: [0x8a4a38, 0x7a7f84, 0x9c6a4a, 0x6b6f72],
    flat: .4, glass: .05, tall: .95, warmBias: .1,
  },
  // grey-white tile, slender glass towers, wall-to-wall density
  eastasia: {
    warm: [0xe1ddd4, 0xd8d4c8, 0xcfc8b8, 0xc8beac, 0xe8dcc0],
    cool: [0xe1e3e6, 0xb5bdc2, 0x9aa2a8, 0x8e99a6, 0x7f8fa0, 0x6e7b86],
    shingles: [0x46505c, 0x3d4043, 0x55606b],
    flat: .75, glass: .3, tall: 1.2, warmBias: -.1,
  },
  // tropical: bright paint, tin and tile, towers with greenery
  seasia: {
    warm: [0xe3b08a, 0xd9776a, 0xe8c46a, 0xcfb37f, 0x9db5a0, 0xc88fb0, 0xd8a087, 0xf0e0c0],
    cool: [0x8e99a6, 0x9a9c9e, 0xa8b4c2, 0xe1e3e6],
    shingles: [0xb5523a, 0x8a4a38, 0x7a7f84, 0x9c4a3c],
    flat: .5, glass: .1, tall: 1.05, warmBias: .2,
  },
  // red-brick suburbs under terracotta, glass downtowns
  oceania: {
    warm: [0xb5654f, 0xc4907f, 0xe8dcc0, 0xd9b8a3, 0xcfb37f, 0xf0e0c8],
    cool: [0x7f8fa0, 0x8496a8, 0xa8b4c2, 0xb5bdc2],
    shingles: [0xb5523a, 0x7a4638, 0x6b4a33, 0x46505c],
    flat: .3, glass: .2, tall: .95, warmBias: .1,
  },
};

const _R = id => id;
// city key (lowercase letters of the catalog name) -> region id, or
// [region id, per-city overrides merged over the region]
export const CITY_REGION = {
  // North America
  newyork: ['nastern', { tall: 1.3, glass: .2 }],
  chicago: ['nastern', { tall: 1.25, glass: .2 }],
  toronto: ['nastern', { glass: .3 }],
  montreal: ['nastern', { flat: .5, shingles: [0x6b6f72, 0x46505c, 0x9c4a3c] }],
  losangeles: ['nawest', { tall: .85, flat: .75 }],
  sanfrancisco: ['nawest', { warm: [0xf2e6d0, 0xe0c8b0, 0xc8d8c8, 0xe8d0a0, 0xd8b0a8], flat: .35 }],
  vancouver: ['nawest', { glass: .4, tall: 1.05 }],
  houston: ['nawest', { glass: .3, tall: 1.05 }],
  lasvegas: ['nawest', { warm: [0xd8b878, 0xe8c878, 0xc4907f, 0xf0e0c8, 0xd8a087], glass: .35, tall: 1.1 }],
  miami: ['nawest', { warm: [0xf4c9d0, 0xbfe3d8, 0xf6e3a8, 0xcfe0f0, 0xf2d2b6, 0xf2efe8], flat: .9, glass: .25 }],
  // Latin America
  mexicocity: 'latin',
  havana: ['latin', { warm: [0xd8a087, 0xe0c8a0, 0x9fc4b8, 0xc8a0b0, 0xe8dcc0, 0xb8c8d8], flat: .85, glass: -.2, tall: .75 }],
  saopaulo: ['latin', { glass: .25, tall: 1.2, flat: .75 }],
  buenosaires: ['latin', { warm: [0xe8dcc0, 0xd8c8a4, 0xcfc2a8, 0xc2766b, 0xd8b890], flat: .45, tall: 1.0 }],
  riodejaneiro: ['latin', { warm: [0xf2efe8, 0xe8dcc0, 0xe3a05a, 0x8aa7cf, 0xd9776a], flat: .7, glass: .1 }],
  lima: ['latin', { warm: [0xd9c29a, 0xcfb37f, 0xe0cfa8, 0xd8a087, 0xe8dcc0], flat: .9 }],
  bogota: ['latin', { warm: [0x9c4a3c, 0xb5654f, 0xa05252, 0xcfb37f, 0xc4907f], flat: .6 }],
  santiago: ['latin', { glass: .25, tall: 1.1 }],
  quito: ['latin', { warm: [0xe8dcc0, 0xd9776a, 0xe3a05a, 0xf0e0c0], flat: .35 }],
  caracas: ['latin', { flat: .75, tall: 1.05 }],
  // Europe
  london: ['nweurope', { glass: .15, tall: .95 }],
  paris: ['weurope', { tall: .8, glass: -.15 }],
  berlin: ['weurope', { warm: [0xe8dcc0, 0xd8c8a4, 0xe0d3b4, 0xc2b8a0, 0xd9a066, 0x9db5a0], flat: .35, tall: .9 }],
  madrid: 'med',
  rome: ['med', { warm: [0xd9a066, 0xc98a5a, 0xcd9488, 0xe0b080, 0xc4907f], tall: .75 }],
  lisbon: ['med', { warm: [0xf2e6d0, 0xe0c08a, 0x8fc4c0, 0xe8c46a, 0xd8a087, 0xb8c8d8], flat: .15 }],
  athens: ['med', { warm: [0xf4f1ea, 0xe8e4da, 0xdcd8cc, 0xe0cfa8], flat: .8, tall: .9 }],
  amsterdam: ['nweurope', { warm: [0x8a4a3a, 0x9c4a3c, 0x7a5c48, 0xa05252, 0x6b5340], flat: .1, tall: .75, glass: -.1 }],
  dublin: ['nweurope', { warm: [0x9c4a3c, 0xa05252, 0xb08d76, 0xd8a087, 0xe8dcc0], flat: .15, tall: .8 }],
  stockholm: ['nweurope', { warm: [0xe8c46a, 0xd9776a, 0xe8dcc0, 0xc2766b, 0xcfb37f], flat: .25 }],
  oslo: ['nweurope', { warm: [0xe8c46a, 0xd9776a, 0xe8dcc0, 0xb08d76, 0xcfb37f], flat: .25, glass: .1 }],
  vienna: ['weurope', { warm: [0xf2e0a0, 0xeee3c8, 0xe8dcc0, 0xd8a087, 0xd8c8a4], tall: .8 }],
  zurich: ['weurope', { glass: .1, tall: .9, flat: .3 }],
  moscow: ['ee', { tall: 1.25, glass: .15 }],
  kyiv: 'ee',
  istanbul: ['mena', { shingles: [0xb5523a, 0x9c4a3c, 0x8a4a38], flat: .45, tall: 1.0 }],
  // Middle East and Africa
  cairo: ['mena', { warm: [0xd9c29a, 0xc8a878, 0xcfb37f, 0xb89a70, 0xd8b890], flat: .95, tall: 1.0 }],
  casablanca: ['mena', { warm: [0xf2efe8, 0xe8e4da, 0xf0e0c8, 0xdcd8cc], flat: .9 }],
  telaviv: ['mena', { warm: [0xf2efe8, 0xe8e4da, 0xf0e0c8, 0xe0dcd4], flat: .9, glass: .25, tall: 1.1 }],
  tehran: ['mena', { flat: .8, tall: 1.0 }],
  riyadh: ['mena', { glass: .25, tall: 1.1, flat: 1 }],
  dubai: 'gulf',
  karachi: ['mena', { warm: [0xe0cfa8, 0xd9b8a3, 0xcfb37f, 0xc4907f], flat: .95 }],
  lagos: 'africa',
  nairobi: ['africa', { glass: .15, tall: 1.0 }],
  addisababa: 'africa',
  johannesburg: ['africa', { glass: .25, tall: 1.15, flat: .5 }],
  // Asia
  tokyo: ['eastasia', { tall: 1.15 }],
  seoul: ['eastasia', { warm: [0xd8d4c8, 0xcfc8b8, 0xe0cfa8, 0xc8beac], tall: 1.25 }],
  beijing: ['eastasia', { warm: [0xcfb37f, 0xc4907f, 0xe0cfa8, 0xd8c8a4, 0xc8beac], flat: .6, tall: 1.1 }],
  shanghai: ['eastasia', { glass: .4, tall: 1.3 }],
  hongkong: ['eastasia', { glass: .45, tall: 1.5 }],
  taipei: ['eastasia', { warm: [0xd8d4c8, 0xcfc8b8, 0xc8beac, 0xb8c8c0], tall: 1.05 }],
  singapore: ['seasia', { warm: [0xf2efe8, 0xe8e4da, 0xf0e0c8, 0xe0dcd4], glass: .4, tall: 1.25, flat: .8 }],
  bangkok: ['seasia', { tall: 1.1 }],
  kualalumpur: ['seasia', { glass: .3, tall: 1.2 }],
  jakarta: ['seasia', { glass: .2, tall: 1.05 }],
  manila: ['seasia', { flat: .7, tall: .95 }],
  mumbai: ['seasia', { warm: [0xd9776a, 0xe8c46a, 0xcfb37f, 0xe3b08a, 0xb0b8a8, 0xd8a087], flat: .75, tall: 1.1 }],
  delhi: ['seasia', { warm: [0xd9a066, 0xe3b08a, 0xcfb37f, 0xc88a70, 0xe0c8a0], flat: .85 }],
  // Oceania
  sydney: ['oceania', { glass: .3 }],
  melbourne: ['oceania', { glass: .25, flat: .25 }],
  auckland: ['oceania', { warm: [0xe8dcc0, 0xc8d0c0, 0xb8c8d8, 0xd8a087, 0xcfb37f], flat: .25, tall: .85 }],
  perth: ['oceania', { glass: .35, tall: .95 }],
};

// coarse lat/lon boxes for searched spots (keys ll<lat>_<lon>): first
// hit wins, ordered most-specific first. [south, north, west, east, id]
const BOXES = [
  [24, 50, -125, -66, 'nastern'], [14, 33, -118, -86, 'latin'], [-56, 13, -82, -34, 'latin'],
  [36, 71, -10, 3, 'nweurope'], [43, 55, 3, 18, 'weurope'], [35, 44, -10, 27, 'med'],
  [44, 70, 18, 60, 'ee'], [12, 38, 25, 62, 'mena'], [-35, 12, -18, 52, 'africa'],
  [20, 46, 100, 146, 'eastasia'], [-11, 30, 92, 128, 'seasia'], [8, 34, 60, 92, 'seasia'],
  [-48, -10, 112, 180, 'oceania'],
];
export function inferRegionId(lat, lon) {
  for (const [s, n, w, e, id] of BOXES) if (lat >= s && lat <= n && lon >= w && lon <= e) return id;
  return null;
}

const _memo = new Map();
// key: city key; lat/lon: only used for searched spots (ll… keys)
export function regionOf(key, lat, lon) {
  if (_memo.has(key)) return _memo.get(key);
  let ent = CITY_REGION[key], out = null;
  if (!ent && typeof key === 'string' && key.startsWith('ll')) {
    let la = lat, lo = lon;
    if (la == null) { const m = key.match(/^ll(-?[\d.]+)_(-?[\d.]+)$/); if (m) { la = +m[1]; lo = +m[2]; } }
    if (la != null) ent = inferRegionId(la, lo);
  }
  if (ent) {
    const id = Array.isArray(ent) ? ent[0] : ent;
    const base = REGIONS[_R(id)];
    if (base) out = { id, ...base, ...(Array.isArray(ent) ? ent[1] : null) };
  }
  _memo.set(key, out);
  return out;
}
