// Browser test for the companies/stocks client against the TEST-ONLY mock (scripts/companies-mock.mjs).
// Needs Playwright with Chromium (preinstalled in the Claude sandbox). Run: node scripts/companies-test.mjs
// Parts: (A) no /api at all, (B) an /api without the companies endpoint: no UI, no errors, no retry loop;
//        (C) a full mock with two simulated players exercising every flow in docs/companies-api.md.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { startMock } from './companies-mock.mjs';

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { const req = createRequire(import.meta.url); chromium = req(join(execSync('npm root -g').toString().trim(), 'playwright')).chromium; }

let n = 0;
const ok = (m) => console.log('PASS ' + (++n) + ': ' + m);
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch();

async function openGame(base, player) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const bad = [], reqs = [];
  page.on('pageerror', e => bad.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) bad.push('console: ' + m.text()); });
  page.on('request', r => { if (/\/api\/companies/.test(r.url())) reqs.push(r.url()); });
  if (player) await page.goto(base + '/api/__mock/login?as=' + player);
  await page.goto(base + '/openworld.html');
  await page.waitForFunction(() => window.CO && window.STATE, null, { timeout: 20000 });
  await wait(2500);
  await page.fill('#pname', player || 'Tester'); await page.click('#enter');   // leave the boot screen so panels are clickable
  await page.waitForFunction(() => window.STATE.mode !== 'boot', null, { timeout: 20000 }); await wait(1500);
  return { ctx, page, bad, reqs, ev: (fn, arg) => page.evaluate(fn, arg) };
}

// ---------------- A: no /api at all (GitHub Pages, local files) ----------------
{
  const m = await startMock({ mode: 'noapi' }), base = 'http://127.0.0.1:' + m.port;
  const g = await openGame(base);
  assert.equal(await g.page.locator('#b-company').count(), 0); assert.equal(await g.page.locator('#b-stocks').count(), 0);
  assert.equal(g.reqs.length, 0, 'no companies request without /api');
  assert.deepEqual(g.bad, []);
  ok('A: without /api there is no button, no request and no console error');
  await g.ctx.close(); await m.close();
}

// ---------------- B: /api exists but has no companies endpoint (today's production) ----------------
{
  const m = await startMock({ mode: 'nocompanies' }), base = 'http://127.0.0.1:' + m.port;
  const g = await openGame(base, 'Solo');
  assert.equal(await g.ev(() => window.CO.state.enabled), false);
  assert.equal(await g.page.locator('#b-company').count(), 0); assert.equal(await g.page.locator('#b-stocks').count(), 0);
  assert.equal(await g.page.locator('#co-body').count(), 0);
  await wait(12000);
  assert.equal(g.reqs.length, 1, 'exactly one status request, no retry loop (saw ' + g.reqs.length + ')');
  assert.deepEqual(g.bad, []);
  // the Empire panel shows no company section either
  const emp = await g.ev(() => { ECO.openEmpire(); return document.getElementById('mbody').innerText; });
  assert.ok(!/Company/.test(emp), 'no Company section in the Empire panel');
  ok('B: /api without companies: no UI, no console errors, one status request and nothing more');
  await g.ctx.close(); await m.close();
}

// ---------------- B2: companies present but disabled / unsupported protocol ----------------
{
  const m = await startMock({ mode: 'full' }), base = 'http://127.0.0.1:' + m.port;
  // a server that answers status with enabled:false must also leave no trace
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.route('**/api/companies/status', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: false, protocol: 1 }) }));
  await page.goto(base + '/api/__mock/login?as=Q'); await page.goto(base + '/openworld.html');
  await page.waitForFunction(() => window.CO, null, { timeout: 20000 }); await wait(2500);
  assert.equal(await page.locator('#b-company').count(), 0);
  const ctx2 = await browser.newContext(); const p2 = await ctx2.newPage();
  await p2.route('**/api/companies/status', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, protocol: 99, minProtocol: 99 }) }));
  await p2.goto(base + '/api/__mock/login?as=Q2'); await p2.goto(base + '/openworld.html');
  await p2.waitForFunction(() => window.CO, null, { timeout: 20000 }); await wait(2500);
  assert.equal(await p2.locator('#b-company').count(), 0);
  ok('B2: enabled:false and an unsupported protocol version both stay invisible');
  await ctx.close(); await ctx2.close(); await m.close();
}

// ---------------- C: full mock, two players ----------------
const mock = await startMock({ mode: 'full' }), base = 'http://127.0.0.1:' + mock.port;
const A = await openGame(base, 'Alice'), B = await openGame(base, 'Bob');
for (const g of [A, B]) { assert.equal(await g.ev(() => window.CO.state.enabled), true); assert.equal(await g.page.locator('#b-company').count(), 1); assert.equal(await g.page.locator('#b-stocks').count(), 1); }
ok('C: both players see the COMPANY and STOCKS buttons when the server enables companies');

const setMoney = (g, v) => g.ev(async (v) => { const { saveGame } = await import('/js/save.js'); STATE.money = v; saveGame(); }, v);
const money = g => g.ev(() => Math.round(STATE.money));
const wallet = async g => { await g.ev(() => CO.refresh(true)); return g.ev(() => CO.state.wallet.balance); };
await setMoney(A, 60000); await setMoney(B, 8000);

// wallet deposit: cash leaves the save, the server credits the wallet only after seeing the synced save
let r = await A.ev(() => CO.qa.walletDeposit(6000));
assert.equal(r.ok, true); assert.equal(await wallet(A), 6000); assert.equal(await money(A), 54000);
ok('C: wallet deposit moves cash into the server wallet (confirmed against the synced save)');

// founding requirements: B is too poor
await B.ev(() => CO.qa.walletDeposit(3000));
r = await B.ev(() => CO.qa.found('Bobs Hotdogs', 'BOBS'));
assert.equal(r.ok, false); assert.equal(r.code, 'net_worth_too_low');
ok('C: founding is refused below the minimum net worth');

// found through the real UI
await A.ev(() => CO.open()); await A.page.fill('#co-name', 'Acme Corp'); await A.page.fill('#co-tick', 'acme'); await A.page.click('[data-co="found"]');
await A.page.waitForSelector('.co-head', { timeout: 8000 });
assert.match(await A.page.innerText('.co-head'), /Acme Corp/);
assert.equal(await wallet(A), 4000);                 // 6000 - 2000 fee
r = await A.ev(() => CO.call('POST', '', { name: 'Second', ticker: 'SEC', requestId: 'x1' }));
assert.equal(r.code, 'already_member');
ok('C: founding through the UI charges the fee from the wallet; one company per player');
await A.page.screenshot({ path: process.env.SHOTS ? join(process.env.SHOTS, 'company-overview.png') : undefined }).catch(() => { });

// invite -> accept (Bob)
r = await A.ev(() => CO.qa.invite('Bob', 'member')); assert.equal(r.ok, true);
r = await A.ev(() => CO.qa.invite('Nobody', 'member')); assert.equal(r.code, 'no_such_player');
await B.ev(() => CO.refresh(true));
assert.equal(await B.ev(() => CO.state.invites.length), 1);
await B.ev(() => CO.open());
await B.page.click('[data-co="accept"]'); await B.page.waitForSelector('.co-head', { timeout: 8000 });
assert.match(await B.page.innerText('.co-head'), /Acme Corp/); assert.match(await B.page.innerText('.co-head'), /Member/);
ok('C: invite, unknown-player error, accept through the UI; the invitee becomes a Member');

// business assignment + income to the shared bank
const cart = { id: 'plot-b1', cityKey: 'newyork', cityName: 'New York', x: 0, z: 0, cart: { cuisine: 'taco' }, crew: [] };
await B.ev((c) => { STATE.plots.push(c); }, cart);
r = await B.ev(() => CO.qa.assignBiz(STATE.plots[STATE.plots.length - 1])); assert.equal(r.ok, true);
await B.ev(() => CO.refresh(true));
assert.equal(await B.ev(() => CO.divert(STATE.plots[STATE.plots.length - 1], 12.5)), true);
assert.equal(await B.ev(() => CO.divert({ id: 'not-mine' }, 5)), false);
const before = await money(B);
await B.ev(() => CO.sendIncome());
await A.ev(() => CO.refresh(true));
assert.equal(await A.ev(() => CO.state.company.bank.balance), 12.5);
assert.equal(await B.ev(() => CO.qa.pend()['plot-b1'] || 0), 0);
assert.equal(await money(B), before, 'diverted income never touched Bob\'s cash');
ok('C: an assigned business pays the company bank; its income no longer reaches the owner\'s cash');

// income over the server's cap is rejected and credited back
await B.ev(() => CO.divert(STATE.plots[STATE.plots.length - 1], 40000));
const cash0 = await money(B); await B.ev(() => CO.sendIncome());
assert.ok(await money(B) > cash0 + 20000, 'rejected income returns to the owner');
assert.equal(await B.ev(() => CO.qa.inflight()), null);
ok('C: the server caps income reports; the rejected part stays with the player');

// ledger + permission gating
await A.ev(() => CO.open('bank')); await A.page.waitForSelector('.co-led', { timeout: 8000 });
assert.match(await A.page.innerText('#co-body'), /business income/);
r = await B.ev(() => CO.qa.bankWithdraw(10, 'nope')); assert.equal(r.code, 'forbidden');
r = await B.ev(() => CO.qa.setRolePerms('member', ['view_ledger', 'withdraw'], 100)); assert.equal(r.code, 'forbidden');
r = await A.ev(() => CO.qa.setRolePerms('member', ['view_ledger', 'withdraw'], 100)); assert.equal(r.ok, true);
await B.ev(() => CO.refresh(true));
r = await B.ev(() => CO.qa.bankWithdraw(8, 'lunch')); assert.equal(r.ok, true);
r = await B.ev(() => CO.qa.bankWithdraw(150, 'too much')); assert.equal(r.code, 'over_limit');
assert.equal(await B.ev(() => CO.state.company.bank.balance), 4.5);
ok('C: ledger lists deposits; withdrawals are permission- and limit-gated and debit the bank atomically');

// wallet payout -> local cash, claimed once
const bCash = await money(B);
r = await B.ev(() => CO.qa.walletWithdraw(5)); assert.equal(r.ok, true);
await wait(600);
assert.equal(await money(B), bCash + 5); assert.equal(await B.ev(() => CO.state.wallet.payouts.length), 0);
await B.ev(() => CO.refresh(true)); assert.equal(await money(B), bCash + 5, 'a payout is credited exactly once');
ok('C: wallet withdrawals arrive as payouts, credited to cash once and acknowledged');

// stocks
const sA = () => A.ev(() => STK.loadList().then(() => STK.state.list));
let list = await sA(); assert.equal(list.length, 1); assert.equal(list[0].ticker, 'ACME');
const sell = await A.ev(() => CO.call('POST', 'stocks/ACME/orders', { side: 'sell', type: 'limit', qty: 1000, limitPrice: 1.05, requestId: 's1' })); assert.equal(sell.ok, true);
r = await A.ev(() => CO.call('POST', 'stocks/ACME/orders', { side: 'buy', type: 'limit', qty: 10, limitPrice: 1.05, requestId: 's2' })); assert.equal(r.code, 'self_trade');
r = await A.ev(() => CO.call('POST', 'stocks/ACME/orders', { side: 'sell', type: 'limit', qty: 10, limitPrice: 2.0, requestId: 's3' })); assert.equal(r.code, 'price_band');
r = await A.ev(() => CO.call('POST', 'stocks/ACME/orders', { side: 'sell', type: 'limit', qty: 500000, limitPrice: 1.05, requestId: 's4' })); assert.equal(r.code, 'order_too_large');
ok('C: self-trade, price-band and order-size safeguards reject bad orders');
// Bob buys through the UI window
await B.ev(() => STK.open('ACME')); await B.page.waitForSelector('#st-qty', { timeout: 8000 });
await B.page.selectOption('#st-side', 'buy'); await B.page.selectOption('#st-type', 'market'); await B.page.fill('#st-qty', '400'); await B.page.click('[data-st="order"]');
await B.page.waitForFunction(() => STK.state.mine && STK.state.mine.some(p => p.ticker === 'ACME' && p.qty === 400), null, { timeout: 8000 });
assert.equal(await B.ev(() => STK.state.quote.quote.last), 1.05);
ok('C: Bob buys 400 ACME shares through the STOCKS window; last price moves to the trade');
await B.page.screenshot({ path: process.env.SHOTS ? join(process.env.SHOTS, 'stocks.png') : undefined }).catch(() => { });
// cancel + position limit
r = await A.ev(() => CO.call('GET', 'stocks/orders')); assert.equal(r.data.orders.length, 1);
r = await A.ev((id) => STK.cancel(id), r.data.orders[0].id); assert.equal(r.ok, true);
assert.equal((await A.ev(() => CO.call('GET', 'stocks/orders'))).data.orders.length, 0);
ok('C: open orders list and cancel');
// issue + dividend (set the bank up directly: test-only backdoor into the mock's memory)
for (const c of mock.state.companies.values()) c.bank = 100000;
await A.ev(() => CO.refresh(true));
r = await A.ev(() => CO.call('POST', CO.state.company.id + '/stock/issues', { shares: 300000, requestId: 'i1' })); assert.equal(r.code, 'issue_limit');
r = await A.ev(() => CO.call('POST', CO.state.company.id + '/stock/issues', { shares: 100000, requestId: 'i2' })); assert.equal(r.ok, true);
r = await B.ev(() => CO.call('POST', CO.state.company.id + '/stock/issues', { shares: 10, requestId: 'i3' })); assert.equal(r.code, 'forbidden');
r = await A.ev(() => CO.call('POST', CO.state.company.id + '/stock/dividends', { perShare: 0.5, requestId: 'd1' })); assert.equal(r.code, 'dividend_limit');
const bw0 = await wallet(B);
r = await A.ev(() => CO.call('POST', CO.state.company.id + '/stock/dividends', { perShare: 0.05, requestId: 'd2' })); assert.equal(r.ok, true);
assert.equal(Math.round(((await wallet(B)) - bw0) * 100) / 100, 20, 'Bob holds 400 shares: 400 x 0.05');
const cap = (await A.ev(() => CO.call('GET', CO.state.company.id + '/stock/cap-table'))).data;
assert.equal(cap.total, 1100000); assert.ok(cap.holders.some(h => h.name === 'Bob' && h.qty === 400));
ok('C: share issuing (limit enforced, permission-gated), dividends paid per share into holders\' wallets, cap table');
// the company window's STOCK tab (owner)
await A.ev(() => CO.open('stock')); await A.page.waitForSelector('[data-sk="issue"]', { timeout: 8000 });
assert.match(await A.page.innerText('#co-body'), /who owns it/i);
await B.ev(() => CO.open('stock')); await B.page.waitForSelector('#co-body [data-sk="market"]', { timeout: 8000 });
assert.equal(await B.page.locator('[data-sk="issue"]').count(), 0, 'a plain member sees no issue/dividend controls');
ok('C: the STOCK tab shows the cap table; issue/dividend controls only for roles with manage_stock');

// removal, leave, and natural polling
r = await B.ev(() => CO.qa.removeMember('whoever')); assert.equal(r.code, 'forbidden');
const bid = await B.ev(() => CO.state.player.id);
r = await A.ev((id) => CO.qa.removeMember(id), bid); assert.equal(r.ok, true);
await B.ev(() => CO.refresh(true)); assert.equal(await B.ev(() => !!CO.state.company), false);
assert.equal(await B.ev(() => Object.keys(CO.qa.pend()).length), 0);
r = await A.ev(() => CO.qa.invite('Bob', 'manager')); assert.equal(r.ok, true);
let tries = 0; while (tries++ < 16 && !(await B.ev(() => CO.state.invites.length))) await wait(1000);
assert.equal(await B.ev(() => CO.state.invites.length), 1, 'the 10 s poll delivers the invite without any action from Bob');
await B.ev(async () => { await CO.qa.accept(CO.state.invites[0].id); });
r = await B.ev(() => CO.qa.leave()); assert.equal(r.ok, true);
assert.equal(await B.ev(() => !!CO.state.company), false);
r = await A.ev(() => CO.qa.leave()); assert.equal(r.code, 'owner_must_transfer');
ok('C: remove a member, invite again (delivered by polling), leave; the owner cannot abandon the company');

// local save contract
const pack = await A.ev(() => JSON.parse(localStorage.getItem('openworld-v2')));
assert.equal(typeof pack.ts, 'number'); assert.ok(pack.v); assert.ok(JSON.stringify(pack).length < 2e6); assert.ok(pack.co);
ok('C: the local save is still a JSON object with numeric ts and v, under 2 MB, with the new optional co field');
for (const [nm, g] of [['Alice', A], ['Bob', B]]) assert.deepEqual(g.bad, [], nm + ' console/page errors: ' + g.bad.join(' | '));
ok('C: no page errors or console errors from the game in either player\'s browser');

await browser.close(); await mock.close();
console.log('companies-test: all ' + n + ' checks passed');
