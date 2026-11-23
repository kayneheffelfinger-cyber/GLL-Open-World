// Browser test for BANKS (js/systems/banks.js) on a plain static server (no /api): every action,
// month-end statements, card fees and interest, net worth, save/reload, an older save without `bank`,
// a hostile save, and company-bank transfers against the test-only companies mock. Run: node scripts/banks-test.mjs
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

async function game(base, { player, city } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }), page = await ctx.newPage(), bad = [];
  page.on('pageerror', e => bad.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) bad.push('console: ' + m.text()); });
  if (player) await page.goto(base + '/api/__mock/login?as=' + player);
  await page.goto(base + '/openworld.html');
  await page.waitForFunction(() => window.BANK && window.STATE, null, { timeout: 20000 }); await wait(2000);
  await page.fill('#pname', player || 'Tester'); await page.click('#enter');
  await page.waitForFunction(() => window.STATE.mode !== 'boot', null, { timeout: 20000 }); await wait(1200);
  return { ctx, page, bad, ev: (f, a) => page.evaluate(f, a) };
}

const m = await startMock({ mode: 'noapi' }), base = 'http://127.0.0.1:' + m.port;
const g = await game(base), E = g.ev;
assert.equal(await g.page.locator('#b-bank').count(), 1);
ok('the BANK button is there with no server at all');

// ---- accounts, deposits, withdrawals
await E(() => { STATE.money = 50000; });
let r = await E(() => BANK.open('newyork')); assert.equal(r.ok, true);
r = await E(() => BANK.open('newyork')); assert.equal(r.ok, false);
await E(() => BANK.open('london'));
r = await E(() => BANK.deposit('a_newyork', 20000)); assert.equal(r.ok, true);
r = await E(() => BANK.deposit('a_newyork', 1e9)); assert.equal(r.ok, false);
r = await E(() => BANK.withdraw('a_newyork', 5000)); assert.equal(r.ok, true);
r = await E(() => BANK.withdraw('a_newyork', 1e9)); assert.equal(r.ok, false);
let s = await E(() => BANK.snap()); assert.equal(s.cash, 35000); assert.equal(s.accts.find(a => a.id === 'a_newyork').bal, 15000);
ok('open (one per city), deposit and withdraw move cash and reject bad amounts');

// ---- transfers between own accounts only (fee), never to a player
r = await E(() => BANK.transfer('a_newyork', 'a_london', 4000)); assert.equal(r.ok, true);
s = await E(() => BANK.snap()); assert.equal(s.accts.find(a => a.id === 'a_newyork').bal, 15000 - 4000 - 1.5); assert.equal(s.accts.find(a => a.id === 'a_london').bal, 4000);
r = await E(() => BANK.transfer('a_newyork', 'a_newyork', 5)); assert.equal(r.ok, false);
r = await E(() => BANK.transfer('a_newyork', 'someoneelse', 5)); assert.equal(r.ok, false);
r = await E(() => BANK.transfer('a_newyork', 'company', 5)); assert.equal(r.ok, false);
assert.equal(await E(() => { BANK.openPanel('transfer'); return !!document.querySelector('#bk-from option[value="company"]'); }), false);
ok('transfers work between your own city accounts with the flat fee; no player or company target without a server');

// ---- cards: debit, credit, PAY WITH, real spend() path, fallback to cash
await E(() => { BANK.issueDebit('a_newyork'); BANK.applyCredit('a_newyork'); });
s = await E(() => BANK.snap()); const lim = s.cc[0].limit; assert.equal(lim, Math.round((1500 + .2 * 10998.5) / 100) * 100);
await E(() => BANK.setMethod('debit:a_newyork'));
await E(async () => { const { spend } = await import('/js/systems/economy.js'); window.__sp = spend(1000, 'test plot'); });
s = await E(() => BANK.snap()); assert.equal(s.cash, 35000); assert.equal(s.accts.find(a => a.id === 'a_newyork').bal, 10998.5 - 1000);
await E(() => BANK.setMethod('credit:a_newyork'));
await E(async () => { const { spend } = await import('/js/systems/economy.js'); spend(1500, 'cart'); });
s = await E(() => BANK.snap()); assert.equal(s.cc[0].owed, 1500); assert.equal(s.cash, 35000);
await E(async (lim) => { const { spend } = await import('/js/systems/economy.js'); window.__r = spend(lim, 'over limit'); }, lim);   // over the limit: falls back to cash
s = await E(() => BANK.snap()); assert.equal(s.cc[0].owed, 1500); assert.equal(s.cash, 35000 - lim);
await E(() => { STATE.money += 3000; });
let L = await E(() => BANK.ledger().map(e => e.type)); for (const t of ['deposit', 'withdrawal', 'transfer_out', 'fee', 'transfer_in', 'card_purchase', 'credit_purchase']) assert.ok(L.includes(t), 'ledger has ' + t);
ok('debit and credit purchases through spend() hit the ledger; a card that cannot cover falls back to cash');

// ---- a real purchase path: build a generator with the credit card
await E(() => { BANK.state.cc.a_newyork.limit = 20000; BANK.setMethod('credit:a_newyork'); });   // test setup: room for a 4,200 purchase
await E(async () => { const { enterWorld } = await import('/js/render/main.js'); const { CITIES } = await import('/js/config.js'); const c = CITIES[0]; enterWorld({ key: c.key, name: c.name, lat: c.lat, lon: c.lon, tier: c.tier }); });
for (let i = 0; i < 60 && (await E(() => STATE.mode)) !== 'city'; i++) await wait(1000); await wait(2500);
await E(() => { document.getElementById('modalwrap').classList.add('hidden'); });
r = await E(async () => { const { CITY } = await import('/js/world/city.js'); const an = CITY.anchor; let sp; for (let dx = -700; dx <= 700 && !sp; dx += 12) for (let dz = -700; dz <= 700 && !sp; dz += 12) if (GEN.siteOk('solar', an.x + dx, an.z + dz).ok) sp = { x: an.x + dx, z: an.z + dz }; STATE.money = 100000; const before = BANK.snap().cc[0].owed; const r = GEN.build('solar', sp.x, sp.z); return { r, d: BANK.snap().cc[0].owed - before, cash: STATE.money }; });
assert.equal(r.r.ok, true); assert.equal(r.d, 4200); assert.equal(r.cash, 100000);
ok('a real game purchase (building a solar array) is charged to the credit card, not cash');

// ---- paying the card, month end, statements, interest, late fees
await E(() => { BANK.setMethod('cash'); });
r = await E(() => BANK.payCard('a_newyork', 700, 'a_newyork')); assert.equal(r.ok, true);
r = await E(() => BANK.payCard('a_newyork', 1, 'cash')); assert.equal(r.ok, true);
s = await E(() => BANK.snap()); assert.equal(s.cc[0].owed, 1500 + 4200 - 701);
await E(() => BANK.qaDays(29)); s = await E(() => BANK.snap()); assert.equal(s.day, 29); assert.equal(s.stmts, 0);
await E(() => BANK.qaDays(1)); s = await E(() => BANK.snap()); assert.equal(s.day, 30); assert.equal(s.stmts, 3);   // 2 accounts + 1 card
const st = await E(() => BANK.state.stmts); const cs = st.find(x => x.kind === 'card'); assert.equal(cs.close, 4999); assert.equal(cs.minDue, 249.95); assert.equal(cs.dueDay, 40);
const ny = st.find(x => x.line === 'a_newyork'); assert.ok(ny.int > 0, 'interest was credited');
ok('month end: interest on accounts, a statement per account and card (minimum due 5%, due 10 days later)');
await E(() => BANK.qaDays(9)); s = await E(() => BANK.snap()); assert.equal(s.cc[0].owed, 4999);   // day 39: no fee yet
await E(() => BANK.qaDays(2)); s = await E(() => BANK.snap()); assert.equal(s.cc[0].owed, 5024);   // day 41: late fee $25
await E(() => BANK.qaDays(1)); s = await E(() => BANK.snap()); assert.equal(s.cc[0].owed, 5024, 'the late fee is charged once');
await E(() => BANK.qaDays(18)); s = await E(() => BANK.snap()); assert.equal(s.day, 60);
assert.ok(Math.abs(s.cc[0].owed - (4999 + 25 + 4999 * .02)) < .02, 'day 60: 4999 + 25 late fee + 2% interest on the unpaid 4999 = ' + s.cc[0].owed);
ok('late fee after the due day (once), 2% interest on a balance not paid in full');
// paying in full before the due date: no interest
await E(() => { STATE.money = 100000; BANK.payCard('a_newyork', 1e9, 'cash'); });
s = await E(() => BANK.snap()); assert.equal(s.cc[0].owed, 0);
ok('a card paid off is settled');

// ---- net worth + the Money List
// read, deposit and re-read inside ONE synchronous page call: with separate round trips the live game loop (market ticks, income)
// can move playerWorth() between the two reads and fail the 1e-6 check at random
const [w0, w1] = await E(() => { const a = RIVALS.playerWorth(); BANK.deposit('a_london', 10000); return [a, RIVALS.playerWorth()]; });
assert.ok(Math.abs(w1 - w0) < 1e-6, 'cash into an account does not change net worth');
await E(() => { BANK.setMethod('credit:a_newyork'); }); await E(async () => { const { spend } = await import('/js/systems/economy.js'); spend(1000, 'x'); });
const n1 = await E(() => BANK.net()), w2 = await E(() => RIVALS.playerWorth());
assert.ok(Math.abs((w2 - w1) - (-1000)) < 5, 'a 1,000 card purchase adds 1,000 of debt to net worth (worth moved ' + (w2 - w1) + ')');
assert.equal(await E(() => BANK.net()), n1);
assert.equal(await E(() => BANK.net()), await E(() => BANK.assets() - BANK.owed()));
ok('BANK.net() (balances less card debt) is inside RIVALS.playerWorth()');

// ---- the panel, by clicking
await E(() => { BANK.setMethod('cash'); BANK.openPanel('accounts'); });
await g.page.selectOption('#bk-city', 'tokyo').catch(() => { }); await g.page.click('[data-bk="open"]');
await g.page.waitForSelector('#bk-amt-a_tokyo'); await g.page.fill('#bk-amt-a_tokyo', '500'); await g.page.click('[data-bk="dep"][data-v="a_tokyo"]');
await wait(300); assert.equal(await E(() => BANK.snap().accts.find(a => a.id === 'a_tokyo').bal), 500);
for (const t of ['transfer', 'cards', 'statements', 'ledger']) { await g.page.click('[data-bk="tab"][data-v="' + t + '"]'); await wait(150); assert.ok((await g.page.innerText('#bk-body')).length > 50); }
await g.page.screenshot({ path: process.env.SHOTS ? join(process.env.SHOTS, 'bank.png') : undefined }).catch(() => { });
ok('the BANK panel: open an account and deposit by clicking; every tab renders');

// ---- ledger integrity: replaying the ledger reproduces every balance
const chk = await E(() => { const b = BANK.state, o = {}; for (const e of b.ledger) o[e.line] = e.bal; const bad = []; for (const a of Object.values(b.accts)) if (Math.abs((o[a.id] ?? 0) - a.bal) > 0.005) bad.push(a.id); return bad; });
assert.deepEqual(chk, []);
ok('the ledger\'s running balances match every account');

// ---- save / reload / older save / hostile save
await E(() => { return import('/js/save.js').then(m => m.saveGame()); });
const before = await E(() => JSON.stringify({ a: BANK.snap().accts, l: BANK.ledger().length, s: BANK.state.stmts.length, m: BANK.state.method }));
await g.page.reload(); await g.page.waitForFunction(() => window.BANK, null, { timeout: 20000 }); await wait(1500);
assert.equal(await E(() => JSON.stringify({ a: BANK.snap().accts, l: BANK.ledger().length, s: BANK.state.stmts.length, m: BANK.state.method })), before);
const pack = await E(() => JSON.parse(localStorage.getItem('openworld-v2'))); assert.equal(typeof pack.ts, 'number'); assert.ok(pack.v); assert.ok(JSON.stringify(pack).length < 2e6); assert.ok(pack.bank.accts.a_newyork);
await E(() => { const r = JSON.parse(localStorage.getItem('openworld-v2')); delete r.bank; localStorage.setItem('openworld-v2', JSON.stringify(r)); });
await g.page.reload(); await g.page.waitForFunction(() => window.BANK, null, { timeout: 20000 }); await wait(1500);
assert.equal(await E(() => BANK.snap().accts.length), 0); assert.equal(await E(() => BANK.snap().method), 'cash');
await E(() => { const r = JSON.parse(localStorage.getItem('openworld-v2')); r.bank = { accts: { a_newyork: { id: 'a_newyork', cityKey: 'newyork', bal: 'x' }, a_mars: { cityKey: 'mars', bal: 5 }, evil: 7 }, cc: { a_newyork: { limit: 1e12, owed: -5 } }, debit: { a_mars: 1 }, ledger: [null, { line: 'zz', type: 't', amt: 1 }, { line: 'a_newyork', type: 'deposit', amt: 'n' }], stmts: 'no', method: 'credit:a_mars', day: -4 }; localStorage.setItem('openworld-v2', JSON.stringify(r)); });
await g.page.reload(); await g.page.waitForFunction(() => window.BANK, null, { timeout: 20000 }); await wait(1500);
s = await E(() => BANK.snap()); assert.deepEqual(s.accts.map(a => a.id), ['a_newyork']); assert.equal(s.accts[0].bal, 0); assert.equal(s.cc[0].limit, 25000); assert.equal(s.cc[0].owed, 0); assert.equal(s.method, 'cash'); assert.equal(s.day, 0); assert.equal(s.ledger, 0);
ok('the save survives a reload; an older save without `bank` loads clean; a hostile bank field is sanitized');
assert.deepEqual(g.bad, [], g.bad.join(' | '));
ok('no page errors or console errors (static server, no /api)');
await g.ctx.close(); await m.close();

// ---- company bank transfers (only when the server enables companies)
const mock = await startMock({ mode: 'full' }), b2 = 'http://127.0.0.1:' + mock.port;
const c = await game(b2, { player: 'Carol' });
await c.ev(async () => { const { saveGame } = await import('/js/save.js'); STATE.money = 60000; saveGame(); await CO.qa.walletDeposit(5000); });
let rr = await c.ev(() => CO.qa.found('Carol Co', 'CAROL')); assert.equal(rr.ok, true);
await c.ev(() => { BANK.open('newyork'); BANK.deposit('a_newyork', 10000); BANK.openPanel('transfer'); });
assert.equal(await c.ev(() => !!document.querySelector('#bk-to option[value="company"]')), true);
rr = await c.ev(() => BANK.transfer('a_newyork', 'company', 2500)); assert.equal(rr.ok, true, JSON.stringify(rr));
await c.ev(() => CO.refresh(true)); assert.equal(await c.ev(() => CO.state.company.bank.balance), 2500);
assert.equal(await c.ev(() => BANK.snap().accts[0].bal), 7500);
rr = await c.ev(() => BANK.transfer('company', 'a_newyork', 1000)); assert.equal(rr.ok, true);
await c.page.waitForFunction(() => BANK.snap().accts[0].bal === 8500, null, { timeout: 8000 });
assert.equal(await c.ev(() => CO.state.company.bank.balance), 1500);
const ct = await c.ev(() => BANK.ledger().filter(e => e.type.startsWith('transfer')).map(e => e.type + ':' + e.amt));
assert.ok(ct.includes('transfer_out:-2500') && ct.includes('transfer_in:1000'), ct.join());
rr = await c.ev(() => BANK.transfer('a_newyork', 'company', 99999)); assert.equal(rr.ok, false);
ok('with companies enabled, account <-> company bank transfers work and are ledgered; failures change nothing');
assert.deepEqual(c.bad, [], c.bad.join(' | '));
await c.ctx.close(); await mock.close(); await browser.close();
console.log('banks-test: all ' + n + ' checks passed');
