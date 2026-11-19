// TEST ONLY. A fake hosted site: serves this repo's files plus an in-memory /api that speaks
// docs/companies-api.md (protocol 1). The game never loads this file; scripts/companies-test.mjs
// starts it. Plain Node 20, no dependencies.
//   node scripts/companies-mock.mjs [port] [mode]     mode: full | noapi | nocompanies
// Players are told apart by the cookie `mock_player`; GET /api/__mock/login?as=NAME sets it.
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.md': 'text/markdown', '.txt': 'text/plain' };
export const RULES = { foundingMinNetWorth: 10000, foundingFee: 2000, maxMembers: 10, stocks: true, incomeCapPerBizPerDay: 5000, dailyPriceBand: 0.10, maxOrderPctOfFloat: 10, maxPositionPct: 49, ordersPerMinute: 20, issueMaxPctPer24h: 20, dividendMaxPctOfPrice: 25 };
const PERMS = ['invite', 'remove_members', 'manage_roles', 'view_ledger', 'withdraw', 'manage_stock'];
const DAY_MS = 86400000;

export function startMock({ port = 0, mode = 'full' } = {}) {
  const players = new Map();        // name -> { id, name, wallet, payouts, save, saveRev, companyId, orderTimes }
  const companies = new Map(), invites = new Map(), stocks = new Map(), orders = new Map(), idem = new Map();
  let ver = 1, nid = 1;
  const id = p => p + '_' + (nid++).toString(36);
  const bump = () => { ver++; };
  const log = [];                    // every companies request, for the tests
  const P = name => { let p = players.get(name); if (!p) { p = { id: id('p'), name, wallet: 0, payouts: [], save: null, saveRev: 0, companyId: null, orderTimes: [] }; players.set(name, p); } return p; };
  const byId = pid => [...players.values()].find(p => p.id === pid);
  const err = (status, code, message) => ({ status, body: { ok: false, error: { code, message } } });
  const ok = (body, status = 200) => ({ status, body: { ok: true, ...body } });

  const roleOf = (c, p) => { const m = c.members.find(x => x.id === p.id); return m ? c.roles.find(r => r.id === m.roleId) : null; };
  const has = (c, p, perm) => { const r = roleOf(c, p); return !!(r && r.permissions.includes(perm)); };
  function ledger(c, type, amount, p, memo) { c.bank += amount; c.ledger.unshift({ id: id('l'), ts: Date.now(), type, amount: Math.round(amount * 100) / 100, balanceAfter: Math.round(c.bank * 100) / 100, memberId: p && p.id, memberName: p && p.name, memo: memo || '' }); }
  function stockView(c) {
    const s = c.stockId && stocks.get(c.stockId); if (!s) return null;
    return { ticker: s.ticker, price: s.last, changePct: +((s.last - s.open) / s.open * 100).toFixed(2), shares: s.shares };
  }
  function companyView(c, p) {
    const r = roleOf(c, p);
    return {
      id: c.id, name: c.name, ticker: c.ticker, ownerId: c.ownerId, createdAt: c.createdAt,
      members: c.members.map(m => ({ id: m.id, name: byId(m.id).name, roleId: m.roleId, joinedAt: m.joinedAt })),
      roles: c.roles, invites: has(c, p, 'invite') ? [...invites.values()].filter(i => i.companyId === c.id && i.status === 'pending').map(i => ({ id: i.id, playerName: i.playerName, roleId: i.roleId })) : [],
      businesses: c.businesses.map(b => ({ ...b, ownerName: byId(b.ownerId).name, income7d: Math.round(b.income7d * 100) / 100 })),
      bank: { balance: Math.round(c.bank * 100) / 100, income24h: Math.round(c.income24h * 100) / 100 },
      stock: stockView(c), myRoleId: r.id, myPermissions: r.permissions, myWithdrawLimit: r.withdrawLimit,
    };
  }
  const meView = p => ({
    player: { id: p.id, name: p.name }, company: p.companyId ? companyView(companies.get(p.companyId), p) : null,
    invites: [...invites.values()].filter(i => i.playerId === p.id && i.status === 'pending').map(i => ({ id: i.id, companyId: i.companyId, companyName: companies.get(i.companyId).name, fromName: i.fromName, roleId: i.roleId, roleName: companies.get(i.companyId).roles.find(r => r.id === i.roleId).name })),
    wallet: { balance: Math.round(p.wallet * 100) / 100, payouts: p.payouts.map(x => ({ id: x.id, amount: x.amount, memo: x.memo, kind: x.kind })) },
  });

  // ---- stocks -------------------------------------------------------------------------------
  function hold(s, pid) { return s.holders.get(pid) || 0; }
  function setHold(s, pid, q) { if (q > 0) s.holders.set(pid, q); else s.holders.delete(pid); }
  const reservedShares = (s, pid) => [...orders.values()].filter(o => o.stock === s.ticker && o.playerId === pid && o.side === 'sell' && o.status === 'open').reduce((a, o) => a + o.left, 0);
  const band = s => ({ min: +(s.open * (1 - RULES.dailyPriceBand)).toFixed(2), max: +(s.open * (1 + RULES.dailyPriceBand)).toFixed(2) });
  function book(s) {
    const open = [...orders.values()].filter(o => o.stock === s.ticker && o.status === 'open' && o.type === 'limit');
    const agg = side => { const m = new Map(); for (const o of open.filter(x => x.side === side)) m.set(o.limitPrice, (m.get(o.limitPrice) || 0) + o.left); return [...m.entries()].sort((a, b) => side === 'buy' ? b[0] - a[0] : a[0] - b[0]); };
    return { bids: agg('buy'), asks: agg('sell') };
  }
  function quote(s) {
    const bk = book(s), c = companies.get(s.companyId);
    return { ticker: s.ticker, name: c.name, last: s.last, bid: bk.bids[0] && bk.bids[0][0], ask: bk.asks[0] && bk.asks[0][0], changePct: +((s.last - s.open) / s.open * 100).toFixed(2), bands: band(s), halted: !!s.halted, shares: s.shares, marketCap: Math.round(s.last * s.shares), volume: s.volume };
  }
  function trade(s, price, qty) { s.last = price; s.volume += qty; s.history.push([Date.now(), price, qty]); }
  function place(p, s, b) {
    const times = p.orderTimes.filter(t => Date.now() - t < 60000); p.orderTimes = times;
    if (times.length >= RULES.ordersPerMinute) return err(429, 'rate_limited', 'Too many orders — wait a moment.');
    p.orderTimes.push(Date.now());
    if (s.halted) return err(409, 'halted', 'Trading in ' + s.ticker + ' is halted.');
    const qty = Math.floor(+b.qty), side = b.side, type = b.type;
    if (!(qty > 0) || (side !== 'buy' && side !== 'sell') || (type !== 'market' && type !== 'limit')) return err(400, 'bad_request', 'Check side, type and quantity.');
    if (qty > s.shares * RULES.maxOrderPctOfFloat / 100) return err(422, 'order_too_large', 'Order exceeds ' + RULES.maxOrderPctOfFloat + '% of the shares.');
    let lim = null;
    if (type === 'limit') { lim = Math.round(+b.limitPrice * 100) / 100; const bd = band(s); if (!(lim >= bd.min && lim <= bd.max)) return err(422, 'price_band', 'Limit price is outside today\'s band ' + bd.min + ' – ' + bd.max + '.'); }
    if (side === 'buy' && p.id !== companies.get(s.companyId).ownerId && hold(s, p.id) + qty > s.shares * RULES.maxPositionPct / 100) return err(422, 'position_limit', 'That would exceed the ' + RULES.maxPositionPct + '% position limit.');
    if (side === 'sell' && hold(s, p.id) - reservedShares(s, p.id) < qty) return err(422, 'insufficient_shares', 'You do not hold that many unreserved shares.');
    const resting = [...orders.values()].filter(o => o.stock === s.ticker && o.status === 'open' && o.type === 'limit' && o.side !== side);
    resting.sort((a, b2) => side === 'buy' ? a.limitPrice - b2.limitPrice : b2.limitPrice - a.limitPrice || a.ts - b2.ts);
    const cross = resting.filter(o => type === 'market' || (side === 'buy' ? o.limitPrice <= lim : o.limitPrice >= lim));
    if (cross.some(o => o.playerId === p.id)) return err(422, 'self_trade', 'This would trade against your own resting order.');   // self-trade prevention
    const o = { id: id('o'), stock: s.ticker, playerId: p.id, side, type, qty, left: qty, limitPrice: lim, status: 'open', ts: Date.now(), reserved: 0 };
    if (side === 'buy') {                                   // escrow the money up front
      const est = type === 'limit' ? lim * qty : cross.reduce((a, x) => a + x.limitPrice * Math.min(x.left, qty), 0);
      if (type === 'market' && !cross.length) return err(422, 'no_liquidity', 'Nobody is selling right now.');
      if (p.wallet < est - 1e-9) return err(422, 'insufficient_wallet', 'Your exchange wallet is short of ' + est.toFixed(2) + '.');
      p.wallet -= est; o.reserved = est;
    }
    orders.set(o.id, o);
    const fills = [];
    for (const m of cross) {
      if (o.left <= 0) break;
      const q = Math.min(o.left, m.left), pr = m.limitPrice, buyer = side === 'buy' ? o : m, seller = side === 'buy' ? m : o;
      const bp = players.get(byId(buyer.playerId).name), sp = seller.playerId.startsWith('T:') ? null : byId(seller.playerId);
      const cost = Math.round(pr * q * 100) / 100;
      buyer.reserved = Math.round((buyer.reserved - cost) * 100) / 100;
      if (sp) sp.wallet += cost; else { const c = companies.get(s.companyId); ledger(c, 'share_sale', cost, null, q + ' shares'); }
      setHold(s, seller.playerId, hold(s, seller.playerId) - q); setHold(s, bp.id, hold(s, bp.id) + q);
      o.left -= q; m.left -= q; if (m.left <= 0) m.status = 'filled'; trade(s, pr, q); fills.push({ qty: q, price: pr });
    }
    if (type === 'market' || o.left <= 0) { if (o.side === 'buy' && o.reserved > 0.005) p.wallet += o.reserved; o.reserved = 0; o.status = o.left <= 0 ? 'filled' : 'partial'; if (o.status === 'partial') o.left = 0; }
    bump();
    return ok({ order: { id: o.id, status: o.status === 'open' ? (fills.length ? 'partially filled' : 'open') : o.status }, fills }, 201);
  }

  // ---- the router ----------------------------------------------------------------------------
  function route(method, path, q, body, p) {
    const seg = path.split('/').filter(Boolean);       // after /api/companies
    const first = seg[0];
    const dup = body && body.requestId && method === 'POST' ? p.id + ':' + body.requestId : null;
    if (dup && idem.has(dup)) return idem.get(dup);
    const out = route2(method, seg, first, q, body, p);
    if (dup && out.status < 300) idem.set(dup, out);
    return out;
  }
  function route2(method, seg, first, q, body, p) {
    if (method === 'GET' && first === 'status') return { status: 200, body: { enabled: true, protocol: 1, minProtocol: 1, rules: RULES, me: { id: p.id, name: p.name } } };
    if (method === 'GET' && first === 'me') return ok(meView(p));
    if (method === 'GET' && first === 'updates') { const since = +q.since || 0; return { status: 200, body: { ok: true, protocol: 1, cursor: ver, changed: since < ver || since === 0, me: meView(p) } }; }

    // wallet
    if (first === 'wallet') {
      if (method === 'GET' && seg.length === 1) return ok(meView(p).wallet);
      if (method === 'POST' && seg[1] === 'deposits' && seg.length === 2) {
        const amount = Math.round(+body.amount * 100) / 100; if (!(amount > 0)) return err(400, 'bad_request', 'Amount must be positive.');
        const d = { id: id('d'), amount, status: 'pending', baseline: p.save ? +p.save.money : 0, playerId: p.id, ts: Date.now() };
        p.deposits = p.deposits || new Map(); p.deposits.set(d.id, d); return ok({ deposit: { id: d.id, status: 'pending' } }, 201);
      }
      if (method === 'POST' && seg[1] === 'deposits' && seg[3] === 'confirm') {
        const d = p.deposits && p.deposits.get(seg[2]); if (!d) return err(404, 'not_found', 'No such deposit.');
        if (d.status === 'confirmed') return ok({ deposit: { id: d.id, status: 'confirmed' }, wallet: meView(p).wallet });
        const now = p.save ? +p.save.money : 0;        // the server checks the synced save really lost the money
        if (!body.synced || now > d.baseline - d.amount + 100) return err(409, 'deposit_not_seen', 'Your saved cash has not dropped by the deposit yet.');
        d.status = 'confirmed'; p.wallet += d.amount; bump(); return ok({ deposit: { id: d.id, status: 'confirmed' }, wallet: meView(p).wallet });
      }
      if (method === 'POST' && seg[1] === 'withdrawals') {
        const amount = Math.round(+body.amount * 100) / 100; if (!(amount > 0)) return err(400, 'bad_request', 'Amount must be positive.');
        if (p.wallet < amount) return err(422, 'insufficient_wallet', 'Your wallet holds less than that.');
        p.wallet -= amount; const x = { id: id('x'), amount, memo: 'wallet withdrawal', kind: 'withdrawal' }; p.payouts.push(x); bump(); return ok({ payout: x }, 201);
      }
      if (method === 'POST' && seg[1] === 'payouts' && seg[3] === 'ack') { p.payouts = p.payouts.filter(x => x.id !== seg[2]); return ok({}); }
      return err(404, 'not_found', 'Unknown wallet route.');
    }

    // invites (player side)
    if (first === 'invites' && method === 'POST' && seg[2]) {
      const inv = invites.get(seg[1]); if (!inv || inv.playerId !== p.id || inv.status !== 'pending') return err(404, 'not_found', 'That invite is gone.');
      if (seg[2] === 'decline') { inv.status = 'declined'; bump(); return ok({}); }
      if (seg[2] === 'accept') {
        const c = companies.get(inv.companyId);
        if (p.companyId) return err(409, 'already_member', 'Leave your current company first.');
        if (c.members.length >= RULES.maxMembers) return err(422, 'company_full', 'The company is full.');
        inv.status = 'accepted'; c.members.push({ id: p.id, roleId: inv.roleId, joinedAt: Date.now() }); p.companyId = c.id; bump(); return ok({ company: companyView(c, p) });
      }
    }

    // stocks
    if (first === 'stocks') {
      if (method === 'GET' && seg.length === 1) return ok({ stocks: [...stocks.values()].map(s => ({ ticker: s.ticker, companyId: s.companyId, name: companies.get(s.companyId).name, price: s.last, changePct: +((s.last - s.open) / s.open * 100).toFixed(2), volume: s.volume, shares: s.shares, halted: !!s.halted })) });
      if (method === 'GET' && seg[1] === 'positions') return ok({ positions: [...stocks.values()].filter(s => hold(s, p.id) > 0).map(s => ({ ticker: s.ticker, qty: hold(s, p.id), avgCost: s.last, value: Math.round(hold(s, p.id) * s.last * 100) / 100 })) });
      if (method === 'GET' && seg[1] === 'orders') return ok({ orders: [...orders.values()].filter(o => o.playerId === p.id && o.status === 'open').map(o => ({ id: o.id, ticker: o.stock, side: o.side, type: o.type, qty: o.left, limitPrice: o.limitPrice })) });
      if (method === 'DELETE' && seg[1] === 'orders' && seg[2]) {
        const o = orders.get(seg[2]); if (!o || o.playerId !== p.id || o.status !== 'open') return err(404, 'not_found', 'No such open order.');
        o.status = 'cancelled'; if (o.reserved > 0) p.wallet += o.reserved; o.reserved = 0; bump(); return ok({});
      }
      const s = stocks.get(seg[1]); if (!s) return err(404, 'not_found', 'No such ticker.');
      if (method === 'GET' && seg.length === 2) return ok({ quote: quote(s), book: book(s) });
      if (method === 'GET' && seg[2] === 'history') return ok({ points: s.history.slice(-200) });
      if (method === 'POST' && seg[2] === 'orders') return place(p, s, body || {});
    }

    // companies
    if (method === 'POST' && seg.length === 0) {
      if (p.companyId) return err(409, 'already_member', 'You are already in a company.');
      const name = String(body.name || '').trim(), ticker = String(body.ticker || '').trim().toUpperCase();
      if (name.length < 3 || name.length > 32) return err(400, 'bad_name', 'Company names are 3–32 characters.');
      if (!/^[A-Z]{2,5}$/.test(ticker)) return err(400, 'bad_ticker', 'Tickers are 2–5 letters.');
      if ([...companies.values()].some(c => c.name.toLowerCase() === name.toLowerCase())) return err(409, 'name_taken', 'That name is taken.');
      if (stocks.has(ticker)) return err(409, 'ticker_taken', 'That ticker is taken.');
      const worth = p.save ? +p.save.money : 0;           // the real server derives this from the synced save
      if (worth < RULES.foundingMinNetWorth) return err(422, 'net_worth_too_low', 'You need a net worth of ' + RULES.foundingMinNetWorth + ' (the server sees ' + Math.round(worth) + ').');
      if (p.wallet < RULES.foundingFee) return err(422, 'insufficient_wallet', 'The founding fee of ' + RULES.foundingFee + ' must be in your exchange wallet.');
      p.wallet -= RULES.foundingFee;
      const c = { id: id('c'), name, ticker, ownerId: p.id, createdAt: Date.now(), bank: 0, income24h: 0, ledger: [], businesses: [], seqs: {}, buckets: {}, batches: new Map(), withdrawn: [],
        members: [{ id: p.id, roleId: 'owner', joinedAt: Date.now() }],
        roles: [{ id: 'owner', name: 'Owner', permissions: [...PERMS], withdrawLimit: 1e9 }, { id: 'admin', name: 'Admin', permissions: ['invite', 'remove_members', 'view_ledger', 'withdraw', 'manage_stock'], withdrawLimit: 5000 }, { id: 'manager', name: 'Manager', permissions: ['invite', 'view_ledger'], withdrawLimit: 500 }, { id: 'member', name: 'Member', permissions: ['view_ledger'], withdrawLimit: 0 }] };
      companies.set(c.id, c); p.companyId = c.id;
      const s = { ticker, companyId: c.id, shares: 1000000, last: 1, open: 1, volume: 0, holders: new Map(), history: [[Date.now(), 1, 0]], issuedAt: [] };
      s.holders.set(p.id, 1000000); stocks.set(ticker, s); c.stockId = ticker; ledger(c, 'founding_fee', 0, p, 'fee ' + RULES.foundingFee + ' paid by founder');
      bump(); return ok({ company: companyView(c, p), fee: RULES.foundingFee }, 201);
    }
    const c = companies.get(first);
    if (!c) return err(404, 'not_found', 'No such company.');
    const me = roleOf(c, p); if (!me) return err(403, 'not_a_member', 'You are not in that company.');
    const rest = seg.slice(1);
    if (method === 'GET' && !rest.length) return ok({ company: companyView(c, p) });
    if (method === 'POST' && rest[0] === 'invites') {
      if (!has(c, p, 'invite')) return err(403, 'forbidden', 'You may not invite players.');
      const t = players.get(String(body.playerName || '').trim()); if (!t) return err(404, 'no_such_player', 'No player has that GLL ID name.');
      if (t.companyId) return err(409, 'already_member', 'That player is already in a company.');
      if (!c.roles.some(r => r.id === body.roleId) || body.roleId === 'owner') return err(400, 'bad_role', 'Pick a role other than owner.');
      if ([...invites.values()].some(i => i.companyId === c.id && i.playerId === t.id && i.status === 'pending')) return err(409, 'already_invited', 'Already invited.');
      const inv = { id: id('i'), companyId: c.id, playerId: t.id, playerName: t.name, fromName: p.name, roleId: body.roleId, status: 'pending' }; invites.set(inv.id, inv); bump(); return ok({ invite: { id: inv.id } }, 201);
    }
    if (method === 'DELETE' && rest[0] === 'invites') { const i = invites.get(rest[1]); if (!has(c, p, 'invite') || !i || i.companyId !== c.id) return err(403, 'forbidden', 'Not allowed.'); i.status = 'revoked'; bump(); return ok({}); }
    if (method === 'POST' && rest[0] === 'leave') {
      if (me.id === 'owner') return err(422, 'owner_must_transfer', 'Hand over ownership before leaving.');
      c.members = c.members.filter(m => m.id !== p.id); p.companyId = null; c.businesses = c.businesses.filter(b => b.ownerId !== p.id); bump(); return ok({});
    }
    if (rest[0] === 'members' && rest[1]) {
      if (method === 'DELETE' && !has(c, p, 'remove_members')) return err(403, 'forbidden', 'You may not remove members.');   // permission before lookup
      const t = byId(rest[1]), tm = c.members.find(m => m.id === rest[1]); if (!tm) return err(404, 'not_found', 'No such member.');
      if (method === 'DELETE') {
        if (tm.roleId === 'owner' || t.id === p.id) return err(422, 'bad_target', 'You cannot remove that member.');
        if (tm.roleId === 'admin' && me.id !== 'owner') return err(403, 'forbidden', 'Only the owner removes admins.');
        c.members = c.members.filter(m => m.id !== t.id); t.companyId = null; c.businesses = c.businesses.filter(b => b.ownerId !== t.id); bump(); return ok({});
      }
      if (method === 'PUT') {
        if (!has(c, p, 'manage_roles')) return err(403, 'forbidden', 'You may not change roles.');
        if (!c.roles.some(r => r.id === body.roleId)) return err(400, 'bad_role', 'Unknown role.');
        if (body.roleId === 'owner') { if (me.id !== 'owner') return err(403, 'forbidden', 'Only the owner hands over ownership.'); tm.roleId = 'owner'; c.members.find(m => m.id === p.id).roleId = 'admin'; c.ownerId = t.id; }
        else { if (tm.roleId === 'owner') return err(422, 'bad_target', 'Hand ownership to someone else first.'); tm.roleId = body.roleId; }
        bump(); return ok({});
      }
    }
    if (method === 'PUT' && rest[0] === 'roles') {
      if (!has(c, p, 'manage_roles')) return err(403, 'forbidden', 'You may not edit roles.');
      const r = c.roles.find(x => x.id === rest[1]); if (!r || r.id === 'owner') return err(400, 'bad_role', 'That role is fixed.');
      r.permissions = (body.permissions || []).filter(x => PERMS.includes(x) && x !== 'manage_roles'); r.withdrawLimit = Math.max(0, Math.min(1e6, +body.withdrawLimit || 0)); bump(); return ok({});
    }
    if (rest[0] === 'businesses') {
      if (method === 'POST') {
        const bizId = String(body.bizId || ''); if (!bizId) return err(400, 'bad_request', 'bizId required.');
        if (c.businesses.some(b => b.bizId === bizId && b.ownerId === p.id)) return err(409, 'already_assigned', 'Already in the company.');
        c.businesses.push({ bizId, ownerId: p.id, name: String(body.name || 'Business').slice(0, 60), city: String(body.city || '').slice(0, 40), kind: 'cart', addedAt: Date.now(), income7d: 0 }); bump(); return ok({}, 201);
      }
      if (method === 'DELETE') {
        const b = c.businesses.find(x => x.bizId === rest[1]); if (!b) return err(404, 'not_found', 'Not in the company.');
        if (b.ownerId !== p.id && !has(c, p, 'remove_members')) return err(403, 'forbidden', 'Not your business.');
        c.businesses = c.businesses.filter(x => x !== b); bump(); return ok({});
      }
    }
    if (rest[0] === 'bank') {
      if (method === 'GET' && rest.length === 1) return ok({ bank: { balance: Math.round(c.bank * 100) / 100 } });
      if (method === 'GET' && rest[1] === 'ledger') { if (!has(c, p, 'view_ledger')) return err(403, 'forbidden', 'You may not see the ledger.'); const start = +q.before || 0, page = c.ledger.slice(start, start + (+q.limit || 25)); return ok({ entries: page, next: start + page.length < c.ledger.length ? String(start + page.length) : null }); }
      if (method === 'POST' && rest[1] === 'income') {
        if (c.batches.has(body.batchId)) return ok(c.batches.get(body.batchId));
        const accepted = [], rejected = [];
        for (const r of (body.reports || [])) {
          const b = c.businesses.find(x => x.bizId === r.bizId && x.ownerId === p.id), amt = Math.round(+r.amount * 100) / 100;
          if (!b) { rejected.push({ bizId: r.bizId, seq: r.seq, amount: amt, reason: 'not_assigned' }); continue; }
          if ((c.seqs[r.bizId] || 0) >= r.seq) { accepted.push({ bizId: r.bizId, seq: r.seq, amount: 0 }); continue; }
          const bk = c.buckets[r.bizId] || { t: Date.now(), v: RULES.incomeCapPerBizPerDay / 90 * 90 };
          const cap = RULES.incomeCapPerBizPerDay * 2, refill = (Date.now() - bk.t) / 1000 * (RULES.incomeCapPerBizPerDay / 90);
          bk.v = Math.min(cap, bk.v + refill); bk.t = Date.now();
          if (!(amt > 0) || amt > bk.v) { rejected.push({ bizId: r.bizId, seq: r.seq, amount: amt, reason: 'over_cap' }); c.buckets[r.bizId] = bk; c.seqs[r.bizId] = r.seq; continue; }
          bk.v -= amt; c.buckets[r.bizId] = bk; c.seqs[r.bizId] = r.seq; ledger(c, 'business_income', amt, p, b.name); b.income7d += amt; c.income24h += amt; accepted.push({ bizId: r.bizId, seq: r.seq, amount: amt });
        }
        const out = { accepted, rejected, balance: Math.round(c.bank * 100) / 100 }; c.batches.set(body.batchId, out); bump(); return ok(out);
      }
      if (method === 'POST' && rest[1] === 'withdrawals') {
        if (!has(c, p, 'withdraw')) return err(403, 'forbidden', 'You may not withdraw.');
        const amt = Math.round(+body.amount * 100) / 100; if (!(amt > 0)) return err(400, 'bad_request', 'Amount must be positive.');
        const used = c.withdrawn.filter(w => w.pid === p.id && Date.now() - w.ts < DAY_MS).reduce((a, w) => a + w.amt, 0);
        if (used + amt > me.withdrawLimit) return err(422, 'over_limit', 'That is over your daily withdrawal limit (' + me.withdrawLimit + ').');
        if (amt > c.bank) return err(422, 'insufficient_bank', 'The bank holds less than that.');
        ledger(c, 'withdrawal', -amt, p, body.memo); c.withdrawn.push({ pid: p.id, ts: Date.now(), amt }); p.wallet += amt; bump(); return ok({ withdrawal: { id: id('w'), amount: amt }, balance: Math.round(c.bank * 100) / 100, wallet: meView(p).wallet });
      }
    }
    if (rest[0] === 'stock') {
      const s = stocks.get(c.stockId);
      if (method === 'GET' && rest[1] === 'cap-table') { const total = s.shares; return ok({ total, holders: [...s.holders.entries()].map(([pid, qty]) => ({ playerId: pid, name: pid.startsWith('T:') ? 'Company treasury' : byId(pid).name, qty, pct: qty / total * 100 })).sort((a, b) => b.qty - a.qty) }); }
      if (method === 'GET' && rest[1] === 'dividends') return ok({ dividends: s.divs || [] });
      if (method === 'POST' && rest[1] === 'issues') {
        if (!has(c, p, 'manage_stock')) return err(403, 'forbidden', 'You may not issue shares.');
        const n = Math.floor(+body.shares); if (!(n > 0)) return err(400, 'bad_request', 'Shares must be positive.');
        const recent = s.issuedAt.filter(x => Date.now() - x.ts < DAY_MS).reduce((a, x) => a + x.n, 0);
        if (recent + n > s.shares * RULES.issueMaxPctPer24h / 100) return err(422, 'issue_limit', 'You may issue at most ' + RULES.issueMaxPctPer24h + '% of the shares per day.');
        s.shares += n; s.issuedAt.push({ ts: Date.now(), n }); const tid = 'T:' + c.id; setHold(s, tid, hold(s, tid) + n);
        const o = { id: id('o'), stock: s.ticker, playerId: tid, side: 'sell', type: 'limit', qty: n, left: n, limitPrice: s.last, status: 'open', ts: Date.now(), reserved: 0 }; orders.set(o.id, o);
        bump(); return ok({ issued: n, shares: s.shares }, 201);
      }
      if (method === 'POST' && rest[1] === 'dividends') {
        if (!has(c, p, 'manage_stock')) return err(403, 'forbidden', 'You may not pay dividends.');
        const per = Math.round(+body.perShare * 100) / 100; if (!(per > 0)) return err(400, 'bad_request', 'Dividend must be positive.');
        if (per > s.last * RULES.dividendMaxPctOfPrice / 100) return err(422, 'dividend_limit', 'A dividend may be at most ' + RULES.dividendMaxPctOfPrice + '% of the share price.');
        const holders = [...s.holders.entries()].filter(([pid]) => !pid.startsWith('T:')), total = Math.round(holders.reduce((a, [, q]) => a + q * per, 0) * 100) / 100;
        if (total > c.bank) return err(422, 'insufficient_bank', 'The bank holds less than ' + total + '.');
        ledger(c, 'dividend', -total, p, per + ' per share');
        for (const [pid, qty] of holders) { const hp = byId(pid); hp.wallet += Math.round(qty * per * 100) / 100; }
        (s.divs = s.divs || []).unshift({ ts: Date.now(), perShare: per, total }); bump(); return ok({ total }, 201);
      }
    }
    return err(404, 'not_found', 'Unknown route.');
  }

  // ---- http ------------------------------------------------------------------------------------
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), path = decodeURIComponent(u.pathname);
    const cookie = Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map(s => s.split('=').map(decodeURIComponent)));
    const send = (status, body, type = 'application/json', extra = {}) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
    if (path.startsWith('/api/')) {
      if (mode === 'noapi') return send(404, '<html>not found</html>', 'text/html');
      if (path === '/api/__mock/login') { const n = u.searchParams.get('as') || 'A'; P(n); return send(200, { ok: true }, 'application/json', { 'set-cookie': 'mock_player=' + encodeURIComponent(n) + '; Path=/' }); }
      if (path === '/api/__mock/state') return send(200, { ver, log, players: [...players.values()].map(p => ({ name: p.name, wallet: p.wallet, saveMoney: p.save && p.save.money })) });
      if (path === '/api/__mock/set') { let b = ''; req.on('data', d => b += d); req.on('end', () => { const j = JSON.parse(b || '{}'); if (j.mode) mode = j.mode; send(200, { ok: true, mode }); }); return; }
      const who = cookie.mock_player;
      if (path === '/api/me') { if (!who) return send(401, { error: 'signin' }); return send(200, { name: who }); }
      if (!who) return send(401, { error: 'signin' });
      const p = P(who);
      let raw = ''; req.on('data', d => raw += d);
      req.on('end', () => {
        let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { ok: false, error: { code: 'bad_json' } }); }
        if (path === '/api/save') {
          if (req.method === 'GET') return send(200, { rev: p.saveRev, data: p.save });
          if (req.method === 'PUT') { p.save = body.data; p.saveRev++; return send(200, { rev: p.saveRev }); }
          if (req.method === 'DELETE') { p.save = null; return send(200, { ok: true }); }
        }
        if (path === '/api/save/import') { p.save = body.data; p.saveRev++; return send(200, { rev: p.saveRev }); }
        if (path.startsWith('/api/companies/') || path === '/api/companies') {
          log.push([who, req.method, path]);
          if (mode === 'nocompanies') return send(404, { error: 'not found' });
          const sub = path.replace(/^\/api\/companies\/?/, '');
          const q = Object.fromEntries(u.searchParams);
          const out = route(req.method, sub, q, body, p);
          return send(out.status, out.body);
        }
        send(404, { error: 'not found' });
      });
      return;
    }
    let f = join(ROOT, path === '/' ? 'index.html' : path);
    if (!f.startsWith(ROOT) || !existsSync(f) || statSync(f).isDirectory()) return send(404, 'not found', 'text/plain');
    send(200, readFileSync(f), TYPES[extname(f)] || 'application/octet-stream');
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r({ server, port: server.address().port, close: () => new Promise(k => server.close(k)), state: { companies, players, stocks, orders } })));
}

if (process.argv[1] && process.argv[1].endsWith('companies-mock.mjs')) {
  const port = +process.argv[2] || 8130, mode = process.argv[3] || 'full';
  startMock({ port, mode }).then(m => console.log('mock hosted site on http://127.0.0.1:' + m.port + ' (mode ' + mode + ') — TEST ONLY'));
}
