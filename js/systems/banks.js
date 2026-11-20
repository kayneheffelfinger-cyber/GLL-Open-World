// ====================================================================
// js/systems/banks.js: BANKS (v2.80). One bank per city: accounts, deposits,
// withdrawals, transfers between your own accounts, debit and credit cards,
// monthly statements, an append-only ledger, and bank balances in net worth.
// Local and single-player; works with no server. If the hosted server supports
// companies (companies.js), transfers to and from the company bank also appear.
// ====================================================================
import { CITIES } from '../config.js';
import { fmt$ } from '../util.js';
import { STATE } from '../state.js';
import { saveGame } from '../save.js';
import { uiBalance } from '../systems/economy.js';
import { closeModal, openModal, toast } from '../ui/dom.js';
import { WORLD } from '../world/world.js';
import { ECO } from '../systems/eco.js';
import { CO } from '../systems/companies.js';

// ======== section: 80_banks.js ========
// v2.80 BANKS. The ask: "Add one bank per city. Players can open accounts, deposit, withdraw and
// transfer, and get debit and credit cards with a credit limit and monthly statements. Card
// spending goes through the ledger. Bank balances count toward net worth."
//   - THE BANKS: every catalog city has one ("<City> Savings & Trust"). You may hold one account at
//     each. DEPOSIT and WITHDRAW move cash in and out; TRANSFER moves money between your own
//     accounts in different cities (flat $1.50 inter-bank fee) and, when the server supports
//     companies, between an account and the company bank. No player-to-player transfers.
//   - THE LEDGER: every movement is an entry (deposit, withdrawal, transfer_out/in, card_purchase,
//     credit_purchase, card_payment, fee, interest), with the balance after it. Append-only; the
//     newest 300 are kept in the save.
//   - THE CARDS: a debit card per account (spends from it) and a credit card per account (spends
//     up to its limit, owed on the card). The PAY WITH setting chooses cash, a debit card or a
//     credit card. Scope: everything bought through the game's spend() (plots, carts, builds,
//     machines, generators, rigs, designs...). Wages, utility bills and other recurring costs the
//     game deducts directly are still paid from cash. If the chosen card cannot cover a purchase
//     it falls back to cash.
//   - THE MONTH: a game month is 30 game days (90 s each) and only runs while you play (loan
//     time and bank time do not tick offline). At each month end every account earns 0.30%
//     interest, every card closes a statement (minimum due = 5% or $25, due 10 days later), and a
//     statement is kept. A minimum not paid by its due day costs a $25 late fee; a balance not
//     paid in full by then costs 2% interest at the next statement.
//   - NET WORTH: RIVALS.playerWorth() adds BANK.net() = account balances - card balances owed.
//     Cash moved into an account stays in your worth, a card purchase adds an asset and a debt.
// Every call is try/caught; window.BANK is the QA surface.
export const BANK = (() => {
  const DAY = 90, MONTH = 30, DUE_GAP = 10;
  const XFER_FEE = 1.5, INT_M = .003, CC_INT_M = .02, LATE_FEE = 25, MIN_PCT = .05, MIN_FLOOR = 25;
  const LEDGER_MAX = 300, STMT_MAX = 48;
  const r2 = v => Math.round((+v || 0) * 100) / 100;
  const byKey = {}; for (const c of CITIES) byKey[c.key] = c;
  const bankName = k => ((byKey[k] || {}).name || k) + ' Savings & Trust';
  let panelTab = 'accounts', dayT = 0;
  const sections = [], dayListeners = [];                    // v2.82: other modules (loans) add panel tabs and ride the game-day beat

  // ---- state (lazy: a save load can replace STATE) -------------------------------
  function B() {
    let b = STATE.bank;
    if (!b || typeof b !== 'object') b = STATE.bank = {};
    if (!b.accts || typeof b.accts !== 'object') b.accts = {};
    if (!b.debit || typeof b.debit !== 'object') b.debit = {};
    if (!b.cc || typeof b.cc !== 'object') b.cc = {};
    if (!Array.isArray(b.ledger)) b.ledger = [];
    if (!Array.isArray(b.stmts)) b.stmts = [];
    if (!Array.isArray(b.inbound)) b.inbound = [];
    if (!isFinite(+b.day)) b.day = 0;
    if (!isFinite(+b.seq)) b.seq = 0;
    if (typeof b.method !== 'string') b.method = 'cash';
    return b;
  }
  const accts = () => Object.values(B().accts);
  const acct = id => B().accts[id] || null;
  const day = () => B().day | 0;
  const scoreFactor = () => { try { return (window.LOAN && window.LOAN.creditFactor) ? +window.LOAN.creditFactor() || 1 : 1; } catch (e) { return 1; } };   // piece 2 (loans) scales limits by credit score; 1 until then

  // ---- the ledger: every movement is one append-only line --------------------------
  function post(line, type, amt, memo, extra) {
    const b = B(), isCard = line.charAt(0) === 'c' && line.charAt(1) === 'c';
    const a = isCard ? b.cc[line.slice(3)] : b.accts[line];
    if (!a) return null;
    amt = r2(amt);
    if (isCard) { a.owed = r2(a.owed + amt); if (amt > 0) a.purch = r2((a.purch || 0) + (type === 'fee' || type === 'interest' ? 0 : amt)); else a.pay = r2((a.pay || 0) - amt); if (amt < 0 && a.stmt) a.stmt.paidSince = r2((a.stmt.paidSince || 0) - amt); }
    else {
      a.bal = r2(a.bal + amt);
      const m = a.m || (a.m = { open: 0, in: 0, out: 0, int: 0, fee: 0 });
      if (type === 'interest') m.int = r2(m.int + amt); else if (type === 'fee') m.fee = r2(m.fee - amt); else if (amt >= 0) m.in = r2(m.in + amt); else m.out = r2(m.out - amt);
    }
    const e = { id: ++b.seq, day: day(), ts: Date.now(), line, type, amt, bal: isCard ? a.owed : a.bal, memo: String(memo || '').slice(0, 80) };
    if (extra) Object.assign(e, extra);
    b.ledger.push(e); if (b.ledger.length > LEDGER_MAX) b.ledger.splice(0, b.ledger.length - LEDGER_MAX);
    return e;
  }
  const cash = n => { STATE.money = r2(STATE.money + n); try { uiBalance(); } catch (e) { } };
  const done = () => { try { saveGame(); } catch (e) { } render(); };

  // ---- accounts ----------------------------------------------------------------------
  function open(cityKey) {
    const c = byKey[cityKey]; if (!c) return { ok: false, why: 'no such city' };
    const id = 'a_' + cityKey, b = B();
    if (b.accts[id]) return { ok: false, why: 'you already bank there' };
    b.accts[id] = { id, cityKey, name: bankName(cityKey), bal: 0, opened: day(), m: { open: 0, in: 0, out: 0, int: 0, fee: 0 } };
    toast('🏦 Account opened at <b>' + bankName(cityKey) + '</b>.'); done();
    return { ok: true, id };
  }
  function close(id) {
    const b = B(), a = b.accts[id]; if (!a) return { ok: false, why: 'no account' };
    if (Math.abs(a.bal) > .004) return { ok: false, why: 'empty the account first' };
    if (b.cc[id] && b.cc[id].owed > .004) return { ok: false, why: 'pay off its credit card first' };
    delete b.accts[id]; delete b.debit[id]; delete b.cc[id];
    if (b.method.slice(-id.length) === id) b.method = 'cash';
    done(); return { ok: true };
  }
  function deposit(id, amt) {
    amt = r2(amt); const a = acct(id);
    if (!a) return { ok: false, why: 'no account' };
    if (!(amt > 0)) return { ok: false, why: 'enter an amount' };
    if (STATE.money < amt) return { ok: false, why: 'not enough cash' };
    cash(-amt); post(id, 'deposit', amt, 'cash deposit'); done(); return { ok: true };
  }
  function withdraw(id, amt) {
    amt = r2(amt); const a = acct(id);
    if (!a) return { ok: false, why: 'no account' };
    if (!(amt > 0)) return { ok: false, why: 'enter an amount' };
    if (a.bal < amt) return { ok: false, why: 'not enough in the account' };
    post(id, 'withdrawal', -amt, 'cash withdrawal'); cash(amt); done(); return { ok: true };
  }
  // transfers: between your own accounts (different city banks) or to/from the company bank. Never to another player.
  async function transfer(from, to, amt) {
    amt = r2(amt);
    if (!(amt > 0)) return { ok: false, why: 'enter an amount' };
    if (from === to) return { ok: false, why: 'pick two different places' };
    const A = acct(from), Z = acct(to);
    if (A && Z) {
      if (A.bal < amt + XFER_FEE) return { ok: false, why: 'not enough in ' + A.name + ' (the ' + fmt$(XFER_FEE) + ' inter-bank fee comes on top)' };
      post(from, 'transfer_out', -amt, 'to ' + Z.name); post(from, 'fee', -XFER_FEE, 'inter-bank transfer fee'); post(to, 'transfer_in', amt, 'from ' + A.name);
      done(); return { ok: true, fee: XFER_FEE };
    }
    if (!companyOn()) return { ok: false, why: 'the company bank is not available' };
    if (A && to === 'company') {                               // account -> cash -> wallet -> company bank
      if (A.bal < amt) return { ok: false, why: 'not enough in ' + A.name };
      post(from, 'transfer_out', -amt, 'to the company bank'); cash(amt); try { saveGame(); } catch (e) { }   // the server judges the wallet deposit against the saved cash, so save before asking
      const r = await CO.depositToCompanyBank(amt);
      if (!r.ok) { cash(-amt); post(from, 'transfer_in', amt, 'company transfer failed: returned'); done(); return { ok: false, why: r.message || r.code || 'the company bank refused it' }; }
      done(); return { ok: true };
    }
    if (Z && from === 'company') {                             // company bank -> wallet -> payout -> cash -> account
      B().inbound.push({ to, amt, ts: Date.now() });
      const r = await CO.companyBankToCash(amt, 'transfer to ' + Z.name);
      if (!r.ok) { const i = B().inbound.findIndex(x => x.to === to && x.amt === amt); if (i >= 0) B().inbound.splice(i, 1); return { ok: false, why: r.message || r.code || 'the company bank refused it' }; }
      done(); return { ok: true };
    }
    return { ok: false, why: 'unknown transfer' };
  }
  const companyOn = () => { try { return !!(CO.state.enabled && CO.state.company); } catch (e) { return false; } };
  try { CO.onPayout(p => {                                     // a company payout lands in cash; route it on into the account it was meant for
    const b = B(), i = b.inbound.findIndex(x => r2(x.amt) === r2(p.amount) && acct(x.to));
    if (i < 0) return;
    const x = b.inbound.splice(i, 1)[0];
    if (STATE.money >= x.amt) { cash(-x.amt); post(x.to, 'transfer_in', x.amt, 'from the company bank'); done(); }
  }); } catch (e) { }

  // ---- cards -------------------------------------------------------------------------
  const limitFor = id => { const a = acct(id); if (!a) return 0; return Math.max(500, Math.min(25000, Math.round((1500 + .2 * Math.max(0, a.bal)) * scoreFactor() / 100) * 100)); };
  function issueDebit(id) { const b = B(); if (!acct(id)) return { ok: false, why: 'no account' }; b.debit[id] = 1; toast('💳 Debit card issued on ' + acct(id).name + '.'); done(); return { ok: true }; }
  function applyCredit(id) {
    const b = B(); if (!acct(id)) return { ok: false, why: 'no account' };
    if (b.cc[id]) return { ok: false, why: 'you already hold that card' };
    const lim = limitFor(id);
    b.cc[id] = { limit: lim, owed: 0, purch: 0, pay: 0, int: 0, fee: 0, stmt: null, since: day() };
    toast('💳 Credit card approved: <b>' + fmt$(lim) + '</b> limit.'); done(); return { ok: true, limit: lim };
  }
  function payCard(id, amt, from) {                           // from: an account id, or 'cash'
    amt = r2(amt); const c = B().cc[id];
    if (!c) return { ok: false, why: 'no card' };
    if (!(amt > 0)) return { ok: false, why: 'enter an amount' };
    amt = Math.min(amt, c.owed);
    if (!(amt > 0)) return { ok: false, why: 'nothing is owed' };
    if (from === 'cash') { if (STATE.money < amt) return { ok: false, why: 'not enough cash' }; cash(-amt); }
    else { const a = acct(from); if (!a) return { ok: false, why: 'no account' }; if (a.bal < amt) return { ok: false, why: 'not enough in the account' }; post(from, 'card_payment', -amt, 'credit card payment'); }
    post('cc_' + id, 'card_payment', -amt, from === 'cash' ? 'paid in cash' : 'from ' + acct(from).name);
    done(); return { ok: true, paid: amt };
  }
  // pay for a purchase with the card chosen under PAY WITH; true = paid (spend() then skips cash)
  function pay(n, memo) {
    const b = B(), m = b.method; n = r2(n);
    if (!(n > 0) || m === 'cash') return false;
    const [kind, id] = [m.slice(0, m.indexOf(':')), m.slice(m.indexOf(':') + 1)];
    if (kind === 'debit') { const a = acct(id); if (!a || !b.debit[id] || a.bal < n) return false; post(id, 'card_purchase', -n, memo || 'purchase'); }
    else if (kind === 'credit') { const c = b.cc[id]; if (!c || c.owed + n > c.limit + 1e-9) return false; post('cc_' + id, 'credit_purchase', n, memo || 'purchase'); }
    else return false;
    try { saveGame(); } catch (e) { } if (document.getElementById('bk-body')) render();
    return true;
  }
  function setMethod(m) { const b = B(); b.method = m; try { saveGame(); } catch (e) { } render(); }

  // ---- net worth -----------------------------------------------------------------------
  const assets = () => accts().reduce((s, a) => s + a.bal, 0);
  const owed = () => Object.values(B().cc).reduce((s, c) => s + c.owed, 0);
  const loansOwed = () => { try { return window.LOAN ? +window.LOAN.owed() || 0 : 0; } catch (e) { return 0; } };   // v2.82: loans subtract from net worth
  const net = () => r2(assets() - owed() - loansOwed());

  // ---- the game clock: days, month-end statements, due dates -----------------------------
  function tick(dt) {
    if (STATE.mode === 'boot') return;
    dayT += dt;
    while (dayT >= DAY) { dayT -= DAY; try { nextDay(); } catch (e) { console.error('[banks]', e); } }
  }
  function nextDay() {
    const b = B(); b.day = day() + 1;
    for (const id of Object.keys(b.cc)) {                       // due dates: a warning, then the late fee
      const c = b.cc[id], s = c.stmt; if (!s || s.settled) continue;
      const left = s.dueDay - b.day;
      if (left === 0) s.paidAtDue = s.paidSince;                 // what counts for the interest rule: paid in full BY the due day
      if (s.paidSince + 1e-9 >= s.minDue) { if (s.paidSince + 1e-9 >= s.closing) s.settled = 1; continue; }
      if (left === 3) toast('💳 <b>Card payment due in 3 days</b> — ' + fmt$(s.minDue) + ' minimum on your ' + bankName(id.slice(2)) + ' card.', 'warn');
      if (left < 0 && !s.late) { s.late = 1; post('cc_' + id, 'fee', LATE_FEE, 'late fee: minimum payment missed'); toast('💳 <b>Late fee ' + fmt$(LATE_FEE) + '</b> — the minimum was not paid by the due day.', 'warn'); }
    }
    for (const f of dayListeners) { try { f(b.day); } catch (e) { console.error('[banks]', e); } }   // loans: interest, due dates, escalation
    if (b.day % MONTH === 0) monthEnd();
    try { saveGame(); } catch (e) { } if (document.getElementById('bk-body')) render();
  }
  function monthEnd() {
    const b = B(), month = b.day / MONTH;
    for (const a of accts()) {
      if (a.bal > 0) post(a.id, 'interest', r2(a.bal * INT_M), 'monthly interest');
      b.stmts.push({ id: 's' + (++b.seq), month, day: b.day, kind: 'account', line: a.id, name: a.name, open: a.m.open, close: a.bal, in: a.m.in, out: a.m.out, int: a.m.int, fee: a.m.fee });
      a.m = { open: a.bal, in: 0, out: 0, int: 0, fee: 0 };
    }
    for (const id of Object.keys(b.cc)) {
      const c = b.cc[id], prev = c.stmt;
      if (prev && prev.closing > 0 && c.owed > 0) {              // carried a balance past the due date: interest on what was not paid
        const unpaid = Math.max(0, prev.closing - (prev.paidAtDue != null ? prev.paidAtDue : prev.paidSince));
        if (unpaid > .004) post('cc_' + id, 'interest', r2(unpaid * CC_INT_M), 'interest on the unpaid balance');
      }
      const open = c.stmtOpen || 0;
      c.limit = scoreFactor() < 1 ? Math.min(c.limit, limitFor(id)) : Math.max(c.limit, limitFor(id));   // a poor credit score shrinks the limit; a good one only ever raises it
      const closing = c.owed, minDue = closing > 0 ? Math.min(closing, Math.max(MIN_FLOOR, r2(closing * MIN_PCT))) : 0;
      b.stmts.push({ id: 's' + (++b.seq), month, day: b.day, kind: 'card', line: id, name: bankName(id.slice(2)) + ' credit card', open, close: closing, purchases: c.purch, payments: c.pay, minDue, dueDay: b.day + DUE_GAP, limit: c.limit });
      c.stmt = { closing, minDue, dueDay: b.day + DUE_GAP, closeDay: b.day, paidSince: 0, late: 0, settled: closing <= 0 ? 1 : 0 };
      c.stmtOpen = closing; c.purch = 0; c.pay = 0;
      if (closing > 0) toast('💳 <b>Statement ready</b> — ' + fmt$(closing) + ' owed, minimum ' + fmt$(minDue) + ' due in ' + DUE_GAP + ' days.', 'warn');
    }
    if (b.stmts.length > STMT_MAX) b.stmts.splice(0, b.stmts.length - STMT_MAX);
    toast('🏦 <b>Month ' + month + ' closed</b> — statements are in the Bank panel.');
  }

  // ---- the panel -----------------------------------------------------------------------
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const val = id => { const e = document.getElementById(id); return e ? e.value : ''; };
  const num = id => +val(id);
  const dstr = d => 'day ' + d + ' (month ' + Math.floor(d / MONTH + 1) + ')';
  function openPanel(tab) {
    if (tab) panelTab = tab;
    openModal('BANK', '<div id="bk-modal-mark"></div><div id="bk-body"></div>');
    render();
  }
  function accOpts(sel, extra) { return accts().map(a => '<option value="' + a.id + '"' + (a.id === sel ? ' selected' : '') + '>' + esc(a.name) + ' · ' + fmt$(a.bal) + '</option>').join('') + (extra || ''); }
  function render() {
    const el = document.getElementById('bk-body'); if (!el) return;
    const b = B(), tabs = [['accounts', 'ACCOUNTS'], ['transfer', 'TRANSFER'], ['cards', 'CARDS']].concat(sections.map(s => [s.id, s.label])).concat([['statements', 'STATEMENTS'], ['ledger', 'LEDGER']]);
    let h = '<div class="bk-sum"><div><span>CASH</span><b>' + fmt$(STATE.money) + '</b></div><div><span>IN BANKS</span><b>' + fmt$(assets()) + '</b></div><div><span>OWED ON CARDS</span><b class="' + (owed() > 0 ? 'r' : '') + '">' + fmt$(owed()) + '</b></div>' + (loansOwed() > 0 ? '<div><span>LOANS</span><b class="r">' + fmt$(loansOwed()) + '</b></div>' : '') + '<div class="bk-net"><span>NET WORTH</span><b>' + fmt$(net()) + '</b></div></div><div class="co-sub bk-clock">game day ' + day() + ' · month ' + (Math.floor(day() / MONTH) + 1) + '</div>' +
      '<div class="co-tabs">' + tabs.map(t => '<button class="co-tab' + (panelTab === t[0] ? ' on' : '') + '" data-bk="tab" data-v="' + t[0] + '">' + t[1] + '</button>').join('') + '</div>';
    const sec = sections.find(s => s.id === panelTab);
    h += sec ? sec.html() : ({ accounts: accountsHTML, transfer: transferHTML, cards: cardsHTML, statements: statementsHTML, ledger: ledgerHTML }[panelTab] || accountsHTML)();
    if (el.dataset.h === h) return;
    const ae = document.activeElement; if (ae && el.contains(ae) && ae.matches('input,select')) return;   // never rebuild under the cursor
    el.dataset.h = h; el.innerHTML = h; wire(el);
    if (sec && sec.wire) sec.wire(el);
  }
  function accountsHTML() {
    const A = accts(), have = new Set(A.map(a => a.cityKey));
    const free = CITIES.filter(c => !have.has(c.key)).sort((a, b) => a.name.localeCompare(b.name));
    const here = STATE.lastCityKey && !have.has(STATE.lastCityKey) ? STATE.lastCityKey : (free[0] || {}).key;
    return '<div class="co-card"><div class="msec">Your accounts</div>' + (A.length ? A.map(a =>
      '<div class="co-item"><div><b>' + esc(a.name) + '</b><span class="co-sub">opened ' + dstr(a.opened) + '</span><span class="bk-tags">' + (B().debit[a.id] ? '<i class="bk-tag">DEBIT</i>' : '') + (B().cc[a.id] ? '<i class="bk-tag gold">CREDIT</i>' : '') + '</span></div><div class="bk-bal">' + fmt$(a.bal) + '</div></div>' +
      '<div class="co-row"><input id="bk-amt-' + a.id + '" type="number" min="1" step="1" placeholder="amount"><button class="tpbtn" data-bk="dep" data-v="' + a.id + '">DEPOSIT</button><button class="tpbtn" data-bk="wd" data-v="' + a.id + '">WITHDRAW</button><button class="tpbtn" data-bk="close" data-v="' + a.id + '">CLOSE</button></div>').join('') : '<p class="co-sub">No accounts yet. Open one at any city\'s bank below.</p>') + '</div>' +
      '<div class="co-card"><div class="msec">Open an account</div><div class="co-row"><select id="bk-city">' + free.map(c => '<option value="' + c.key + '"' + (c.key === here ? ' selected' : '') + '>' + esc(bankName(c.key)) + '</option>').join('') + '</select><button class="tpbtn" data-bk="open">OPEN</button></div><p class="co-sub">One bank per city, one account per bank. Free to open. Balances earn 0.30% a month and count toward your net worth.</p></div>';
  }
  function transferHTML() {
    const co = companyOn(), A = accts();
    if (!A.length) return '<div class="co-card"><p>Open an account first.</p></div>';
    const from = accOpts('', co ? '<option value="company">Company bank</option>' : ''), to = accOpts(A[1] ? A[1].id : '', co ? '<option value="company">Company bank</option>' : '');
    return '<div class="co-card"><div class="msec">Transfer</div><div class="co-row"><select id="bk-from">' + from + '</select><span class="co-sub">→</span><select id="bk-to">' + to + '</select></div><div class="co-row"><input id="bk-xamt" type="number" min="1" step="1" placeholder="amount"><button class="tpbtn" data-bk="xfer">TRANSFER</button></div>' +
      '<p class="co-sub">Between your own accounts at different city banks — ' + fmt$(XFER_FEE) + ' flat fee. ' + (co ? 'The company bank is available because your company is enabled; moving money out of it needs the withdraw permission.' : '') + ' Transfers to other players are not possible.</p></div>';
  }
  // v2.82: a card face (cosmetic — the last four digits are a hash of the account id, not data)
  function cardFace(a, kind, on, foot) {
    let hh = 7; for (const ch of a.cityKey) hh = (hh * 31 + ch.charCodeAt(0)) % 360;
    let n = 17; for (const ch of a.id + kind) n = (n * 131 + ch.charCodeAt(0)) % 10000;
    return '<div class="bk-card ' + kind + (on ? ' on' : '') + '" style="--h:' + hh + '"><div class="bk-ctop"><span class="bk-ctype">' + (kind === 'debit' ? 'DEBIT' : 'CREDIT') + '</span>' + (on ? '<span class="bk-cuse">PAYING WITH THIS</span>' : '') + '</div>' +
      '<div class="bk-chip"></div><div class="bk-cnum">•••• •••• •••• ' + String(n).padStart(4, '0') + '</div>' +
      '<div class="bk-cfoot"><span>' + esc(STATE.name || 'Tycoon') + '</span><span>' + esc(foot) + '</span></div><div class="bk-cbank">' + esc(bankName(a.cityKey)) + '</div></div>';
  }
  function cardsHTML() {
    const A = accts(), b = B();
    const meth = [['cash', 'Cash']].concat(A.filter(a => b.debit[a.id]).map(a => ['debit:' + a.id, 'Debit · ' + a.name])).concat(Object.keys(b.cc).map(id => ['credit:' + id, 'Credit · ' + bankName(id.slice(2))]));
    let h = '<div class="co-card"><div class="msec">Pay with</div><div class="co-row"><select id="bk-method" data-bk="method">' + meth.map(m => '<option value="' + m[0] + '"' + (m[0] === b.method ? ' selected' : '') + '>' + esc(m[1]) + '</option>').join('') + '</select></div><p class="co-sub">Plots, carts, builds, machines, generators and the other purchases the game makes through its checkout use this card. Wages and utility bills still come out of cash. A card that cannot cover a purchase falls back to cash.</p></div>';
    h += A.length ? A.map(a => {
      const c = b.cc[a.id];
      const dOn = b.method === 'debit:' + a.id, cOn = b.method === 'credit:' + a.id;
      const use = c ? Math.min(100, Math.round(c.owed / Math.max(1, c.limit) * 100)) : 0;
      return '<div class="co-card"><div class="msec">' + esc(a.name) + '</div><div class="bk-cards">' +
        (b.debit[a.id] ? cardFace(a, 'debit', dOn, 'spends from ' + fmt$(a.bal)) : '<div class="bk-card empty"><span>DEBIT CARD</span><button class="tpbtn" data-bk="debit" data-v="' + a.id + '">GET DEBIT CARD</button></div>') +
        (c ? cardFace(a, 'credit', cOn, fmt$(Math.max(0, c.limit - c.owed)) + ' available') : '<div class="bk-card empty"><span>CREDIT CARD</span><button class="tpbtn" data-bk="credit" data-v="' + a.id + '">APPLY · ' + fmt$(limitFor(a.id)) + ' LIMIT</button></div>') + '</div>' +
        (c ? '<div class="bk-use"><div class="bk-bar"><i class="u' + (use < 40 ? 0 : use < 75 ? 1 : 2) + '" style="width:' + use + '%"></i></div><div class="bk-uleg"><span>' + use + '% of limit used</span><span>limit ' + fmt$(c.limit) + '</span></div></div>' +
          '<div class="kv"><span class="k">OWED</span><span class="v ' + (c.owed > 0 ? 'r' : 'g') + '">' + fmt$(c.owed) + '</span></div><div class="kv"><span class="k">AVAILABLE</span><span class="v">' + fmt$(Math.max(0, c.limit - c.owed)) + '</span></div>' +
          (c.stmt && c.stmt.minDue > 0 && !c.stmt.settled ? '<div class="kv"><span class="k">MINIMUM DUE</span><span class="v ' + (day() > c.stmt.dueDay ? 'r' : 'amber') + '">' + fmt$(Math.max(0, c.stmt.minDue - c.stmt.paidSince)) + ' by day ' + c.stmt.dueDay + (day() > c.stmt.dueDay ? ' · OVERDUE' : '') + '</span></div>' : '') +
          '<div class="co-row"><input id="bk-cc-' + a.id + '" type="number" min="1" step="1" placeholder="payment"><button class="tpbtn" data-bk="ccpay" data-v="' + a.id + '">PAY FROM ACCOUNT</button><button class="tpbtn" data-bk="ccpaycash" data-v="' + a.id + '">PAY IN CASH</button></div>' : '') + '</div>';
    }).join('') : '<div class="co-card"><p>Open an account to get cards.</p></div>';
    return h + '<p class="co-sub">Credit cards: statement each month (minimum 5% or $25, due 10 days later). Miss the minimum: $25 late fee. Not paid in full: 2% a month on the rest.</p>';
  }
  function statementsHTML() {
    const S = B().stmts.slice().reverse();
    const st = (k, v, cls) => '<div><span>' + k + '</span><b' + (cls ? ' class="' + cls + '"' : '') + '>' + v + '</b></div>';
    return '<div class="co-card"><div class="msec">Monthly statements</div>' + (S.length ? S.map(s => s.kind === 'account'
      ? '<div class="bk-stm"><div class="bk-sh"><div><b>' + esc(s.name) + '</b><span class="co-sub">month ' + s.month + ' · account</span></div><b class="bk-close">' + fmt$(s.close) + '</b></div><div class="bk-stats">' + st('OPENED', fmt$(s.open)) + st('IN', fmt$(s.in), 'g') + st('OUT', fmt$(s.out), 'r') + st('INTEREST', fmt$(s.int), 'g') + st('FEES', fmt$(s.fee), s.fee > 0 ? 'r' : '') + '</div></div>'
      : '<div class="bk-stm card"><div class="bk-sh"><div><b>' + esc(s.name) + '</b><span class="co-sub">month ' + s.month + ' · credit card</span></div><b class="bk-close r">' + fmt$(s.close) + ' owed</b></div><div class="bk-stats">' + st('PURCHASES', fmt$(s.purchases)) + st('PAYMENTS', fmt$(s.payments), 'g') + st('MINIMUM', fmt$(s.minDue) + ' · day ' + s.dueDay, 'amber') + st('LIMIT', fmt$(s.limit)) + '</div></div>').join('') : '<p class="co-sub">The first statements arrive when game day ' + MONTH + ' closes (about 45 minutes of play).</p>') + '</div>';
  }
  function ledgerHTML() {
    const L = B().ledger.slice(-60).reverse();
    return '<div class="co-card"><div class="msec">Ledger — every movement</div>' + (L.length ? L.map(e => '<div class="bk-led"><span class="bk-day">D' + e.day + '</span><div><b>' + esc(e.type.replace(/_/g, ' ')) + (e.memo ? '<span class="co-sub inl"> · ' + esc(e.memo) + '</span>' : '') + '</b><span class="co-sub">' + esc(lineName(e.line)) + '</span></div><b class="' + ((e.line.slice(0, 3) === 'cc_' ? e.amt > 0 : e.amt < 0) ? 'r' : 'g') + '">' + (e.amt < 0 ? '-' : '+') + fmt$(Math.abs(e.amt)) + '</b></div>').join('') : '<p class="co-sub">No movements yet.</p>') + '</div>';
  }
  const lineName = l => l.slice(0, 3) === 'cc_' ? bankName(l.slice(5)) + ' card' : bankName(l.slice(2));
  function wire(root) {
    root.querySelectorAll('[data-bk]').forEach(el => {
      const k = el.dataset.bk, v = el.dataset.v;
      if (k === 'method') { el.onchange = () => setMethod(el.value); return; }
      el.onclick = async () => {
        let r;
        if (k === 'tab') { panelTab = v; render(); return; }
        else if (k === 'open') r = open(val('bk-city'));
        else if (k === 'close') r = close(v);
        else if (k === 'dep') r = deposit(v, num('bk-amt-' + v));
        else if (k === 'wd') r = withdraw(v, num('bk-amt-' + v));
        else if (k === 'xfer') r = await transfer(val('bk-from'), val('bk-to'), num('bk-xamt'));
        else if (k === 'debit') r = issueDebit(v);
        else if (k === 'credit') r = applyCredit(v);
        else if (k === 'ccpay') r = payCard(v, num('bk-cc-' + v), v);
        else if (k === 'ccpaycash') r = payCard(v, num('bk-cc-' + v), 'cash');
        if (r && !r.ok) toast('<b>' + esc(r.why || 'That did not work.') + '</b>', 'warn');
        render();
      };
    });
  }
  function installButton() {
    if (document.getElementById('b-bank')) return;
    const help = document.getElementById('b-help'), row = help ? help.parentNode : document.getElementById('bb-row'); if (!row) return;
    const b = document.createElement('button'); b.className = 'bb-btn'; b.id = 'b-bank';
    b.innerHTML = '<span class="tip">BANK</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 10 12 4l9 6"/><path d="M5 10v8M9 10v8M15 10v8M19 10v8"/><path d="M3 21h18"/></svg>';
    b.onclick = () => openPanel();
    row.insertBefore(b, help || null);
  }
  function empireInto() {
    const body = document.getElementById('mbody'); if (!body) return;
    const close = document.getElementById('em-x'), anchorEl = close ? close.parentElement : null;
    const html = '<div class="msec" style="margin-top:14px">Banks</div><div class="kv"><span class="k">' + accts().length + ' account' + (accts().length === 1 ? '' : 's') + ' · ' + fmt$(assets()) + ' deposited' + (owed() > 0 ? ' · ' + fmt$(owed()) + ' owed on cards' : '') + '</span><button class="tpbtn" id="em-bk">OPEN</button></div>';
    if (anchorEl) anchorEl.insertAdjacentHTML('beforebegin', html); else body.insertAdjacentHTML('beforeend', html);
    const b = document.getElementById('em-bk'); if (b) b.onclick = () => openPanel();
  }
  try { installButton(); } catch (e) { }

  return {
    open, close, deposit, withdraw, transfer, issueDebit, applyCredit, payCard, pay, setMethod, openPanel, empireInto, tick, installButton,
    post, cash, render, accts, acct, day, r2, addSection(s) { sections.push(s); }, onDay(f) { dayListeners.push(f); },
    net, assets, owed, loansOwed, limitFor, bankName, XFER_FEE, MONTH, DAY,
    get state() { return B(); },
    // QA: run n whole game days instantly (the same day beat the clock runs)
    qaDays(n) { for (let i = 0; i < (n || 1); i++) { try { nextDay(); } catch (e) { console.error('[banks]', e); } } return this.snap(); },
    snap() { const b = B(); return { day: day(), cash: STATE.money, assets: assets(), owed: owed(), net: net(), accts: accts().map(a => ({ id: a.id, bal: a.bal })), cc: Object.keys(b.cc).map(id => ({ id, owed: b.cc[id].owed, limit: b.cc[id].limit, stmt: b.cc[id].stmt })), method: b.method, ledger: b.ledger.length, stmts: b.stmts.length }; },
    ledger: () => B().ledger.slice(),
  };
})();
window.BANK = BANK;   // QA surface

// ADDITIVE hooks — the same wrap pattern the game already uses.
const __bankEmpire = ECO.openEmpire.bind(ECO);
ECO.openEmpire = function () { __bankEmpire(); try { BANK.empireInto(); } catch (e) { console.error('[banks]', e); } };
const __bankOrigUpdate = WORLD.update.bind(WORLD);
WORLD.update = function (dt, px, pz, camDist) {
  const req = __bankOrigUpdate(dt, px, pz, camDist);
  try { BANK.tick(dt); } catch (e) { console.error('[banks]', e); }
  return req;
};
