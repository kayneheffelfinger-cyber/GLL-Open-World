// ====================================================================
// js/systems/companystocks.js: company stocks (client side only).
// Loads after companies.js and shows nothing unless CO.state.enabled (the
// server said GET api/companies/status -> enabled). The server owns listings,
// order matching, prices, issuing, dividends and the cap table; this file
// displays quotes and submits requests. See docs/companies-api.md.
// ====================================================================
import { STATE } from '../state.js';
import { toast, openModal } from '../ui/dom.js';
import { fmt$ } from '../util.js';
import { CO } from './companies.js';

export const STK = (() => {
  const { esc, r2 } = CO;
  const M = { list: null, sel: null, quote: null, hist: null, mine: null, orders: null, cap: null, divs: null, timer: 0, busy: false };
  const uid = () => 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const px = v => '$' + (+v || 0).toFixed(2);
  const pc = v => (v >= 0 ? '▲' : '▼') + Math.abs(+v || 0).toFixed(2) + '%';
  const on = () => CO.state.enabled;

  async function loadList() { const r = await CO.call('GET', 'stocks'); if (r.ok) M.list = r.data.stocks || []; return r; }
  async function loadMine() {
    const [a, b] = await Promise.all([CO.call('GET', 'stocks/positions'), CO.call('GET', 'stocks/orders')]);
    if (a.ok) M.mine = a.data.positions || []; if (b.ok) M.orders = b.data.orders || [];
  }
  async function loadQuote(t) {
    const [q, h] = await Promise.all([CO.call('GET', 'stocks/' + encodeURIComponent(t)), CO.call('GET', 'stocks/' + encodeURIComponent(t) + '/history?range=7d')]);
    if (q.ok) { M.quote = q.data; M.sel = t; } if (h.ok) M.hist = h.data.points || [];
    return q;
  }
  async function loadCompany() {
    const c = CO.state.company; if (!c || !c.stock) { M.cap = null; M.divs = null; return; }
    const [a, b] = await Promise.all([CO.call('GET', c.id + '/stock/cap-table'), CO.call('GET', c.id + '/stock/dividends')]);
    if (a.ok) M.cap = a.data; if (b.ok) M.divs = b.data.dividends || [];
  }

  // ---- the exchange modal ---------------------------------------------------------
  async function open(ticker) {
    if (!on()) return;
    openModal('COMPANY STOCKS', '<div id="st-modal-mark"></div><div id="st-body"><p class="co-sub">Loading…</p></div>');
    await Promise.all([loadList(), loadMine()]);
    if (ticker) await loadQuote(ticker);
    render();
    clearInterval(M.timer);
    M.timer = setInterval(async () => {                    // live while the window is open, no longer
      if (!document.getElementById('st-modal-mark') || document.hidden) { if (!document.getElementById('st-modal-mark')) { clearInterval(M.timer); M.timer = 0; } return; }
      const ae = document.activeElement; if (ae && ae.matches && ae.matches('input,select')) return;
      await Promise.all([loadList(), M.sel ? loadQuote(M.sel) : null, loadMine()]); render();
    }, 5000);
  }
  function spark(pts) {
    if (!pts || pts.length < 2) return '<p class="co-sub">No history yet.</p>';
    const xs = pts.map(p => +p[0]), ys = pts.map(p => +p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs) || 1, y0 = Math.min(...ys), y1 = Math.max(...ys);
    const W = 320, Hh = 70, sy = y1 - y0 || 1, sx = x1 - x0 || 1;
    const d = pts.map((p, i) => (i ? 'L' : 'M') + ((p[0] - x0) / sx * W).toFixed(1) + ' ' + (Hh - 4 - (p[1] - y0) / sy * (Hh - 8)).toFixed(1)).join(' ');
    const up = ys[ys.length - 1] >= ys[0];
    return '<svg class="st-spark" viewBox="0 0 ' + W + ' ' + Hh + '" preserveAspectRatio="none"><path d="' + d + '" fill="none" stroke="' + (up ? '#48BB78' : '#FC8181') + '" stroke-width="2"/></svg>';
  }
  function render() {
    const body = document.getElementById('st-body'); if (!body) return;
    const w = CO.state.wallet || { balance: 0 };
    let h = '<div class="co-wallet"><div><span class="k">EXCHANGE WALLET</span> <b>' + fmt$(w.balance || 0) + '</b><span class="co-sub"> · move cash in the COMPANY window</span></div></div>';
    h += '<div class="co-card"><div class="msec">Listed companies</div>' + ((M.list || []).length ? (M.list || []).map(s =>
      '<div class="co-item st-row' + (M.sel === s.ticker ? ' on' : '') + '" data-st="pick" data-v="' + esc(s.ticker) + '"><div><b>' + esc(s.ticker) + '</b><span class="co-sub">' + esc(s.name) + (s.halted ? ' · HALTED' : '') + '</span></div><div class="st-px"><b>' + px(s.price) + '</b><span class="' + (s.changePct >= 0 ? 'g' : 'r') + '">' + pc(s.changePct) + '</span></div></div>').join('') : '<p class="co-sub">No company has listed yet.</p>') + '</div>';
    if (M.sel && M.quote) h += quoteHTML();
    if ((M.mine || []).length) h += '<div class="co-card"><div class="msec">Your shares</div>' + M.mine.map(p => '<div class="co-item"><div><b>' + esc(p.ticker) + '</b><span class="co-sub">' + (+p.qty).toLocaleString('en-US') + ' shares · avg ' + px(p.avgCost) + '</span></div><b>' + fmt$(p.value) + '</b></div>').join('') + '</div>';
    if ((M.orders || []).length) h += '<div class="co-card"><div class="msec">Your open orders</div>' + M.orders.map(o => '<div class="co-item"><span>' + esc(o.side.toUpperCase()) + ' ' + o.qty + ' ' + esc(o.ticker) + (o.limitPrice ? ' @ ' + px(o.limitPrice) : ' at market') + '</span><button class="tpbtn" data-st="cancel" data-v="' + esc(o.id) + '">CANCEL</button></div>').join('') + '</div>';
    body.innerHTML = h; wire(body);
  }
  function quoteHTML() {
    const q = M.quote.quote || {}, bk = M.quote.book || { bids: [], asks: [] }, b = q.bands || {};
    return '<div class="co-card"><div class="msec">' + esc(q.ticker || M.sel) + ' · ' + esc(q.name || '') + '</div>' +
      '<div class="kv"><span class="k">LAST</span><span class="v">' + px(q.last) + ' <span class="' + (q.changePct >= 0 ? 'g' : 'r') + '">' + pc(q.changePct) + '</span></span></div>' + spark(M.hist) +
      '<div class="kv"><span class="k">BID / ASK</span><span class="v">' + (q.bid ? px(q.bid) : '—') + ' / ' + (q.ask ? px(q.ask) : '—') + '</span></div>' +
      '<div class="kv"><span class="k">TODAY\'S BAND</span><span class="v">' + px(b.min) + ' – ' + px(b.max) + (q.halted ? ' · <b class="r">TRADING HALTED</b>' : '') + '</span></div>' +
      '<div class="kv"><span class="k">SHARES</span><span class="v">' + (+q.shares || 0).toLocaleString('en-US') + ' · cap ' + fmt$(q.marketCap) + '</span></div>' +
      '<div class="st-book"><div>' + (bk.bids || []).slice(0, 4).map(l => '<div class="g">' + px(l[0]) + ' × ' + l[1] + '</div>').join('') + '</div><div>' + (bk.asks || []).slice(0, 4).map(l => '<div class="r">' + px(l[0]) + ' × ' + l[1] + '</div>').join('') + '</div></div>' +
      '<div class="co-row" style="margin-top:8px"><select id="st-side"><option value="buy">BUY</option><option value="sell">SELL</option></select><select id="st-type"><option value="market">MARKET</option><option value="limit">LIMIT</option></select><input id="st-qty" type="number" min="1" step="1" placeholder="shares" style="width:90px"><input id="st-lim" type="number" min="0.01" step="0.01" placeholder="limit $" style="width:90px"><button class="tpbtn" data-st="order">PLACE ORDER</button></div>' +
      '<p class="co-sub">Orders are matched by the server against other real players, never against yourself. Prices stay inside the daily band.</p></div>';
  }
  async function placeOrder(side, type, qty, limit) {
    qty = Math.floor(+qty);
    if (!(qty > 0)) { toast('<b>Enter a whole number of shares.</b>', 'warn'); return { ok: false }; }
    if (type === 'limit' && !(+limit > 0)) { toast('<b>Enter a limit price.</b>', 'warn'); return { ok: false }; }
    const body = { side, type, qty, requestId: uid() }; if (type === 'limit') body.limitPrice = r2(limit);
    const r = await CO.call('POST', 'stocks/' + encodeURIComponent(M.sel) + '/orders', body);
    if (!r.ok) { toast('<b>' + esc(r.message || r.code) + '</b>', 'warn'); return r; }
    const f = (r.data.fills || []).reduce((s, x) => s + x.qty, 0);
    toast('📈 Order ' + esc(r.data.order.status) + (f ? ' — ' + f + ' shares filled' : '') + '.');
    await CO.refresh(true); return r;
  }
  async function cancel(id) { const r = await CO.call('DELETE', 'stocks/orders/' + encodeURIComponent(id)); if (!r.ok) toast('<b>' + esc(r.message || r.code) + '</b>', 'warn'); else await CO.refresh(true); return r; }
  function wire(root) {
    root.querySelectorAll('[data-st]').forEach(el => {
      el.onclick = async () => {
        const k = el.dataset.st, v = el.dataset.v;
        if (k === 'pick') { await loadQuote(v); }
        else if (k === 'order') { const g = id => (document.getElementById(id) || {}).value; await placeOrder(g('st-side'), g('st-type'), g('st-qty'), g('st-lim')); await Promise.all([loadQuote(M.sel), loadMine(), loadList()]); }
        else if (k === 'cancel') { await cancel(v); await loadMine(); }
        render();
      };
    });
  }

  // ---- the company window's STOCK tab: issuing, dividends, ownership ---------------------
  const section = {
    id: 'stock', label: 'STOCK',
    html(S) {
      const c = S.company, st = c.stock;
      if (!st) return '<div class="co-card"><p>Your company\'s shares are listed on the exchange when the server opens the listing.</p></div>';
      if (!M.cap) loadCompany().then(() => { if (document.getElementById('co-body') && CO.state.tab === 'stock') CO.render(); });
      const cap = M.cap || { holders: [], total: 0 };
      let h = '<div class="co-card"><div class="kv"><span class="k">' + esc(st.ticker) + '</span><span class="v">' + px(st.price) + ' <span class="' + (st.changePct >= 0 ? 'g' : 'r') + '">' + pc(st.changePct) + '</span></span></div>' +
        '<div class="kv"><span class="k">SHARES ISSUED</span><span class="v">' + (+cap.total || +st.shares || 0).toLocaleString('en-US') + '</span></div>' +
        '<button class="btn primary" data-sk="market" style="width:100%;margin-top:6px">OPEN THE EXCHANGE</button></div>';
      h += '<div class="co-card"><div class="msec">Who owns it</div>' + ((cap.holders || []).length ? cap.holders.map(x => '<div class="co-item"><span>' + esc(x.name) + '</span><span><b>' + (+x.qty).toLocaleString('en-US') + '</b> <span class="co-sub">' + (+x.pct).toFixed(2) + '%</span></span></div>').join('') : '<p class="co-sub">No holders yet.</p>') + '</div>';
      if (CO.can('manage_stock')) {
        h += '<div class="co-card"><div class="msec">Issue new shares</div><div class="co-row"><input id="sk-iss" type="number" min="1" step="1" placeholder="shares"><button class="tpbtn" data-sk="issue">ISSUE</button></div><p class="co-sub">New shares go to the company treasury and are offered for sale by the server within its issuing limits; issuing dilutes every holder.</p></div>' +
          '<div class="co-card"><div class="msec">Pay a dividend</div><div class="co-row"><input id="sk-div" type="number" min="0.01" step="0.01" placeholder="$ per share"><button class="tpbtn" data-sk="divpay">PAY</button></div><p class="co-sub">Paid from the company bank to every holder\'s exchange wallet, in proportion to shares held.</p></div>';
      }
      if ((M.divs || []).length) h += '<div class="co-card"><div class="msec">Dividends paid</div>' + M.divs.slice(0, 8).map(d => '<div class="co-item"><span class="co-sub">' + new Date(d.ts).toLocaleDateString() + '</span><span>' + px(d.perShare) + ' / share · ' + fmt$(d.total) + '</span></div>').join('') + '</div>';
      return h;
    },
    wire(root, S) {
      root.querySelectorAll('[data-sk]').forEach(el => {
        el.onclick = async () => {
          const k = el.dataset.sk, g = id => +(document.getElementById(id) || {}).value, cid = S.company.id;
          if (k === 'market') { open(S.company.stock && S.company.stock.ticker); return; }
          let r;
          if (k === 'issue') r = await CO.call('POST', cid + '/stock/issues', { shares: Math.floor(g('sk-iss')), requestId: uid() });
          else if (k === 'divpay') r = await CO.call('POST', cid + '/stock/dividends', { perShare: r2(g('sk-div')), requestId: uid() });
          if (r && !r.ok) toast('<b>' + esc(r.message || r.code) + '</b>', 'warn');
          else if (r) toast(k === 'issue' ? '📄 Shares issued.' : '💸 Dividend paid.');
          await CO.refresh(true); await loadCompany(); CO.render();
        };
      });
    },
  };
  CO.addSection(section);
  CO.onChange(S => {
    const b = document.getElementById('b-stocks');
    if (S.enabled && S.rules && S.rules.stocks !== false && !b) installButton();
  });
  function installButton() {
    const help = document.getElementById('b-help'), row = help ? help.parentNode : document.getElementById('bb-row'); if (!row) return;
    const b = document.createElement('button'); b.className = 'bb-btn'; b.id = 'b-stocks';
    b.innerHTML = '<span class="tip">STOCKS</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 17l5-6 4 3 8-9"/><path d="M15 5h5v5"/></svg>';
    b.onclick = () => open();
    row.insertBefore(b, help || null);
  }
  return { open, placeOrder, cancel, loadList, loadQuote, loadMine, loadCompany, installButton, get state() { return M; } };
})();
window.STK = STK;   // QA surface
