// ====================================================================
// js/systems/saveio.js: SAVE FILE (v2.99). EXPORT SAVE downloads the current save as a
// .json file; IMPORT SAVE reads one back. Everything happens in the browser: no network.
// Saves live per origin (localStorage 'openworld-v2'), so a new domain starts empty; this is
// how a player carries a game from one origin to another (GitHub Pages, the hosted site, a
// rotated domain) or keeps a backup.
// ====================================================================
import { SAVE_KEY } from '../config.js';
import { STATE } from '../state.js';
import { loadGame, saveGame } from '../save.js';
import { flushNow, isHosted, onSaved } from '../sync.js';
import { closeModal, openModal, toast } from '../ui/dom.js';
import { fmt$ } from '../util.js';

// ======== section: 99_saveio.js ========
// v2.99 SAVE FILE.
//   EXPORT: the pack is written to openworld-save-YYYY-MM-DD.json with a Blob + object URL.
//   IMPORT: a file picker reads a .json file and checks it BEFORE touching anything:
//     - under 2 MB, valid JSON, a plain object, a numeric ts and a known pack version `v`
//       (2, 3, 4 or 5; newer packs are refused), no __proto__/constructor/prototype keys,
//       every list/record field the right shape, money and gdp finite numbers;
//     - a confirm modal shows what is in the file and what it replaces;
//     - the current save is kept as a ONE-STEP undo copy (localStorage 'openworld-v2-undo');
//       if the browser has no room for the copy, nothing is imported;
//     - the file is written as the save with a fresh ts (so the Night Shift does not pay the
//       gap and the hosted site's sync treats it as the newest save), then the game's OWN
//       loadGame() sanitizers read it as a dry run: if they refuse it, the old save is put
//       back; otherwise the page reloads into the imported game (hosted: uploaded first).
//     UNDO IMPORT puts the previous save back the same way.
// Nothing is ever uploaded by this module; on the hosted site the imported save syncs up like
// any other save through js/sync.js. window.SAVEIO is the QA surface.
export const SAVEIO = (() => {
  const MAX_BYTES = 2e6, KNOWN_V = [2, 3, 4, 5];
  const UNDO_KEY = SAVE_KEY + '-undo', MSG_KEY = SAVE_KEY + '-saveio-msg';
  const ARR = ['plots', 'offices', 'rooms', 'acres', 'rentals', 'mines', 'rigs', 'rivals', 'dsg', 'designs'];
  const OBJ = ['res', 'mkt', 'works', 'mat', 'pow', 'gen', 'bank', 'loan', 'co', 'tut', 'gfx'];
  const BAD = new Set(['__proto__', 'constructor', 'prototype']);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ls = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }, del: k => { try { localStorage.removeItem(k); } catch (e) { } } };
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const pad = n => (n < 10 ? '0' : '') + n;
  const dateStamp = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const fmtDate = ts => { try { return new Date(ts).toLocaleString(); } catch (e) { return String(ts); } };

  // ---- checking a file (no state is touched) ---------------------------------------------
  function hostile(root) {                                  // refuse prototype-pollution keys anywhere, and absurd sizes
    let nodes = 0; const stack = [[root, 0]];
    while (stack.length) {
      const [o, d] = stack.pop();
      if (d > 40 || ++nodes > 300000) return true;
      if (!o || typeof o !== 'object') continue;
      for (const k of Object.keys(o)) { if (BAD.has(k)) return true; const c = o[k]; if (c && typeof c === 'object') stack.push([c, d + 1]); }
    }
    return false;
  }
  function summarize(p) {
    const accts = isObj(p.bank) && isObj(p.bank.accts) ? Object.values(p.bank.accts) : [];
    const banks = accts.reduce((s, a) => s + (isFinite(+(a && a.bal)) ? +a.bal : 0), 0);
    const loans = isObj(p.loan) && Array.isArray(p.loan.loans) ? p.loan.loans.reduce((s, l) => s + (isFinite(+(l && l.balance)) ? +l.balance : 0), 0) : 0;
    return { name: typeof p.name === 'string' ? p.name : '', cash: +p.money || 0, banks, loans, plots: Array.isArray(p.plots) ? p.plots.length : 0, v: p.v, ts: p.ts };
  }
  function validate(text, bytes) {
    if (typeof text !== 'string') return { ok: false, why: 'That file could not be read.' };
    if ((bytes || text.length) > MAX_BYTES || text.length > MAX_BYTES) return { ok: false, why: 'That file is too big for a save (' + ((bytes || text.length) / 1e6).toFixed(1) + ' MB; the limit is 2 MB).' };
    let p;
    try { p = JSON.parse(text); } catch (e) { return { ok: false, why: 'That is not a valid JSON file.' }; }
    if (!isObj(p)) return { ok: false, why: 'That file is not an Open World save (it is not a JSON object).' };
    if (hostile(p)) return { ok: false, why: 'That file contains unsafe data and was not imported.' };
    if (typeof p.v !== 'number' || !Number.isInteger(p.v)) return { ok: false, why: 'That file has no save version, so it is not an Open World save.' };
    if (p.v > Math.max(...KNOWN_V)) return { ok: false, why: 'That save was made by a newer version of the game (pack v' + p.v + '). Update the game first.' };
    if (!KNOWN_V.includes(p.v)) return { ok: false, why: 'That save is from an unknown version (v' + p.v + ').' };
    if (typeof p.ts !== 'number' || !isFinite(p.ts) || p.ts <= 0) return { ok: false, why: 'That save has no valid timestamp.' };
    if (p.ts > Date.now() + 864e5) return { ok: false, why: 'That save is dated in the future.' };
    for (const k of ARR) if (p[k] != null && (!Array.isArray(p[k]) || p[k].length > 5000)) return { ok: false, why: 'That save has a damaged "' + k + '" list.' };
    for (const k of OBJ) if (p[k] != null && !isObj(p[k])) return { ok: false, why: 'That save has a damaged "' + k + '" section.' };
    for (const k of ['money', 'gdp']) if (p[k] != null && (typeof p[k] !== 'number' || !isFinite(p[k]) || Math.abs(p[k]) > 1e15)) return { ok: false, why: 'That save has an impossible ' + k + ' value.' };
    if (p.name != null && (typeof p.name !== 'string' || p.name.length > 60)) return { ok: false, why: 'That save has a damaged player name.' };
    return { ok: true, pack: p, info: summarize(p) };
  }

  // ---- export -------------------------------------------------------------------------------
  function exportSave() {
    try { if (STATE.mode !== 'boot') saveGame(); } catch (e) { }
    const raw = ls.get(SAVE_KEY);
    if (!raw) { toast('<b>Nothing to export yet</b> — enter the world and play a little first.', 'warn'); return { ok: false, why: 'no save' }; }
    const name = 'openworld-save-' + dateStamp(new Date()) + '.json';
    try {
      const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = name; a.style.display = 'none';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { } }, 4000);
    } catch (e) { toast('<b>Could not create the file.</b>', 'warn'); return { ok: false, why: 'blob' }; }
    toast('💾 <b>Save exported</b> — <b>' + esc(name) + '</b> is in your downloads. Keep it somewhere safe; it never leaves your device unless you move it.');
    return { ok: true, name, bytes: raw.length };
  }

  // ---- import ---------------------------------------------------------------------------------
  const hasUndo = () => !!ls.get(UNDO_KEY);
  function remember(msg) { try { sessionStorage.setItem(MSG_KEY, msg); } catch (e) { } }
  async function reloadInto(msg) {
    remember(msg);
    STATE.mode = 'boot';                                      // the page's own pagehide / timer saves must not overwrite the file we just wrote
    if (isHosted()) { try { onSaved(); await flushNow(); } catch (e) { } }   // the hosted site gets the imported save like any save
    location.reload();
  }
  // write `pack` as the save (keeping an undo copy), then let loadGame() read it as a dry run
  async function apply(pack, undo) {
    try { if (STATE.mode !== 'boot') saveGame(); } catch (e) { }   // the undo copy must be the game as it is right now
    const cur = ls.get(SAVE_KEY);
    if (!undo && cur) {                                       // one-step backup of the current game
      if (!ls.set(UNDO_KEY, JSON.stringify({ at: Date.now(), raw: cur }))) return { ok: false, why: 'The browser has no room to keep an undo copy of your current game, so nothing was imported.' };
    }
    const next = Object.assign({}, pack, { ts: Date.now() });   // a fresh stamp: no Night Shift gap, and sync treats it as the newest save
    const text = JSON.stringify(next);
    if (text.length > MAX_BYTES) { if (!undo) ls.del(UNDO_KEY); return { ok: false, why: 'That save is too big.' }; }
    if (!ls.set(SAVE_KEY, text)) { if (!undo && cur) { ls.set(SAVE_KEY, cur); ls.del(UNDO_KEY); } return { ok: false, why: 'The browser has no room to store that save.' }; }
    let good = false;
    try { good = loadGame(); } catch (e) { good = false; }   // the game's own sanitizers, the same ones every boot uses
    if (!good) {                                              // refused: put everything back and reload to a clean state
      if (cur) ls.set(SAVE_KEY, cur); else ls.del(SAVE_KEY);
      if (!undo) ls.del(UNDO_KEY);
      await reloadInto('The game could not read that save, so nothing was changed.');
      return { ok: false, why: 'The game could not read that save.' };
    }
    if (undo) ls.del(UNDO_KEY);
    await reloadInto(undo ? 'Your previous game is back.' : 'Save imported. Welcome back' + (pack.name ? ', ' + pack.name : '') + '!');
    return { ok: true };
  }
  function confirmModal(v, fileName) {
    const i = v.info, cur = (() => { try { const c = JSON.parse(ls.get(SAVE_KEY) || 'null'); return c && typeof c === 'object' ? summarize(c) : null; } catch (e) { return null; } })();
    openModal('Import saved game?', `
      <p>This <b>replaces your current game</b>${cur ? ': ' + fmt$(cur.cash) + ' cash, ' + cur.plots + ' plots, saved ' + esc(fmtDate(cur.ts)) : ' (you have no saved game here yet)'}. A one-step undo copy is kept.</p>
      <div class="kv"><span class="k">FILE</span><span class="v">${esc(fileName || 'save.json')}</span></div>
      <div class="kv"><span class="k">PLAYER</span><span class="v">${esc(i.name || '—')}</span></div>
      <div class="kv"><span class="k">SAVED</span><span class="v">${esc(fmtDate(i.ts))} · pack v${i.v}</span></div>
      <div class="kv"><span class="k">CASH</span><span class="v g">${fmt$(i.cash)}</span></div>
      <div class="kv"><span class="k">IN BANKS</span><span class="v">${fmt$(i.banks)}${i.loans > 0 ? ' · owes ' + fmt$(i.loans) + ' in loans' : ''}</span></div>
      <div class="kv"><span class="k">PLOTS</span><span class="v">${i.plots}</span></div>
      <div style="display:flex;gap:8px;margin-top:14px"><button class="btn primary" id="sio-go" style="flex:1">REPLACE MY GAME</button><button class="btn" id="sio-x" style="flex:1">CANCEL</button></div>`);
    document.getElementById('sio-x').onclick = closeModal;
    document.getElementById('sio-go').onclick = async () => {
      const go = document.getElementById('sio-go'); if (go) go.disabled = true;
      const r = await apply(v.pack, false);
      if (!r.ok) { closeModal(); toast('<b>' + esc(r.why) + '</b>', 'warn'); }
    };
  }
  // from a file (picker) or from text (QA): check, then show the confirm modal
  function offer(text, fileName, bytes) {
    const v = validate(text, bytes);
    if (!v.ok) { toast('<b>Import refused.</b> ' + esc(v.why), 'warn'); return v; }
    confirmModal(v, fileName); return { ok: true, info: v.info };
  }
  function pickFile() {
    let inp = document.getElementById('sio-file');
    if (!inp) { inp = document.createElement('input'); inp.type = 'file'; inp.id = 'sio-file'; inp.accept = '.json,application/json'; inp.style.display = 'none'; document.body.appendChild(inp); }
    inp.value = '';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0]; if (!f) return;
      if (f.size > MAX_BYTES) { toast('<b>Import refused.</b> That file is too big for a save (' + (f.size / 1e6).toFixed(1) + ' MB; the limit is 2 MB).', 'warn'); return; }
      let text = null; try { text = await f.text(); } catch (e) { text = null; }
      offer(text, f.name, f.size);
    };
    inp.click();
  }
  function undoImport() {
    const u = ls.get(UNDO_KEY); if (!u) { toast('There is nothing to undo.', 'warn'); return { ok: false, why: 'none' }; }
    let raw = null; try { raw = JSON.parse(u).raw; } catch (e) { raw = null; }
    const v = validate(raw, raw && raw.length);
    if (!v.ok) { ls.del(UNDO_KEY); toast('<b>The undo copy is damaged</b> and was discarded.', 'warn'); return { ok: false, why: 'damaged' }; }
    openModal('Undo the import?', `<p>This puts your <b>previous game</b> back (${fmt$(v.info.cash)} cash, ${v.info.plots} plots, saved ${esc(fmtDate(v.info.ts))}) and replaces the imported one.</p>
      <div style="display:flex;gap:8px;margin-top:14px"><button class="btn primary" id="sio-ugo" style="flex:1">UNDO IMPORT</button><button class="btn" id="sio-ux" style="flex:1">CANCEL</button></div>`);
    document.getElementById('sio-ux').onclick = closeModal;
    document.getElementById('sio-ugo').onclick = async () => { const r = await apply(v.pack, true); if (!r.ok) { closeModal(); toast('<b>' + esc(r.why) + '</b>', 'warn'); } };
    return { ok: true };
  }

  // ---- where the buttons live: the Help window and the boot screen ---------------------------------
  function rowHTML() {
    return '<div id="sio-row" style="display:flex;gap:8px;margin:0 0 12px;flex-wrap:wrap"><button class="btn" id="sio-exp" style="flex:1">EXPORT SAVE</button><button class="btn" id="sio-imp" style="flex:1">IMPORT SAVE</button>' + (hasUndo() ? '<button class="btn" id="sio-und" style="flex:1">UNDO IMPORT</button>' : '') + '</div>' +
      '<p class="co-sub" style="margin:-6px 0 12px;font-size:10.5px;color:var(--dim)">Save files stay on your device. Use them to move your game to another site address or keep a backup.</p>';
  }
  function wireRow(root) {
    const g = id => root.querySelector('#' + id);
    if (g('sio-exp')) g('sio-exp').onclick = () => exportSave();
    if (g('sio-imp')) g('sio-imp').onclick = () => pickFile();
    if (g('sio-und')) g('sio-und').onclick = () => undoImport();
  }
  function helpInto() {
    const body = document.getElementById('mbody'), gfx = document.getElementById('hp-gfx');
    if (!body || !gfx || document.getElementById('sio-row')) return;
    gfx.parentElement.insertAdjacentHTML('afterend', rowHTML());
    wireRow(body);
  }
  function bootLinks() {
    const foot = document.querySelector('#boot .foot'); if (!foot || document.getElementById('bt-sio')) return;
    const s = document.createElement('span'); s.id = 'bt-sio';
    s.innerHTML = '·<a href="#" id="bt-exp">EXPORT SAVE</a>·<a href="#" id="bt-imp">IMPORT SAVE</a>';
    foot.appendChild(s);
    s.querySelector('#bt-exp').onclick = e => { e.preventDefault(); exportSave(); };
    s.querySelector('#bt-imp').onclick = e => { e.preventDefault(); pickFile(); };
  }
  function showPending() {                                   // the message left by the reload that finished an import / undo
    let m = null; try { m = sessionStorage.getItem(MSG_KEY); sessionStorage.removeItem(MSG_KEY); } catch (e) { }
    if (m) setTimeout(() => { try { toast('💾 <b>' + esc(m) + '</b>'); } catch (e) { } }, 1500);
  }
  try {
    document.addEventListener('click', e => {                 // delegated, so it survives the bottom bar being rebuilt; after the tick the game's own handler has opened Help
      if (e.target && e.target.closest && e.target.closest('#b-help')) setTimeout(() => { try { helpInto(); } catch (er) { console.error('[saveio]', er); } }, 0);
    });
    bootLinks(); showPending();
  } catch (e) { console.error('[saveio]', e); }

  return {
    exportSave, validate, offer, pickFile, undoImport, hasUndo, MAX_BYTES, KNOWN_V,
    // QA: check + apply with no modal (the same code the confirm button runs)
    importText(text) { const v = validate(text, text && text.length); if (!v.ok) { toast('<b>Import refused.</b> ' + esc(v.why), 'warn'); return Promise.resolve(v); } return apply(v.pack, false); },
  };
})();
window.SAVEIO = SAVEIO;   // QA surface
