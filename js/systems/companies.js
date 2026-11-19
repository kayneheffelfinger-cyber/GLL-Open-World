// ====================================================================
// js/systems/companies.js: real-player companies (client side only).
// Hidden until the hosted site's /api answers GET api/companies/status with
// { enabled: true, protocol: 1 }. On GitHub Pages, local files and servers
// without the endpoint this module does nothing visible: no button, no
// panel, no polling. The server owns membership, roles, the bank ledger and
// wallets; this file only displays them and submits requests.
// The wire protocol is in docs/companies-api.md.
// ====================================================================
import { STATE } from '../state.js';
import { saveGame } from '../save.js';
import { earn, spendCash as spend } from '../systems/economy.js';   // company/wallet money always leaves CASH, never a bank card
import { closeModal, openModal, toast } from '../ui/dom.js';
import { fmt$ } from '../util.js';
import { ECO } from '../systems/eco.js';
import { RIVALS } from '../systems/rivals.js';
import { isHosted, accountName, flushNow } from '../sync.js';

export const CO = (() => {
  const PROTO = 1;                       // the protocol version this client speaks
  const POLL_MS = 10000, INCOME_MS = 20000, MAX_BACKOFF = 300000;
  const H = { 'content-type': 'application/json', 'x-ow': '1' };
  const PERMS = [['invite', 'Invite players'], ['remove_members', 'Remove members & businesses'], ['manage_roles', 'Change roles'], ['view_ledger', 'See the ledger'], ['withdraw', 'Withdraw from the bank'], ['manage_stock', 'Issue shares & pay dividends']];

  const S = {                            // everything the server told us last (display only)
    enabled: false, checked: false, rules: {}, player: null, company: null, invites: [], wallet: null,
    cursor: 0, quotes: null, tab: 'overview', ledger: null, busy: false,
  };
  let pollT = 0, fails = 0, stopped = false, incomeT = 0, flushing = false;
  const sections = [];                   // other modules (company stocks) add company-panel tabs here
  const listeners = [];
  const payoutListeners = [];

  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const r2 = v => Math.round((+v || 0) * 100) / 100;
  const uid = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

  // ---- the local pack field: held income + payout bookkeeping --------------
  function co() {
    let c = STATE.co;
    if (!c || typeof c !== 'object') c = STATE.co = {};
    for (const k of ['pend', 'seq', 'assigned']) if (!c[k] || typeof c[k] !== 'object') c[k] = {};
    if (!Array.isArray(c.claimed)) c.claimed = [];
    return c;
  }

  // ---- the one HTTP helper ----------------------------------------------------
  async function call(method, path, body) {
    let r;
    try { r = await fetch('api/companies/' + path, { method, credentials: 'same-origin', headers: H, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch (e) { return { ok: false, status: 0, code: 'network', message: 'Could not reach the server.' }; }
    let j = null;
    if ((r.headers.get('content-type') || '').includes('json')) { try { j = await r.json(); } catch (e) { j = null; } }
    if (r.ok && j && j.ok !== false) return { ok: true, status: r.status, data: j };
    const e = (j && j.error) || {};
    return { ok: false, status: r.status, code: e.code || ('http_' + r.status), message: e.message || '', data: j };
  }
  const say = r => toast('<b>' + esc(r.message || r.code || 'Request failed') + '</b>', 'warn');

  // ---- boot: the gate -------------------------------------------------------------
  async function init() {
    if (S.checked) return S.enabled;
    S.checked = true;
    if (!isHosted()) return false;                           // sync.js found no working /api: stay invisible
    const r = await call('GET', 'status');
    const d = r.ok ? r.data : null;
    if (!d || d.enabled !== true || !(+d.protocol >= PROTO) || (+d.minProtocol || 1) > PROTO) return false;
    S.enabled = true; S.rules = d.rules || {};
    installButton();
    await refresh(true);
    schedulePoll(); scheduleIncome();
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.enabled && !stopped) { clearTimeout(pollT); pollT = 0; poll(); } });
    return true;
  }

  // ---- polling: one request, backing off, never a tight loop -----------------------
  const schedulePoll = () => { if (!pollT && !stopped) pollT = setTimeout(poll, Math.min(MAX_BACKOFF, POLL_MS * Math.pow(2, fails))); };
  async function poll() { pollT = 0; if (stopped || document.hidden) { schedulePoll(); return; } await refresh(false); schedulePoll(); }
  async function refresh(full) {
    const r = await call('GET', 'updates?since=' + (full ? 0 : S.cursor));
    if (!r.ok) {
      if (r.status === 401 || r.status === 403 || r.status === 404 || r.status === 501 || r.code === 'companies_disabled') { shutdown(); return false; }
      fails = Math.min(fails + 1, 5); return false;
    }
    fails = 0;
    const d = r.data;
    if (d.protocol && +d.protocol < PROTO) { shutdown(); return false; }
    S.cursor = +d.cursor || S.cursor;
    if (d.changed === false && !full) return true;
    if (d.me) apply(d.me);
    if (d.quotes) S.quotes = d.quotes;
    changed();
    return true;
  }
  function shutdown() {                                      // the server stopped supporting us: vanish quietly
    stopped = true; S.enabled = false; clearTimeout(pollT); clearTimeout(incomeT);
    const b = document.getElementById('b-company'); if (b) b.remove();
    const m = document.getElementById('co-modal-mark'); if (m) closeModal();
  }
  function apply(me) {
    S.ledger = null;
    S.player = me.player || S.player; S.company = me.company || null; S.invites = me.invites || []; S.wallet = me.wallet || null;
    const c = co(); c.assigned = {};
    if (S.company) for (const b of (S.company.businesses || [])) if (S.player && b.ownerId === S.player.id) c.assigned[b.bizId] = S.company.id;
    claimPayouts();
  }
  const onChange = fn => listeners.push(fn);
  function changed() {
    for (const f of listeners) { try { f(S); } catch (e) { console.error('[companies]', e); } }
    const mb = document.getElementById('mbody');
    const ae = document.activeElement, typing = !!(ae && mb && mb.contains(ae) && ae.matches('input,select,textarea'));
    if (mb && document.getElementById('co-modal-mark') && !typing) render();
  }

  // ---- payouts: money the server owes this player's local cash ------------------------
  // The server debits first; we credit the local balance exactly once per payout id (remembered
  // in the save), then acknowledge. A crash between the two is safe: the id is already claimed.
  async function claimPayouts() {
    const list = (S.wallet && S.wallet.payouts) || [];
    if (!list.length || flushing) return;
    flushing = true;
    try {
      const c = co();
      for (const p of list) {
        if (!(+p.amount > 0)) continue;
        if (c.claimed.indexOf(p.id) < 0) {
          earn(r2(p.amount), false);
          c.claimed.push(p.id); if (c.claimed.length > 200) c.claimed.shift();
          saveGame();
          toast('💼 <b>' + fmt$(p.amount) + '</b> paid into your cash' + (p.memo ? ' — ' + esc(p.memo) : '') + '.');
          for (const f of payoutListeners) { try { f(p); } catch (e) { console.error('[companies]', e); } }   // v2.80: the bank module routes a company-bank transfer on into the chosen account
        }
        const a = await call('POST', 'wallet/payouts/' + encodeURIComponent(p.id) + '/ack', {});
        if (a.ok && S.wallet) S.wallet.payouts = (S.wallet.payouts || []).filter(x => x.id !== p.id);
      }
    } finally { flushing = false; }
  }

  // ---- income: businesses under a company pay the shared bank -----------------------------
  // eco.js asks divert() before crediting a sale. For a business assigned to your company the
  // money is held here and reported in batches; the server validates and caps each report, and any
  // part it rejects is credited back to you, so nothing is ever lost.
  function divert(plot, amount) {
    if (!S.enabled || !plot || !(amount > 0)) return false;
    const c = co();
    if (!c.assigned[plot.id]) return false;
    c.pend[plot.id] = r2((+c.pend[plot.id] || 0) + amount);
    return true;
  }
  const scheduleIncome = () => { if (!incomeT && !stopped) incomeT = setTimeout(async () => { incomeT = 0; await sendIncome(); scheduleIncome(); }, INCOME_MS); };
  async function sendIncome() {
    if (!S.enabled || !S.company || flushing) return;
    const c = co();
    if (!c.inflight) {                                       // freeze a batch; retried verbatim until answered (idempotent by batchId)
      const reports = [];
      for (const id of Object.keys(c.pend)) {
        const amt = r2(c.pend[id]);
        if (amt >= .01 && c.assigned[id]) { c.seq[id] = (c.seq[id] | 0) + 1; reports.push({ bizId: id, seq: c.seq[id], amount: amt, periodMs: INCOME_MS }); delete c.pend[id]; }
        else if (!(amt >= .01)) delete c.pend[id];
      }
      if (!reports.length) return;
      c.inflight = { batchId: uid(), companyId: S.company.id, reports };
      saveGame();
    }
    const f = c.inflight;
    const r = await call('POST', encodeURIComponent(f.companyId) + '/bank/income', { batchId: f.batchId, reports: f.reports });
    if (!r.ok) {
      if (r.status === 0 || r.status >= 500) return;         // try again next beat with the same batch
      for (const x of f.reports) earn(x.amount, false);      // the server refused the whole batch: it is yours again
      delete c.inflight; saveGame(); return;
    }
    const bad = (r.data.rejected || []);
    let back = 0; for (const x of bad) back += +x.amount || 0;
    if (back > 0) { earn(r2(back), false); toast('💼 ' + fmt$(back) + ' of company income was over the server\'s limit and stayed in your cash.', 'warn'); }
    delete c.inflight; saveGame();
    if (S.company && r.data.balance != null && S.company.bank) { S.company.bank.balance = r.data.balance; }
  }

  // ---- actions (all server-authoritative; we only submit and then re-read) -----------------
  async function act(method, path, body, okMsg) {
    if (S.busy) return { ok: false };
    S.busy = true;
    const r = await call(method, path, body);
    S.busy = false;
    if (r.ok) { if (okMsg) toast(okMsg); await refresh(true); } else say(r);
    return r;
  }
  const playerWorth = () => { try { return RIVALS.playerWorth(); } catch (e) { return STATE.money; } };
  async function found(name, ticker) {
    try { await flushNow(); } catch (e) { }                  // the server reads the synced save for the net-worth check
    const r = await act('POST', '', { name, ticker, requestId: uid(), clientNetWorth: Math.round(playerWorth()) }, null);
    if (r.ok) toast('🏢 <b>' + esc(r.data.company.name) + '</b> is founded' + (r.data.fee ? ' — ' + fmt$(r.data.fee) + ' fee paid from your exchange wallet' : '') + '.');
    return r;
  }
  const invite = (name, roleId) => act('POST', S.company.id + '/invites', { playerName: name, roleId }, '✉ Invite sent to <b>' + esc(name) + '</b>.');
  const revokeInvite = id => act('DELETE', S.company.id + '/invites/' + encodeURIComponent(id), undefined, 'Invite withdrawn.');
  const accept = id => act('POST', 'invites/' + encodeURIComponent(id) + '/accept', {}, '🤝 You joined the company.');
  const decline = id => act('POST', 'invites/' + encodeURIComponent(id) + '/decline', {}, 'Invite declined.');
  const setRole = (pid, roleId) => act('PUT', S.company.id + '/members/' + encodeURIComponent(pid), { roleId }, 'Role updated.');
  const removeMember = pid => act('DELETE', S.company.id + '/members/' + encodeURIComponent(pid), undefined, 'Member removed.');
  const leave = () => act('POST', S.company.id + '/leave', {}, 'You left the company.');
  const setRolePerms = (roleId, permissions, withdrawLimit) => act('PUT', S.company.id + '/roles/' + encodeURIComponent(roleId), { permissions, withdrawLimit }, 'Role saved.');
  function assignBiz(plot) { return act('POST', S.company.id + '/businesses', { bizId: plot.id, name: bizLabel(plot), city: plot.cityName || plot.cityKey || '', kind: 'cart' }, '🏪 Business moved under the company — its income now goes to the shared bank.'); }
  async function unassignBiz(bizId) {
    const r = await act('DELETE', S.company.id + '/businesses/' + encodeURIComponent(bizId), undefined, 'Business taken back — its income is yours again.');
    if (r.ok) { const c = co(); const held = +c.pend[bizId] || 0; delete c.pend[bizId]; if (held > 0) earn(r2(held), false); saveGame(); }
    return r;
  }
  async function bankWithdraw(amount, memo) {
    const r = await act('POST', S.company.id + '/bank/withdrawals', { amount: r2(amount), memo: memo || '', requestId: uid() }, null);
    if (r.ok) toast('🏦 ' + fmt$(amount) + ' moved from the company bank to your exchange wallet.');
    return r;
  }
  // wallet: the only place local cash and server balances meet
  async function walletDeposit(amount) {
    amount = r2(amount);
    if (!(amount > 0)) return { ok: false };
    if (STATE.money < amount) { toast('<b>Not enough cash.</b>', 'warn'); return { ok: false }; }
    try { await flushNow(); } catch (e) { }
    const d = await call('POST', 'wallet/deposits', { amount, requestId: uid(), cashBefore: Math.round(STATE.money) });
    if (!d.ok) { say(d); return d; }
    if (!spend(amount)) return { ok: false };
    saveGame();
    let synced = false; try { synced = await flushNow(); } catch (e) { }
    const c = await call('POST', 'wallet/deposits/' + encodeURIComponent(d.data.deposit.id) + '/confirm', { synced });
    if (!c.ok) { say(c); earn(amount, false); saveGame(); return c; }   // not confirmed: the cash comes back
    toast('💼 ' + fmt$(amount) + ' added to your exchange wallet.'); await refresh(true); return c;
  }
  async function walletWithdraw(amount) {
    const r = await call('POST', 'wallet/withdrawals', { amount: r2(amount), requestId: uid() });
    if (!r.ok) { say(r); return r; }
    await refresh(true); return r;                           // the payout arrives with the refresh and is credited once
  }
  // v2.80 BANKS: move money between your own cash and the company bank (cash -> wallet -> bank, and back)
  async function depositToCompanyBank(amount) {
    if (!S.enabled || !S.company) return { ok: false, code: 'no_company' };
    amount = r2(amount);
    const w = await walletDeposit(amount); if (!w.ok) return w;
    const r = await call('POST', S.company.id + '/bank/deposits', { amount, requestId: uid() });
    if (!r.ok) { say(r); toast('The money is safe in your exchange wallet — move it again from the COMPANY window.', 'warn'); return r; }
    await refresh(true); return r;
  }
  async function companyBankToCash(amount, memo) {
    if (!S.enabled || !S.company) return { ok: false, code: 'no_company' };
    const r = await bankWithdraw(amount, memo || 'transfer to a bank account'); if (!r.ok) return r;
    return walletWithdraw(amount);
  }
  async function loadLedger(before) {
    const r = await call('GET', S.company.id + '/bank/ledger?limit=25' + (before ? '&before=' + encodeURIComponent(before) : ''));
    if (r.ok) { S.ledger = before && S.ledger ? { entries: S.ledger.entries.concat(r.data.entries || []), next: r.data.next } : { entries: r.data.entries || [], next: r.data.next }; render(); } else say(r);
  }

  // ---- helpers over server state -------------------------------------------------------------
  const can = p => !!(S.company && S.company.myPermissions && S.company.myPermissions.indexOf(p) >= 0);
  const isOwner = () => !!(S.company && S.player && S.company.ownerId === S.player.id);
  const myCarts = () => (STATE.plots || []).filter(p => p && p.cart);
  const bizLabel = p => { const cui = (ECO.CUISINES || []).find(c => c && p.cart && c.id === p.cart.cuisine); return (cui ? cui.emoji + ' ' + cui.name : 'Food') + ' cart · ' + (p.cityName || p.cityKey || 'the road'); };
  const num = id => { const el = document.getElementById(id); return el ? +el.value : NaN; };
  const val = id => { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
  const roleName = id => { const r = S.company && (S.company.roles || []).find(x => x.id === id); return r ? r.name : id; };

  // ---- the UI --------------------------------------------------------------------------------
  function installButton() {
    if (document.getElementById('b-company')) return;
    const help = document.getElementById('b-help'), row = help ? help.parentNode : document.getElementById('bb-row');
    if (!row) return;
    const b = document.createElement('button');
    b.className = 'bb-btn'; b.id = 'b-company';
    b.innerHTML = '<span class="tip">COMPANY</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18"/><path d="M6 21V9l6-4 6 4v12"/><path d="M10 21v-5h4v5"/></svg>';
    b.onclick = () => open();
    row.insertBefore(b, help || null);
  }
  function open(tab) {
    if (!S.enabled) return;
    if (tab) S.tab = tab;
    openModal('COMPANY', '<div id="co-modal-mark"></div><div id="co-body"></div>');
    render(); refresh(true);
  }
  function walletBar() {
    const w = S.wallet || { balance: 0 };
    return '<div class="co-wallet"><div><span class="k">EXCHANGE WALLET</span> <b>' + fmt$(w.balance || 0) + '</b><span class="co-sub"> · cash ' + fmt$(STATE.money) + '</span></div>' +
      '<div class="co-row"><input id="co-wamt" type="number" min="1" step="1" placeholder="amount"><button class="tpbtn" data-co="wdep">DEPOSIT</button><button class="tpbtn" data-co="wwd">WITHDRAW</button></div></div>';
  }
  function render() {
    const body = document.getElementById('co-body');
    if (!body) return;
    const comp = S.company;
    let html = walletBar();
    if (!comp) html += foundHTML();
    else {
      const tabs = [['overview', 'OVERVIEW'], ['members', 'MEMBERS'], ['business', 'BUSINESSES'], ['bank', 'BANK']].concat(sections.map(s => [s.id, s.label]));
      if (!tabs.some(t => t[0] === S.tab)) S.tab = 'overview';
      html += '<div class="co-head"><b>' + esc(comp.name) + '</b> <span class="co-tick">' + esc(comp.ticker || '') + '</span><span class="co-sub"> · you are ' + esc(roleName(comp.myRoleId)) + '</span></div>' +
        '<div class="co-tabs">' + tabs.map(t => '<button class="co-tab' + (S.tab === t[0] ? ' on' : '') + '" data-co="tab" data-v="' + t[0] + '">' + t[1] + '</button>').join('') + '</div>';
      const sec = sections.find(s => s.id === S.tab);
      html += sec ? sec.html(S, CO) : ({ overview: overviewHTML, members: membersHTML, business: businessHTML, bank: bankHTML }[S.tab] || overviewHTML)();
    }
    body.innerHTML = html;
    wire(body);
    const sec = sections.find(s => s.id === S.tab);
    if (sec && sec.wire) sec.wire(body, S, CO);
  }
  function foundHTML() {
    const R = S.rules || {}, worth = Math.round(playerWorth());
    const need = +R.foundingMinNetWorth || 0, fee = +R.foundingFee || 0;
    const ok = worth >= need;
    let h = '<div class="co-card"><div class="msec">Found a company</div>' +
      '<p>A company pools your businesses into one shared bank account, takes on partners, and lists its own shares on the stock exchange. Everyone in it is a real player.</p>' +
      '<div class="kv"><span class="k">NET WORTH NEEDED</span><span class="v ' + (ok ? 'g' : 'r') + '">' + fmt$(need) + ' (you: ' + fmt$(worth) + ')</span></div>' +
      '<div class="kv"><span class="k">FOUNDING FEE</span><span class="v">' + fmt$(fee) + ' from your exchange wallet</span></div>' +
      '<div class="co-row"><input id="co-name" maxlength="32" placeholder="Company name"><input id="co-tick" maxlength="5" placeholder="TICKR" style="width:84px;text-transform:uppercase"></div>' +
      '<button class="btn primary" data-co="found" style="width:100%;margin-top:10px">FOUND COMPANY</button></div>';
    if (S.invites.length) h += '<div class="co-card"><div class="msec">Invitations</div>' + S.invites.map(i =>
      '<div class="co-item"><div><b>' + esc(i.companyName) + '</b><span class="co-sub">invited by ' + esc(i.fromName) + ' as ' + esc(i.roleName || i.roleId) + '</span></div>' +
      '<div class="co-row"><button class="tpbtn" data-co="accept" data-v="' + esc(i.id) + '">JOIN</button><button class="tpbtn" data-co="decline" data-v="' + esc(i.id) + '">DECLINE</button></div></div>').join('') + '</div>';
    return h;
  }
  function overviewHTML() {
    const c = S.company, b = c.bank || {};
    return '<div class="co-card"><div class="kv"><span class="k">BANK</span><span class="v g">' + fmt$(b.balance || 0) + '</span></div>' +
      '<div class="kv"><span class="k">INCOME (24 h)</span><span class="v">' + fmt$(b.income24h || 0) + '</span></div>' +
      '<div class="kv"><span class="k">MEMBERS</span><span class="v">' + (c.members || []).length + '</span></div>' +
      '<div class="kv"><span class="k">BUSINESSES</span><span class="v">' + (c.businesses || []).length + '</span></div>' +
      (c.stock ? '<div class="kv"><span class="k">SHARE PRICE</span><span class="v">' + esc(c.stock.ticker) + ' ' + fmt$(c.stock.price) + '</span></div>' : '') +
      '</div><button class="btn" data-co="leave" style="width:100%;margin-top:10px">' + (isOwner() ? 'LEAVE (hand over ownership first)' : 'LEAVE COMPANY') + '</button>';
  }
  function membersHTML() {
    const c = S.company, roles = c.roles || [];
    let h = '<div class="co-card"><div class="msec">Members</div>' + (c.members || []).map(m => {
      const me = S.player && m.id === S.player.id;
      const sel = can('manage_roles') && !me ? '<select data-co="role" data-v="' + esc(m.id) + '">' + roles.map(r => '<option value="' + esc(r.id) + '"' + (r.id === m.roleId ? ' selected' : '') + '>' + esc(r.name) + '</option>').join('') + '</select>' : '<span class="co-sub">' + esc(roleName(m.roleId)) + '</span>';
      const rm = can('remove_members') && !me && m.roleId !== 'owner' ? '<button class="tpbtn" data-co="kick" data-v="' + esc(m.id) + '">REMOVE</button>' : '';
      return '<div class="co-item"><div><b>' + esc(m.name) + (me ? ' (you)' : '') + '</b></div><div class="co-row">' + sel + rm + '</div></div>';
    }).join('') + '</div>';
    if (can('invite')) h += '<div class="co-card"><div class="msec">Invite a player</div><div class="co-row"><input id="co-inv" maxlength="32" placeholder="GLL ID name"><select id="co-invrole">' + roles.filter(r => r.id !== 'owner').map(r => '<option value="' + esc(r.id) + '">' + esc(r.name) + '</option>').join('') + '</select><button class="tpbtn" data-co="invite">INVITE</button></div>' +
      ((c.invites || []).length ? (c.invites || []).map(i => '<div class="co-item"><span class="co-sub">pending: ' + esc(i.playerName) + ' as ' + esc(roleName(i.roleId)) + '</span><button class="tpbtn" data-co="revoke" data-v="' + esc(i.id) + '">WITHDRAW</button></div>').join('') : '') + '</div>';
    if (can('manage_roles')) h += '<div class="co-card"><div class="msec">Role permissions</div>' + roles.filter(r => r.id !== 'owner').map(r =>
      '<div class="co-role"><b>' + esc(r.name) + '</b><div class="co-perms">' + PERMS.map(p => '<label><input type="checkbox" data-rp="' + esc(r.id) + '" value="' + p[0] + '"' + ((r.permissions || []).indexOf(p[0]) >= 0 ? ' checked' : '') + '> ' + p[1] + '</label>').join('') +
      '</div><div class="co-row"><span class="co-sub">daily bank withdrawal limit</span><input type="number" min="0" step="100" data-rl="' + esc(r.id) + '" value="' + (+r.withdrawLimit || 0) + '" style="width:110px"><button class="tpbtn" data-co="saverole" data-v="' + esc(r.id) + '">SAVE</button></div></div>').join('') + '</div>';
    return h;
  }
  function businessHTML() {
    const c = S.company, mine = c.businesses || [];
    const free = myCarts().filter(p => !mine.some(b => b.bizId === p.id));
    const pend = Object.keys(co().pend).reduce((s, k) => s + (+co().pend[k] || 0), 0);
    return '<div class="co-card"><div class="msec">Businesses under ' + esc(c.name) + '</div>' + (mine.length ? mine.map(b => {
      const own = S.player && b.ownerId === S.player.id;
      const btn = own || can('remove_members') ? '<button class="tpbtn" data-co="unassign" data-v="' + esc(b.bizId) + '">TAKE BACK</button>' : '';
      return '<div class="co-item"><div><b>' + esc(b.name) + '</b><span class="co-sub">' + esc(b.ownerName) + ' · last 7 days ' + fmt$(b.income7d || 0) + '</span></div>' + btn + '</div>';
    }).join('') : '<p class="co-sub">None yet.</p>') + '</div>' +
      '<div class="co-card"><div class="msec">Move one of yours under the company</div>' + (free.length ? free.map(p => '<div class="co-item"><span>' + esc(bizLabel(p)) + '</span><button class="tpbtn" data-co="assign" data-v="' + esc(p.id) + '">MOVE IN</button></div>').join('') : '<p class="co-sub">Every business you own is already in, or you have none yet.</p>') +
      '<p class="co-sub">From then on its sales are paid into the company bank, not your cash.' + (pend > 0 ? ' Held for the next deposit: ' + fmt$(pend) + '.' : '') + '</p></div>';
  }
  function bankHTML() {
    const c = S.company, b = c.bank || {};
    let h = '<div class="co-card"><div class="kv"><span class="k">BALANCE</span><span class="v g">' + fmt$(b.balance || 0) + '</span></div>';
    if (can('withdraw')) h += '<div class="co-row"><input id="co-wd" type="number" min="1" step="1" placeholder="amount"><input id="co-wdm" maxlength="60" placeholder="memo (optional)"><button class="tpbtn" data-co="bankwd">WITHDRAW</button></div><p class="co-sub">Your limit: ' + fmt$(c.myWithdrawLimit || 0) + ' per day. Money lands in your exchange wallet.</p>';
    h += '</div>';
    if (can('view_ledger')) {
      if (S.ledger === null) { S.ledger = false; loadLedger(); }
      const L = S.ledger && S.ledger.entries || [];
      h += '<div class="co-card"><div class="msec">Ledger</div>' + (L.length ? L.map(e => '<div class="co-led"><span class="co-sub">' + new Date(e.ts).toLocaleString() + '</span><span>' + esc(e.type.replace(/_/g, ' ')) + (e.memberName ? ' · ' + esc(e.memberName) : '') + (e.memo ? ' · ' + esc(e.memo) : '') + '</span><b class="' + (e.amount < 0 ? 'r' : 'g') + '">' + (e.amount < 0 ? '-' : '+') + fmt$(Math.abs(e.amount)) + '</b></div>').join('') : '<p class="co-sub">No entries yet.</p>') +
        (S.ledger && S.ledger.next ? '<button class="tpbtn" data-co="more">MORE</button>' : '') + '</div>';
    }
    return h;
  }
  function wire(root) {
    root.querySelectorAll('[data-co]').forEach(el => {
      const k = el.dataset.co, v = el.dataset.v;
      if (k === 'role') { el.onchange = () => setRole(v, el.value); return; }
      el.onclick = async () => {
        if (k === 'tab') { S.tab = v; render(); return; }
        if (k === 'found') { const r = await found(val('co-name'), val('co-tick').toUpperCase()); if (r.ok) { S.tab = 'overview'; } }
        else if (k === 'accept') await accept(v);
        else if (k === 'decline') await decline(v);
        else if (k === 'leave') { if (confirm('Leave ' + S.company.name + '? Your businesses in it are taken back.')) await leave(); }
        else if (k === 'invite') await invite(val('co-inv'), val('co-invrole'));
        else if (k === 'revoke') await revokeInvite(v);
        else if (k === 'kick') { if (confirm('Remove this member?')) await removeMember(v); }
        else if (k === 'saverole') await setRolePerms(v, [...root.querySelectorAll('[data-rp="' + v + '"]:checked')].map(x => x.value), +(root.querySelector('[data-rl="' + v + '"]') || {}).value || 0);
        else if (k === 'assign') { const p = (STATE.plots || []).find(q => q.id === v); if (p) await assignBiz(p); }
        else if (k === 'unassign') await unassignBiz(v);
        else if (k === 'bankwd') await bankWithdraw(num('co-wd'), val('co-wdm'));
        else if (k === 'more') await loadLedger(S.ledger && S.ledger.next);
        else if (k === 'wdep') await walletDeposit(num('co-wamt'));
        else if (k === 'wwd') await walletWithdraw(num('co-wamt'));
        render();
      };
    });
  }
  function empireInto() {
    if (!S.enabled) return;
    const body = document.getElementById('mbody'); if (!body) return;
    const close = document.getElementById('em-x'), anchorEl = close ? close.parentElement : null;
    const c = S.company;
    const html = '<div class="msec" style="margin-top:14px">Company</div><div class="kv"><span class="k">' + (c ? esc(c.name) + ' · bank ' + fmt$((c.bank || {}).balance || 0) : 'You are not in a company') + (S.invites.length ? ' · ' + S.invites.length + ' invite' + (S.invites.length === 1 ? '' : 's') : '') + '</span><button class="tpbtn" id="em-co">OPEN</button></div>';
    if (anchorEl) anchorEl.insertAdjacentHTML('beforebegin', html); else body.insertAdjacentHTML('beforeend', html);
    const b = document.getElementById('em-co'); if (b) b.onclick = () => open();
  }

  return {
    init, open, call, divert, refresh, sendIncome, empireInto, onChange, depositToCompanyBank, companyBankToCash,
    onPayout(fn) { payoutListeners.push(fn); },
    esc, r2, can, isOwner, playerWorth, render,
    addSection(s) { sections.push(s); },
    get state() { return S; },
    PERMS, PROTO,
    // QA surface
    qa: { found, invite, accept, decline, assignBiz, unassignBiz, bankWithdraw, walletDeposit, walletWithdraw, leave, removeMember, setRole, setRolePerms, loadLedger, pend: () => ({ ...co().pend }), inflight: () => co().inflight || null, claimed: () => co().claimed.slice(), who: () => accountName(), polls: () => fails, stopped: () => stopped, enabled: () => S.enabled },
  };
})();
window.CO = CO;   // QA surface

// ADDITIVE hook: the Empire panel gains a one-line Company section (only when the server supports companies)
const __coEmpire = ECO.openEmpire.bind(ECO);
ECO.openEmpire = function () {
  __coEmpire();
  try { CO.empireInto(); } catch (e) { console.error('[companies]', e); }
};
