// Browser test for the HELP BOOK (js/systems/helpbook.js). Checks that every section and entry opens, that
// every number in the text is rendered from a live constant (no digit may appear outside a data-live tag,
// a button name or the attribution line, and changing a constant changes the text), that search works,
// that the original Help buttons still work (GRAPHICS, REPLAY TUTORIAL, CLOSE, the save-file row), that the
// ACADEMY slot exists, that it all fits a 390 px phone, and that nothing logs a console error.
// Run: node scripts/helpbook-test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { startMock } from './companies-mock.mjs';

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { chromium = createRequire(import.meta.url)(join(execSync('npm root -g').toString().trim(), 'playwright')).chromium; }
let n = 0; const ok = m => console.log('PASS ' + (++n) + ': ' + m);
const wait = ms => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch();

async function game(base, { player, width = 1280, height = 800 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } }), page = await ctx.newPage(), bad = [];
  page.on('pageerror', e => bad.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) bad.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  if (player) await page.goto(base + '/api/__mock/login?as=' + player);
  await page.goto(base + '/openworld.html');
  await page.waitForFunction(() => window.HELP && window.STATE, null, { timeout: 20000 }); await wait(1500);
  await page.fill('#pname', 'Helper'); await page.click('#enter');
  await page.waitForFunction(() => window.STATE.mode !== 'boot', null, { timeout: 30000 }); await wait(1500);
  return { ctx, page, bad, ev: (f, a) => page.evaluate(f, a) };
}
const openHelp = async g => { await g.ev(() => { document.getElementById('modalwrap').classList.add('hidden'); document.getElementById('b-help').click(); }); await g.page.waitForSelector('#hb-q'); await g.page.waitForSelector('#sio-row', { timeout: 5000 }).catch(() => { }); };

// ---- the digit rule, run inside the page ---------------------------------------------------------------
const digitsOutsideLive = () => {
  const out = [];
  document.querySelectorAll('#hb-list .hb-body, #hb-list summary').forEach(el => {
    const c = el.cloneNode(true);
    c.querySelectorAll('.hb-n, .hb-b, .hb-c').forEach(x => x.remove());   // live numbers, exact button/catalog names, and the entry counts on the section headings
    const t = c.textContent;
    if (/\d/.test(t)) out.push(t.slice(Math.max(0, t.search(/\d/) - 40), t.search(/\d/) + 40));
  });
  return out;
};

const m = await startMock({ mode: 'noapi' }), base = 'http://127.0.0.1:' + m.port;
const g = await game(base), E = g.ev;
await openHelp(g);

// ---- the original furniture of the Help window --------------------------------------------------------
for (const id of ['hp-gfx', 'hp-tut', 'hp-x', 'hp-academy-slot', 'hb-q', 'sio-row']) assert.ok(await E(i => !!document.getElementById(i), id), id + ' is in the Help window');
assert.match(await E(() => document.getElementById('mbody').innerText), /Map data © OpenStreetMap contributors \(ODbL\)/);
assert.match(await E(() => document.getElementById('mtitle').innerText), /Open World v\d+\.\d+ — Help/);
assert.ok(await E(() => document.getElementById('hp-gfx').parentElement.nextElementSibling.id === 'sio-row'), 'the save-file row still sits right under the graphics button');
ok('the GRAPHICS / REPLAY TUTORIAL / CLOSE buttons, the save-file row, the OSM line and the ACADEMY slot are all there');

// ---- sections and entries ------------------------------------------------------------------------------
const secIds = await E(() => [...document.querySelectorAll('.hb-sec')].map(s => s.dataset.sec));
assert.deepEqual(secIds, ['basics', 'carts', 'land', 'build', 'mining', 'market', 'power', 'banks', 'rank', 'saves'], 'ten sections, Companies hidden while the server has no companies');
const ents = await E(() => [...document.querySelectorAll('.hb-ent')].map(e => e.dataset.ent));
assert.ok(ents.length >= 30, 'at least thirty entries (found ' + ents.length + ')');
assert.equal(await E(() => document.querySelectorAll('.hb-fail').length), 0, 'no entry failed to read its numbers');
for (const e of ents) {
  const txt = await E(id => { const el = document.querySelector('.hb-ent[data-ent="' + id + '"]'); el.open = true; el.closest('.hb-sec').open = true; return el.querySelector('.hb-body').innerText; }, e);
  assert.ok(txt.length > 80, e + ' has text');
  assert.ok(/WHERE|STEP BY STEP|COSTS AND NUMBERS/.test(txt), e + ' has the standard blocks');
}
ok(secIds.length + ' sections, ' + ents.length + ' entries; every one opens, none failed to read its numbers');

// ---- every number is live --------------------------------------------------------------------------
const stray = await E(digitsOutsideLive);
assert.deepEqual(stray, [], 'no digit outside a data-live number or a button name: ' + JSON.stringify(stray));
const live = await E(() => [...document.querySelectorAll('.hb-n')].map(x => x.dataset.live));
assert.ok(live.length > 250, 'a few hundred live numbers (found ' + live.length + ')');
assert.ok(!(await E(() => [...document.querySelectorAll('.hb-n')].some(x => !x.textContent.trim() || /NaN|undefined|Infinity/.test(x.textContent)))), 'no number renders as blank / NaN');
ok(live.length + ' numbers rendered; none is typed into the prose');

// change constants at their source and the book follows (prove the numbers are read, not copied)
await E(async () => { const c = await import('/js/config.js'); c.ECON.cartCost = 7777; c.ECON.startMoney = 4321; window.MINE.rules.WAGE = 888; window.OIL.rules.PRICE = 999000; window.PROP.rules.BUY_MULT = 31; window.BLD.TYPES[0].inc = 4242; window.WORKS.rules.POWER = 3.5; });
await openHelp(g);
const book = await E(() => { document.querySelectorAll('.hb-sec,.hb-ent').forEach(d => d.open = true); return document.getElementById('hb-list').innerText; });
for (const want of ['$7,777', '$4,321', '$888', '$999,000', '$4,242']) assert.ok(book.includes(want), 'the book shows ' + want);
assert.ok(/\b31 days of the unit/.test(book), 'the property multiplier follows its constant');
assert.ok(book.includes('$3.50 per tonne'), 'the Works power rate follows its constant');
assert.ok(book.includes('0.25% of every fill'), 'the market fee keeps its fraction (not rounded to 0%)'); assert.ok(book.includes('$1.50 flat fee'), 'the bank transfer fee keeps its cents');
ok('changing ECON.cartCost / startMoney, MINE / OIL / PROP / WORKS rules and a catalog row changes the text');

// ---- search ----------------------------------------------------------------------------------------------
const shown = () => E(() => [...document.querySelectorAll('.hb-ent')].filter(e => e.style.display !== 'none').map(e => e.dataset.ent));
await g.page.fill('#hb-q', 'loan');
let s1 = await shown(); assert.ok(s1.includes('banks/loans') && !s1.includes('carts/park'), 'loan finds the loans entry and hides unrelated ones'); assert.ok(s1.length < ents.length / 2, 'and hides most of the book');
assert.ok(await E(() => document.querySelector('.hb-ent[data-ent="banks/loans"]').open), 'a matching entry opens itself');
await g.page.fill('#hb-q', 'lease'); s1 = await shown(); assert.ok(s1.includes('land/offices') && s1.includes('land/landlord'), 'lease finds the office and landlord entries');
await g.page.fill('#hb-q', 'solar'); s1 = await shown(); assert.ok(s1.includes('power/generators'), 'solar finds the generators');
await g.page.fill('#hb-q', 'furniture desk'); s1 = await shown(); assert.ok(s1.includes('build/furniture'), 'two words must both match');
await g.page.fill('#hb-q', 'zzqqxx'); s1 = await shown(); assert.equal(s1.length, 0); assert.ok(await E(() => !document.getElementById('hb-none').classList.contains('hidden')), 'a no-match message shows');
await g.page.fill('#hb-q', ''); s1 = await shown(); assert.equal(s1.length, ents.length, 'clearing brings everything back');
ok('search filters by title, keywords and text, needs every word, shows a no-match message and clears');

// ---- the original buttons --------------------------------------------------------------------------------
await E(() => { window.__tut = 0; const t = window.TUT, r = t.restart; t.restart = function () { window.__tut++; return r.apply(this, arguments); }; });
await g.page.click('#hp-tut'); assert.equal(await E(() => window.__tut), 1, 'REPLAY TUTORIAL restarts the starter guide'); assert.ok(await E(() => document.getElementById('modalwrap').classList.contains('hidden')), 'and closes Help');
await openHelp(g); await g.page.click('#hp-gfx'); await g.page.waitForFunction(() => /^Graphics/.test(document.getElementById('mtitle').innerText)); ok('REPLAY TUTORIAL restarts the guide, GRAPHICS SETTINGS opens the graphics panel');
await g.ev(() => document.getElementById('gf-x').click());
await openHelp(g); await g.page.click('#hp-x'); assert.ok(await E(() => document.getElementById('modalwrap').classList.contains('hidden')), 'CLOSE closes Help'); ok('CLOSE closes Help');
await g.page.keyboard.press('Escape');

// ---- the bottom bar entry is read from the page -------------------------------------------------------------
await openHelp(g);
const barTxt = await E(() => { const e = document.querySelector('.hb-ent[data-ent="basics/bar"]'); e.open = true; e.closest('.hb-sec').open = true; return e.innerText; });
for (const l of ['BUILD', 'MARKET', 'MINE', 'ORE', 'RANK', 'POWER', 'FIND ME', 'HELP', 'BANK']) assert.ok(barTxt.includes(l), 'the bar entry lists ' + l);
assert.ok(!/COMPANY|STOCKS/.test(barTxt.split('WHERE')[1].split('COSTS')[1] || ''), 'COMPANY and STOCKS are not listed while the server has none');
ok('the bottom-bar entry lists the real buttons');
assert.deepEqual(g.bad, [], 'no console errors on desktop: ' + g.bad.join(' | '));
await g.ctx.close();

// ---- phone width ------------------------------------------------------------------------------------------
const p = await game(base, { width: 390, height: 780 });
const docBefore = await p.ev(() => document.documentElement.scrollWidth);   // the page itself may already be wider than a phone; Help must not make it wider
await openHelp(p);
await p.ev(() => document.querySelectorAll('.hb-sec,.hb-ent').forEach(d => d.open = true));
const fit = await p.ev(() => { const mb = document.getElementById('mbody'), md = document.getElementById('modal'); return { sw: md.scrollWidth, cw: md.clientWidth, bw: mb.scrollWidth, bcw: mb.clientWidth, vw: innerWidth, docw: document.documentElement.scrollWidth }; });
assert.ok(fit.sw <= fit.cw + 1 && fit.bw <= fit.bcw + 1 && fit.docw <= docBefore, 'the Help window fits 390 px and does not widen the page (page was ' + docBefore + '): ' + JSON.stringify(fit));
const wide = await p.ev(() => [...document.querySelectorAll('#hb-list .kv, #hb-list table, #hb-list p, #hb-list li')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).length);
assert.equal(wide, 0, 'nothing pokes out of the screen at 390 px');
assert.ok(await p.ev(() => { const r = document.getElementById('hb-q').getBoundingClientRect(); return r.width > 200 && r.right <= innerWidth; }), 'the search box fits');
assert.deepEqual(p.bad, [], 'no console errors on the phone: ' + p.bad.join(' | '));
ok('phone width 390 px: no sideways scroll, nothing wider than the screen, search box fits');
await p.page.screenshot({ path: process.env.HELPBOOK_SHOT || '/tmp/helpbook-phone.png' });
await p.ctx.close();

// ---- companies: the section appears when the server enables them ----------------------------------------------
const m2 = await startMock({ mode: 'full' }), b2 = 'http://127.0.0.1:' + m2.port;
const c = await game(b2, { player: 'alice' });
await c.page.waitForFunction(() => window.CO && window.CO.state && window.CO.state.enabled, null, { timeout: 20000 });
await openHelp(c);
assert.ok((await c.ev(() => [...document.querySelectorAll('.hb-sec')].map(s => s.dataset.sec))).includes('companies'), 'the Companies and stocks section shows on a companies server');
assert.equal(await c.ev(() => document.querySelectorAll('.hb-fail').length), 0);
assert.deepEqual(await c.ev(digitsOutsideLive), []);
assert.deepEqual(c.bad, [], 'no console errors with companies: ' + c.bad.join(' | '));
ok('the Companies and stocks section appears only when the server enables companies');
await c.ctx.close();

await browser.close(); m.close && m.close(); m2.close && m2.close();
console.log('helpbook-test: all ' + n + ' checks passed');
process.exit(0);
