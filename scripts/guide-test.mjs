// Browser test for the BUSINESS ACADEMY engine (js/systems/guide.js) with TEST chapters registered through GUIDE.register.
// Fresh save and older/hostile saves, locked chapters, step advance by real state, skip/resume/replay, progress across reload,
// the starter guide keeping priority, suggestions, phone width, nothing blocking, no money touched, no console errors.
// Run: node scripts/guide-test.mjs        (the real chapters get their own checks in this same file as they land)
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
const m = await startMock({ mode: 'noapi' }), base = 'http://127.0.0.1:' + m.port;
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }), page = await ctx.newPage(), bad = [];
page.on('pageerror', e => bad.push('pageerror: ' + e.message));
page.on('console', x => { if (x.type() === 'error' && !/Failed to load resource/.test(x.text())) bad.push('console: ' + x.text()); if (x.type() === 'warning' && /\[guide\]/.test(x.text())) bad.push('guide warning (expected only in the bad-chapter check): ' + x.text()); });
const E = (f, a) => page.evaluate(f, a);
const boot = async () => { await page.goto(base + '/openworld.html'); await page.waitForFunction(() => window.GUIDE && window.STATE, null, { timeout: 20000 }); await wait(1200); };
const enter = async () => { await page.fill('#pname', 'Student'); await page.click('#enter'); await page.waitForFunction(() => window.STATE.mode !== 'boot', null, { timeout: 20000 }); await wait(900); await E(() => document.getElementById('modalwrap').classList.add('hidden')); };
const regTest = () => E(() => {
  window.__f = window.__f || {};
  const mk = (id, order, extra, steps) => GUIDE.register(Object.assign({ id, title: 'Test ' + id, icon: '🧪', order, intro: 'intro ' + id, steps }, extra));
  mk('tc1', 10, {}, [
    { key: 'a', title: 'Do A', body: () => 'Do <b>A</b>. Money is ' + STATE.money, obj: () => 'Set flag A.', check: () => !!window.__f.a, open: () => { window.__f.opened = 1; } },
    { key: 'b', title: 'Do B', body: () => 'Do <b>B</b>.', obj: () => 'Set flag B.', check: () => !!window.__f.b },
    { key: 'c', title: 'Do C', body: () => 'Do <b>C</b>.', obj: () => 'Set flag C.', check: () => !!window.__f.c, tgt: () => ({ x: 0, z: 0 }) },
  ]);
  mk('tc2', 20, { unlock: () => !!window.__f.unlock, lockedWhy: () => 'Unlock flag first.' }, [{ key: 'a', title: 'Only step', body: () => 'x', obj: () => 'y', check: () => !!window.__f.t2 }]);
  mk('tc3', 30, { opened: () => !!window.__f.panel }, [{ key: 'a', title: 'Panel step', body: () => 'x', obj: () => 'y', check: () => !!window.__f.t3 }]);
  return GUIDE.chapters().map(c => c.id + ':' + c.status);
});
const chip = () => E(() => { const c = document.getElementById('gd'); return c && !c.classList.contains('hidden') ? c.innerText : null; });
const moneyNow = () => E(() => STATE.money);

// ---- A. a fresh save, on the globe (the starter guide only runs inside a city)
await boot(); await enter();
assert.deepEqual(await E(() => GUIDE.chapters()), []); assert.equal(await E(() => GUIDE.state().cur), null); assert.equal(await E(() => GUIDE.state().ready), true);
await E(() => document.getElementById('b-help').click()); await wait(300);
assert.equal(await page.locator('#hp-academy').count(), 0, 'no ACADEMY button while no chapter is registered');
await E(() => document.getElementById('modalwrap').classList.add('hidden'));
const bad0 = await E(() => [GUIDE.register({ id: 'Bad Id', steps: [] }), GUIDE.register({ id: 'ok1', steps: [] }), GUIDE.register({ id: 'ok2', steps: [{ key: 'x', title: 't' }] }), GUIDE.register(null), GUIDE.register({ id: 'dup', steps: [{ key: 'a', title: 't', body: () => '', obj: () => '', check: () => 1 }, { key: 'a', title: 't2', body: () => '', obj: () => '', check: () => 1 }] })]);
assert.deepEqual(bad0, [false, false, false, false, false]); assert.deepEqual(await E(() => GUIDE.chapters()), []);
bad.length = 0;   // the five deliberate rejections above warned
const money0 = await moneyNow();
assert.deepEqual(await regTest(), ['tc1:available', 'tc2:locked', 'tc3:available']);
await E(() => document.getElementById('b-help').click()); await page.waitForSelector('#hp-academy');
await page.click('#hp-academy'); await page.waitForSelector('#gd-list-mark', { state: 'attached' });
let listTxt = await page.innerText('#mbody'); assert.match(listTxt, /test tc1/i); assert.match(listTxt, /LOCKED/); assert.match(listTxt, /Unlock flag first/); assert.match(listTxt, /NEW/);
assert.equal(await page.locator('[data-gl="start"][data-v="tc2"]').count(), 0, 'a locked chapter has no START');
ok('the engine starts empty (no Academy button, bad chapters refused); registering shows ACADEMY in HELP; the list shows NEW and LOCKED (with why)');

// locked stays locked
assert.deepEqual(await E(() => GUIDE.start('tc2')), { ok: false, why: 'locked' });
// start from the list
await page.click('[data-gl="start"][data-v="tc1"]'); await wait(700);
assert.equal(await E(() => document.getElementById('modalwrap').classList.contains('hidden')), true, 'the list closes; nothing else opens');
let c1 = await chip(); assert.match(c1, /1\/3/); assert.match(c1, /Do A/); assert.match(c1, /Set flag A/); assert.match(c1, /SHOW ME/);
await page.click('#gd [data-gd="show"]'); assert.equal(await E(() => window.__f.opened), 1);
assert.equal(await E(() => GUIDE.state().cur), 'tc1');
// a step advances only when the real state says so
await wait(1000); assert.equal(await E(() => GUIDE.state().step), 0);
await E(() => { window.__f.a = 1; }); await page.waitForFunction(() => GUIDE.state().step === 1, null, { timeout: 5000 });
assert.match(await chip(), /2\/3/);
// skipping ahead by setting a LATER flag does not complete an earlier step
await E(() => { window.__f.c = 1; }); await wait(1300); assert.equal(await E(() => GUIDE.state().step), 1, 'step 2 still needs flag B');
// close (X): the chapter closes, progress is kept
await page.click('#gd .gd-x'); await wait(300);
assert.equal(await chip(), null); assert.equal(await E(() => GUIDE.state().cur), null); assert.equal(await E(() => GUIDE.state().steps.tc1), 1);
assert.equal((await E(() => GUIDE.chapters())).find(c => c.id === 'tc1').status, 'progress');
await E(() => { document.getElementById('b-help').click(); }); await page.waitForSelector('#hp-academy'); await page.click('#hp-academy'); await page.waitForSelector('[data-gl="resume"]');
assert.match(await page.innerText('#mbody'), /IN PROGRESS · step 2\/3/);
await page.click('[data-gl="resume"][data-v="tc1"]'); await wait(500); assert.equal(await E(() => GUIDE.state().step), 1); assert.match(await chip(), /Do B/);
await E(() => { window.__f.b = 1; }); await page.waitForFunction(() => GUIDE.state().step === 2 || GUIDE.state().done.tc1, null, { timeout: 5000 });   // step C's flag is already set, so it completes right after
await page.waitForFunction(() => GUIDE.state().done.tc1, null, { timeout: 5000 });
const sum = await chip(); assert.match(sum, /done/i); assert.match(sum, /test tc1/i); assert.match(sum, /NEXT/); assert.match(sum, /REPLAY/);
assert.equal(await E(() => GUIDE.state().cur), null);
ok('START from the list; SHOW ME runs the step\'s open(); steps advance only on the real check; X closes and RESUME comes back at the same step; a finished chapter shows the summary card');
// replay
await E(() => { window.__f = { unlock: 1 }; }); await page.click('#gd [data-gd="replay"]'); await wait(500);
assert.match(await chip(), /1\/3/); assert.equal(await E(() => GUIDE.state().done.tc1), true, 'the DONE mark stays while replaying');
await E(() => GUIDE.skip()); await wait(200);
assert.equal((await E(() => GUIDE.chapters())).find(c => c.id === 'tc2').status, 'available', 'unlock() is read live');
ok('REPLAY restarts a finished chapter from step 1 (still marked done); a chapter unlocks live when unlock() turns true');
assert.equal(await moneyNow(), money0, 'the Academy never touched the money');
assert.equal(await E(() => document.getElementById('modalwrap').classList.contains('hidden')), true);

// ---- B. saved progress: shape on disk, reload, older and hostile saves
await E(async () => { const { saveGame } = await import('/js/save.js'); window.__f = { a: 1 }; GUIDE.start('tc1'); saveGame(); });
await wait(1500);
const disk = await E(() => JSON.parse(localStorage.getItem('openworld-v2')).guide);
assert.equal(disk.cur, 'tc1'); assert.equal(disk.done.tc1, true); assert.equal(typeof disk.step, 'object');
const pk = await E(() => JSON.parse(localStorage.getItem('openworld-v2'))); assert.equal(typeof pk.ts, 'number'); assert.ok(pk.v); assert.ok(JSON.stringify(pk).length < 2e6);
await page.reload(); await page.waitForFunction(() => window.GUIDE, null, { timeout: 20000 }); await wait(1200);
assert.equal(await E(() => GUIDE.state().cur), 'tc1'); assert.equal(await E(() => GUIDE.state().done.tc1), true);
await regTest(); await enter(); await wait(900);
assert.equal(await E(() => GUIDE.state().cur), 'tc1'); assert.match(await chip(), /test tc1/i);
ok('progress (active chapter, done marks, steps) is saved in the pack field `guide` and survives a reload; the chip comes back by itself');
// unknown ids dropped, steps clamped (after boot has registered the chapters)
await E(async () => { const raw = JSON.parse(localStorage.getItem('openworld-v2')); raw.guide = { cur: 'ghost', done: { ghost: true, tc1: true }, step: { ghost: 4, tc1: 99, tc3: -5 }, sug: { ghost: true, starter: true } }; localStorage.setItem('openworld-v2', JSON.stringify(raw)); STATE.mode = 'boot'; });
await page.reload(); await page.waitForFunction(() => window.GUIDE, null, { timeout: 20000 }); await regTest(); await E(() => GUIDE.ready());
const pr = await E(() => GUIDE.state());
assert.equal(pr.cur, null); assert.deepEqual(Object.keys(pr.done), ['tc1']); assert.equal(pr.steps.tc1, 2, 'steps clamped to the chapter length'); assert.equal(pr.steps.tc3, 0); assert.equal(pr.steps.ghost, undefined); assert.deepEqual(Object.keys(pr.sug).sort(), ['starter']);
// older save without the field, and hostile shapes
await E(() => { const raw = JSON.parse(localStorage.getItem('openworld-v2')); delete raw.guide; localStorage.setItem('openworld-v2', JSON.stringify(raw)); STATE.mode = 'boot'; });
await page.reload(); await page.waitForFunction(() => window.GUIDE, null, { timeout: 20000 });
assert.deepEqual(await E(() => { const s = GUIDE.state(); return [s.cur, Object.keys(s.done).length, Object.keys(s.steps).length]; }), [null, 0, 0]);
for (const evil of [{ cur: 5, done: [1, 2], step: 'x', sug: null }, { cur: '../x', done: { 'Bad Key': true, ok: 1 }, step: { ok: 'NaN', z: Infinity, y: 1e99 }, sug: { '__proto__': true } }, 'string', [1], null]) {
  await E(e => { const raw = JSON.parse(localStorage.getItem('openworld-v2')); raw.guide = e; localStorage.setItem('openworld-v2', JSON.stringify(raw)); STATE.mode = 'boot'; }, evil);
  await page.reload(); await page.waitForFunction(() => window.GUIDE, null, { timeout: 20000 });
  const s = await E(() => GUIDE.state()); assert.equal(s.cur, null); for (const k of ['done', 'steps', 'sug']) for (const [id, v] of Object.entries(s[k])) assert.match(id, /^[a-z0-9_-]{1,32}$/, 'sanitized ids');
  assert.equal(await E(() => ({}).polluted), undefined);
}
ok('an older save without `guide` loads clean; unknown chapter ids and out-of-range steps are pruned; hostile shapes (arrays, odd keys, __proto__, huge numbers) are sanitized');
await regTest(); await enter(); await E(() => { GUIDE.reset(); });

// ---- C. suggestions (once each), no modal by itself, starter guide priority (needs a city)
await E(() => { GUIDE.qaGap(0); GUIDE.reset(); window.__f = {}; });
await E(async () => { const { enterWorld } = await import('/js/render/main.js'); const { CITIES } = await import('/js/config.js'); const c = CITIES[0]; enterWorld({ key: c.key, name: c.name, lat: c.lat, lon: c.lon, tier: c.tier }); });
for (let i = 0; i < 60 && (await E(() => STATE.mode)) !== 'city'; i++) await wait(1000); await wait(2500);
await E(() => { document.getElementById('modalwrap').classList.add('hidden'); });
assert.equal(await E(() => TUT.state().active), true, 'a fresh save runs the starter guide in the city');
assert.equal(await E(() => GUIDE.start('tc1').ok), false, 'START is refused while the starter guide runs');
assert.match(await E(() => document.getElementById('toasts').innerText), /starter guide/i);
await E(() => { GUIDE.go('tc1', 0); }); await wait(900);
assert.equal(await chip(), null, 'the Academy chip stays hidden under the starter guide'); assert.equal(await E(() => !document.getElementById('tut').classList.contains('hidden')), true);
await E(() => { document.getElementById('b-help').click(); }); await page.waitForSelector('#hp-academy'); await page.click('#hp-academy'); await page.waitForSelector('#gd-list-mark', { state: 'attached' });
assert.match(await page.innerText('#mbody'), /starter guide is still running/i); assert.equal(await page.locator('[data-gl="start"]:not([disabled])').count(), 0);
await E(() => document.getElementById('modalwrap').classList.add('hidden'));
assert.equal(await E(() => GUIDE.state().sug.starter), undefined, 'no suggestion while the starter guide runs');
ok('the starter guide keeps priority: START refused, the chip stays hidden, list buttons disabled; no suggestion yet');
await E(() => TUT.skip()); await wait(1200);
assert.equal(await E(() => TUT.state().done), true);
await page.waitForFunction(() => !!document.getElementById('gd') && !document.getElementById('gd').classList.contains('hidden'), null, { timeout: 5000 });   // the chapter we had selected shows again
assert.match(await chip(), /Do A/); await E(() => GUIDE.skip());
await E(() => { GUIDE.reset(); }); await page.waitForSelector('#gd-sug:not(.hidden)', { timeout: 6000 });
const sugTxt = await page.innerText('#gd-sug'); assert.match(sugTxt, /test tc1/i); assert.match(sugTxt, /starter guide is done/i);
assert.equal(await E(() => document.getElementById('modalwrap').classList.contains('hidden')), true, 'a suggestion is a small card, never a modal');
assert.equal(await E(() => GUIDE.state().sug.starter), true);
await page.click('#gd-sug [data-gs="go"]'); await wait(600); assert.equal(await E(() => GUIDE.state().cur), 'tc1'); await E(() => GUIDE.skip());
// panel-open suggestion: fires once, on the false -> true edge
await E(() => { window.__f.panel = 0; }); await wait(900); await E(() => { window.__f.panel = 1; });
await page.waitForSelector('#gd-sug:not(.hidden)', { timeout: 6000 }); assert.match(await page.innerText('#gd-sug'), /test tc3/i); assert.match(await page.innerText('#gd-sug'), /first time/);
await page.click('#gd-sug [data-gs="no"]'); await E(() => { window.__f.panel = 0; }); await wait(900); await E(() => { window.__f.panel = 1; }); await wait(1500);
assert.equal(await page.locator('#gd-sug:not(.hidden)').count(), 0, 'each chapter is suggested once'); assert.equal(await E(() => GUIDE.state().sug.tc3), true);
ok('after the starter guide a card offers the first chapter once (START works); opening a system\'s panel offers its chapter once; both are remembered in the save');
assert.equal(await moneyNow() >= 0, true);

// ---- D. world beacon, phone width, nothing blocking
await E(() => { window.__f = { a: 1, b: 1 }; GUIDE.start('tc1'); }); await wait(1200);
assert.equal(await E(() => GUIDE.state().beacon), true, 'a step with tgt() draws the beacon in the city');
await E(() => { window.__f.c = 1; }); await page.waitForFunction(() => GUIDE.state().done.tc1 && !GUIDE.state().beacon, null, { timeout: 5000 });
await E(() => { GUIDE.start('tc1'); }); await wait(600);
await page.setViewportSize({ width: 390, height: 800 }); await wait(500);
const r = await E(() => { const c = document.getElementById('gd'); const b = c.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, vw: innerWidth, hidden: c.classList.contains('hidden'), sw: document.documentElement.scrollWidth }; });
assert.ok(!r.hidden && r.l >= 0 && r.r <= 390 && r.b < 800 - 120, 'the chip fits a 390 px phone and clears the bottom bar: ' + JSON.stringify(r)); assert.ok(r.sw <= 390, 'no horizontal page scroll');
await E(() => { document.getElementById('b-help').click(); }); await page.waitForSelector('#hp-academy'); await page.click('#hp-academy'); await page.waitForSelector('#gd-list-mark', { state: 'attached' });
const lw = await E(() => { const m = document.getElementById('mbody'); return [m.scrollWidth, m.clientWidth]; }); assert.ok(lw[0] <= lw[1] + 1, 'the chapter list fits at phone width: ' + lw);
await page.screenshot({ path: process.env.SHOTS ? join(process.env.SHOTS, 'academy-phone.png') : undefined }).catch(() => { });
await E(() => document.getElementById('modalwrap').classList.add('hidden')); await page.setViewportSize({ width: 1280, height: 800 });
// the chip never sits over the canvas centre or blocks the world's input
const over = await E(() => { const c = document.getElementById('gd').getBoundingClientRect(); return c.left < 300 && c.right < 320; }); assert.ok(over, 'the chip stays on the left edge');
await page.mouse.click(640, 400); await wait(300); assert.equal(await E(() => document.getElementById('modalwrap').classList.contains('hidden')), true);
ok('a step with tgt() draws the beacon (and clears it when done); the chip fits a 390 px phone with no horizontal scroll; the list fits; the chip stays on the left edge and clicks reach the world');
assert.deepEqual(bad, [], bad.join(' | '));
ok('no page errors or console errors');
await ctx.close(); await m.close(); await browser.close();
console.log('guide-test: all ' + n + ' checks passed');
