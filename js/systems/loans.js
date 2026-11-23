// ====================================================================
// js/systems/loans.js: LOANS (v2.82). Loans from the city banks with interest
// and a minimum-payment schedule, a credit score, warned escalation and a
// loan dashboard (a LOANS tab in the BANK panel). Local, single-player.
// ====================================================================
import { fmt$ } from '../util.js';
import { STATE } from '../state.js';
import { saveGame } from '../save.js';
import { toast } from '../ui/dom.js';
import { BANK } from '../systems/banks.js';
import { FARM } from '../systems/farmland.js';
import { OIL } from '../systems/oilrig.js';
import { GEN } from '../systems/generators.js';

// ======== section: 82_loans.js ========
// v2.82 LOANS. The ask: loans from the bank with interest and a repayment schedule (a minimum
// payment every X in-game days); warnings, a grace period and a clear escalation (late fees, then
// credit score drops, then seizure of the account balance and some properties); loan time must
// respect offline time; a credit score that approval, rates and card limits depend on; a dashboard.
//   - THE CLOCK. A loan day is a BANK game day (90 s of active play). Nothing here runs from the
//     Night Shift or any offline settle, and BANK.day only advances while the world runs, so while
//     you are away (or the tab is asleep) NO interest accrues, NO due date passes and NO penalty
//     applies. Loan time only advances during active play.
//   - THE LOAN. Borrow $500-$250,000 for 30, 60, 90, 180 or 360 days at a chosen city bank; the
//     money is paid into your account there. Interest accrues every game day at APR/360 on the
//     balance. A minimum payment (a level annuity) is due every 10 game days; pay more any time,
//     or PAY OFF. Optional AUTOPAY pays the minimum from the account on the due day if it can.
//     Fees and interest are part of the balance, so a loan always shows what you really owe.
//   - THE SCORE (300-850, you start at 700). +4 per on-time payment, +20 for paying a loan off,
//     +1 a month with nothing overdue; -40 / -30 credit drops and -60 seizures when you fall
//     behind. It sets (1) the APR: 30% - 0.04% per point above 300, floored at 6%, (2) how much
//     you may owe in total: $5,000 x ((score - 300) / 100)^2 up to $250,000 (no loans under 450),
//     (3) card limits: x1.00 at 700, up to x1.6 at 850, down to x0.4 at 300.
//   - THE ESCALATION (days counted from the first missed due day), always warned in advance:
//       due day  reminder 3 days before; if the minimum is not paid by the due day: WARNING
//       +0..+4   GRACE PERIOD, no penalty, pay the minimum and it never happened
//       +5       LATE FEE (5% of the minimum, at least $25) added to what is overdue
//       +10      CREDIT DROP of 40 points (another 30 every 10 days after)
//       +20      SEIZURE I: the overdue amount is taken from your bank accounts
//       +30      SEIZURE II: up to two properties (acres, oil rigs, generators), highest resale
//                value first, are repossessed and sold at their usual resale rate to cover it
//     Paying what is overdue at any point ends the episode: "back on track". Cash in hand is never
//     seized, only account balances; the overdue amount only grows if the next minimum is missed too.
//   - NET WORTH: BANK.net() subtracts what you owe on loans, so the Money List does too.
// Every call is try/caught; window.LOAN is the QA surface.
export const LOAN = (() => {
  const X = 10;                                   // game days between minimum payments
  const GRACE = 5, FEE_PCT = .05, FEE_MIN = 25, DROP1 = 40, DROP_N = 30, SEIZE_BANK = 20, SEIZE_PROP = 30, MAX_LOANS = 3;
  const TERMS = [30, 60, 90, 180, 360];
  const MIN_AMT = 500, MAX_AMT = 250000, MIN_SCORE = 450;
  const r2 = v => Math.round((+v || 0) * 100) / 100;
  const ceil2 = v => Math.ceil((+v || 0) * 100 - 1e-9) / 100;
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function L() {
    let l = STATE.loan;
    if (!l || typeof l !== 'object') l = STATE.loan = {};
    if (!isFinite(+l.score)) l.score = 700;
    l.score = Math.max(300, Math.min(850, Math.round(l.score)));
    if (!Array.isArray(l.loans)) l.loans = [];
    if (!Array.isArray(l.log)) l.log = [];
    if (!l.hist || typeof l.hist !== 'object') l.hist = { onTime: 0, late: 0, paidOff: 0, seized: 0 };
    if (!isFinite(+l.seq)) l.seq = 0;
    if (!isFinite(+l.lastMonth)) l.lastMonth = 0;
    return l;
  }
  const loans = () => L().loans;
  const score = () => L().score;
  const day = () => BANK.day();
  const owed = () => r2(loans().reduce((s, x) => s + x.balance, 0));
  const overdueTotal = () => r2(loans().reduce((s, x) => s + (x.overdue || 0), 0));

  // ---- what the credit score means -----------------------------------------------------
  const rating = s => s >= 800 ? 'Excellent' : s >= 740 ? 'Very good' : s >= 670 ? 'Good' : s >= 580 ? 'Fair' : 'Poor';
  const aprFor = s => Math.max(.06, Math.min(.30, .30 - (s - 300) * .0004));
  const maxTotal = s => s < MIN_SCORE ? 0 : Math.min(MAX_AMT, Math.round(5000 * Math.pow((s - 300) / 100, 2) / 100) * 100);
  const creditFactor = () => { const s = score(); return Math.max(.4, Math.min(1.6, s >= 700 ? 1 + (s - 700) / 250 : 1 - (700 - s) / 400)); };
  const room = () => Math.max(0, maxTotal(score()) - owed());
  function setScore(delta, why) {
    const l = L(), before = l.score;
    l.score = Math.max(300, Math.min(850, l.score + delta));
    if (l.score !== before) note((delta > 0 ? '+' : '') + (l.score - before) + ' credit score (' + l.score + '): ' + why);
  }
  function note(text) { const l = L(); l.log.push({ day: day(), text: String(text).slice(0, 140) }); if (l.log.length > 40) l.log.shift(); }

  // ---- the quote: a level annuity paid every X days -------------------------------------
  function quote(amount, term, s) {
    amount = r2(amount); s = s == null ? score() : s;
    const apr = aprFor(s), n = Math.round(term / X), r = Math.pow(1 + apr / 360, X) - 1;
    const minPay = ceil2(amount * r / (1 - Math.pow(1 + r, -n)));
    return { apr, n, minPay, total: r2(minPay * n), interest: r2(minPay * n - amount) };
  }
  function schedule(lo, rows) {
    const out = [], r = Math.pow(1 + lo.apr / 360, X) - 1;
    let bal = lo.balance, d = lo.nextDue;
    for (let i = 0; i < (rows || 8) && bal > .004; i++) {
      bal = r2(bal * (1 + r));
      const pay = Math.min(lo.minPay, bal);
      bal = r2(bal - pay); out.push({ day: d, pay: r2(pay), bal }); d += X;
    }
    return out;
  }

  // ---- taking a loan --------------------------------------------------------------------------
  function take(acctId, amount, term) {
    const l = L(); amount = r2(amount); term = +term;
    const a = BANK.acct(acctId);
    if (!a) return { ok: false, why: 'open an account at that city\'s bank first' };
    if (!TERMS.includes(term)) return { ok: false, why: 'pick one of the terms' };
    if (!(amount >= MIN_AMT)) return { ok: false, why: 'the smallest loan is ' + fmt$(MIN_AMT) };
    if (loans().length >= MAX_LOANS) return { ok: false, why: 'you may hold at most ' + MAX_LOANS + ' loans' };
    if (overdueTotal() > 0) return { ok: false, why: 'pay what is overdue before borrowing more' };
    if (score() < MIN_SCORE) return { ok: false, why: 'your credit score (' + score() + ') is too low to borrow — pay down debt and keep paying on time' };
    if (amount > room() + 1e-9) return { ok: false, why: 'you can owe at most ' + fmt$(maxTotal(score())) + ' in total at a score of ' + score() + ' (' + fmt$(room()) + ' left to borrow)' };
    const q = quote(amount, term);
    const lo = { id: 'L' + (++l.seq), acct: acctId, principal: amount, balance: amount, apr: q.apr, term, n: q.n, minPay: q.minPay, opened: day(), nextDue: day() + X, paid: 0, overdue: 0, missedSince: null, fees: 0, interest: 0, stage: 0, warned: {}, feeAt: 0, dropAt: 0, auto: 0 };
    loans().push(lo);
    BANK.post(acctId, 'loan_disbursement', amount, 'loan ' + lo.id + ' at ' + (q.apr * 100).toFixed(1) + '% APR');
    note('Took ' + fmt$(amount) + ' for ' + term + ' days at ' + (q.apr * 100).toFixed(1) + '% APR, minimum ' + fmt$(q.minPay) + ' every ' + X + ' days');
    toast('🏦 <b>Loan approved:</b> ' + fmt$(amount) + ' paid into ' + esc(a.name) + ' at ' + (q.apr * 100).toFixed(1) + '% APR. Minimum ' + fmt$(q.minPay) + ' every ' + X + ' game days, first due day ' + lo.nextDue + '.');
    done(); return { ok: true, id: lo.id, quote: q };
  }

  // ---- paying ---------------------------------------------------------------------------------
  const effMin = lo => Math.min(lo.minPay, lo.balance);
  function pay(id, amt, from) {
    const lo = loans().find(x => x.id === id); if (!lo) return { ok: false, why: 'no such loan' };
    amt = Math.min(r2(amt), lo.balance);
    if (!(amt > 0)) return { ok: false, why: 'enter an amount' };
    if (from === 'cash') { if (STATE.money < amt) return { ok: false, why: 'not enough cash' }; BANK.cash(-amt); }
    else { const a = BANK.acct(from); if (!a) return { ok: false, why: 'pick an account to pay from' }; if (a.bal < amt) return { ok: false, why: 'not enough in the account' }; BANK.post(from, 'loan_payment', -amt, 'loan ' + lo.id); }
    apply(lo, amt);
    done(); return { ok: true, paid: amt, left: lo.balance };
  }
  function apply(lo, amt) {
    lo.balance = r2(lo.balance - amt);
    let rest = amt;
    if (lo.overdue > 0) { const t = Math.min(rest, lo.overdue); lo.overdue = r2(lo.overdue - t); rest = r2(rest - t); }
    lo.paid = r2(lo.paid + rest);
    if (lo.balance <= .004) return payoff(lo);
    if (lo.overdue <= .004 && lo.missedSince != null) {
      lo.overdue = 0; lo.missedSince = null; lo.stage = 0; lo.warned = {}; lo.feeAt = 0; lo.dropAt = 0;
      note('Caught up on ' + lo.id); toast('✅ <b>Back on track</b> — loan ' + lo.id + ' is no longer overdue. The escalation stops here.');
    }
  }
  function payoff(lo) {
    const l = L(); l.loans = l.loans.filter(x => x !== lo); l.hist.paidOff++;
    const clean = lo.missedSince == null;
    if (clean) setScore(20, 'loan ' + lo.id + ' paid off'); else note('Loan ' + lo.id + ' paid off (late)');
    toast('🎉 <b>Loan ' + lo.id + ' paid off.</b>' + (clean ? ' Credit score +20.' : ''));
  }
  const payMin = (id, from) => {
    const lo = loans().find(x => x.id === id); if (!lo) return { ok: false, why: 'no such loan' };
    const need = lo.overdue > 0 ? lo.overdue : Math.max(0, effMin(lo) - lo.paid);
    return pay(id, need > 0 ? need : effMin(lo), from);
  };
  const payOff = (id, from) => { const lo = loans().find(x => x.id === id); return lo ? pay(id, lo.balance, from) : { ok: false, why: 'no such loan' }; };
  function setAuto(id, on) { const lo = loans().find(x => x.id === id); if (!lo) return { ok: false }; lo.auto = on ? 1 : 0; done(); return { ok: true }; }

  // ---- the daily beat (driven by BANK's game day; never by the Night Shift) ---------------------
  function onDay(d) {
    const l = L();
    for (const lo of l.loans.slice()) { try { step(lo, d); } catch (e) { console.error('[loans]', e); } }
    if (d - l.lastMonth >= 30) { l.lastMonth = d; if (!l.loans.some(x => x.overdue > 0)) setScore(1, 'a clean month'); }
    try { saveGame(); } catch (e) { }
    if (document.getElementById('bk-body')) BANK.render();
  }
  function step(lo, d) {
    // 1) interest accrues every game day
    const i = r2(lo.balance * lo.apr / 360); lo.balance = r2(lo.balance + i); lo.interest = r2(lo.interest + i);
    // 2) the reminder, then autopay, then the due day itself
    const need = Math.max(0, effMin(lo) - lo.paid);
    if (lo.overdue <= 0 && d === lo.nextDue - 3 && need > 0 && !lo.auto) toast('🏦 <b>Loan payment due in 3 days</b> — ' + fmt$(need) + ' minimum on loan ' + lo.id + ' (day ' + lo.nextDue + ').', 'warn');
    if (d >= lo.nextDue) {
      if (lo.auto && need > 0) { const a = BANK.acct(lo.acct); const amt = Math.min(need, a ? a.bal : 0); if (amt > 0) { BANK.post(lo.acct, 'loan_payment', -amt, 'autopay loan ' + lo.id); apply(lo, amt); if (!L().loans.includes(lo)) return; } }
      const short = Math.max(0, effMin(lo) - lo.paid);
      if (short <= .004) { lo.paid = r2(lo.paid - effMin(lo)); lo.nextDue += X; if (lo.overdue <= 0) { L().hist.onTime++; setScore(4, 'on-time payment on ' + lo.id); } }
      else {                                                                   // the minimum was missed
        lo.paid = 0; lo.overdue = r2(lo.overdue + short); lo.nextDue += X;
        if (lo.missedSince == null) {
          lo.missedSince = d; lo.stage = 1; lo.feeAt = d + GRACE; lo.dropAt = d + 10; L().hist.late++;
          note('Missed the ' + fmt$(short) + ' minimum on ' + lo.id);
          toast('⚠ <b>Payment missed on loan ' + lo.id + '</b> — ' + fmt$(lo.overdue) + ' overdue. You have a <b>grace period of ' + GRACE + ' days</b>: pay it and nothing else happens. Counting days overdue from the missed due day: a late fee at ' + GRACE + ', a credit score drop at 10, your bank balance seized at ' + SEIZE_BANK + ' and some properties at ' + SEIZE_PROP + ' days overdue.', 'warn');
        } else toast('⚠ <b>Another minimum missed on loan ' + lo.id + '</b> — ' + fmt$(lo.overdue) + ' now overdue.', 'warn');
      }
    }
    if (lo.missedSince != null && lo.overdue > 0) escalate(lo, d - lo.missedSince, d);
  }
  const warnOnce = (lo, key, msg) => { if (!lo.warned[key]) { lo.warned[key] = 1; toast(msg, 'warn'); } };
  function escalate(lo, late, d) {
    const fee = Math.max(FEE_MIN, r2((lo.minPay) * FEE_PCT));
    if (late < GRACE) { lo.stage = late === 0 ? 1 : 2; if (late === GRACE - 2) warnOnce(lo, 'g', '⏳ <b>Grace period ends in 2 days</b> on loan ' + lo.id + ' — pay ' + fmt$(lo.overdue) + ' now or a ' + fmt$(fee) + ' late fee is added.'); return; }
    if (d >= lo.feeAt) {                                                       // LATE FEE (day 5, then every X days while overdue)
      lo.stage = Math.max(lo.stage, 3); lo.balance = r2(lo.balance + fee); lo.overdue = r2(lo.overdue + fee); lo.fees = r2(lo.fees + fee); lo.feeAt = d + X;
      note('Late fee ' + fmt$(fee) + ' on ' + lo.id); toast('💸 <b>Late fee ' + fmt$(fee) + '</b> on loan ' + lo.id + ' — ' + fmt$(lo.overdue) + ' now overdue. Next: a credit score drop in ' + Math.max(0, lo.dropAt - d) + ' days.', 'warn');
    }
    if (late === lo.dropAt - lo.missedSince - 2) warnOnce(lo, 'c' + lo.dropAt, '📉 <b>Credit score drop in 2 days</b> on loan ' + lo.id + ' — pay ' + fmt$(lo.overdue) + ' to stop it.');
    if (d >= lo.dropAt) {                                                      // CREDIT DROP (day 10, then every 10)
      lo.stage = Math.max(lo.stage, 4); const first = lo.dropAt === lo.missedSince + 10; lo.dropAt = d + 10;
      setScore(first ? -DROP1 : -DROP_N, 'loan ' + lo.id + ' is ' + late + ' days overdue');
      toast('📉 <b>Credit score drops to ' + score() + '</b> — loan ' + lo.id + ' is ' + late + ' days overdue. At ' + SEIZE_BANK + ' days overdue (in ' + Math.max(0, SEIZE_BANK - late) + ' days) the overdue amount is seized from your bank accounts.', 'warn');
    }
    if (late === SEIZE_BANK - 3) warnOnce(lo, 'sb', '🚨 <b>Bank seizure in 3 days</b> — the lender will take ' + fmt$(lo.overdue) + ' from your bank accounts. Pay loan ' + lo.id + ' now.');
    if (late >= SEIZE_BANK && lo.overdue > 0 && (late - SEIZE_BANK) % X === 0) { lo.stage = Math.max(lo.stage, 5); seizeBank(lo); }
    if (late === SEIZE_PROP - 3) warnOnce(lo, 'sp', '🚨 <b>Property seizure in 3 days</b> — if ' + fmt$(lo.overdue) + ' is still overdue on loan ' + lo.id + ', up to two properties (acres, oil rigs, generators) are repossessed and sold.');
    if (late >= SEIZE_PROP && lo.overdue > 0 && (late - SEIZE_PROP) % X === 0) { lo.stage = 6; seizeProps(lo); }
  }
  function seizeBank(lo) {
    let need = lo.overdue, took = 0;
    const accts = BANK.accts().slice().sort((a, b) => (a.id === lo.acct ? -1 : 0) - (b.id === lo.acct ? -1 : 0) || b.bal - a.bal);
    for (const a of accts) { if (need <= .004) break; const t = Math.min(a.bal, need); if (t > .004) { BANK.post(a.id, 'loan_seizure', -t, 'seized by the lender: loan ' + lo.id); need = r2(need - t); took = r2(took + t); } }
    if (took > 0) { L().hist.seized++; setScore(-60, 'bank balance seized'); note('Seized ' + fmt$(took) + ' from your accounts'); toast('🚨 <b>' + fmt$(took) + ' seized from your bank accounts</b> for loan ' + lo.id + '.' + (lo.overdue - took > .004 ? ' ' + fmt$(lo.overdue - took) + ' is still overdue. Next: property seizure.' : ''), 'warn'); apply(lo, took); }
  }
  // what can be repossessed: only things the game can sell back cleanly
  function seizable() {
    const out = [];
    try { for (const a of (STATE.acres || [])) out.push({ kind: 'acre', id: a.id, name: a.name, val: Math.round(a.price * .6) }); } catch (e) { }
    try { for (const r of (STATE.rigs || [])) out.push({ kind: 'rig', id: r.id, name: r.name, val: Math.round((r.price || 0) * .6) }); } catch (e) { }
    try { for (const u of (STATE.gen && STATE.gen.units || [])) out.push({ kind: 'gen', id: u.id, name: GEN.TYPES[u.t].name, val: Math.round((u.price || 0) * .6) }); } catch (e) { }
    return out.sort((a, b) => b.val - a.val);
  }
  function seizeProps(lo) {
    let need = lo.overdue, n = 0; const taken = [];
    for (const p of seizable()) {
      if (need <= .004 || n >= 2) break;
      const before = STATE.money; let ok = false;
      try { ok = p.kind === 'acre' ? FARM.sellAt(p.id).ok : p.kind === 'rig' ? OIL.salvage(p.id).ok : GEN.demolish(p.id).ok; } catch (e) { ok = false; }
      if (!ok) continue;
      const got = Math.max(0, STATE.money - before), t = Math.min(got, need);
      BANK.cash(-t); need = r2(need - t); n++; taken.push(p.name + ' (' + fmt$(got) + ')'); apply(lo, t);
      if (!L().loans.includes(lo)) break;
    }
    if (n) { L().hist.seized++; setScore(-60, 'property seized'); note('Repossessed ' + taken.join(', ')); toast('🚨 <b>Property seized</b> for loan ' + lo.id + ': ' + esc(taken.join(', ')) + '. Anything above the debt stays with you.', 'warn'); }
    else if (need > .004) toast('🚨 <b>Loan ' + lo.id + ' is ' + fmt$(need) + ' overdue</b> and you have nothing left the lender can seize. The credit score keeps falling until it is paid.', 'warn');
  }
  const done = () => { try { saveGame(); } catch (e) { } try { BANK.render(); } catch (e) { } };

  // ---- the stage text: where you are and what happens next --------------------------------------
  function stageInfo(lo) {
    const d = day();
    if (lo.missedSince == null || lo.overdue <= 0) {
      const left = lo.nextDue - d;
      return { name: 'CURRENT', cls: 'g', next: 'Next minimum ' + fmt$(Math.max(0, effMin(lo) - lo.paid)) + ' due on day ' + lo.nextDue + (left >= 0 ? ' (in ' + left + ' days)' : '') + '. Miss it and a ' + GRACE + '-day grace period starts.' };
    }
    const late = d - lo.missedSince, to = (n) => Math.max(0, n - late), od = fmt$(lo.overdue) + ' overdue (day ' + late + ')';
    if (late < GRACE) return { name: 'GRACE PERIOD', cls: 'y', next: od + '. No penalty if paid within ' + to(GRACE) + ' more days; then a late fee, then a credit score drop.' };
    if (late < 10) return { name: 'LATE FEE', cls: 'r', next: od + ', incl. fees. Credit score drops at 10 days overdue (in ' + to(10) + ' days).' };
    if (late < SEIZE_BANK) return { name: 'CREDIT DROP', cls: 'r', next: od + '. Your bank balance is seized at ' + SEIZE_BANK + ' days overdue (in ' + to(SEIZE_BANK) + ' days).' };
    if (late < SEIZE_PROP) return { name: 'BANK SEIZURE', cls: 'r', next: od + '. Properties are seized at ' + SEIZE_PROP + ' days overdue (in ' + to(SEIZE_PROP) + ' days).' };
    return { name: 'PROPERTY SEIZURE', cls: 'r', next: od + '. Up to two properties are repossessed every ' + X + ' days until it is paid.' };
  }

  // ---- the dashboard (a tab in the BANK panel) --------------------------------------------------
  const val = id => { const e = document.getElementById(id); return e ? e.value : ''; };
  const num = id => +val(id);
  // v2.84: the stage as a 0-5 step for the dashboard's escalation stepper (look only)
  const STAGE_STEPS = ['CURRENT', 'GRACE PERIOD', 'LATE FEE', 'CREDIT DROP', 'BANK SEIZURE', 'PROPERTY SEIZURE'], STEP_LBL = ['ON TIME', 'GRACE', 'FEE', 'DROP', 'BANK', 'PROPERTY'];
  const stepOf = lo => Math.max(0, STAGE_STEPS.indexOf(stageInfo(lo).name));
  function dashHTML() {
    const s = score(), l = L(), A = BANK.accts();
    const accOpts = (sel) => A.map(a => '<option value="' + a.id + '"' + (a.id === sel ? ' selected' : '') + '>' + esc(a.name) + ' · ' + fmt$(a.bal) + '</option>').join('');
    let h = '<div class="co-card"><div class="msec">Credit score</div>' +
      '<div class="ln-score"><b class="' + (s >= 670 ? 'g' : s >= 580 ? 'y' : 'r') + '">' + s + '</b><span class="ln-rate ' + (s >= 670 ? 'g' : s >= 580 ? 'y' : 'r') + '">' + rating(s) + '</span><span>300–850</span></div>' +
      '<div class="ln-gauge"><i style="left:' + (Math.max(0, Math.min(1, (s - 300) / 550)) * 100).toFixed(1) + '%"></i></div><div class="ln-gl"><span style="left:0">300</span><span style="left:50.9%">580</span><span style="left:67.3%">670</span><span style="left:80%">740</span><span style="left:100%">850</span></div>' +
      '<div class="kv"><span class="k">YOUR RATE</span><span class="v">' + (aprFor(s) * 100).toFixed(1) + '% APR</span></div>' +
      '<div class="kv"><span class="k">YOU MAY OWE</span><span class="v">' + fmt$(maxTotal(s)) + ' in total · ' + fmt$(room()) + ' left</span></div>' +
      '<div class="kv"><span class="k">CARD LIMITS</span><span class="v">× ' + creditFactor().toFixed(2) + '</span></div>' +
      '<p class="co-sub">+4 per on-time payment, +20 for paying a loan off. Late payments, drops and seizures lower it. Loan time only passes while you play: nothing accrues or comes due while you are away.</p></div>';
    const worst = loans().reduce((m, lo) => stepOf(lo) > (m ? stepOf(m) : 0) ? lo : m, null);
    if (worst && stepOf(worst) > 0) { const wi = stageInfo(worst); h = '<div class="ln-banner st' + stepOf(worst) + '"><b>' + (stepOf(worst) >= 4 ? '🚨 ' : '⚠ ') + wi.name + ' · loan ' + worst.id + '</b><span>' + esc(wi.next) + '</span></div>' + h; }
    h += '<div class="co-card"><div class="msec">Your loans' + (loans().length ? ' · ' + fmt$(owed()) + ' owed' : '') + '</div>' + (loans().length ? loans().map(lo => {
      const st = stageInfo(lo), sch = schedule(lo, 6), bank = BANK.acct(lo.acct), si = stepOf(lo);
      const paidPct = Math.max(0, Math.min(100, Math.round((1 - lo.balance / Math.max(1, lo.principal)) * 100)));
      return '<div class="ln-loan st' + si + '"><div class="co-item"><div><b>Loan ' + lo.id + '</b><span class="co-sub">' + esc(bank ? bank.name : 'bank') + ' · ' + (lo.apr * 100).toFixed(1) + '% APR · ' + lo.term + ' days</span></div><div class="bk-bal ln-bal">' + fmt$(lo.balance) + '</div></div>' +
        '<div class="ln-prog"><div class="bk-bar"><i style="width:' + paidPct + '%"></i></div><div class="bk-uleg"><span>' + paidPct + '% repaid</span><span>borrowed ' + fmt$(lo.principal) + '</span></div></div>' +
        '<div class="ln-steps">' + STEP_LBL.map((t, i) => '<span title="' + STAGE_STEPS[i] + '" class="s s' + i + (i < si ? ' done' : '') + (i === si ? ' on' : '') + '">' + t + '</span>').join('') + '</div>' +
        '<div class="ln-stage ' + st.cls + ' st' + si + '"><b>' + st.name + '</b> ' + esc(st.next) + '</div>' +
        '<div class="bk-stats"><div><span>MINIMUM</span><b>' + fmt$(effMin(lo)) + '</b></div><div><span>NEXT DUE</span><b class="' + (si > 0 ? 'r' : '') + '">day ' + lo.nextDue + '</b></div><div><span>INTEREST SO FAR</span><b>' + fmt$(lo.interest) + '</b></div>' + (lo.overdue > 0 ? '<div><span>OVERDUE</span><b class="r">' + fmt$(lo.overdue) + '</b></div>' : '') + (lo.fees ? '<div><span>FEES</span><b class="r">' + fmt$(lo.fees) + '</b></div>' : '') + '</div>' +
        '<details class="ln-sched"><summary>Repayment schedule</summary>' + sch.map(r => '<div class="ln-sr"><span class="bk-day">D' + r.day + '</span><span>pay <b>' + fmt$(r.pay) + '</b></span><b>' + fmt$(r.bal) + ' left</b></div>').join('') + '</details>' +
        '<div class="co-row"><select id="ln-from-' + lo.id + '"><option value="cash">Cash · ' + fmt$(STATE.money) + '</option>' + accOpts(lo.acct) + '</select><input id="ln-amt-' + lo.id + '" type="number" min="1" step="1" placeholder="amount"></div>' +
        '<div class="co-row"><button class="tpbtn" data-ln="pay" data-v="' + lo.id + '">PAY</button><button class="tpbtn" data-ln="min" data-v="' + lo.id + '">PAY MINIMUM</button><button class="tpbtn" data-ln="off" data-v="' + lo.id + '">PAY OFF ' + fmt$(lo.balance) + '</button><button class="tpbtn" data-ln="auto" data-v="' + lo.id + '">AUTOPAY: ' + (lo.auto ? 'ON' : 'OFF') + '</button></div></div>';
    }).join('') : '<p class="co-sub">No loans. Borrow below — the money is paid into your account at the bank you pick.</p>') + '</div>';
    if (A.length) {
      const qa = Math.min(5000, Math.max(MIN_AMT, room())), q = quote(qa, 90);
      h += '<div class="co-card"><div class="msec">Borrow</div><div class="co-row"><select id="ln-acct">' + accOpts('') + '</select><input id="ln-new" type="number" min="' + MIN_AMT + '" step="100" placeholder="amount" value="' + (room() >= MIN_AMT ? Math.min(5000, room()) : '') + '"><select id="ln-term">' + TERMS.map(t => '<option value="' + t + '"' + (t === 90 ? ' selected' : '') + '>' + t + ' days</option>').join('') + '</select><button class="tpbtn" data-ln="take">TAKE LOAN</button></div>' +
        '<p class="co-sub" id="ln-q">At your score: ' + (aprFor(s) * 100).toFixed(1) + '% APR. Example: ' + fmt$(qa) + ' over 90 days → ' + fmt$(q.minPay) + ' every ' + X + ' days, ' + fmt$(q.interest) + ' interest.</p></div>';
    } else h += '<div class="co-card"><p>Open an account at a city bank (ACCOUNTS tab) to borrow.</p></div>';
    if (l.log.length) h += '<div class="co-card"><div class="msec">History</div>' + l.log.slice(-8).reverse().map(e => '<div class="co-item"><span class="co-sub">day ' + e.day + '</span><span style="flex:1;margin-left:10px">' + esc(e.text) + '</span></div>').join('') + '</div>';
    return h;
  }
  function wire(root) {
    root.querySelectorAll('[data-ln]').forEach(el => {
      const k = el.dataset.ln, v = el.dataset.v;
      el.onclick = () => {
        let r;
        if (k === 'take') r = take(val('ln-acct'), num('ln-new'), num('ln-term'));
        else if (k === 'pay') r = pay(v, num('ln-amt-' + v), val('ln-from-' + v));
        else if (k === 'min') r = payMin(v, val('ln-from-' + v));
        else if (k === 'off') r = payOff(v, val('ln-from-' + v));
        else if (k === 'auto') r = setAuto(v, !(loans().find(x => x.id === v) || {}).auto);
        if (r && !r.ok) toast('<b>' + esc(r.why || 'That did not work.') + '</b>', 'warn');
        BANK.render();
      };
    });
  }
  BANK.addSection({ id: 'loans', label: 'LOANS', html: dashHTML, wire });
  BANK.onDay(onDay);

  return {
    take, pay, payMin, payOff, setAuto, quote, schedule, stageInfo, seizable,
    score, rating, aprFor, maxTotal, creditFactor, owed, overdueTotal, room,
    X, GRACE, TERMS, MAX_LOANS,
    list: () => loans().slice(),
    get state() { return L(); },
    // QA: run n game days (the loan beat rides BANK's day, exactly like play); set the score
    qaDays(n) { return BANK.qaDays(n); },
    qaScore(v) { L().score = Math.max(300, Math.min(850, v | 0)); return score(); },
  };
})();
window.LOAN = LOAN;   // QA surface
