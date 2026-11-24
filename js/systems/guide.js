// ====================================================================
// js/systems/guide.js: BUSINESS ACADEMY (v2.101), the guide ENGINE.
// A chapter-based, never-in-the-way tutorial system that lives next to the
// six-step starter guide (js/systems/tutorial.js, which it never touches).
// This file is only the engine: other files register their chapters with
// GUIDE.register(). The engine has no game numbers of its own.
// ====================================================================
import * as THREE from 'three';
import { STATE } from '../state.js';
import { saveGame } from '../save.js';
import { closeModal, openModal, toast } from '../ui/dom.js';
import { WORLD } from '../world/world.js';   // (the beacon is parented to the live world group)
import { CITY } from '../world/city.js';
import { TUT } from '../systems/tutorial.js';

// ======== section: 101_guide.js ========
// ====================================================================
// HOW TO WRITE A CHAPTER (read this first; the format is exact)
// --------------------------------------------------------------------
//   import { GUIDE } from './guide.js';
//   GUIDE.register({
//     id: 'bakery',                 // unique, lowercase letters/digits/_/-, max 32 chars. Never reuse or rename:
//                                   //   the player's progress is saved under it.
//     title: 'The Bakery',          // plain text (shown escaped)
//     icon: '🥐',                   // one emoji
//     order: 40,                    // list position, ascending (the older-systems chapters use 10-39,
//                                   //   the newer ones 40-99; ties sort by id)
//     intro: 'One sentence on what this chapter teaches.',       // plain text; may be a function () => string
//     unlock: () => true,           // live, called every few hundred ms: true when the chapter may be started.
//                                   //   A false result shows the chapter as LOCKED. Optional: lockedWhy: () => 'why'.
//     opened: () => !!document.getElementById('bakery-panel'),   // OPTIONAL. true while the player has this
//                                   //   system's panel open. The first time it turns true (and the chapter is
//                                   //   unlocked and not done) the engine offers the chapter once.
//     summary: () => '<p>What you learned...</p>',               // OPTIONAL HTML for the end-of-chapter card
//                                   //   (default: the list of step titles with ticks)
//     steps: [                      // 1 or more, in order
//       {
//         key: 'buy',               // unique within the chapter
//         title: 'Buy a bakery',    // plain text, short
//         body: () => 'HTML. Click <b>BUY</b> for ' + fmt$(PRICE) + '.' + (GUIDE.touch ? ' Tap...' : ' Click...'),
//                                   // HTML, called at render time (~1 s): READ EVERY NUMBER FROM THE GAME'S OWN
//                                   //   CONSTANTS OR FUNCTIONS here, never type one by hand. GUIDE.touch is true on
//                                   //   touch devices: use it for tap/click wording like tutorial.js does.
//         obj: () => 'Buy one bakery.',      // the ONE-LINE objective shown under the text (plain text)
//         check: () => STATE.bakeries.length > 0,
//                                   // true when the player has REALLY done it. Read live game state (an account
//                                   //   exists with a balance, a generator of that type stands, a loan exists...).
//                                   //   Never a timer, never "the player clicked next". It must stay true once done
//                                   //   if the player undoes it later (or the chapter must tolerate that).
//         tgt: () => ({ x: 1, z: 2 }),       // OPTIONAL world position for the gold beacon (world metres), or
//                                   //   null for none. Only drawn while the player is in a city.
//         open: () => BAKERY.open(),         // OPTIONAL. Runs when the player taps SHOW ME on the chip; open the
//                                   //   relevant panel. The engine never opens anything by itself.
//       },
//     ],
//   });
//
// RULES (they keep the guide from ever disagreeing with the game)
//   * check() and body() must never throw (they are wrapped, a throw counts as "not yet"), and must never change
//     the game: the Academy only teaches. No money in, no money out, no state writes.
//   * Never extend the starter guide's STEPS (tutorial.js): js/save.js clamps its progress to 0-5.
//   * Progress is saved by the engine in the pack field `guide` (below). Chapters add nothing to the save.
//
// THE ENGINE
//   * Progress: STATE.guide = { cur: chapterId|null, done: {id: true}, step: {id: n}, sug: {id: true} } saved in the pack
//     field `guide`, sanitized on load; ids of chapters that no longer exist and out-of-range steps are dropped once
//     boot has registered every chapter (GUIDE.ready() at the end of js/boot.js).
//   * UI: a quest chip (same look as the starter guide's, same corner) shows the active step. While the starter guide
//     is active the chip stays hidden and START is refused: the starter guide wins. The chip's X closes the chapter
//     (progress is kept: RESUME it from HELP > ACADEMY). A finished chapter shows a non-blocking summary card.
//     HELP gets an ACADEMY button (id hp-academy) once at least one chapter is registered. The engine fills the empty
//     <div id="hp-academy-slot"> that the Help book leaves for it (a delegated click on #b-help, then a tick, so it
//     works every time Help re-renders); without the slot it falls back to after #hp-gfx. If an element with id
//     hp-academy already exists it is wired as is.
//   * Suggestions: when the starter guide is finished, and when a chapter's opened() first turns true, a small card
//     offers the matching chapter once. Remembered in the save (sug).
//   * Never in the way: no modal opens by itself, no input is blocked, it works on touch and at phone width.
//   * QA: window.GUIDE = { register, chapters, state, start, resume, go, skip, reset, openList, ready, touch }.
// ====================================================================
export const GUIDE = (() => {
  const ID_RE = /^[a-z0-9_-]{1,32}$/;
  const REG = new Map();                            // id -> chapter
  const touch = (() => { try { return matchMedia('(pointer:coarse)').matches; } catch (e) { return false; } })();
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let booted = false;                               // true once boot has registered every chapter
  let chipMode = 'hidden', summaryOf = null;        // 'step' | 'summary' | 'hidden'
  let tickT = 0, renderT = 0, lastSugAt = 0, lastNow = 0, wasStarter = null, sugGap = 20000;   // sugGap: at least this long between two suggestion cards
  const wasOpen = {};                               // chapter id -> opened() last tick (edge detection)

  // ---- state ------------------------------------------------------------------------------
  function G() {
    let g = STATE.guide;
    if (!g || typeof g !== 'object') g = STATE.guide = {};
    if (typeof g.cur !== 'string' && g.cur !== null) g.cur = null;
    for (const k of ['done', 'step', 'sug']) if (!g[k] || typeof g[k] !== 'object') g[k] = {};
    return g;
  }
  function prune() {                                // drop what no chapter owns any more; clamp steps (only after boot)
    if (!booted || !REG.size) return;               // (with no chapter registered at all nothing can be judged unknown)
    const g = G();
    for (const k of ['done', 'step', 'sug']) for (const id of Object.keys(g[k])) {
      if (k === 'sug' && id === 'starter') continue;
      const ch = REG.get(id);
      if (!ch) { delete g[k][id]; continue; }
      if (k === 'step') g.step[id] = Math.max(0, Math.min(ch.steps.length - 1, g.step[id] | 0));
    }
    if (g.cur && !REG.has(g.cur)) g.cur = null;
  }

  // ---- chapters -----------------------------------------------------------------------------
  function register(ch) {
    try {
      if (!ch || typeof ch !== 'object' || !ID_RE.test(ch.id || '')) throw new Error('bad chapter id');
      if (!Array.isArray(ch.steps) || !ch.steps.length) throw new Error('a chapter needs steps');
      const keys = new Set();
      for (const s of ch.steps) {
        if (!s || typeof s.key !== 'string' || keys.has(s.key)) throw new Error('step keys must be unique strings');
        keys.add(s.key);
        if (typeof s.title !== 'string' || typeof s.body !== 'function' || typeof s.obj !== 'function' || typeof s.check !== 'function') throw new Error('step ' + s.key + ' needs title, body(), obj(), check()');
      }
      REG.set(ch.id, Object.assign({ icon: '📘', order: 50, intro: '', unlock: () => true }, ch, { order: isFinite(+ch.order) ? +ch.order : 50 }));
      return true;
    } catch (e) { console.warn('[guide] chapter not registered:', e && e.message); return false; }
  }
  const call = (f, dflt) => { try { const v = f(); return v === undefined ? dflt : v; } catch (e) { return dflt; } };
  const ordered = () => [...REG.values()].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  const unlocked = ch => !!call(ch.unlock, false);
  function status(ch) {
    const g = G();
    if (g.done[ch.id]) return 'done';
    if (!unlocked(ch)) return 'locked';
    return (g.cur === ch.id || (g.step[ch.id] | 0) > 0) ? 'progress' : 'available';
  }
  function describe(ch) {
    const g = G(), st = status(ch);
    return { id: ch.id, title: ch.title, icon: ch.icon, order: ch.order, status: st, unlocked: unlocked(ch), step: g.step[ch.id] | 0, steps: ch.steps.length, active: g.cur === ch.id,
      intro: typeof ch.intro === 'function' ? call(ch.intro, '') : ch.intro, why: st === 'locked' && ch.lockedWhy ? call(ch.lockedWhy, '') : '' };
  }
  const chapters = () => ordered().map(describe);
  const starterActive = () => { try { return !!TUT.state().active; } catch (e) { return false; } };

  // ---- starting, resuming, skipping ----------------------------------------------------------
  function begin(id, fromStep) {
    const ch = REG.get(id); if (!ch) return { ok: false, why: 'no such chapter' };
    if (!unlocked(ch)) return { ok: false, why: 'locked' };
    if (starterActive()) { toast('Finish the <b>starter guide</b> first (or close it with its ✕) — then the Academy chapters open up.', 'warn'); return { ok: false, why: 'starter guide active' }; }
    const g = G();
    g.cur = id; g.step[id] = Math.max(0, Math.min(ch.steps.length - 1, fromStep | 0));
    chipMode = 'step'; summaryOf = null; renderT = 0; tickT = 0;
    try { saveGame(); } catch (e) { }
    toast(ch.icon + ' <b>' + esc(ch.title) + '</b> — step 1 of ' + ch.steps.length + ': ' + esc(ch.steps[g.step[id]].title) + (g.step[id] ? ' (resumed at step ' + (g.step[id] + 1) + ')' : ''));
    paint(); return { ok: true };
  }
  const start = id => begin(id, 0);                 // START and REPLAY
  function resume(id) { return begin(id, G().step[id] | 0); }
  function go(id, n) {                              // QA: jump (still refuses an unknown chapter; ignores the unlock for tests of one step)
    const ch = REG.get(id); if (!ch) return { ok: false, why: 'no such chapter' };
    const g = G(); g.cur = id; g.step[id] = Math.max(0, Math.min(ch.steps.length - 1, n | 0)); chipMode = 'step'; summaryOf = null; renderT = 0;
    try { saveGame(); } catch (e) { } paint(); return { ok: true };
  }
  function skip(id) {                               // close the chapter; the progress stays so it can be resumed
    const g = G(); id = id || g.cur;
    if (id && g.cur === id) { g.cur = null; chipMode = 'hidden'; summaryOf = null; clearBeacon(); try { saveGame(); } catch (e) { } paint(); return { ok: true }; }
    return { ok: false, why: 'not active' };
  }
  function reset() {                                // QA: forget everything
    STATE.guide = { cur: null, done: {}, step: {}, sug: {} }; chipMode = 'hidden'; summaryOf = null; clearBeacon();
    for (const k of Object.keys(wasOpen)) delete wasOpen[k];
    try { saveGame(); } catch (e) { } paint(); return state();
  }
  function advance(ch) {
    const g = G(), cur = ch.steps[g.step[ch.id] | 0];
    g.step[ch.id] = (g.step[ch.id] | 0) + 1;
    if (g.step[ch.id] >= ch.steps.length) return complete(ch);
    try { saveGame(); } catch (e) { }
    toast('✓ <b>' + esc(cur.title) + '</b> — next: ' + esc(ch.steps[g.step[ch.id]].title));
    renderT = 0; paint();
  }
  function complete(ch) {
    const g = G();
    g.done[ch.id] = true; g.step[ch.id] = 0; g.cur = null; chipMode = 'summary'; summaryOf = ch.id; clearBeacon();
    try { saveGame(); } catch (e) { }
    toast(ch.icon + ' <b>' + esc(ch.title) + '</b> complete!');
    paint();
  }
  const nextChapterAfter = id => ordered().find(c => c.id !== id && !G().done[c.id] && unlocked(c));

  // ---- the quest chip -------------------------------------------------------------------------
  let chip = null;
  function ensureChip() {
    if (chip) return chip;
    chip = document.createElement('div'); chip.id = 'gd'; chip.className = 'glass hidden';
    document.body.appendChild(chip);
    chip.addEventListener('click', e => {
      const b = e.target.closest ? e.target.closest('[data-gd]') : null; if (!b) return;
      const act = b.dataset.gd, g = G(), ch = REG.get(g.cur || summaryOf);
      if (act === 'x') { if (chipMode === 'summary') { chipMode = 'hidden'; summaryOf = null; paint(); } else skip(); }
      else if (act === 'show' && ch) { const s = ch.steps[g.step[ch.id] | 0]; if (s && s.open) call(s.open); }
      else if (act === 'list') openList();
      else if (act === 'next' && summaryOf) { const n = nextChapterAfter(summaryOf); if (n) start(n.id); else { chipMode = 'hidden'; paint(); } }
      else if (act === 'replay' && summaryOf) start(summaryOf);
    });
    return chip;
  }
  function paint() {                                // build the chip's HTML for the current mode
    const el = ensureChip(), g = G();
    const hide = STATE.mode === 'boot' || starterActive() || chipMode === 'hidden';
    if (hide) { el.classList.add('hidden'); return; }
    if (chipMode === 'summary' && summaryOf) {
      const ch = REG.get(summaryOf); if (!ch) { el.classList.add('hidden'); return; }
      const n = nextChapterAfter(ch.id);
      const sum = ch.summary ? call(ch.summary, '') : '<ul class="gd-sum">' + ch.steps.map(s => '<li>✓ ' + esc(s.title) + '</li>').join('') + '</ul>';
      el.innerHTML = '<div class="th"><span class="n">DONE</span><span class="t">' + esc(ch.icon + ' ' + ch.title) + '</span><button class="gd-x" data-gd="x" title="Close">✕</button></div>' +
        '<div class="b">' + sum + '</div><div class="gd-btns">' + (n ? '<button class="tpbtn" data-gd="next">NEXT: ' + esc(n.title.toUpperCase()) + '</button>' : '') + '<button class="tpbtn" data-gd="replay">REPLAY</button><button class="tpbtn" data-gd="list">ACADEMY</button></div>';
      el.classList.remove('hidden'); return;
    }
    const ch = REG.get(g.cur); if (!ch) { el.classList.add('hidden'); return; }
    const i = Math.min(ch.steps.length - 1, g.step[ch.id] | 0), s = ch.steps[i];
    const body = call(s.body, ''), obj = call(s.obj, '');
    el.innerHTML = '<div class="th"><span class="n">' + (i + 1) + '/' + ch.steps.length + '</span><span class="t">' + esc(ch.title) + ' · ' + esc(s.title) + '</span><button class="gd-x" data-gd="x" title="Close this chapter (resume it from HELP › ACADEMY)">✕</button></div>' +
      '<div class="b">' + body + '</div><div class="o">▸ ' + esc(obj) + '</div>' +
      '<div class="gd-btns">' + (s.open ? '<button class="tpbtn" data-gd="show">SHOW ME</button>' : '') + '<button class="tpbtn" data-gd="list">ACADEMY</button></div>';
    el.classList.remove('hidden');
  }

  // ---- the world beacon (own copy, so it never fights the starter guide's) --------------------------
  let bcn = null;
  function buildBeacon() {
    if (bcn) return bcn;
    const cv = document.createElement('canvas'); cv.width = cv.height = 128; const c = cv.getContext('2d');
    const tri = () => { c.beginPath(); c.moveTo(30, 26); c.lineTo(98, 26); c.lineTo(64, 96); c.closePath(); };
    tri(); c.lineWidth = 12; c.lineJoin = 'round'; c.strokeStyle = 'rgba(13,17,23,.85)'; c.stroke();
    tri(); c.fillStyle = '#7DD3FC'; c.fill(); tri(); c.lineWidth = 4; c.strokeStyle = '#e6f6ff'; c.stroke();
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
    spr.scale.set(5.2, 5.2, 1); spr.position.y = 8.4; spr.renderOrder = 999;
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.7, 3.5, 30), new THREE.MeshBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: .85, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = .17;
    const grp = new THREE.Group(); grp.add(spr); grp.add(ring);
    return (bcn = { grp, spr, ring });
  }
  function setBeacon(x, z) { buildBeacon(); bcn.grp.position.set(x, 0, z); if (!bcn.grp.parent) { const g = CITY.group || WORLD.group; if (g) g.add(bcn.grp); } }
  function clearBeacon() { if (bcn && bcn.grp.parent) bcn.grp.parent.remove(bcn.grp); }

  // ---- the chapter list (HELP > ACADEMY) -------------------------------------------------------------
  const LABEL = { locked: 'LOCKED', available: 'NEW', progress: 'IN PROGRESS', done: 'DONE' };
  function openList() {
    const list = chapters();
    const sa = starterActive();
    const rows = list.map(c => {
      let btn;
      if (c.status === 'locked') btn = '<button class="tpbtn" disabled>LOCKED</button>';
      else if (c.status === 'done') btn = '<button class="tpbtn" data-gl="start" data-v="' + c.id + '"' + (sa ? ' disabled' : '') + '>REPLAY</button>';
      else if (c.status === 'progress') btn = '<button class="tpbtn" data-gl="resume" data-v="' + c.id + '"' + (sa ? ' disabled' : '') + '>RESUME</button><button class="tpbtn" data-gl="start" data-v="' + c.id + '"' + (sa ? ' disabled' : '') + '>RESTART</button>';
      else btn = '<button class="tpbtn" data-gl="start" data-v="' + c.id + '"' + (sa ? ' disabled' : '') + '>START</button>';
      return '<div class="gd-ch ' + c.status + '"><div class="gd-chh"><b>' + esc(c.icon + ' ' + c.title) + '</b><span class="gd-st ' + c.status + '">' + LABEL[c.status] + (c.status === 'progress' ? ' · step ' + (c.step + 1) + '/' + c.steps : '') + '</span></div>' +
        '<div class="co-sub">' + esc(c.intro) + (c.why ? ' <i>' + esc(c.why) + '</i>' : '') + '</div><div class="co-row">' + btn + '</div></div>';
    }).join('');
    openModal('BUSINESS ACADEMY', '<div id="gd-list-mark"></div>' +
      '<p class="co-sub" style="margin:0 0 8px">Short guided chapters that teach one system each by having you do it. They never cost you anything, never block the game, and you can close or replay any of them.' + (sa ? ' <b>The starter guide is still running — finish it (or close it with its ✕) and the chapters open up.</b>' : '') + '</p>' +
      (rows || '<p class="co-sub">No chapters yet.</p>') +
      '<div style="display:flex;gap:8px;margin-top:12px"><button class="btn" id="gd-lx" style="flex:1">CLOSE</button></div>');
    const body = document.getElementById('mbody');
    body.onclick = e => {
      const b = e.target.closest ? e.target.closest('[data-gl]') : null;
      if (b && !b.disabled) { const r = b.dataset.gl === 'resume' ? resume(b.dataset.v) : start(b.dataset.v); if (r.ok) closeModal(); return; }
      if (e.target.id === 'gd-lx') closeModal();
    };
  }

  // ---- HELP integration (no edit to night.js: an injected, id'd button) --------------------------------
  function helpInto() {
    if (!REG.size) return;
    const body = document.getElementById('mbody'); if (!body || !/Help/.test(document.getElementById('mtitle').textContent || '')) return;
    let btn = document.getElementById('hp-academy');
    if (!btn) {
      const html = '<button class="btn primary" id="hp-academy" style="flex:1">ACADEMY — guided chapters</button>';
      const slot = document.getElementById('hp-academy-slot');          // the Help book (js/systems/helpbook.js) leaves this empty slot for the Academy
      if (slot) { slot.innerHTML = '<div style="display:flex;gap:8px;margin:0 0 12px">' + html + '</div>'; }
      else {                                                            // an older Help without the slot: after #hp-gfx, or at the top
        const row = document.createElement('div'); row.id = 'gd-help-row'; row.style.cssText = 'display:flex;gap:8px;margin:0 0 12px'; row.innerHTML = html;
        const gfx = document.getElementById('hp-gfx');
        if (gfx && gfx.parentElement && gfx.parentElement.parentElement) gfx.parentElement.insertAdjacentElement('afterend', row); else body.insertBefore(row, body.firstChild);
      }
      btn = document.getElementById('hp-academy');
    }
    btn.onclick = () => { closeModal(); openList(); };
  }

  // ---- suggestions (once each, remembered in the save) --------------------------------------------------
  let sug = null, sugTimer = 0;
  function suggest(ch, why) {
    const g = G(), now = Date.now();
    if (now - lastSugAt < sugGap) return false;
    if (!sug) {
      sug = document.createElement('div'); sug.id = 'gd-sug'; sug.className = 'glass hidden'; document.body.appendChild(sug);
      sug.addEventListener('click', e => {
        const b = e.target.closest ? e.target.closest('[data-gs]') : null; if (!b) return;
        sug.classList.add('hidden'); if (b.dataset.gs === 'go') start(b.dataset.v);
      });
    }
    lastSugAt = now; g.sug[ch.id] = true; try { saveGame(); } catch (e) { }
    sug.innerHTML = '<div class="th"><span class="n">TIP</span><span class="t">' + esc(ch.icon + ' ' + ch.title) + '</span><button class="gd-x" data-gs="no" title="Dismiss">✕</button></div><div class="b">' + esc(why) + '</div><div class="gd-btns"><button class="tpbtn" data-gs="go" data-v="' + ch.id + '">START</button><button class="tpbtn" data-gs="no">NOT NOW</button></div>';
    sug.classList.remove('hidden');
    clearTimeout(sugTimer); sugTimer = setTimeout(() => { if (sug) sug.classList.add('hidden'); }, 18000);   // one timer: a newer card must not be hidden by an older card's timeout
    return true;
  }
  function suggestions() {
    if (STATE.mode === 'boot' || starterActive() || (G().cur && chipMode === 'step')) return;
    if (!STATE.tut || !STATE.tut.done) return;      // the starter guide goes first: nothing is suggested until it is finished or skipped
    const g = G();
    // 1) the starter guide has finished (or was always done on this save): offer the first chapter that is open to the player
    if (!g.sug.starter) {
      const first = ordered().find(c => !g.done[c.id] && unlocked(c));
      if (first && suggest(first, 'The starter guide is done. This short chapter teaches the next system: ' + first.title + '.')) g.sug.starter = true;
      return;
    }
    // 2) a system's panel was just opened for the first time
    for (const ch of ordered()) {
      if (typeof ch.opened !== 'function') continue;
      const op = !!call(ch.opened, false), was = wasOpen[ch.id]; wasOpen[ch.id] = op;
      if (op && was === false && !g.sug[ch.id] && !g.done[ch.id] && unlocked(ch)) { if (suggest(ch, 'You opened this system for the first time. A guided chapter walks you through it.')) return; }
    }
  }

  // ---- the beat -------------------------------------------------------------------------------------------
  function tick(dt) {
    if (STATE.mode === 'boot') { if (chip) chip.classList.add('hidden'); return; }
    const now = performance.now(), rdt = lastNow ? Math.min(.5, (now - lastNow) / 1000) : 0; lastNow = now;
    tickT -= rdt; if (tickT > 0) return; tickT = .4;
    prune();
    const sa = starterActive();
    if (sa !== wasStarter) { wasStarter = sa; paint(); }
    if (sa) { clearBeacon(); return; }
    const g = G();
    if (g.cur && chipMode !== 'summary') {
      const ch = REG.get(g.cur);
      if (!ch) { g.cur = null; chipMode = 'hidden'; paint(); return; }
      if (chipMode === 'hidden') { chipMode = 'step'; paint(); }
      const s = ch.steps[Math.min(ch.steps.length - 1, g.step[ch.id] | 0)];
      if (call(s.check, false)) { advance(ch); return; }
      renderT -= .4; if (renderT <= 0) { renderT = 1.2; paint(); }
      const t = s.tgt ? call(s.tgt, null) : null;
      if (t && isFinite(t.x) && isFinite(t.z) && STATE.mode === 'city' && (CITY.group || WORLD.group)) setBeacon(t.x, t.z); else clearBeacon();
      if (bcn && bcn.grp.parent) { const k = 1 + .2 * Math.sin(now / 320); bcn.ring.scale.set(k, k, 1); bcn.spr.position.y = 8.4 + Math.sin(now / 430) * .9; }
    } else clearBeacon();
    suggestions();
  }

  // ---- wiring ------------------------------------------------------------------------------------------------
  try {
    document.addEventListener('click', e => {       // delegated: survives the bottom bar / Help being rebuilt; runs after the tick so Help is already open
      if (e.target && e.target.closest && e.target.closest('#b-help')) setTimeout(() => { try { helpInto(); } catch (er) { console.error('[guide]', er); } }, 0);
    });
  } catch (e) { console.error('[guide]', e); }

  function state() {
    const g = G();
    return { cur: g.cur, step: g.cur ? (g.step[g.cur] | 0) : null, done: Object.assign({}, g.done), steps: Object.assign({}, g.step), sug: Object.assign({}, g.sug), chip: chipMode, chipVisible: !!(chip && !chip.classList.contains('hidden')), starterActive: starterActive(), beacon: !!(bcn && bcn.grp.parent), ready: booted };
  }
  return {
    register, chapters, state, start, resume, go, skip, reset, openList, touch, prune, tick,
    ready() { booted = true; prune(); },            // js/boot.js calls this once every chapter file has registered
    help: helpInto, qaGap(ms) { sugGap = +ms || 0; },
  };
})();
window.GUIDE = GUIDE;   // QA surface

// The beat runs on real time (not the world's frame loop) so the guide also works on the globe and in a throttled tab;
// every call is try/caught so a guide error can never touch the game.
setInterval(() => { try { GUIDE.tick(0); } catch (e) { console.error('[guide]', e); } }, 400);
