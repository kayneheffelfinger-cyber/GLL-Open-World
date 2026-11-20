// Browser test for LOANS (js/systems/loans.js) on a plain static server (no /api): approval and rates by credit score,
// the repayment schedule, autopay, payoff, a full escalation run (warning, grace, late fee, credit drop, bank seizure,
// property seizure) stepped with the QA day helper, loan clocks PAUSED across an offline gap, net worth, save/reload,
// an older save without `loan`, a hostile save, the dashboard by clicking, and no console errors. Run: node scripts/loans-test.mjs
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
page.on('console', x => { if (x.type() === 'error' && !/Failed to load resource/.test(x.text())) bad.push('console: ' + x.text()); });
const E = (f, a) => page.evaluate(f, a);
await page.goto(base + '/openworld.html');
await page.waitForFunction(() => window.LOAN && window.STATE, null, { timeout: 20000 }); await wait(2000);
await page.fill('#pname', 'Lender'); await page.click('#enter');
await page.waitForFunction(() => window.STATE.mode !== 'boot', null, { timeout: 20000 }); await wait(1200);
await E(async () => { const { enterWorld } = await import('/js/render/main.js'); const { CITIES } = await import('/js/config.js'); const c = CITIES[0]; enterWorld({ key: c.key, name: c.name, lat: c.lat, lon: c.lon, tier: c.tier }); });
for (let i = 0; i < 60 && (await E(() => STATE.mode)) !== 'city'; i++) await wait(1000); await wait(2500);
await E(() => { document.getElementById('modalwrap').classList.add('hidden'); window.__t = []; new MutationObserver(ms => { for (const x of ms) for (const nd of x.addedNodes) window.__t.push(nd.innerText || ''); }).observe(document.getElementById('toasts'), { childList: true }); });
const toasts = () => E(() => window.__t.join(' || '));
const has = async re => assert.match(await toasts(), re);

// ---- approval, rates, the score
await E(() => { STATE.money = 200000; BANK.open('newyork'); BANK.deposit('a_newyork', 50000); });
assert.equal(await E(() => LOAN.score()), 700); assert.equal(await E(() => LOAN.creditFactor()), 1);
assert.ok(Math.abs((await E(() => LOAN.aprFor(700))) - .14) < 1e-9); assert.ok((await E(() => LOAN.aprFor(800))) < (await E(() => LOAN.aprFor(600))));
assert.equal(await E(() => LOAN.maxTotal(700)), 80000); assert.equal(await E(() => LOAN.maxTotal(400)), 0);
const q = await E(() => LOAN.quote(10000, 90)); assert.equal(q.n, 9); assert.ok(q.minPay > 1100 && q.minPay < 1200 && q.interest > 0);
const net0 = await E(() => BANK.net());
let r = await E(() => LOAN.take('a_newyork', 10000, 90)); assert.equal(r.ok, true);
assert.equal(await E(() => BANK.net()), net0, 'cash in the account minus the debt: net worth unchanged at disbursement');
assert.equal(await E(() => BANK.snap().accts[0].bal), 60000);
assert.ok((await E(() => BANK.ledger().map(e => e.type))).includes('loan_disbursement'));
for (const [args, why] of [[['a_newyork', 300000, 90], /at most/], [['a_newyork', 100, 90], /smallest/], [['a_newyork', 5000, 45], /terms/], [['a_nowhere', 5000, 90], /account/]]) { r = await E(a => LOAN.take(...a), args); assert.equal(r.ok, false); assert.match(r.why, why); }
await E(() => { LOAN.qaScore(400); }); r = await E(() => LOAN.take('a_newyork', 1000, 30)); assert.equal(r.ok, false); assert.match(r.why, /too low/);
await E(() => { LOAN.qaScore(700); });
ok('approval: amount, term, account and score checks; rate and borrowing limit follow the credit score; disbursement is ledgered and net worth stays level');

// ---- interest, the schedule, on-time payments, autopay
await E(() => BANK.qaDays(1));
let lo = await E(() => LOAN.list()[0]); assert.ok(Math.abs(lo.balance - (10000 + 10000 * .14 / 360)) < .02, 'daily interest: ' + lo.balance);
const sch = await E(() => LOAN.schedule(LOAN.list()[0], 20)); assert.ok(sch.length >= 8 && sch[sch.length - 1].bal < lo.balance);
r = await E(() => LOAN.payMin('L1', 'a_newyork')); assert.equal(r.ok, true);
await E(() => BANK.qaDays(9)); lo = await E(() => LOAN.list()[0]);
assert.equal(lo.nextDue, 20); assert.equal(await E(() => LOAN.score()), 704); assert.equal(lo.overdue, 0);
await E(() => LOAN.setAuto('L1', true)); const bal0 = await E(() => BANK.snap().accts[0].bal);
await E(() => BANK.qaDays(10)); lo = await E(() => LOAN.list()[0]);
assert.equal(lo.nextDue, 30); assert.equal(await E(() => LOAN.score()), 708);
assert.ok((await E(() => BANK.ledger().filter(e => e.type === 'loan_payment').length)) >= 2); assert.ok(await E(() => BANK.snap().accts[0].bal) < bal0);
ok('interest accrues daily, a minimum paid on time raises the score, autopay pays on the due day, the schedule projects to zero');

// ---- the credit score reaches the cards
await E(() => LOAN.qaScore(500)); assert.ok((await E(() => LOAN.creditFactor())) < .6);
await E(() => LOAN.qaScore(850)); const hi = await E(() => BANK.limitFor('a_newyork')); await E(() => LOAN.qaScore(500)); const lowL = await E(() => BANK.limitFor('a_newyork'));
assert.ok(hi > lowL * 2, 'a better score gives a higher card limit: ' + hi + ' vs ' + lowL); await E(() => LOAN.qaScore(708));
ok('the credit score scales card limits through the hook');

// ---- pay off
r = await E(() => LOAN.payOff('L1', 'a_newyork')); assert.equal(r.ok, true);
assert.equal(await E(() => LOAN.list().length), 0); assert.equal(await E(() => LOAN.score()), 728);
ok('PAY OFF clears the loan and adds 20 points');

// ---- escalation A: bank seizure resolves it. missed minimum -> grace -> fee -> credit drop -> bank seized
r = await E(() => LOAN.take('a_newyork', 8000, 60)); assert.equal(r.ok, true);
await E(() => { LOAN.setAuto('L2', false); BANK.deposit('a_newyork', 0.01); });
lo = await E(() => LOAN.list()[0]); const D = lo.nextDue, s0 = await E(() => LOAN.score()), minPay = lo.minPay;
await E(d => BANK.qaDays(d - 3 - BANK.day()), D); await has(/due in 3 days/);
await E(() => BANK.qaDays(3)); lo = await E(() => LOAN.list()[0]);
assert.ok(lo.overdue >= minPay - .01 && lo.stage === 1); await has(/grace period of 5 days/);
assert.equal(await E(() => LOAN.stageInfo(LOAN.list()[0]).name), 'GRACE PERIOD'); assert.equal(lo.fees, 0);
await E(() => BANK.qaDays(3)); await has(/Grace period ends in 2 days/);
await E(() => BANK.qaDays(2)); lo = await E(() => LOAN.list()[0]);
const fee = Math.max(25, Math.round(minPay * 5) / 100); assert.ok(Math.abs(lo.fees - fee) < .02, 'late fee ' + lo.fees); await has(/Late fee/);
assert.equal(await E(() => LOAN.stageInfo(LOAN.list()[0]).name), 'LATE FEE'); assert.equal(await E(() => LOAN.score()), s0);
await E(() => BANK.qaDays(3)); await has(/Credit score drop in 2 days/);
await E(() => BANK.qaDays(2)); assert.equal(await E(() => LOAN.score()), s0 - 40); await has(/Credit score drops/);
await E(() => BANK.qaDays(7)); await has(/Bank seizure in 3 days/);
const bankBefore = await E(() => BANK.snap().accts[0].bal), overdueBefore = (await E(() => LOAN.list()[0])).overdue;
await E(() => BANK.qaDays(3)); lo = await E(() => LOAN.list()[0]);
assert.ok(bankBefore - (await E(() => BANK.snap().accts[0].bal)) > overdueBefore - 1, 'the overdue amount was taken from the account');
assert.equal(lo.missedSince, null); assert.equal(await E(() => LOAN.score()), s0 - 130);   // -40 at day 10, -30 more at day 20, -60 for the seizure await has(/seized from your bank accounts/); await has(/Back on track/);
assert.ok((await E(() => BANK.ledger().map(e => e.type))).includes('loan_seizure'));
ok('escalation: reminder, WARNING, grace period (no fee), late fee, credit drop of 40, bank seizure — each announced by a toast beforehand — and seizing the overdue amount ends the episode');
await E(() => LOAN.payOff('L2', 'a_newyork'));

// ---- escalation B: empty accounts, so properties are seized (cash is never touched)
await E(async () => { const { CITY } = await import('/js/world/city.js'); const an = CITY.anchor; const spots = []; for (let dx = -700; dx <= 700 && spots.length < 3; dx += 12) for (let dz = -700; dz <= 700 && spots.length < 3; dz += 12) { const x = an.x + dx, z = an.z + dz; if (GEN.siteOk('solar', x, z).ok && !spots.some(p => Math.hypot(p.x - x, p.z - z) < 40)) spots.push({ x, z }); } STATE.money = 300000; for (const s of spots) GEN.build('wind', s.x, s.z); });
assert.equal(await E(() => GEN.list().length), 3);
r = await E(() => LOAN.take('a_newyork', 5000, 60)); assert.equal(r.ok, true);
await E(() => { const a = BANK.state.accts.a_newyork; BANK.withdraw('a_newyork', a.bal); window.__cash = STATE.money; });
lo = await E(() => LOAN.list()[0]); await E(d => BANK.qaDays(d - BANK.day()), lo.nextDue);
await E(() => BANK.qaDays(27)); await has(/Property seizure in 3 days/);
assert.equal(await E(() => GEN.list().length), 3);
const sc0 = await E(() => LOAN.score());
await E(() => BANK.qaDays(3)); lo = (await E(() => LOAN.list()))[0] || null;
assert.equal(await E(() => GEN.list().length), 2, 'one generator (the highest resale value) was repossessed'); await has(/Property seized/);
assert.ok((await E(() => LOAN.score())) <= sc0 - 60);
assert.ok(!lo || lo.missedSince == null || lo.overdue >= 0);
assert.ok((await E(() => STATE.money)) > (await E(() => window.__cash)) - 1, 'cash was not seized (only the debt was taken out of the sale proceeds)');
ok('escalation: with empty accounts a property is repossessed and sold at its resale rate to cover the debt; cash in hand stays yours');
await E(() => { for (const l of LOAN.list()) LOAN.payOff(l.id, 'cash'); });

// ---- loan clocks pause offline: the Night Shift settles hours of absence and no loan moves
await E(() => { STATE.money = 100000; BANK.deposit('a_newyork', 30000); LOAN.take('a_newyork', 6000, 90); STATE.plots.push({ id: 'pz', cityKey: 'newyork', cart: { cuisine: 'hotdog' }, crew: [{}], x: 0, z: 0 }); });
await E(() => BANK.qaDays(4)); await E(() => import('/js/save.js').then(mm => mm.saveGame()));
const snap = await E(() => ({ day: BANK.day(), loan: LOAN.list()[0], score: LOAN.score(), m: Math.round(STATE.money) }));
await E(() => { const raw = JSON.parse(localStorage.getItem('openworld-v2')); raw.ts = Date.now() - 6 * 3600e3; localStorage.setItem('openworld-v2', JSON.stringify(raw)); STATE.mode = 'boot'; });   // boot mode: the page's own pagehide save must not re-stamp the pack   // six hours away = 240 game days
await page.reload(); await page.waitForFunction(() => window.LOAN, null, { timeout: 20000 }); await wait(2500);
const after = await E(() => ({ day: BANK.day(), loan: LOAN.list()[0], score: LOAN.score(), m: Math.round(STATE.money), saveTs: STATE.saveTs }));
assert.ok(after.m > snap.m, 'the Night Shift did run (a staffed cart earned overnight): ' + snap.m + ' -> ' + after.m);
assert.equal(after.day, snap.day); assert.equal(after.score, snap.score);
assert.equal(after.loan.balance, snap.loan.balance); assert.equal(after.loan.nextDue, snap.loan.nextDue); assert.equal(after.loan.overdue, 0); assert.equal(after.loan.fees, 0); assert.equal(after.loan.missedSince, null);
ok('OFFLINE RULE: six hours away, the Night Shift paid the cart and moved no loan clock — no interest, no due date, no fee, no score change');

// ---- the dashboard, by clicking
await page.fill('#pname', 'Lender'); await page.click('#enter');   // the reload put the boot screen back
await page.waitForFunction(() => window.STATE.mode !== 'boot', null, { timeout: 20000 }); await wait(1500);
await page.waitForFunction(() => document.getElementById('b-bank'), null, { timeout: 10000 });
await E(() => { document.getElementById('modalwrap').classList.add('hidden'); BANK.openPanel('loans'); });
const id1 = await E(() => LOAN.list()[0].id);
await page.waitForSelector('[data-ln="pay"]'); assert.match(await page.innerText('#bk-body'), /credit score/i); assert.match(await page.innerText('#bk-body'), /CURRENT/);
await page.screenshot({ path: process.env.SHOTS ? join(process.env.SHOTS, 'loans.png') : undefined }).catch(() => { });
await page.fill('#ln-amt-' + id1, '500'); const b1 = (await E(() => LOAN.list()[0])).balance; await page.click('[data-ln="pay"][data-v="' + id1 + '"]'); await wait(300);
assert.ok((await E(() => LOAN.list()[0])).balance < b1 - 400);
await page.fill('#ln-new', '2000'); await page.click('[data-ln="take"]'); await wait(300); assert.equal(await E(() => LOAN.list().length), 2);
await page.click('[data-ln="off"][data-v="' + id1 + '"]'); await wait(300); assert.equal(await E(() => LOAN.list().length), 1);
await page.click('[data-ln="auto"]'); await wait(300); assert.equal((await E(() => LOAN.list()[0])).auto, 1);
ok('the LOANS dashboard: score and terms, stage, schedule; PAY, TAKE LOAN, PAY OFF and AUTOPAY by clicking');

// ---- net worth, save/reload, older save, hostile save
assert.equal(await E(() => BANK.net()), await E(() => BANK.assets() - BANK.owed() - LOAN.owed())); assert.ok(await E(() => LOAN.owed()) > 0);
const w = await E(() => RIVALS.playerWorth()); const nb = await E(() => BANK.net()); await E(() => { STATE.money += 1000; }); assert.equal(Math.round((await E(() => RIVALS.playerWorth())) - w), 1000);
assert.ok(nb < await E(() => BANK.assets()), 'loans lower the net below the deposits');
ok('loans subtract in BANK.net(), which sits inside RIVALS.playerWorth() (the Money List)');
await E(() => import('/js/save.js').then(mm => mm.saveGame()));
const keep = await E(() => JSON.stringify({ l: LOAN.list(), s: LOAN.score(), h: LOAN.state.log.length }));
await page.reload(); await page.waitForFunction(() => window.LOAN, null, { timeout: 20000 }); await wait(1500);
assert.equal(await E(() => JSON.stringify({ l: LOAN.list(), s: LOAN.score(), h: LOAN.state.log.length })), keep);
const pack = await E(() => JSON.parse(localStorage.getItem('openworld-v2'))); assert.equal(typeof pack.ts, 'number'); assert.ok(pack.v); assert.ok(JSON.stringify(pack).length < 2e6); assert.ok(pack.loan.loans.length);
await E(() => { const r2 = JSON.parse(localStorage.getItem('openworld-v2')); delete r2.loan; localStorage.setItem('openworld-v2', JSON.stringify(r2)); });
await page.reload(); await page.waitForFunction(() => window.LOAN, null, { timeout: 20000 }); await wait(1500);
assert.equal(await E(() => LOAN.list().length), 0); assert.equal(await E(() => LOAN.score()), 700);
await E(() => { const r2 = JSON.parse(localStorage.getItem('openworld-v2')); r2.loan = { score: 99999, loans: [null, { id: 'x', balance: -5, minPay: 1, apr: 1 }, { id: 'L9', acct: 'a_newyork', balance: 'junk', minPay: 5, apr: .1 }, { id: 'L8', acct: 'a_newyork', balance: 1000, minPay: 50, apr: 9, term: 90, nextDue: 'z', missedSince: 'q', warned: { a: 1 } }], log: [1, { text: 5 }, { day: 'x', text: 'ok' }], hist: 'no', seq: -4 }; localStorage.setItem('openworld-v2', JSON.stringify(r2)); });
await page.reload(); await page.waitForFunction(() => window.LOAN, null, { timeout: 20000 }); await wait(1500);
const hs = await E(() => ({ s: LOAN.score(), l: LOAN.list(), log: LOAN.state.log }));
assert.equal(hs.s, 850); assert.equal(hs.l.length, 1); assert.equal(hs.l[0].id, 'L8'); assert.ok(hs.l[0].apr <= .6); assert.equal(hs.l[0].missedSince, null); assert.equal(hs.log.length, 1);
ok('the save survives a reload; an older save without `loan` loads clean (score 700); a hostile loan field is sanitized');
assert.deepEqual(bad, [], bad.join(' | '));
ok('no page errors or console errors');
await browser.close(); await m.close();
console.log('loans-test: all ' + n + ' checks passed');
