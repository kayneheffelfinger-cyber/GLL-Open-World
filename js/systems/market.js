// ====================================================================
// js/systems/market.js — the Open Exchange (Stage 5): order book,
// depth ladder, trade tape, limit/market orders, positions, the
// synthetic market-maker crowd. window.MARKET included.
// ====================================================================
import { COMMODITIES } from '../config.js';
import { STATE } from '../state.js';
import { uiBalance } from '../systems/economy.js';
import { toast } from '../ui/dom.js';

// ======== section: 70_market.js ========
// ======== section: 70_market.js ========
// ====================================================================
// v2.0 — MARKET: the Open Exchange — a live crypto-style order book
// with depth ladder, trade tape, limit/market orders and positions.
// A synthetic crowd of market-makers works the desk between you and
// the reserve. Feeds the bottom stats ticker.
// ====================================================================

export const MARKET = (() => {
  const FEE = 0.0025;
  let books = {};             // sym -> {asks:[{p,s}], bids:[{p,s}], last, prevLast, open}
  let positions = {};         // sym -> qty
  let orders = [];            // {id, sym, side, price, qty, filled, escrow}
  let tape = [];              // {sym, qty, price, side, you, t}
  let active = COMMODITIES[0].sym;
  let uiTick = 0;
  let oid = 1;

  // ---------------- deterministic seed helpers ----------------
  function h32(x, y, s) {
    let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b9);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h >>> 0) / 4294967296;
  }
  const hashStr = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

  function ensureBook(sym) {
    if (books[sym]) return books[sym];
    const c = COMMODITIES.find(x => x.sym === sym);
    const seed = hashStr(sym);
    const b = { asks: [], bids: [], last: c.base, prevLast: c.base, open: c.base, hist: [] };
    // v2.72 CHART: a deterministic mean-reverting back-fill (72 points ending
    // on the base price) so the chart opens with a believable recent past;
    // live ticks append to it. History is scenery, never saved.
    {
      let p = c.base * (1 + (h32(seed, 5, 3) - .5) * .06);
      for (let i = 0; i < 72; i++) {
        p += (c.base - p) * .06 + (h32(seed + i, 9, 17) - .5) * c.base * .012;
        b.hist.push(+Math.max(.05, p).toFixed(2));
      }
      b.hist[71] = c.base;
    }
    for (let i = 0; i < 6; i++) {
      b.asks.push({ p: +(c.base * (1.012 + i * .011)).toFixed(2), s: Math.round(60 + h32(seed + i, 3, 11) * 340) });
      b.bids.push({ p: +(c.base * (0.988 - i * .011)).toFixed(2), s: Math.round(60 + h32(seed + i, 7, 29) * 340) });
    }
    books[sym] = b;
    return b;
  }

  // ---------------- desk tick (the book breathes) --------------------
  function tick() {
    for (const c of COMMODITIES) {
      const b = ensureBook(c.sym);
      // prices mean-revert toward base with drift
      const pull = (c.base - b.last) * 0.06;
      b.prevLast = b.last;
      b.last = Math.max(.05, +(b.last + pull + (Math.random() - .5) * c.base * .012).toFixed(2));
      b.hist.push(b.last); if (b.hist.length > 90) b.hist.shift();   // v2.72 CHART
      // sizes drift: asks drain, bids stack (then occasionally refresh)
      for (const a of b.asks) a.s = Math.max(4, a.s - Math.round(Math.random() * 9));
      for (const bd of b.bids) bd.s = bd.s + Math.round(Math.random() * 8);
      if (Math.random() < .22) {
        const i = Math.floor(Math.random() * 6);
        b.asks[i] = { p: +(b.last * (1.012 + i * .011)).toFixed(2), s: Math.round(80 + Math.random() * 300) };
      }
      if (Math.random() < .22) {
        const i = Math.floor(Math.random() * 6);
        b.bids[i] = { p: +(b.last * (0.988 - i * .011)).toFixed(2), s: Math.round(80 + Math.random() * 300) };
      }
      b.asks.sort((x, y) => x.p - y.p);
      b.bids.sort((x, y) => y.p - x.p);
      // crowd trades print
      if (Math.random() < .5) {
        const buy = Math.random() < .5;
        const lvl = (buy ? b.asks : b.bids)[Math.floor(Math.random() * 3)];
        const qty = 1 + Math.floor(Math.random() * 14);
        pushTape(c.sym, qty, lvl.p, buy, false);
      }
      // resting limit orders fill on cross
      fillOrders(c.sym);
    }
  }

  function pushTape(sym, qty, price, buy, you) {
    tape.unshift({ sym, qty, price, buy, you, t: Date.now() });
    if (tape.length > 14) tape.pop();
  }

  function fillOrders(sym) {
    const b = ensureBook(sym);
    for (let i = orders.length - 1; i >= 0; i--) {
      const o = orders[i];
      if (o.sym !== sym) continue;
      if (o.side === 'buy' && b.asks[0] && b.asks[0].p <= o.price) {
        // fill walking asks up to qty at prices ≤ limit
        let remaining = o.qty;
        let cost = 0;
        while (remaining > 0 && b.asks[0] && b.asks[0].p <= o.price) {
          const take = Math.min(remaining, b.asks[0].s);
          cost += take * b.asks[0].p;
          b.asks[0].s -= take; remaining -= take;
          if (b.asks[0].s <= 0) b.asks.shift();
        }
        if (remaining > 0) { cost += remaining * o.price; }   // top-up at limit
        const fee = cost * FEE;
        STATE.money -= (cost + fee - o.escrow);   // escrow already deducted
        positions[sym] = (positions[sym] || 0) + o.qty;
        pushTape(sym, o.qty, o.price, true, true);
        orders.splice(i, 1);
        uiBalance();
        toast('📈 <b>LIMIT BUY filled</b> — ' + o.qty + ' ' + sym + ' @ $' + o.price.toFixed(2));
      } else if (o.side === 'sell' && b.bids[0] && b.bids[0].p >= o.price) {
        let remaining = o.qty, gain = 0;
        while (remaining > 0 && b.bids[0] && b.bids[0].p >= o.price) {
          const take = Math.min(remaining, b.bids[0].s);
          gain += take * b.bids[0].p;
          b.bids[0].s -= take; remaining -= take;
          if (b.bids[0].s <= 0) b.bids.shift();
        }
        if (remaining > 0) gain += remaining * o.price;
        const fee = gain * FEE;
        STATE.money += gain - fee;
        positions[sym] = (positions[sym] || 0) - o.qty;   // qty was escrowed out
        pushTape(sym, o.qty, o.price, false, true);
        orders.splice(i, 1);
        uiBalance();
        toast('📉 <b>LIMIT SELL filled</b> — ' + o.qty + ' ' + sym + ' @ $' + o.price.toFixed(2));
      }
    }
  }

  // ---------------- market orders ------------------------------------
  function marketOrder(sym, side, qty) {
    const b = ensureBook(sym);
    if (!qty || qty < 1) { toast('Enter a quantity.', 'warn'); return; }
    if (side === 'buy') {
      let remaining = qty, cost = 0;
      while (remaining > 0 && b.asks.length) {
        const take = Math.min(remaining, b.asks[0].s);
        cost += take * b.asks[0].p;
        b.asks[0].s -= take; remaining -= take;
        if (b.asks[0].s <= 0) b.asks.shift();
      }
      if (remaining > 0) cost += remaining * b.last * 1.05;   // reserve slippage
      const fee = cost * FEE;
      if (STATE.money < cost + fee) { toast('<b>Insufficient balance</b> for this buy.', 'err'); return; }
      STATE.money -= cost + fee;
      positions[sym] = (positions[sym] || 0) + qty;
      pushTape(sym, qty, cost / qty, true, true);
      uiBalance();
      toast('Bought <b>' + qty + ' ' + sym + '</b> — $' + (cost + fee).toFixed(2) + ' (incl. fee)');
    } else {
      if ((positions[sym] || 0) < qty) { toast('<b>Insufficient position</b> — you hold ' + (positions[sym] || 0) + ' ' + sym + '.', 'err'); return; }
      let remaining = qty, gain = 0;
      while (remaining > 0 && b.bids.length) {
        const take = Math.min(remaining, b.bids[0].s);
        gain += take * b.bids[0].p;
        b.bids[0].s -= take; remaining -= take;
        if (b.bids[0].s <= 0) b.bids.shift();
      }
      if (remaining > 0) gain += remaining * b.last * .95;
      const fee = gain * FEE;
      STATE.money += gain - fee;
      positions[sym] -= qty;
      pushTape(sym, qty, gain / qty, false, true);
      uiBalance();
      toast('Sold <b>' + qty + ' ' + sym + '</b> — +$' + (gain - fee).toFixed(2) + ' (after fee)');
    }
    render();
  }

  function limitOrder(sym, side, price, qty) {
    const b = ensureBook(sym);
    if (!qty || qty < 1) { toast('Enter a quantity.', 'warn'); return; }
    if (!price || price <= 0) { toast('Enter a price.', 'warn'); return; }
    if (side === 'buy') {
      const cost = price * qty * (1 + FEE);
      if (STATE.money < cost) { toast('<b>Insufficient balance</b> — escrow needs $' + cost.toFixed(2) + '.', 'err'); return; }
      STATE.money -= cost;
      orders.push({ id: oid++, sym, side, price: +price, qty, escrow: cost });
      toast('LIMIT BUY resting — <b>' + qty + ' ' + sym + ' @ $' + (+price).toFixed(2) + '</b>');
    } else {
      if ((positions[sym] || 0) < qty) { toast('<b>Insufficient position</b> — you hold ' + (positions[sym] || 0) + ' ' + sym + '.', 'err'); return; }
      positions[sym] -= qty;   // goods escrowed
      orders.push({ id: oid++, sym, side, price: +price, qty, escrow: 0 });
      toast('LIMIT SELL resting — <b>' + qty + ' ' + sym + ' @ $' + (+price).toFixed(2) + '</b>');
    }
    fillOrders(sym);
    render();
  }
  function cancelOrder(id) {
    const i = orders.findIndex(o => o.id === id);
    if (i < 0) return;
    const o = orders[i];
    if (o.side === 'buy') STATE.money += o.escrow;
    else positions[o.sym] = (positions[o.sym] || 0) + o.qty;
    orders.splice(i, 1);
    toast('Order cancelled — escrow returned.');
    render();
  }

  // ---------------- rendering ----------------------------------------
  const $ = id => document.getElementById(id);

  // v2.72 QUOTE + CHART: big price, change pill, high/low and a line chart of
  // the selected symbol (canvas, DPR-aware, redrawn on every render)
  function renderQuote() {
    const c = COMMODITIES.find(x => x.sym === active), b = ensureBook(active);
    if (!c || !$('mchart')) return;
    const chg = (b.last - b.open) / b.open * 100, up = chg >= 0;
    $('mq-sym').textContent = c.sym;
    $('mq-name').textContent = c.name;
    $('mq-price').textContent = '$' + b.last.toFixed(2);
    const ce = $('mq-chg'); ce.textContent = (up ? '▲ ' : '▼ ') + Math.abs(chg).toFixed(2) + '%'; ce.className = 'mq-chg ' + (up ? 'up' : 'dn');
    const hs = b.hist, lo = Math.min(...hs), hi = Math.max(...hs);
    $('mq-lo').textContent = '$' + lo.toFixed(2); $('mq-hi').textContent = '$' + hi.toFixed(2);
    // chart
    const cv = $('mchart'), dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = cv.clientWidth || 340, H = cv.clientHeight || 110;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const pad = 6, span = Math.max(hi - lo, b.last * .004), y0 = lo - span * .12, y1 = hi + span * .12;
    const X = i => pad + (W - pad * 2) * i / (hs.length - 1), Y = v => H - pad - (H - pad * 2) * (v - y0) / (y1 - y0);
    g.strokeStyle = 'rgba(255,255,255,.05)'; g.lineWidth = 1;
    for (let k = 1; k < 4; k++) { const y = Math.round(H * k / 4) + .5; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    const col = up ? '104,211,145' : '239,68,68';
    const grad = g.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, `rgba(${col},.30)`); grad.addColorStop(1, `rgba(${col},0)`);
    g.beginPath(); hs.forEach((v, i) => i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)));
    g.lineTo(X(hs.length - 1), H); g.lineTo(X(0), H); g.closePath(); g.fillStyle = grad; g.fill();
    g.beginPath(); hs.forEach((v, i) => i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)));
    g.strokeStyle = `rgb(${col})`; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
    const ly = Y(b.last);   // last-price guide + dot
    g.setLineDash([3, 4]); g.strokeStyle = `rgba(${col},.5)`; g.lineWidth = 1; g.beginPath(); g.moveTo(0, ly); g.lineTo(W, ly); g.stroke(); g.setLineDash([]);
    g.fillStyle = '#fff'; g.beginPath(); g.arc(X(hs.length - 1), ly, 3.2, 0, 6.2832); g.fill();
    g.strokeStyle = `rgb(${col})`; g.lineWidth = 2; g.stroke();
  }

  function renderComps() {
    $('comps').innerHTML = COMMODITIES.map(c => {
      const b = ensureBook(c.sym);
      const chg = ((b.last - b.open) / b.open * 100);
      return `<div class="comp ${c.sym === active ? 'on' : ''}" data-sym="${c.sym}"><span class="cs">${c.sym}</span><span class="pp">$${b.last.toFixed(2)}</span><span class="cc ${chg >= 0 ? 'up' : 'dn'}">${chg >= 0 ? '▲' : '▼'}${Math.abs(chg).toFixed(1)}%</span></div>`;
    }).join('');
    document.querySelectorAll('.comp').forEach(el => {
      el.onclick = () => { active = el.dataset.sym; render(); };
    });
  }

  function renderBook() {
    const b = ensureBook(active);
    const myBids = orders.filter(o => o.sym === active && o.side === 'buy');
    const myAsks = orders.filter(o => o.sym === active && o.side === 'sell');
    let html = '';
    const maxS = Math.max(...b.asks.map(a => a.s), ...b.bids.map(x => x.s), 1);
    // asks (descending into spread)
    const asks = b.asks.slice(0, 6).reverse();
    let cum = 0;
    const cumA = asks.map(a => (cum += a.s));
    asks.forEach((a, i) => {
      const mine = myAsks.find(o => Math.abs(o.price - a.p) < .005);
      html += `<div class="lvl ask"><div class="bar" style="width:${(a.s / maxS * 100).toFixed(0)}%"></div>
        <span class="pr">$${a.p.toFixed(2)}${mine ? '<span class="you">YOU</span>' : ''}</span><span class="sz">${a.s}</span><span class="cu">${cumA[i]}</span></div>`;
    });
    const chg = b.last - b.prevLast;
    const spread = b.asks[0] ? (b.asks[0].p - (b.bids[0] ? b.bids[0].p : b.last)).toFixed(2) : '—';
    html += `<div class="lvl last"><span class="pr">$${b.last.toFixed(2)} ${chg > 0 ? '▲' : chg < 0 ? '▼' : '•'}</span><span class="sz">SPRD ${spread}</span><span class="cu">${active} · 0.25%</span></div>`;
    cum = 0;
    b.bids.slice(0, 6).forEach((bd, i) => {
      cum += bd.s;
      const mine = myBids.find(o => Math.abs(o.price - bd.p) < .005);
      html += `<div class="lvl bid"><div class="bar" style="width:${(bd.s / maxS * 100).toFixed(0)}%"></div>
        <span class="pr">$${bd.p.toFixed(2)}${mine ? '<span class="you">YOU</span>' : ''}</span><span class="sz">${bd.s}</span><span class="cu">${cum}</span></div>`;
    });
    $('bookrows').innerHTML = html;
    // tape
    $('tape').innerHTML = tape.slice(0, 12).map(t =>
      `<div class="tr"><span>${t.time || ''}${t.you ? '<span class="y">YOU</span>' : ''} ${t.sym}</span><span class="p ${t.buy ? 'g' : 'r'}">${t.buy ? 'B' : 'S'} ${t.qty} @ $${t.price.toFixed(2)}</span></div>`).join('')
      || '<div class="tr"><span>awaiting trades…</span></div>';
    // position
    const pos = positions[active] || 0;
    $('posline').innerHTML = pos > 0
      ? 'HOLD <b>' + pos + ' ' + active + '</b> · mark $' + (pos * ensureBook(active).last).toFixed(2)
      : 'HOLD — (0 ' + active + ')';
    // open orders
    $('oorows').innerHTML = orders.map(o =>
      `<div class="oo"><span>${o.side === 'buy' ? 'BID' : 'ASK'} ${o.qty} ${o.sym} @ $${o.price.toFixed(2)}</span><span class="c" data-cx="${o.id}">CANCEL</span></div>`).join('')
      || '<div class="oo" style="color:var(--dim)">no resting orders</div>';
    document.querySelectorAll('[data-cx]').forEach(el => el.onclick = () => cancelOrder(+el.dataset.cx));
  }

  function estPreview() {
    const b = ensureBook(active);
    const mode = document.querySelector('#ordertabs button.on').dataset.ot;
    let html = '';
    if (mode === 'market') {
      const q = +$('mkt-q').value || 0;
      if (q > 0) {
        let rem = q, cost = 0;
        for (const a of b.asks) { if (rem <= 0) break; const t2 = Math.min(rem, a.s); cost += t2 * a.p; rem -= t2; }
        if (rem > 0) cost += rem * b.last * 1.05;
        html = 'EST. FILL <b>' + q + ' ' + active + '</b> ≈ $' + cost.toFixed(2) + ' (avg $' + (cost / q).toFixed(2) + ')';
      } else html = '—';
    } else {
      const p = +$('lmt-p').value || 0, q = +$('lmt-q').value || 0;
      if (p > 0 && q > 0) html = 'ESCROW <b>$' + (p * q * (1 + FEE)).toFixed(2) + '</b> (' + q + ' × $' + p.toFixed(2) + ' + fee)';
      else html = '—';
    }
    $('oest').innerHTML = html;
  }

  let mode = 'limit';
  function render() {
    renderComps();
    renderQuote();
    renderBook();
    estPreview();
  }

  function bind() {
    $('mx').onclick = toggleOpen;
    document.querySelectorAll('#ordertabs button').forEach(b => {
      b.onclick = () => {
        mode = b.dataset.ot;
        document.querySelectorAll('#ordertabs button').forEach(x => x.classList.toggle('on', x === b));
        $('of-limit').classList.toggle('hidden', mode !== 'limit');
        $('of-market').classList.toggle('hidden', mode !== 'market');
        estPreview();
      };
    });
    $('buybtn').onclick = () => {
      if (mode === 'market') marketOrder(active, 'buy', Math.round(+$('mkt-q').value || 0));
      else limitOrder(active, 'buy', +$('lmt-p').value, Math.round(+$('lmt-q').value || 0));
      uiBalanceRef();
    };
    $('sellbtn').onclick = () => {
      if (mode === 'market') marketOrder(active, 'sell', Math.round(+$('mkt-q').value || 0));
      else limitOrder(active, 'sell', +$('lmt-p').value, Math.round(+$('lmt-q').value || 0));
      uiBalanceRef();
    };
    ['lmt-p', 'lmt-q', 'mkt-q'].forEach(id => $(id).addEventListener('input', estPreview));
  }
  let uiBalanceRef = () => { };
  function setBalanceRef(fn) { uiBalanceRef = fn; }

  function toggleOpen() {
    const el = $('market');
    el.classList.toggle('open');
    document.getElementById('b-market').classList.toggle('on', el.classList.contains('open'));
    if (el.classList.contains('open')) render();
  }

  function start() {
    COMMODITIES.forEach(c => ensureBook(c.sym));
    bind();
    setInterval(() => { tick(); if ($('market').classList.contains('open')) render(); }, 1200);
    render();
  }

  // stats ticker feed
  function tickerStats() {
    return COMMODITIES.map(c => {
      const b = ensureBook(c.sym);
      const chg = (b.last - b.open) / b.open * 100;
      return { sym: c.sym, price: b.last, chg };
    });
  }

  // ---------------- persistence --------------------------------------
  function pack() {
    return { positions, orders, oid, lasts: Object.fromEntries(COMMODITIES.map(c => [c.sym, ensureBook(c.sym).last])) };
  }
  function restore(p) {
    if (!p) return;
    positions = p.positions || {};
    orders = (p.orders || []).map(o => ({ ...o }));
    oid = p.oid || orders.length + 1;
    if (p.lasts) for (const k in p.lasts) { const b = ensureBook(k); if (b) b.last = p.lasts[k]; }
  }

  return { start, tick, render, toggleOpen, tickerStats, pack, restore, setBalanceRef,
    get active() { return active; } };
})();

window.MARKET = MARKET;

