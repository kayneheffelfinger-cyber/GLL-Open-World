// ====================================================================
// js/systems/generators.js — OWN POWER (v2.75): build coal/oil burners,
// hydro turbines, wind turbines and solar arrays that feed your own
// businesses, sell the surplus to the grid, and ride out blackouts.
// Additive on top of power.js (the v2.59 Grid) — nothing there is rewritten.
// ====================================================================
import * as THREE from 'three';
import { fmt$, fmt$2, hashStr } from '../util.js';
import { STATE } from '../state.js';
import { saveGame } from '../save.js';
import { earn, spend, uiBalance } from '../systems/economy.js';
import { closeModal, openModal, toast } from '../ui/dom.js';
import { LANDGEO } from '../core.js';
import { WORLD } from '../world/world.js';
import { CITY } from '../world/city.js';
import { ECO } from '../systems/eco.js';
import { EXCH } from '../systems/exchange.js';
import { PWR } from '../systems/power.js';
import { canvas } from '../render/main.js';
import { clickPick, patchClickPick, screenToGround } from '../render/night.js';

// ======== section: 75_generators.js ========
// ====================================================================
// v2.75 — OWN POWER. The ask: "Let players build generators that supply
// their own businesses and optionally sell surplus to the grid: coal/oil
// burners (consume fuel), hydroelectric turbines (only on rivers from
// OSM water data), wind turbines (land or ocean, output varying), and
// solar panels (output by day/night). Show capacity vs. demand and
// handle blackouts."
//   - THE UNITS (rated kW · price · upkeep/day):
//       ☀ Solar array   25 kW · $4,200  · $3   — follows the sun: 0 at night,
//                                        full at noon, dimmed on cloudy days
//       🌬 Wind turbine  40 kW · $8,500  · $12  — land or open ocean (ocean is
//                                        ×1.6 to build, steadier and stronger);
//                                        output wanders with the weather
//       💧 Hydro turbine 50 kW · $24,000 · $20  — ONLY inside a river polygon
//                                        of the standing city's real OSM map
//       🏭 Coal burner   60 kW · $14,000 · $35  — burns Coal (1 t = 110 kWh)
//       🛢 Oil burner    90 kW · $19,000 · $45  — burns Oil  (1 t = 700 kWh)
//   - THE DISPATCH (every frame): your businesses' demand (the same kW the
//     Grid meters) is met by hydro, wind and solar first, then by burners.
//     Whatever your own units supply is NOT metered, so it is not billed.
//     Any shortfall is imported from GLL Power & Light at the grid price
//     (the existing bill). Burners pull fuel from the Ore Exchange stockpile
//     first; when it runs out they buy on the spot at 125% of the market,
//     and a burner that cannot pay for fuel goes dark.
//   - SELLING: SELL SURPLUS (on by default) pays your unused output at
//     today's grid price every second. Burners only fire up to sell when
//     the price beats their fuel cost.
//   - BLACKOUTS: the utility's feeder fails now and then (about one game
//     day in nine, 4–10 hours, announced). While it is down, nothing is
//     imported or sold: businesses your units cannot cover lose power for
//     real (the same "no customers, no income" as a cut-off — but they come
//     back by themselves the moment supply returns, no bill to pay). Build
//     enough capacity, or keep the burners fuelled, and the lights stay on.
//   - THE DISPLAY: the POWER panel gains OWN POWER — demand vs capacity,
//     supply now, import/export, per-unit rows with BUILD buttons — and the
//     Empire panel a one-line summary; a banner shows during a blackout.
//   - THE SAVE: a `gen` field (clock, sell switch, units), sanitized on
//     load; absent on older saves = nothing built. Pack stays v5.
// Touchpoints outside this file: state.js/save.js (`gen`), js/boot.js
// (import + ready log), the osm.js river flag. Every call is try/caught so
// a mistake here can never touch the world. window.GEN is the QA surface.
// ====================================================================
export const GEN = (() => {
  const DAY = 90;                      // seconds per game day — the beat everything settles on
  const HPS = 24 / DAY;                // game-hours per real second
  const MAX_UNITS = 24;
  const GAP = 14;                      // m between units
  const SELL_BACK = .6;                // demolish salvage rate (the property rate)
  const SPOT = 1.25;                   // burners buy missing fuel at 125% of market
  const TYPES = {
    solar: { name: 'Solar array', emoji: '☀', kw: 25, cost: 4200, up: 3, hint: 'on dry land · output follows the sun' },
    wind: { name: 'Wind turbine', emoji: '🌬', kw: 40, cost: 8500, up: 12, seaX: 1.6, hint: 'land or open ocean · output varies with the weather' },
    hydro: { name: 'Hydro turbine', emoji: '💧', kw: 50, cost: 24000, up: 20, hint: 'only on a river in the real OSM map of the city you are standing in' },
    coal: { name: 'Coal burner', emoji: '🏭', kw: 60, cost: 14000, up: 35, fuel: 'Coal', kwhPer: 110, hint: 'on dry land · burns Coal from your stockpile' },
    oil: { name: 'Oil burner', emoji: '🛢', kw: 90, cost: 19000, up: 45, fuel: 'Oil', kwhPer: 700, hint: 'on dry land · burns Oil from your stockpile' },
  };
  const ORDER = ['solar', 'wind', 'hydro', 'coal', 'oil'];
  const RENEW = { solar: 1, wind: 1, hydro: 1 };

  let root = null, acc = 0, dayAcc = 0;
  let placing = null, lastPtr = null, ghost = null, ghostMat = null;
  let panelT = null;
  const built = new Map();             // unit id -> { g, rot, t }
  // live dispatch snapshot (recomputed every frame; read by the panel/QA)
  let snap = { demand: 0, own: 0, ren: 0, burn: 0, sold: 0, imp: 0, short: 0, gridUp: true, shed: 0, cap: 0, avail: 0 };
  let shed = {};                       // plot id -> 1 while blacked out
  let wasBlack = false;
  let sales = 0;                       // $ accrued since the last 1 s settle

  // ---- state (all lazy: a save load can replace STATE) -----------------
  function ensure() {
    let g = STATE.gen;
    if (!g || typeof g !== 'object') g = STATE.gen = { sell: 1, t: 12, sold: 0, units: [], out: null };
    if (!Array.isArray(g.units)) g.units = [];
    if (!isFinite(+g.t)) g.t = 12;
    return g;
  }
  const units = () => ensure().units;
  const typeOf = u => TYPES[u.t];
  const hourNow = () => ((ensure().t % 24) + 24) % 24;
  const dayIdx = () => Math.floor(ensure().t / 24);
  const R2 = v => Math.round(v * 100) / 100;
  const biz = () => { try { return PWR.biz(); } catch (e) { return []; } };
  const price = () => { try { return PWR.price(); } catch (e) { return .4; } };
  const fuelPx = f => { try { return +EXCH.price(f) || 0; } catch (e) { return f === 'Oil' ? 95 : 12; } };
  const stock = f => +((STATE.res || {})[f] || 0) || 0;
  function bizName(p) { try { return PWR.state().biz.find(b => b.id === p.id).name; } catch (e) { return 'a business'; } }

  // ---- the weather: deterministic functions of the game clock ----------
  const frac = n => { const h = hashStr('gn' + n); return (h % 10000) / 10000; };
  function cloud(d) { return .55 + .45 * frac('c' + d); }                       // 0.55–1.0 per game day
  function sunK(h) { return (h > 6 && h < 18) ? Math.sin(Math.PI * (h - 6) / 12) : 0; }
  function windK(u, t) {                                                       // 0..1, wanders on 60 h / 19 h / 6 h swells
    const ph = frac(u.id) * 6.283;
    let v = .46 + .30 * Math.sin(t / 9.5 + ph) + .17 * Math.sin(t / 3 + ph * 2.1) + .09 * Math.sin(t / .95 + ph * 3.3);
    if (u.sea) v = v * 1.15 + .12;
    return Math.max(0, Math.min(1, v));
  }
  function flowK(u, t) { return Math.max(.3, Math.min(.95, .62 + .3 * Math.sin(t / 110 + frac(u.id) * 6.283))); }   // rivers swell and ebb over weeks
  function renewKw(u, t) {
    const ty = typeOf(u); if (!ty || !u.on) return 0;
    const h = ((t % 24) + 24) % 24;
    if (u.t === 'solar') return ty.kw * sunK(h) * cloud(Math.floor(t / 24));
    if (u.t === 'wind') return ty.kw * windK(u, t);
    if (u.t === 'hydro') return ty.kw * flowK(u, t);
    return 0;
  }
  const fuelCostKwh = u => { const ty = typeOf(u); return ty && ty.fuel ? fuelPx(ty.fuel) * SPOT / ty.kwhPer : 0; };

  // ---- the grid feeder: an outage window some days ----------------------
  function outageFor(day) {                                                   // {s,e} hours or null — ~1 day in 9
    if (frac('o' + day) > .11) return null;
    const s = 3 + Math.floor(frac('os' + day) * 14), d = 4 + Math.floor(frac('od' + day) * 7);
    return { s, e: s + d };
  }
  function gridUp() {
    const g = ensure();
    if (g.out && g.t < g.out.e) return false;      // QA / forced outage (absolute game-hour end)
    const d = dayIdx(), h = hourNow(), o = outageFor(d);
    if (o && h >= o.s && h < o.e) return false;
    return true;
  }
  function outageText() {
    const g = ensure();
    if (g.out && g.t < g.out.e) return 'until ' + clock(g.out.e);
    const d = dayIdx(), h = hourNow(), o = outageFor(d);
    if (o && h >= o.s && h < o.e) return 'until ' + clock(o.e);
    return '';
  }
  const clock = h => { h = ((h % 24) + 24) % 24; const hh = Math.floor(h), mm = Math.floor((h - hh) * 60); return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm; };

  // ---- the dispatch ---------------------------------------------------------
  // Pure arithmetic over the current snapshot of the world; step() applies it.
  function dispatch(t, dtH, apply) {
    const g = ensure();
    const bz = biz();
    const live = bz.filter(p => { try { return !PWR.__arrears(p); } catch (e) { return true; } });
    const dem = live.reduce((s, p) => s + PWR.draw(p), 0);
    const up = gridUp();
    let ren = 0, cap = 0, avail = 0;
    const us = g.units;
    const out = new Map();                         // unit -> kW delivered
    for (const u of us) {
      const ty = typeOf(u); if (!ty) continue;
      cap += u.on ? ty.kw : 0;
      if (RENEW[u.t]) { const k = renewKw(u, t); out.set(u, k); ren += k; avail += k; }
    }
    // burners: fuel on hand or cash for the spot price?
    const burners = us.filter(u => typeOf(u) && typeOf(u).fuel && u.on).sort((a, b) => fuelCostKwh(a) - fuelCostKwh(b));
    const ready = u => { const ty = typeOf(u); return !u.dry && (stock(ty.fuel) > .001 || STATE.money > ty.kw * dtH / ty.kwhPer * fuelPx(ty.fuel) * SPOT + 1); };
    for (const u of burners) if (ready(u)) avail += typeOf(u).kw;
    // 1) renewables meet demand; 2) burners fill the gap; 3) selling: free surplus + profitable burners
    let need = Math.max(0, dem - ren), burnKw = 0;
    for (const u of burners) {
      if (!ready(u)) { out.set(u, 0); continue; }
      const k = Math.min(typeOf(u).kw, need); need -= k; out.set(u, k); burnKw += k;
    }
    let ownForDemand = Math.min(dem, ren + burnKw);
    let sellKw = 0;
    if (g.sell && up) {
      sellKw = Math.max(0, ren - dem);
      for (const u of burners) {                   // spare burner capacity sells only if it beats the fuel bill
        if (!ready(u) || fuelCostKwh(u) >= price() * .98) continue;
        const room = typeOf(u).kw - (out.get(u) || 0);
        if (room > 0) { out.set(u, typeOf(u).kw); burnKw += room; sellKw += room; }
      }
    }
    const short = Math.max(0, dem - ownForDemand);
    let shedSet = {}, shedN = 0;
    if (short > 1e-6 && !up) {                     // grid down and your units cannot cover it → businesses go dark
      let remain = ownForDemand;
      for (const p of live.slice().sort((a, b) => PWR.draw(a) - PWR.draw(b))) {   // keep as many lights on as the supply allows
        const d = PWR.draw(p);
        if (remain + 1e-9 >= d) remain -= d; else { shedSet[p.id] = 1; shedN++; }
      }
    }
    const shedDraw = live.filter(p => shedSet[p.id]).reduce((s, p) => s + PWR.draw(p), 0);
    const served = dem - shedDraw;                 // kW of demand actually running
    const imp = up ? short : 0;
    const res = { demand: dem, own: ownForDemand, ren, burn: burnKw, sold: sellKw, imp, short, gridUp: up, shed: shedN, cap, avail, served, shedSet, out, live, shedDraw };
    return res;
  }

  function step(dt) {
    const g = ensure();
    const hrs = dt * HPS;
    g.t += hrs;
    const r = dispatch(g.t, hrs, true);
    // meter correction: PWR just metered every live cart's full draw; take back what your own units
    // supplied (and everything a blacked-out cart never drew) so only grid imports are billed
    if (r.live.length && STATE.mode !== 'boot') {
      const cover = r.demand > 0 ? Math.min(1, r.own / r.demand) : 0;
      let rec; try { rec = STATE.pow && STATE.pow.b; } catch (e) { rec = null; }
      if (rec) for (const p of r.live) {
        const e = rec[p.id]; if (!e || e.cut) continue;
        const d = PWR.draw(p) * hrs;
        const back = r.shedSet[p.id] ? d : (r.gridUp ? d * cover : d);   // grid down: served carts ran on own power entirely
        e.m = Math.max(0, +(e.m - back).toFixed(3));
      }
    }
    // fuel burn
    for (const u of g.units) {
      const ty = typeOf(u); if (!ty || !ty.fuel) continue;
      const kw = r.out.get(u) || 0;
      u.run = kw;
      if (kw > 0) {
        const tons = kw * hrs / ty.kwhPer;
        const have = stock(ty.fuel), use = Math.min(have, tons);
        if (use > 0) { const left = +(have - use).toFixed(3); if (left > .004) STATE.res[ty.fuel] = left; else delete STATE.res[ty.fuel]; }
        u.spot = (u.spot || 0) + (tons - use) * fuelPx(ty.fuel) * SPOT;
        u.burnt = (u.burnt || 0) + tons;
      }
    }
    if (r.sold > 0) sales += r.sold * hrs * price();
    snap = { demand: r.demand, own: r.own, ren: r.ren, burn: r.burn, sold: r.sold, imp: r.imp, short: r.short, gridUp: r.gridUp, shed: r.shed, cap: r.cap, avail: r.avail };
    // blackout bookkeeping
    const before = shed;
    shed = r.shedSet;
    const nowBlack = r.shed > 0;
    if (nowBlack && !wasBlack) {
      const first = r.live.find(p => shed[p.id]);
      try { toast('🔌 <b>BLACKOUT</b> — the grid is down' + (outageText() ? ' ' + outageText() : '') + ' and your generators cover only ' + R2(r.own) + ' of ' + R2(r.demand) + ' kW. <b>' + r.shed + ' business' + (r.shed === 1 ? '' : 'es') + ' lost power</b>' + (first ? ' (' + bizName(first) + (r.shed > 1 ? ' +' + (r.shed - 1) : '') + ')' : '') + ' — no customers, no income. Build more capacity or fuel your burners.', 'warn'); } catch (e) { }
      g.black = (g.black | 0) + 1;
    } else if (!nowBlack && wasBlack) {
      try { toast('💡 <b>Power restored</b> — supply covers demand again, every business is back on.'); } catch (e) { }
    }
    if (nowBlack !== wasBlack) { wasBlack = nowBlack; banner(); }
    void before;
    // 1 s beat: sales are paid, spot fuel is bought
    acc += dt;
    if (acc >= 1) { acc = 0; settle(); }
    // day beat: upkeep
    dayAcc += dt;
    if (dayAcc >= DAY) { dayAcc -= DAY; try { upkeepDay(1); } catch (e) { console.error('[gen]', e); } }
  }

  function settle() {
    const g = ensure();
    if (sales > .005) { const v = +sales.toFixed(2); sales = 0; g.sold = +((+g.sold || 0) + v).toFixed(2); earn(v, false); }
    for (const u of g.units) {
      const ty = typeOf(u); if (!ty || !ty.fuel) continue;
      if (u.spot > .004) {
        const due = +u.spot.toFixed(2);
        if (STATE.money >= due) { STATE.money = +(STATE.money - due).toFixed(2); u.spot = 0; if (u.dry) u.dry = 0; try { uiBalance(); } catch (e) { } }
        else {
          u.spot = 0; u.dry = 1;
          try { toast('⛽ <b>' + ty.name + ' is out of fuel</b> — the stockpile is empty and the balance can\'t cover ' + fmt$(due) + ' of spot ' + ty.fuel + '. It goes dark until you fund it (buy ' + ty.fuel + ' on the exchange or add cash).', 'warn'); } catch (e) { }
        }
      } else if (u.dry && STATE.money > 500) u.dry = 0;
    }
  }
  function upkeepDay(days) {
    const g = ensure();
    let total = 0;
    for (const u of g.units) {
      const ty = typeOf(u); if (!ty || !u.on) continue;
      const due = ty.up * days;
      if (STATE.money >= due) { STATE.money = +(STATE.money - due).toFixed(2); total += due; }
      else { u.on = 0; try { toast('🔧 <b>' + ty.name + ' tripped off</b> — the balance couldn\'t cover its ' + fmt$(ty.up) + '/day upkeep. Switch it back on in its panel when you can pay.', 'warn'); } catch (e) { } }
    }
    if (total > 0) { try { uiBalance(); } catch (e) { } try { saveGame(); } catch (e) { } }
    return total;
  }

  // ---- offline: the night shift settles the gap on averages ---------------
  const AVG = { solar: .3183 * .78, wind: .34, windSea: .52, hydro: .62 };
  function nightSettle(days, pr) {
    const g = ensure(), out = { sold: 0, upkeep: 0, saved: 0 };
    if (!(days > 0) || !g.units.length) { g.t += (days > 0 ? days : 0) * 24; return out; }
    g.t += days * 24;
    const bz = biz().filter(p => (p.crew || []).length);
    const dem = bz.reduce((s, p) => { try { return PWR.isCut(p) ? s : s + PWR.draw(p); } catch (e) { return s; } }, 0);
    let ren = 0;
    for (const u of g.units) { const ty = typeOf(u); if (!ty || !u.on || !RENEW[u.t]) continue; ren += ty.kw * (u.t === 'wind' && u.sea ? AVG.windSea : AVG[u.t]); }
    const burners = g.units.filter(u => typeOf(u) && typeOf(u).fuel && u.on).sort((a, b) => fuelCostKwh(a) - fuelCostKwh(b));
    const hrs = 24 * days;
    let own = Math.min(dem, ren), need = Math.max(0, dem - ren), burnKw = 0, sell = g.sell ? Math.max(0, ren - dem) : 0;
    const burn = (u, kw) => {
      const ty = typeOf(u), tons = kw * hrs / ty.kwhPer, have = stock(ty.fuel), use = Math.min(have, tons);
      const cost = (tons - use) * fuelPx(ty.fuel) * SPOT;
      if (use > 0) { const left = +(have - use).toFixed(3); if (left > .004) STATE.res[ty.fuel] = left; else delete STATE.res[ty.fuel]; }
      if (cost > STATE.money) return false;           // can't pay for the fuel — it sits idle overnight
      STATE.money = +(STATE.money - cost).toFixed(2); return true;
    };
    for (const u of burners) { const k = Math.min(typeOf(u).kw, need); if (k > 0 && burn(u, k)) { need -= k; own += k; burnKw += k; } }
    if (g.sell) for (const u of burners) {
      if (fuelCostKwh(u) >= price() * .98) continue;
      const room = typeOf(u).kw - Math.min(typeOf(u).kw, Math.max(0, dem - ren - (burnKw - 0)));
      if (room > 0 && burn(u, room)) sell += room;
    }
    // overnight bills were charged by PWR for staffed carts at full draw → refund the share your units supplied
    const cover = dem > 0 ? Math.min(1, own / dem) : 0;
    if (pr && pr.billed > 0 && cover > 0) { const back = +(pr.billed * cover).toFixed(2); STATE.money = +(STATE.money + back).toFixed(2); pr.billed = +(pr.billed - back).toFixed(2); out.saved = back; }
    if (sell > 0) { out.sold = +(sell * hrs * price()).toFixed(2); STATE.money = +(STATE.money + out.sold).toFixed(2); g.sold = +((+g.sold || 0) + out.sold).toFixed(2); }
    out.upkeep = upkeepDay(days);
    try { uiBalance(); } catch (e) { }
    return out;
  }

  // ---- siting -------------------------------------------------------------
  const isW = (x, z) => { try { return !!(LANDGEO.ready && LANDGEO.isWaterWorld(x, z)); } catch (e) { return false; } };
  const isLake = (x, z) => { try { return LANDGEO.isLakeLL(-z / 111320, x / 111320); } catch (e) { return false; } };
  // a river polygon from the standing city's real OSM map: flagged river by the importer,
  // or (older cached imports) a long thin water polygon — lakes and ponds are round and never qualify
  function riverPoly(poly) {
    if (!poly || poly.length < 4) return false;
    let x0 = 1e18, x1 = -1e18, z0 = 1e18, z1 = -1e18, cx = 0, cz = 0;
    for (const p of poly) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); cx += p[0]; cz += p[1]; }
    cx /= poly.length; cz /= poly.length;
    // principal-axis aspect from the second moments
    let sxx = 0, szz = 0, sxz = 0;
    for (const p of poly) { const a = p[0] - cx, b = p[1] - cz; sxx += a * a; szz += b * b; sxz += a * b; }
    const tr = sxx + szz, det = sxx * szz - sxz * sxz, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
    return Math.sqrt(l1 / l2) >= 3 && Math.max(x1 - x0, z1 - z0) >= 120;
  }
  function onRiver(x, z) {
    try {
      const rec = CITY.rec;
      if (!rec || rec.source !== 'osm') return false;        // generated fallback cities carry made-up water, never real rivers
      const an = CITY.anchor || { x: 0, z: 0 };            // rec.waters are city-local; the world is shifted by the anchor
      const lx = x - (an.x || 0), lz = z - (an.z || 0);
      for (const w of (rec.waters || [])) {
        const poly = w.poly; if (!poly) continue;
        if (w.river !== true && !(w.river === undefined && riverPoly(poly))) continue;
        if (CITY.inPoly(lx, lz, poly)) return true;
      }
    } catch (e) { }
    return false;
  }
  function siteOk(type, x, z) {
    if (STATE.mode !== 'city' || !WORLD.group) return { ok: false, why: 'world' };
    for (const u of units()) if (Math.hypot(x - u.x, z - u.z) < GAP) return { ok: false, why: 'unit' };
    if (type === 'hydro') return onRiver(x, z) ? { ok: true } : { ok: false, why: 'river' };
    if (isW(x, z)) {
      if (type !== 'wind') return { ok: false, why: 'water' };
      if (isLake(x, z) || onRiver(x, z)) return { ok: false, why: 'lake' };
      return { ok: true, sea: true };
    }
    try { if (CITY.pointInBuilding) for (const [dx, dz] of [[0, 0], [9, 0], [-9, 0], [0, 9], [0, -9]]) if (CITY.pointInBuilding(x + dx, z + dz)) return { ok: false, why: 'building' }; } catch (e) { }
    try { if (CITY.distToRoad && (CITY.distToRoad(x, z) || {}).d < 17) return { ok: false, why: 'road' }; } catch (e) { }
    try { if (onRiver(x, z)) return { ok: false, why: 'river-bank' }; } catch (e) { }
    return { ok: true };
  }
  const WHY = {
    world: 'Enter the world first.', unit: 'Too close to another generator — leave ' + GAP + ' m.',
    river: 'Hydro turbines only go IN a river from the city\'s real OSM map — stand in the water of a mapped river (not a lake, pond or the sea).',
    water: 'That is water — this unit needs dry land (only wind turbines and hydro turbines go on water).',
    lake: 'Lakes and rivers are not open ocean — put wind turbines on land or out at sea.',
    building: 'A building is in the way.', road: 'Too close to a road — leave about 17 m of clearance.', 'river-bank': 'That is a river — build a hydro turbine there instead.',
  };
  const priceOf = (type, sea) => Math.round(TYPES[type].cost * (type === 'wind' && sea ? TYPES.wind.seaX : 1));

  function build(type, x, z) {
    const ty = TYPES[type]; if (!ty) return { ok: false, why: 'type' };
    const g = ensure();
    if (g.units.length >= MAX_UNITS) return { ok: false, why: 'cap' };
    const s = siteOk(type, x, z);
    if (!s.ok) return { ok: false, why: s.why, text: WHY[s.why] };
    const cost = priceOf(type, s.sea);
    if (!spend(cost)) return { ok: false, why: 'funds', cost };
    const id = 'g' + Math.round(x) + '_' + Math.round(z);
    if (g.units.some(u => u.id === id)) return { ok: false, why: 'unit', text: WHY.unit };
    const u = { id, t: type, x: +x, z: +z, on: 1, sea: s.sea ? 1 : 0, price: cost, spot: 0, burnt: 0, dry: 0, run: 0 };
    g.units.push(u);
    ensureOne(u.id);
    try { saveGame(); } catch (e) { }
    return { ok: true, id, cost, sea: !!s.sea };
  }
  function demolish(id) {
    const g = ensure(), i = g.units.findIndex(u => u.id === id);
    if (i < 0) return { ok: false };
    const u = g.units[i], back = Math.round(u.price * SELL_BACK);
    g.units.splice(i, 1); disposeOne(id);
    earn(back, false);
    try { saveGame(); } catch (e) { }
    return { ok: true, back };
  }
  function toggle(id) {
    const u = units().find(q => q.id === id); if (!u) return { ok: false };
    u.on = u.on ? 0 : 1; if (u.on) u.dry = 0;
    try { saveGame(); } catch (e) { }
    return { ok: true, on: u.on };
  }
  const unitAt = (x, z) => units().find(u => Math.abs(x - u.x) <= 9 && Math.abs(z - u.z) <= 9) || null;
  const outNow = u => RENEW[u.t] ? renewKw(u, ensure().t) : (u.run || 0);
  const statusOf = u => {
    const ty = typeOf(u);
    if (!u.on) return 'switched off';
    if (RENEW[u.t]) return R2(renewKw(u, ensure().t)) + ' kW now of ' + ty.kw + ' kW rated';
    if (u.dry) return 'out of fuel — can\'t pay';
    return (u.run > 0 ? R2(u.run) + ' kW · burning ' + ty.fuel : 'standing by') + ' · ' + R2(stock(ty.fuel)) + ' t ' + ty.fuel + ' in stock';
  };

  // ---- meshes -----------------------------------------------------------------
  const LM = c => new THREE.MeshLambertMaterial({ color: c });
  function mesh(u) {
    const g = new THREE.Group(), ref = {};
    const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
    const B = THREE.BoxGeometry, C = THREE.CylinderGeometry;
    if (u.t === 'solar') {
      const pan = new THREE.Group(); pan.rotation.x = -.5; pan.position.y = 2.4; g.add(pan);
      for (let i = -1; i <= 1; i++) { const m = new THREE.Mesh(new B(5.2, .25, 4.2), LM(0x1d3f7a)); m.position.set(i * 5.6, 0, 0); pan.add(m); }
      add(new B(.6, 2.4, .6), LM(0x777777), -5.6, 1.2, 0); add(new B(.6, 2.4, .6), LM(0x777777), 5.6, 1.2, 0);
    } else if (u.t === 'wind') {
      const h = u.sea ? 30 : 24;
      if (u.sea) add(new C(2.6, 3.4, 8, 10), LM(0xd9a13b), 0, 0, 0);
      add(new C(.55, 1.1, h, 10), LM(0xeeeeee), 0, h / 2, 0);
      add(new B(1.3, 1.3, 2.6), LM(0xdddddd), 0, h + .4, 0);
      const rot = new THREE.Group(); rot.position.set(0, h + .4, 1.5); g.add(rot);
      for (let i = 0; i < 3; i++) { const b = new THREE.Mesh(new B(.45, 9.5, .15), LM(0xf4f4f4)); b.position.y = 4.4; const pv = new THREE.Group(); pv.rotation.z = i * 2.0944; pv.add(b); rot.add(pv); }
      ref.rot = rot;
    } else if (u.t === 'hydro') {
      add(new B(10, 3.2, 8), LM(0x8a8f95), 0, 1.6, 0);
      add(new B(11, .5, 9), LM(0x4a5560), 0, 3.4, 0);
      add(new C(1.6, 1.6, 2.4, 12), LM(0x2d6fa5), 3.2, 4.5, 0);
      const wh = new THREE.Group(); wh.position.set(0, 1.8, 4.3); g.add(wh);
      for (let i = 0; i < 6; i++) { const b = new THREE.Mesh(new B(.4, 3, .5), LM(0x35506b)); b.rotation.z = i * 1.0472; b.position.set(Math.cos(i * 1.0472) * 1.5, Math.sin(i * 1.0472) * 1.5, 0); wh.add(b); }
      ref.rot = wh;
    } else {
      const coal = u.t === 'coal';
      add(new B(14, 6, 10), LM(coal ? 0x4a4642 : 0x5b6b78), 0, 3, 0);
      add(new C(1.2, 1.7, coal ? 15 : 12, 10), LM(0x8c8c8c), -4, coal ? 11.5 : 12, 2.5);
      add(new C(1.2, 1.7, coal ? 15 : 12, 10), LM(0x8c8c8c), -1.2, coal ? 11.5 : 12, 2.5);
      if (!coal) add(new C(2.6, 2.6, 5, 14), LM(0xe8e4d8), 5, 2.5, -7);
      const glow = new THREE.Mesh(new B(2.2, 1.4, .3), new THREE.MeshBasicMaterial({ color: 0xffa63d })); glow.position.set(4, 3.4, 5.1); g.add(glow);
      ref.glow = glow;
    }
    g.traverse(o => { if (o.isMesh) o.castShadow = true; });
    ref.g = g;
    return ref;
  }
  function disposeOne(id) { const e = built.get(id); if (e && e.g && e.g.parent) e.g.parent.remove(e.g); built.delete(id); }
  function ensureOne(id) {
    const u = units().find(q => q.id === id);
    if (!u || !root) { disposeOne(id); return; }
    const old = built.get(id); if (old && old.g.parent === root) return;
    disposeOne(id);
    const e = mesh(u); e.g.position.set(u.x, u.sea ? -1.35 : 0, u.z); e.g.rotation.y = frac(id + 'r') * 6.283;
    try { root.add(e.g); } catch (er) { }
    built.set(id, e);
  }
  const disposeAll = () => { for (const id of [...built.keys()]) disposeOne(id); };
  const ensureAll = () => { for (const u of units()) ensureOne(u.id); };
  function animate(dt) {
    for (const [id, e] of built) {
      const u = units().find(q => q.id === id); if (!u) continue;
      const k = typeOf(u) ? outNow(u) / typeOf(u).kw : 0;
      if (e.rot) e.rot.rotation.z += dt * (u.on ? k * 3.2 : 0);
      if (e.glow) e.glow.visible = !!(u.run > 0);
    }
  }

  // ---- placement ----------------------------------------------------------------
  function ensureGhost(type) {
    if (ghost && ghost.parent === root && ghost.userData.t === type) return;
    killGhost(); if (!root) return;
    ghostMat = new THREE.MeshBasicMaterial({ color: 0x4dff88, transparent: true, opacity: .45, depthWrite: false });
    ghost = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, type === 'wind' ? 24 : 8, 12), ghostMat);
    ghost.userData.t = type; ghost.renderOrder = 3; ghost.visible = false; root.add(ghost);
  }
  function killGhost() { if (ghost) { try { if (ghost.parent) ghost.parent.remove(ghost); ghostMat && ghostMat.dispose(); } catch (e) { } } ghost = null; ghostMat = null; }
  function bar(msg, onCancel) {
    let b = document.getElementById('gn-bar');
    if (!b) { b = document.createElement('div'); b.id = 'gn-bar'; document.body.appendChild(b); }
    b.innerHTML = '<span>' + msg + '</span><span class="gn-x" id="gn-bx">CANCEL</span>'; b.classList.remove('hidden');
    document.getElementById('gn-bx').onclick = onCancel;
  }
  const hideBar = () => { const b = document.getElementById('gn-bar'); if (b) { b.classList.add('hidden'); b.innerHTML = ''; } };
  function arm(type) {
    if (STATE.mode !== 'city' || !WORLD.group) { toast('Enter the world first — a generator needs ground (or a river) to stand on.'); return; }
    if (units().length >= MAX_UNITS) { toast('<b>Generator cap reached</b> (' + MAX_UNITS + '). Demolish one first.', 'warn'); return; }
    try { closeModal(); } catch (e) { }
    placing = type;
    const ty = TYPES[type];
    bar(ty.emoji + ' <b>' + ty.name.toUpperCase() + '</b> — click a site: ' + ty.hint + ' · ' + fmt$(ty.cost) + (type === 'wind' ? ' (' + fmt$(priceOf('wind', true)) + ' at sea)' : ''), () => disarm());
  }
  function disarm() { placing = null; killGhost(); hideBar(); }
  function placeClick(x, z) {
    const r = build(placing, x, z);
    if (r.ok) {
      const ty = TYPES[placing]; const t = placing; disarm();
      toast(ty.emoji + ' <b>' + ty.name + ' built</b> for ' + fmt$(r.cost) + (r.sea ? ' (offshore)' : '') + ' — it feeds your businesses first' + (ensure().sell ? ' and sells the surplus to the grid.' : '.'));
      void t;
    } else if (r.why === 'funds') toast('<b>Not enough money.</b> That unit costs ' + fmt$(r.cost) + '.', 'warn');
    else toast('<b>' + (r.text || 'That site will not do.') + '</b> Pick another spot — placement stays armed.', 'warn');
  }
  function click(cx, cy) {
    if (STATE.mode !== 'city' || !WORLD.group) return false;
    if (placing) {
      const pt = screenToGround(cx, cy);
      if (!pt) { toast('Aim at the ground — the camera needs to see the site.', 'warn'); return true; }
      placeClick(pt.x, pt.z); return true;
    }
    try { if (window.MACH && MACH_placing()) return false; } catch (e) { }
    const pt = screenToGround(cx, cy); if (!pt) return false;
    const u = unitAt(pt.x, pt.z);
    if (u) { openUnit(u); return true; }
    return false;
  }
  const MACH_placing = () => { try { return window.MACH.placing(); } catch (e) { return false; } };
  function tip(x, z) {
    if (STATE.mode !== 'city' || !WORLD.group) return null;
    const u = unitAt(x, z); if (!u) return null; const ty = typeOf(u);
    return { t: ty.name + ' — your generator', s: statusOf(u), p: u.on ? '≈ ' + R2(outNow(u)) + ' kW now' : 'switched off', a: ty.emoji + (u.on ? ' ONLINE' : ' OFF'), l: 'Click to manage' };
  }
  function openUnit(u) {
    const ty = typeOf(u);
    openModal(ty.emoji + ' ' + ty.name, `
      <div class="kv"><span class="k">STATUS</span><span class="v">${statusOf(u)}</span></div>
      <div class="kv"><span class="k">RATED</span><span class="v">${ty.kw} kW${u.sea ? ' · offshore' : ''} · upkeep ${fmt$(ty.up)}/day</span></div>
      ${ty.fuel ? `<div class="kv"><span class="k">FUEL</span><span class="v">${ty.fuel}: 1 t = ${ty.kwhPer} kWh · market ${fmt$2(fuelPx(ty.fuel))}/t · spot ${fmt$2(fuelPx(ty.fuel) * SPOT)}/t · burned ${(u.burnt || 0).toFixed(1)} t</span></div>` : ''}
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn primary" id="gu-t" style="flex:1">${u.on ? 'SWITCH OFF' : 'SWITCH ON'}</button>
        <button class="btn" id="gu-d" style="flex:1">DEMOLISH +${fmt$(Math.round(u.price * SELL_BACK))}</button>
        <button class="btn" id="gu-x">CLOSE</button>
      </div>`);
    document.getElementById('gu-t').onclick = () => { toggle(u.id); closeModal(); };
    document.getElementById('gu-d').onclick = () => { const r = demolish(u.id); closeModal(); if (r.ok) toast('Demolished — ' + fmt$(r.back) + ' salvaged.'); };
    document.getElementById('gu-x').onclick = closeModal;
  }

  // ---- the panel: capacity vs demand ---------------------------------------------
  function bar$(a, b, col) { const w = b > 0 ? Math.max(0, Math.min(100, a / b * 100)) : 0; return '<div class="gn-meter"><i style="width:' + w.toFixed(0) + '%;background:' + col + '"></i></div>'; }
  function boxHTML() {
    ensure();
    const s = snap, g = STATE.gen, U = g.units;
    const status = !s.gridUp
      ? (s.shed ? '<b style="color:#FC8181">BLACKOUT — grid down ' + outageText() + ' · ' + s.shed + ' business' + (s.shed === 1 ? '' : 'es') + ' dark</b>' : '<b style="color:#F5CC74">GRID DOWN ' + outageText() + ' — your units are carrying the load</b>')
      : s.imp > .01 ? '<b style="color:#F5CC74">importing ' + R2(s.imp) + ' kW from the grid</b>'
      : s.sold > .01 ? '<b style="color:#48BB78">selling ' + R2(s.sold) + ' kW ≈ ' + fmt$(s.sold * 24 * price()) + '/day at ' + fmt$2(price()) + '/kWh</b>'
      : '<b style="color:#48BB78">covered by your own units</b>';
    const rows = U.map(u => { const ty = typeOf(u); return '<div class="pg-row"><div class="pg-name"><b>' + ty.emoji + ' ' + ty.name + (u.sea ? ' · offshore' : '') + '</b><span data-k="r' + u.id + '">' + statusOf(u) + '</span></div><button class="tpbtn" data-gu="' + u.id + '">' + (u.on ? 'MANAGE' : 'OFF') + '</button></div>'; }).join('');
    return '<div class="msec" style="margin-top:14px">Own power — generators</div>' +
      '<div class="kv"><span class="k">STATUS</span><span class="v" data-k="st">' + status + '</span></div>' +
      '<div class="kv"><span class="k">DEMAND</span><span class="v" data-k="dm">' + R2(s.demand) + ' kW (your businesses)</span></div>' +
      '<div class="kv"><span class="k">CAPACITY</span><span class="v" data-k="cp">' + R2(s.cap) + ' kW rated · ' + R2(s.avail) + ' kW available now</span></div>' +
      '<div class="kv"><span class="k">SUPPLY NOW</span><span class="v" data-k="sp">' + R2(s.own) + ' own (' + R2(s.ren) + ' renewable + ' + R2(Math.max(0, s.own - s.ren)) + ' burners) · ' + R2(s.imp) + ' grid</span></div>' +
      '<div data-k="mt">' + bar$(s.own, s.demand, s.shed ? '#FC8181' : '#48BB78') + '</div>' +
      '<div class="kv"><span class="k">EARNED</span><span class="v" data-k="er">' + fmt$(g.sold || 0) + ' sold to the grid · ' + (g.black | 0) + ' blackout' + ((g.black | 0) === 1 ? '' : 's') + ' so far</span></div>' +
      (rows || '<p style="margin-top:6px">No generators yet — build one below. Your own output is not metered, so it is not billed.</p>') +
      '<div style="margin-top:8px"><button class="tpbtn" id="gn-sell">SELL SURPLUS: ' + (g.sell ? 'ON' : 'OFF') + '</button></div>' +
      '<div class="msec" style="margin-top:10px">Build a generator</div>' +
      '<div id="gn-build">' + ORDER.map(k => { const ty = TYPES[k]; return '<button class="tpbtn gn-b" data-gb="' + k + '" title="' + ty.hint + '">' + ty.emoji + ' ' + ty.name + ' · ' + ty.kw + ' kW · ' + fmt$(ty.cost) + '</button>'; }).join('') + '</div>' +
      '<p style="margin-top:6px;font-size:10px;color:var(--mut)">The utility feeder fails about one game day in nine (4–10 h). While it is down, nothing is imported or sold — businesses your units can\'t cover lose power until supply returns.</p>';
  }
  function wireBox() {
    const box = document.getElementById('gn-box'); if (!box) return;
    box.querySelectorAll('[data-gb]').forEach(b => { b.onclick = () => arm(b.dataset.gb); });
    box.querySelectorAll('[data-gu]').forEach(b => { b.onclick = () => { const u = units().find(q => q.id === b.dataset.gu); if (u) openUnit(u); }; });
    const s = document.getElementById('gn-sell');
    if (s) s.onclick = () => { const g = ensure(); g.sell = g.sell ? 0 : 1; try { saveGame(); } catch (e) { } renderBox(); };
  }
  // the box is rebuilt only when its structure changes (units added/removed/switched, sell toggled);
  // otherwise just the live numbers are patched in place, so buttons never move under the cursor
  let boxSig = '';
  function renderBox() {
    const box = document.getElementById('gn-box'); if (!box) return;
    const g = ensure(), sig = g.units.map(u => u.id + u.on).join(',') + '|' + (g.sell ? 1 : 0);
    const html = boxHTML();
    if (sig !== boxSig || !box.firstChild) { boxSig = sig; box.innerHTML = html; wireBox(); return; }
    const tmp = document.createElement('div'); tmp.innerHTML = html;
    tmp.querySelectorAll('[data-k]').forEach(n => { const cur = box.querySelector('[data-k="' + n.dataset.k + '"]'); if (cur && cur.innerHTML !== n.innerHTML) cur.innerHTML = n.innerHTML; });
  }
  function panelInto() {
    const all = document.getElementById('pg-all');
    if (!all || document.getElementById('gn-box')) return;
    const holder = document.createElement('div'); holder.id = 'gn-box'; boxSig = '';
    all.parentElement.insertAdjacentElement('beforebegin', holder);
    renderBox();
    if (panelT) clearInterval(panelT);
    panelT = setInterval(() => { if (!document.getElementById('gn-box')) { clearInterval(panelT); panelT = null; return; } renderBox(); }, 1000);
  }
  function empireInto() {
    const body = document.getElementById('mbody'); if (!body) return;
    const close = document.getElementById('em-x'), anchorEl = close ? close.parentElement : null;
    const s = snap, n = units().length;
    const html = '<div class="msec" style="margin-top:14px">Own power — generators</div>' +
      '<div class="kv"><span class="k">' + n + ' unit' + (n === 1 ? '' : 's') + ' · demand ' + R2(s.demand) + ' kW · capacity ' + R2(s.cap) + ' kW · ' + (s.shed ? '<b style="color:#FC8181">BLACKOUT</b>' : !s.gridUp ? 'grid down' : s.sold > .01 ? 'selling ' + R2(s.sold) + ' kW' : s.imp > .01 ? 'importing ' + R2(s.imp) + ' kW' : 'self-supplied') + '</span><button class="tpbtn" id="em-gn">OPEN</button></div>';
    if (anchorEl) anchorEl.insertAdjacentHTML('beforebegin', html); else body.insertAdjacentHTML('beforeend', html);
    const b = document.getElementById('em-gn'); if (b) b.onclick = () => { try { PWR.open(); } catch (e) { } };
  }
  function banner() {
    let b = document.getElementById('gn-black');
    if (!b) { b = document.createElement('div'); b.id = 'gn-black'; b.onclick = () => { try { PWR.open(); } catch (e) { } }; document.body.appendChild(b); }
    if (wasBlack) { b.innerHTML = '🔌 BLACKOUT — ' + snap.shed + ' business' + (snap.shed === 1 ? '' : 'es') + ' without power · click for the grid'; b.classList.remove('hidden'); }
    else b.classList.add('hidden');
  }

  try {
    const st = document.createElement('style');
    st.textContent = [
      '#gn-bar{position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:70;display:flex;align-items:center;gap:10px;background:var(--panel2);border:1px solid rgba(72,187,120,.5);border-radius:10px;padding:8px 12px;font-size:12px;color:var(--txt);box-shadow:0 8px 26px rgba(0,0,0,.55);max-width:92vw}',
      '#gn-bar.hidden,#gn-black.hidden{display:none}',
      '#gn-bar .gn-x{flex:none;padding:5px 12px;border-radius:7px;background:rgba(72,187,120,.18);color:#48BB78;font-weight:700;cursor:pointer}',
      '#gn-black{position:fixed;top:104px;left:50%;transform:translateX(-50%);z-index:69;background:rgba(120,20,20,.92);border:1px solid #FC8181;color:#fff;border-radius:10px;padding:7px 14px;font-size:12px;font-weight:700;letter-spacing:.3px;cursor:pointer;max-width:92vw;text-align:center}',
      '.gn-meter{height:7px;border-radius:4px;background:rgba(255,255,255,.1);margin:4px 0 6px;overflow:hidden}.gn-meter i{display:block;height:100%}',
      '#gn-build{display:flex;flex-wrap:wrap;gap:6px}#gn-build .gn-b{margin:0;white-space:nowrap}',
    ].join('');
    document.head.appendChild(st);
  } catch (er) { }

  // ---- the beat -------------------------------------------------------------------
  function tick(dt) {
    if (STATE.mode === 'boot') return;
    try {
      if (WORLD.group !== root) { root = WORLD.group; disposeAll(); killGhost(); if (root) ensureAll(); }
      step(Math.min(dt, .5));
      if (placing && lastPtr && root) {
        ensureGhost(placing);
        const pt = screenToGround(lastPtr.x, lastPtr.y);
        if (ghost) { if (!pt) ghost.visible = false; else { const s = siteOk(placing, pt.x, pt.z); ghost.visible = true; ghost.position.set(pt.x, s.sea ? -1.35 : 0, pt.z); ghost.position.y += 4; ghostMat.color.setHex(s.ok ? 0x4dff88 : 0xff5d5d); } }
      }
      animate(dt);
    } catch (e) { console.error('[gen]', e); }
  }
  try {
    canvas.addEventListener('pointermove', e => { lastPtr = { x: e.clientX, y: e.clientY }; }, { passive: true });
    canvas.addEventListener('pointerleave', () => { lastPtr = null; }, { passive: true });
    window.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || !placing) return;
      const mw = document.getElementById('modalwrap'); if (mw && !mw.classList.contains('hidden')) return;
      e.stopPropagation(); disarm();
    }, true);
  } catch (er) { }

  ensure();
  return {
    tick, click, tip, empireInto, panelInto, nightSettle, arm, disarm, build, demolish, toggle, siteOk, onRiver,
    TYPES, MAX_UNITS, list: () => units().slice(),
    rules: { SELL_BACK, SPOT, GAP, ORDER },   // v2.101 HELP BOOK
    placing: () => placing,
    arrears: p => { try { const e = STATE.pow.b[p.id]; return !!(e && e.cut); } catch (er) { return false; } },
    isBlackout: p => !!shed[p && p.id || p],
    snapshot: () => ({ ...snap }),
    // QA: set the game clock hour (0–24), keeping the day count
    setHour(h) { const g = ensure(); g.t = Math.floor(g.t / 24) * 24 + h; return g.t; },
    // QA: force a utility outage for `hours` game hours from now
    outage(hours) { const g = ensure(); g.out = hours > 0 ? { s: g.t, e: g.t + hours } : null; return g.out; },
    // QA: run n game-hours of the live beat instantly
    // (withMeter: also turn the Grid's meters/billing exactly like the live beat does)
    qaHours(n, withMeter) { const dt = 0.25 / HPS; const k = Math.round(n / (dt * HPS)); for (let i = 0; i < k; i++) { if (withMeter) { try { PWR.tick(dt); } catch (e) { } } step(dt); } return this.state(); },
    outputs: () => units().map(u => ({ id: u.id, t: u.t, kw: +outNow(u).toFixed(2), on: u.on, dry: u.dry })),
    state() { const g = ensure(); return { t: +g.t.toFixed(2), hour: +hourNow().toFixed(2), gridUp: gridUp(), sell: g.sell, sold: g.sold, units: g.units.length, snap: { ...snap }, shed: Object.keys(shed), black: g.black | 0 }; },
  };
})();
window.GEN = GEN;   // QA surface

// ADDITIVE hooks — the same wrap pattern the game already uses.
// 0. blackouts ride the existing cut-off: a blacked-out cart is "cut" for every reader of isCut
//    (customers, serving, night shift) but needs no payment and clears itself when supply returns.
const __genIsCut = PWR.isCut;
PWR.__arrears = p => { try { return __genIsCut(p); } catch (e) { return false; } };
PWR.isCut = p => { try { if (GEN.isBlackout(p)) return true; } catch (e) { } return __genIsCut(p); };
// 1. the POWER panel gains OWN POWER (capacity vs demand) above the PAY buttons
const __genOpen = PWR.open;
PWR.open = function () { __genOpen.apply(PWR, arguments); try { GEN.panelInto(); } catch (e) { console.error('[gen]', e); } };
// 2. the business panel's Power block notes a blackout
const __genBizRow = PWR.bizRow;
PWR.bizRow = p => { let h = __genBizRow(p); try { if (GEN.isBlackout(p)) h = '<div class="msec" style="margin-top:14px;color:#FC8181">🔌 BLACKOUT — no power until supply returns</div>' + h; } catch (e) { } return h; };
// 3. the night shift: your own units settle the offline gap on averages
const __genNight = PWR.nightSettle;
PWR.nightSettle = days => { const r = __genNight(days); try { const o = GEN.nightSettle(days, r); if (o.sold > 0 || o.saved > 0) setTimeout(() => { try { toast('⚡ <b>Own power overnight</b> — your generators saved ' + fmt$(o.saved) + ' in bills and sold ' + fmt$(o.sold) + (o.upkeep ? ' (upkeep ' + fmt$(o.upkeep) + ')' : '') + '.'); } catch (e) { } }, 2500); } catch (e) { console.error('[gen]', e); } return r; };
// 4. the click chain: a generator click runs first so placing/managing never walks the character
const __genClickPick = clickPick;
patchClickPick(function (cx, cy) {
  try { if (GEN.click(cx, cy)) return; } catch (e) { console.error('[gen]', e); }
  return __genClickPick(cx, cy);
});
// 5. hover tip
const __genHover = ECO.hoverInfo.bind(ECO);
ECO.hoverInfo = function (x, z) { const info = __genHover(x, z); if (info) return info; try { return GEN.tip(x, z); } catch (e) { return null; } };
// 6. the Empire panel gains one summary line
const __genEmpire = ECO.openEmpire.bind(ECO);
ECO.openEmpire = function () { __genEmpire(); try { GEN.empireInto(); } catch (e) { console.error('[gen]', e); } };
// 7. the update chain: … → THE GRID → OWN POWER
const __genOrigUpdate = WORLD.update.bind(WORLD);
WORLD.update = function (dt, px, pz, camDist) {
  const req = __genOrigUpdate(dt, px, pz, camDist);
  try { GEN.tick(dt); } catch (e) { console.error('[gen]', e); }
  return req;
};
