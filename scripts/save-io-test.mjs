// Browser test for SAVE FILE (js/systems/saveio.js): export, import with a confirm modal, round-trip equality, one-step undo,
// rejection of bad files (not JSON, too big, wrong/unknown/newer version, hostile fields), a save the game's own loader refuses,
// the hosted site (an import syncs up), and no console errors. Run: node scripts/save-io-test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startMock } from './companies-mock.mjs';

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { chromium = createRequire(import.meta.url)(join(execSync('npm root -g').toString().trim(), 'playwright')).chromium; }
let n = 0; const ok = m => console.log('PASS ' + (++n) + ': ' + m);
const wait = ms => new Promise(r => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), 'saveio-'));
const browser = await chromium.launch();

async function game(base, player) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true }), page = await ctx.newPage(), bad = [];
  page.on('pageerror', e => bad.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) bad.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  if (player) await page.goto(base + '/api/__mock/login?as=' + player);
  await page.goto(base + '/openworld.html');
  await page.waitForFunction(() => window.SAVEIO && window.STATE, null, { timeout: 20000 }); await wait(1500);
  return { ctx, page, bad, ev: (f, a) => page.evaluate(f, a) };
}
const enter = async (g, nm) => { await g.page.fill('#pname', nm); await g.page.click('#enter'); await g.page.waitForFunction(() => window.STATE.mode !== 'boot', null, { timeout: 20000 }); await wait(1000); await g.ev(() => document.getElementById('modalwrap').classList.add('hidden')); };
const reloaded = async g => { await g.page.waitForLoadState('load'); await g.page.waitForFunction(() => window.SAVEIO && window.STATE, null, { timeout: 20000 }); await wait(1200); };
const strip = raw => { const o = JSON.parse(raw); delete o.ts; return JSON.stringify(o); };
const raw = g => g.ev(() => localStorage.getItem('openworld-v2'));
const toasts = g => g.ev(() => [...document.querySelectorAll('#toasts > *')].map(t => t.innerText).join(' | '));

const m = await startMock({ mode: 'noapi' }), base = 'http://127.0.0.1:' + m.port;
const g = await game(base), E = g.ev;
await enter(g, 'Exporter');
await E(async () => { const { saveGame } = await import('/js/save.js'); STATE.money = 12345; STATE.plots.push({ id: 'pxa', cityKey: 'newyork', cityName: 'New York', price: 900, x: 10, z: 20, cart: { cuisine: 'taco' }, crew: [{ name: 'Ann', stars: 4 }] }); saveGame(); });

// ---- export
await E(() => document.getElementById('b-help').click()); await g.page.waitForSelector('#sio-exp');
const [dl] = await Promise.all([g.page.waitForEvent('download'), g.page.click('#sio-exp')]);
assert.match(dl.suggestedFilename(), /^openworld-save-\d{4}-\d{2}-\d{2}\.json$/);
const file1 = join(tmp, 'save1.json'); await dl.saveAs(file1);
const exported = readFileSync(file1, 'utf8'), pack1 = JSON.parse(exported);
assert.equal(pack1.v, 5); assert.equal(typeof pack1.ts, 'number'); assert.equal(pack1.money, 12345); assert.equal(pack1.plots.length, 1); assert.ok(exported.length < 2e6);
assert.equal(exported, await raw(g), 'the file is exactly the saved pack');
ok('EXPORT SAVE downloads openworld-save-YYYY-MM-DD.json: a JSON object with numeric ts and v, the exact saved pack, no network');

// ---- import through the file picker, confirm modal, round trip
await E(async () => { const { saveGame } = await import('/js/save.js'); STATE.money = 777; saveGame(); });
await E(() => { document.getElementById('modalwrap').classList.add('hidden'); document.getElementById('b-help').click(); }); await g.page.waitForSelector('#sio-imp');
const [fc] = await Promise.all([g.page.waitForEvent('filechooser'), g.page.click('#sio-imp')]); await fc.setFiles(file1);
await g.page.waitForSelector('#sio-go'); const modalTxt = await g.page.innerText('#mbody');
assert.match(modalTxt, /replaces your current game/i); assert.match(modalTxt, /\$777/); assert.match(modalTxt, /\$12,345/); assert.match(modalTxt, /PLOTS/i);
await Promise.all([g.page.waitForNavigation({ waitUntil: 'load' }), g.page.click('#sio-go')]); await reloaded(g);
assert.equal(await E(() => STATE.money), 12345); assert.equal(await E(() => STATE.plots.length), 1); assert.equal(await E(() => STATE.plots[0].crew[0].stars), 4);
assert.equal(strip(await raw(g)), strip(exported), 'the stored save equals the exported pack (only ts is fresh)');
assert.match(await toasts(g).then(t => t || ''), /Save imported|imported/i);
// export again from the boot screen link and compare: round-trip equality
const [dl2] = await Promise.all([g.page.waitForEvent('download'), g.page.click('#bt-exp')]); const file2 = join(tmp, 'save2.json'); await dl2.saveAs(file2);
assert.equal(strip(readFileSync(file2, 'utf8')), strip(exported));
ok('IMPORT SAVE: file picker -> confirm modal naming what it replaces -> reload into the imported game; export -> import -> export is identical (except ts)');

// ---- undo
assert.equal(await E(() => SAVEIO.hasUndo()), true);
await E(() => localStorage.getItem('openworld-v2-undo')); await g.page.fill('#pname', 'Exporter'); await g.page.click('#enter'); await g.page.waitForFunction(() => window.STATE.mode !== 'boot', null, { timeout: 20000 }); await wait(800);
await E(() => { document.getElementById('modalwrap').classList.add('hidden'); document.getElementById('b-help').click(); }); await g.page.waitForSelector('#sio-und');
await g.page.click('#sio-und'); await g.page.waitForSelector('#sio-ugo'); assert.match(await g.page.innerText('#mbody'), /\$777/);
await Promise.all([g.page.waitForNavigation({ waitUntil: 'load' }), g.page.click('#sio-ugo')]); await reloaded(g);
assert.equal(await E(() => STATE.money), 777); assert.equal(await E(() => SAVEIO.hasUndo()), false);
ok('UNDO IMPORT puts the previous game back (one step) and clears the undo copy');

// ---- rejection of bad files: nothing changes, never a crash
const before = await raw(g);
const now = Date.now();
const good = JSON.parse(exported);
const cases = {
  'not JSON': 'hello world', 'empty': '', 'JSON array': '[1,2,3]', 'JSON null': 'null', 'a string': '"x"',
  'no version': JSON.stringify({ ts: now, money: 5 }), 'version as text': JSON.stringify({ v: '5', ts: now }), 'newer version': JSON.stringify({ ...good, v: 99 }), 'old unknown version': JSON.stringify({ ...good, v: 1 }),
  'no timestamp': JSON.stringify({ v: 5, money: 5 }), 'timestamp as text': JSON.stringify({ v: 5, ts: 'now' }), 'future timestamp': JSON.stringify({ ...good, ts: now + 9e9 }),
  '__proto__ key': '{"v":5,"ts":' + now + ',"money":1,"__proto__":{"polluted":true}}', 'nested constructor': JSON.stringify({ ...good, res: { constructor: { x: 1 } } }),
  'money as text': JSON.stringify({ ...good, money: 'a lot' }), 'money infinite': '{"v":5,"ts":' + now + ',"money":1e999}', 'money huge': JSON.stringify({ ...good, money: 1e30 }),
  'plots as object': JSON.stringify({ ...good, plots: { a: 1 } }), 'bank as array': JSON.stringify({ ...good, bank: [1] }), 'name too long': JSON.stringify({ ...good, name: 'x'.repeat(500) }),
  'too many plots': JSON.stringify({ ...good, plots: new Array(6000).fill({}) }),
  'too big': JSON.stringify({ ...good, pad: 'x'.repeat(2.1e6) }),
};
const results = {};
for (const [k, txt] of Object.entries(cases)) { const v = await E(t => SAVEIO.validate(t, t.length), txt); results[k] = v; assert.equal(v.ok, false, k + ' must be refused'); assert.ok(typeof v.why === 'string' && v.why.length > 8, k + ' has a reason'); }
assert.equal(await raw(g), before, 'refused files change nothing'); assert.equal(await E(() => SAVEIO.hasUndo()), false);
assert.match(results['too big'].why, /too big/i); assert.match(results['newer version'].why, /newer/i); assert.match(results['not JSON'].why, /JSON/);
assert.equal(await E(() => ({}).polluted), undefined, 'no prototype pollution');
// and through the picker: a bad file shows a toast, no modal
const badFile = join(tmp, 'bad.json'); writeFileSync(badFile, 'not json at all'); await E(() => { document.getElementById('modalwrap').classList.add('hidden'); });
const [fc2] = await Promise.all([g.page.waitForEvent('filechooser'), E(() => SAVEIO.pickFile())]); await fc2.setFiles(badFile); await wait(600);
assert.match(await toasts(g), /Import refused/i); assert.equal(await g.page.locator('#sio-go').count(), 0);
const bigFile = join(tmp, 'big.json'); writeFileSync(bigFile, JSON.stringify({ ...good, pad: 'y'.repeat(2.2e6) }));
const [fc3] = await Promise.all([g.page.waitForEvent('filechooser'), E(() => SAVEIO.pickFile())]); await fc3.setFiles(bigFile); await wait(600);
assert.match(await toasts(g), /too big/i); assert.equal(await raw(g), before);
ok(Object.keys(cases).length + ' kinds of bad file are refused with a clear reason (not JSON, wrong or newer version, hostile keys, impossible money, damaged sections, over 2 MB) and nothing changes');

// ---- a pack that passes the checks but the game's own loader cannot read: rolled back cleanly
const tricky = JSON.stringify({ ...good, plots: [null, 5, { id: 1 }], money: 4242 });
const v = await E(t => SAVEIO.validate(t, t.length), tricky);
const outcome = await Promise.all([g.page.waitForNavigation({ waitUntil: 'load', timeout: 20000 }).catch(() => null), E(t => SAVEIO.importText(t).catch(() => null), tricky).catch(() => null)]);
await reloaded(g);
const m2 = await E(() => STATE.money); assert.ok(m2 === 777 || m2 === 4242, 'either rolled back (777) or read through the sanitizers (4242): ' + m2);
assert.equal(typeof (await E(() => STATE.plots.length)), 'number');
ok('a save the structural checks accept is then read by the game\'s own loadGame sanitizers; a refusal rolls back (' + (m2 === 777 ? 'rolled back' : 'sanitized and loaded') + ')');
assert.deepEqual(g.bad, [], g.bad.join(' | '));
ok('no page errors or console errors');
await g.ctx.close(); await m.close();

// ---- the hosted site: an import is uploaded like any save
const mock = await startMock({ mode: 'full' }), b2 = 'http://127.0.0.1:' + mock.port;
const h = await game(b2, 'Dana'); await enter(h, 'Dana');
await h.ev(async () => { const { saveGame } = await import('/js/save.js'); STATE.money = 50000; saveGame(); });
const [dl3] = await Promise.all([h.page.waitForEvent('download'), h.ev(() => SAVEIO.exportSave())]); const file3 = join(tmp, 'hosted.json'); await dl3.saveAs(file3);
await h.ev(async () => { const { saveGame } = await import('/js/save.js'); const { flushNow } = await import('/js/sync.js'); STATE.money = 1000; saveGame(); await flushNow(); });
const srv = async () => (await (await fetch(b2 + '/api/__mock/state')).json()).players.find(p => p.name === 'Dana').saveMoney;
assert.equal(await srv(), 1000);
await h.ev(() => { document.getElementById('b-help').click(); }); await h.page.waitForSelector('#sio-imp');
const [fc4] = await Promise.all([h.page.waitForEvent('filechooser'), h.page.click('#sio-imp')]); await fc4.setFiles(file3); await h.page.waitForSelector('#sio-go');
await Promise.all([h.page.waitForNavigation({ waitUntil: 'load' }), h.page.click('#sio-go')]); await reloaded(h);
assert.equal(await h.ev(() => STATE.money), 50000); assert.equal(await srv(), 50000, 'the server copy now holds the imported save');
const hp = await h.ev(() => JSON.parse(localStorage.getItem('openworld-v2'))); assert.equal(typeof hp.ts, 'number'); assert.ok(hp.v);
ok('on the hosted site the imported save is uploaded through the normal sync (server copy updated) and the sync contract holds (JSON object, numeric ts and v)');
assert.deepEqual(h.bad, [], h.bad.join(' | '));
ok('no page errors or console errors on the hosted site');
await h.ctx.close(); await mock.close(); await browser.close();
console.log('save-io-test: all ' + n + ' checks passed');
