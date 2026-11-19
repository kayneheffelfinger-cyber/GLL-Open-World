# Companies & Company Stocks API: protocol 1

The contract between the Open World client (`js/systems/companies.js`, `js/systems/companystocks.js`) and the hosted site's server. **The server half does not exist yet.** Gamble Limited builds it on the hosted site's `/api`. `scripts/companies-mock.mjs` is a test-only in-memory server that implements exactly this document; use it as a worked example, never in production.

Play money only. Members, invitees and traders are real players (GLL IDs).

## 1. Conventions

- **Base path:** every URL is relative to the game page: `api/companies/...` (never an absolute host). Only the hosted site serves it.
- **Auth:** the existing GLL ID session cookie, same-origin (`credentials: 'same-origin'`), exactly like `api/me` and `api/save`. Every request carries `x-ow: 1` and, with a body, `content-type: application/json`. A missing/expired session is `401`. The server identifies the player from the session, never from the request body.
- **Formats:** JSON. Money is a number of play dollars rounded to cents (the server stores integer cents). Timestamps are Unix milliseconds. Ids are opaque strings; company ids start with `c_`.
- **Success:** HTTP 2xx and `{ "ok": true, ... }`.
- **Failure:** HTTP 4xx/5xx and `{ "ok": false, "error": { "code": "snake_case_code", "message": "Human sentence shown to the player." } }`. Clients show `message` and branch on `code`.
- **Idempotency:** every `POST` that changes money, shares or membership carries a client-made `requestId` (string, unique per player). Repeating a `requestId` returns the original response and changes nothing. Clients retry network failures with the same `requestId`.
- **Reserved first path segments** under `api/companies/`: `status`, `me`, `updates`, `wallet`, `stocks`, `invites`. A company id is any other segment.
- **Money flow:** the player's cash lives in their save (client). The server only moves money that was explicitly put into the **exchange wallet** (section 4); founding fees, share orders, dividends and bank withdrawals all use the wallet. That is the only place client cash and server balances meet.

## 2. Discovery, gating and protocol version

### `GET api/companies/status`

The only request an unsupporting server ever sees. The client sends it only when `js/sync.js` has already found a working `/api` (`isHosted()`), once per page load.

```json
{ "enabled": true, "protocol": 1, "minProtocol": 1,
  "rules": { "foundingMinNetWorth": 10000, "foundingFee": 2000, "maxMembers": 10, "stocks": true,
             "incomeCapPerBizPerDay": 5000, "dailyPriceBand": 0.10, "maxOrderPctOfFloat": 10,
             "maxPositionPct": 49, "ordersPerMinute": 20, "issueMaxPctPer24h": 20, "dividendMaxPctOfPrice": 25 },
  "me": { "id": "p_1", "name": "Alice" } }
```

The client shows company/stock UI **only** if the body is JSON with `enabled === true`, `protocol >= 1` and `minProtocol <= 1`. Anything else (404, HTML, `enabled:false`, network error, unsupported version) means: no button, no panel, no polling, no retry, no console noise from the game. `rules` is informational (the client shows it); the server enforces the real values. `rules.stocks:false` hides only the stock UI.

Protocol changes: additive fields do not bump `protocol`. A breaking change raises `protocol`; clients that need `minProtocol` above what they speak hide the feature.

## 3. Players, invites, polling

### `GET api/companies/me`
```json
{ "ok": true, "player": { "id": "p_1", "name": "Alice" }, "company": <Company>|null,
  "invites": [ { "id": "i_9", "companyId": "c_2", "companyName": "Acme Corp", "fromName": "Bob", "roleId": "member", "roleName": "Member" } ],
  "wallet": <Wallet> }
```

`Company` (what a member may see):
```json
{ "id": "c_2", "name": "Acme Corp", "ticker": "ACME", "ownerId": "p_1", "createdAt": 1760000000000,
  "members": [ { "id": "p_1", "name": "Alice", "roleId": "owner", "joinedAt": 1760000000000 } ],
  "roles": [ { "id": "owner", "name": "Owner", "permissions": ["invite","remove_members","manage_roles","view_ledger","withdraw","manage_stock"], "withdrawLimit": 1000000000 } ],
  "invites": [ { "id": "i_9", "playerName": "Bob", "roleId": "member" } ],
  "businesses": [ { "bizId": "plot-17", "ownerId": "p_1", "ownerName": "Alice", "name": "🌮 Taco cart · New York", "city": "New York", "kind": "cart", "addedAt": 1760000000000, "income7d": 812.5 } ],
  "bank": { "balance": 4410.25, "income24h": 530.0 },
  "stock": { "ticker": "ACME", "price": 1.05, "changePct": 5.0, "shares": 1000000 },
  "myRoleId": "owner", "myPermissions": ["..."], "myWithdrawLimit": 1000000000 }
```
`invites` inside `Company` is returned only to members with `invite`. `stock` is `null` until listed.

`Wallet`: `{ "balance": 4000, "payouts": [ { "id": "x_5", "amount": 5, "memo": "wallet withdrawal", "kind": "withdrawal|dividend|..." } ] }` (payouts = money the server has already debited and the client has not yet acknowledged, section 4).

### `GET api/companies/updates?since=<cursor>`
The polling endpoint. The client calls it once at start and then every 10 s while the tab is visible (exponential backoff up to 5 min after failures; stops for good on 401/403/404/501 or `companies_disabled`). `since=0` forces a full snapshot.
```json
{ "ok": true, "protocol": 1, "cursor": 412, "changed": true, "me": <body of GET me without "ok">, "quotes": [ <ListedStock> ] }
```
`cursor` is a server-side monotonically increasing version per player; `changed:false` may omit `me`/`quotes`. After any of its own mutations the client re-reads with `since=0`.

### Invites
| Method & path | Body | Result |
|---|---|---|
| `POST api/companies/{cid}/invites` | `{ "playerName": "Bob", "roleId": "member" }` | `201 { "invite": { "id" } }` |
| `DELETE api/companies/{cid}/invites/{iid}` | | `200 {}` (revoke) |
| `POST api/companies/invites/{iid}/accept` | `{}` | `200 { "company": <Company> }` |
| `POST api/companies/invites/{iid}/decline` | `{}` | `200 {}` |

Errors: `forbidden` (no `invite` permission), `no_such_player`, `already_member`, `already_invited`, `bad_role` (`owner` can never be offered), `company_full`, `not_found` (invite gone/not yours).

## 4. The exchange wallet

A per-player server balance. Cash enters by **deposit** and leaves by **withdrawal**; both are two-phase so a hostile client cannot mint or double-spend money.

- `GET api/companies/wallet` → `{ "ok": true, "balance": 4000, "payouts": [...] }`
- **Deposit.** `POST api/companies/wallet/deposits` `{ "amount": 6000, "requestId": "...", "cashBefore": 60000 }` → `201 { "deposit": { "id": "d_1", "status": "pending" } }`. The server records the player's last synced save cash as `baseline`. The client then deducts the cash locally, saves, uploads the save (`api/save`), and calls `POST api/companies/wallet/deposits/{id}/confirm` `{ "synced": true }`. The server credits the wallet only if the **synced save's cash is at most `baseline - amount` (+ a small income tolerance)**, else `409 deposit_not_seen` (the client then restores the cash). Pending deposits expire (recommended 10 min).
- **Withdrawal.** `POST api/companies/wallet/withdrawals` `{ "amount": 5, "requestId": "..." }` → `201 { "payout": { "id": "x_5", "amount": 5, "memo": "..." } }`. The server debits the wallet immediately and lists the payout in `wallet.payouts` until acknowledged.
- **Payout claim.** The client credits cash locally once per payout id (it remembers claimed ids in its save), then `POST api/companies/wallet/payouts/{id}/ack` `{}`. Unacknowledged payouts stay listed, so a crash between debit and credit never loses money, and the client never credits an id twice.

Errors: `insufficient_wallet`, `deposit_not_seen`, `not_found`, `bad_request`.

## 5. Companies

### Create: `POST api/companies`
```json
{ "name": "Acme Corp", "ticker": "ACME", "requestId": "r1", "clientNetWorth": 61000 }
```
`201 { "company": <Company>, "fee": 2000 }`. The server **ignores `clientNetWorth`** (display only) and computes the player's net worth itself from the synced save (cash plus assets valued by the same rules as `RIVALS.playerWorth`, see Server-side rules). The fee is debited from the **exchange wallet**. Success atomically creates the company, makes the caller `owner`, opens the bank, and lists the company's stock (section 8).
Errors: `already_member` (one company per player), `bad_name` (3–32 chars, no markup), `bad_ticker` (2–5 A–Z), `name_taken`, `ticker_taken`, `net_worth_too_low`, `insufficient_wallet`, `rate_limited`.

### Read: `GET api/companies/{cid}` → `{ "company": <Company> }` (`not_a_member` 403 otherwise)

### Roles and permissions
Fixed role ids: `owner`, `admin`, `manager`, `member`. Permissions: `invite`, `remove_members` (also removes other members' businesses), `manage_roles`, `view_ledger`, `withdraw`, `manage_stock`. Every member may assign **their own** businesses.
- `PUT api/companies/{cid}/roles/{roleId}` `{ "permissions": ["view_ledger","withdraw"], "withdrawLimit": 100 }`. Needs `manage_roles`. `owner` is immutable and `manage_roles` can never be granted to other roles. `withdrawLimit` is dollars per rolling 24 h.
- `PUT api/companies/{cid}/members/{pid}` `{ "roleId": "admin" }`. Needs `manage_roles`; `roleId:"owner"` is the owner handing ownership over (owner only; the old owner becomes `admin`).
- `DELETE api/companies/{cid}/members/{pid}`: remove a member (needs `remove_members`; admins only removable by the owner; owner and self not removable, use leave). The member's businesses leave the company.
- `POST api/companies/{cid}/leave` `{}`: the owner must hand over ownership first (`owner_must_transfer`). The leaver's businesses leave the company.

Errors: `forbidden`, `not_found`, `bad_role`, `bad_target`, `owner_must_transfer`.

### Businesses
Only carts are supported in protocol 1 (offices, rigs etc. are not moved under companies yet).
- `POST api/companies/{cid}/businesses` `{ "bizId": "plot-17", "name": "...", "city": "...", "kind": "cart" }` → `201 {}`. The business is keyed `(playerId, bizId)`, so two players with the same local plot id never collide. Error `already_assigned`.
- `DELETE api/companies/{cid}/businesses/{bizId}`: the owner, or a member with `remove_members`. Error `forbidden`/`not_found`.

From the moment a business is assigned the client stops crediting its sales to cash and reports them to the bank (section 6). On removal the client returns any unreported held income to the owner.

## 6. The bank and ledger

- `GET api/companies/{cid}/bank` → `{ "bank": { "balance": 4410.25 } }`
- `GET api/companies/{cid}/bank/ledger?limit=25&before=<cursor>` (needs `view_ledger`) → `{ "entries": [ { "id","ts","type","amount","balanceAfter","memberId","memberName","memo" } ], "next": "<cursor>"|null }`, newest first. `amount` is signed. Types include `founding_fee`, `business_income`, `member_deposit`, `withdrawal`, `dividend`, `share_sale`, `adjustment`. The ledger is append-only.
- **Income deposit** `POST api/companies/{cid}/bank/income`
```json
{ "batchId": "rk3x...", "reports": [ { "bizId": "plot-17", "seq": 12, "amount": 41.5, "periodMs": 20000 } ] }
```
  → `200 { "accepted": [ { "bizId","seq","amount" } ], "rejected": [ { "bizId","seq","amount","reason": "not_assigned|over_cap|bad_amount" } ], "balance": 4451.75 }`.
  The client holds each assigned business's sales and sends one batch about every 20 s; `seq` is a per-business counter that only increases; the batch is saved locally and **re-sent verbatim** until answered (the same `batchId` returns the stored answer). Rejected amounts are credited back to the player's cash by the client, so a rejection costs the player nothing and a cheater gains nothing beyond the cap.
- **Member deposit** `POST api/companies/{cid}/bank/deposits` `{ "amount": 250, "memo": "optional", "requestId": "..." }` → `201 { "balance", "wallet": <Wallet> }`. Any member moves money from their **exchange wallet** into the company bank (ledger type `member_deposit`). Errors: `insufficient_wallet`, `bad_request`, `not_a_member`. (Added after protocol 1 shipped; additive, so `protocol` stays 1. The single-player Bank panel uses it for transfers between a player's own bank accounts and the company bank.)
- **Withdrawal** `POST api/companies/{cid}/bank/withdrawals` `{ "amount": 8, "memo": "lunch", "requestId": "..." }` → `200 { "withdrawal": { "id","amount" }, "balance", "wallet": <Wallet> }`. Needs `withdraw`; money goes to the caller's **exchange wallet**, and the role's 24 h limit applies. Errors: `forbidden`, `over_limit`, `insufficient_bank`, `bad_request`.

## 7. Stock market

All under `api/companies/stocks`, all require a signed-in player (trading does not require membership).

- `GET api/companies/stocks` → `{ "stocks": [ <ListedStock> ] }`, `ListedStock = { ticker, companyId, name, price, changePct, volume, shares, halted }`.
- `GET api/companies/stocks/{ticker}` → `{ "quote": { ticker, name, last, bid, ask, changePct, bands: {min,max}, halted, shares, marketCap, volume }, "book": { "bids": [[price,qty]], "asks": [[price,qty]] } }`.
- `GET api/companies/stocks/{ticker}/history?range=1d|7d|30d` → `{ "points": [ [ts, price, volume] ] }`.
- `POST api/companies/stocks/{ticker}/orders` `{ "side": "buy|sell", "type": "market|limit", "qty": 400, "limitPrice": 1.05, "requestId": "..." }` → `201 { "order": { "id", "status": "open|partially filled|filled|partial|cancelled" }, "fills": [ { "qty", "price" } ] }`. Buys escrow wallet money at order time (limit: `qty × limit`; market: the cost of the book it will cross); sells reserve the shares. `partial` = a market order that exhausted the book (the rest is cancelled). Settlement is atomic per fill: shares and wallet balances move in one transaction.
- `GET api/companies/stocks/orders` → `{ "orders": [ { id, ticker, side, type, qty, limitPrice } ] }` (my open orders). `DELETE api/companies/stocks/orders/{oid}` cancels and releases the escrow.
- `GET api/companies/stocks/positions` → `{ "positions": [ { ticker, qty, avgCost, value } ] }`.
- Errors: `halted`, `bad_request`, `order_too_large`, `price_band`, `position_limit`, `insufficient_shares`, `insufficient_wallet`, `no_liquidity`, `self_trade`, `rate_limited`, `not_found`.

## 8. Company stock lifecycle

- **Listing at founding.** In the same transaction as `POST api/companies` the server creates the stock: ticker from the request, an initial share count (recommended 1,000,000, all held by the founder) and an initial price (recommended `max(1, round(founderNetWorthSnapshot / shares))`, floored at $1). Nothing trades until holders place orders.
- **Price formation.** Price = last trade price, kept inside the daily band (section 10). The server also publishes a **fundamental value** per share used for the band centre on each new trading day and for halts: `fundamental = (bank balance + 30 × trailing-7-day average daily business income − debts) / shares`, smoothed (EMA) so one day cannot swing it. Profit, growth (income trend) and debts (negative bank/arrears) therefore move the band; trading moves the price inside it.
- **Issuing** `POST api/companies/{cid}/stock/issues` `{ "shares": 100000, "requestId": "..." }` (needs `manage_stock`) → `201 { "issued": 100000, "shares": 1100000 }`. New shares are held by the company **treasury** (holder id `T:<cid>`) and offered by the server at the current price; proceeds go to the bank ledger as `share_sale`. Issuing dilutes every holder and is capped (section 10).
- **Dividends** `POST api/companies/{cid}/stock/dividends` `{ "perShare": 0.05, "requestId": "..." }` (needs `manage_stock`) → `201 { "total": 49975 }`. Debited from the bank ledger (`dividend`) and credited to every non-treasury holder's **wallet** in proportion to shares, atomically. `GET api/companies/{cid}/stock/dividends` → `{ "dividends": [ { ts, perShare, total } ] }`.
- **Ownership view** `GET api/companies/{cid}/stock/cap-table` → `{ "total": 1100000, "holders": [ { "playerId","name","qty","pct" } ] }` (treasury shown as "Company treasury").

Errors: `forbidden`, `issue_limit`, `dividend_limit`, `insufficient_bank`, `bad_request`.

## 9. Update polling summary

One request per ~10 s per open tab: `GET api/companies/updates?since=<cursor>`. Quotes for the player's stocks may ride on it (`quotes`). While the STOCKS window is open the client also reads `stocks`, `stocks/{ticker}` and `stocks/positions`/`orders` every 5 s. No long-polling or websockets in protocol 1.

---

## Server-side rules (what the server MUST enforce)

The client is untrusted. Everything below is enforced by the server regardless of what the UI allows.

**Founding.** (1) One company per player. (2) Net worth ≥ `foundingMinNetWorth`, computed **by the server from the synced save** (same terms as `RIVALS.playerWorth`: cash, offices, rooms, acres, machines, mines, stockpile at par, buildings, factories, furniture, oil rigs); never trust `clientNetWorth`. (3) The fee is debited from the wallet inside the founding transaction; no fee, no company. (4) Name 3–32 chars, ticker 2–5 A–Z, both unique case-insensitively, profanity/impersonation filtered, no markup stored raw. (5) Founding is rate-limited per player and per day.

**Permissions.** Every endpoint re-derives the caller's role and permissions from the stored membership; `403 forbidden` otherwise. Permission is checked **before** looking up targets (do not leak existence). The owner can never be removed, demoted or left behind; ownership moves only by explicit transfer. `manage_roles` is never grantable to roles. Admins are removable only by the owner. Invites expire (recommend 7 days), cap pending invites per company and per invitee, and cannot target players already in a company.

**Atomic ledger transactions.** Bank, wallet, share positions, escrow and orders change only inside database transactions that write the ledger entry in the same commit. Ledger rows are append-only with `balanceAfter`, never updated or deleted; balances never go negative; every debit is checked against the balance inside the transaction (no check-then-write races). Withdrawals respect each role's rolling-24 h limit; keep an audit trail of who withdrew what.

**Idempotency.** `requestId` (per player) makes every money/share/membership `POST` replay-safe; income batches are idempotent by `batchId` and per-business `seq` (a `seq` at or below the stored one is ignored).

**Income validation.** Accept income only from a business assigned to that company **and** owned by the reporter. Cap each business with a token bucket sized from the game's real maximum earn rate (e.g. `incomeCapPerBizPerDay` per 90 s game day, burst 2×) and cap per company per day; reject (not clip silently) the excess with `over_cap`. Reject non-finite, negative or absurdly large amounts and batches older than a set age. Compare reported income with the player's synced saves over time and flag outliers. Newly assigned businesses get a probation cap.

**Wallet deposits.** Credit only after `confirm` and only when the **stored synced save** shows cash reduced by at least the amount (minus income tolerance). One deposit per `requestId`; expire pending ones; per-day deposit and withdrawal limits; never credit from a client assertion alone. Because saves are client-authored, treat wallet money as the exposure and bound it with limits and monitoring.

**Anti-manipulation for the stock market.**
- **Self-trade and wash-trade prevention:** reject an order that would cross a resting order of the same player (`self_trade`); also link accounts that repeatedly trade only with each other (same company members, same IP/device) and block or flag round-trips between them.
- **Order and position limits:** max order size as a % of shares (`maxOrderPctOfFloat`), max open orders per player, max position per non-founder (`maxPositionPct`), minimum tick and lot sizes, limit-price sanity (no orders far from the market).
- **Daily price bands and circuit breakers:** the price may move at most `dailyPriceBand` from the day's reference price; breaching it, or a rapid multi-% move within minutes, **halts** the stock for a cooling period; market orders trade only against resting limits inside the band; no trading against stale prices.
- **Rate limits:** per-player orders per minute and cancel/replace churn limits (spoofing and layering), per-IP limits on the whole `api/companies` namespace.
- **Issuing limits:** at most `issueMaxPctPer24h` of shares per day and a rolling weekly cap; issues are public, appear in the ledger and cap table, and cannot be reversed; no issuing to a single player at a discount.
- **Dividend limits:** at most `dividendMaxPctOfPrice` of the share price per payment, only from the bank balance, a minimum gap between payments, and none within a cooling window after an issue or a halt (prevents dumping the bank to inflate the price and sell into it).
- **Insider/founder rules:** founder and officers cannot sell more than a set % of their holding per day for the first N days; related-party trades are disclosed in the cap table history.
- **Audit logs:** an append-only log of every order, fill, cancel, issue, dividend, withdrawal, role change, invite and removal with player id, IP and timestamp, retained for review; moderators can halt a stock or freeze a company bank.
- **Fair settlement:** price-time priority; fills at the resting order's price; wallet escrow before an order rests; shares reserved before a sell rests.

**Privacy and abuse.** Show other players only their GLL ID name; escape everything the client displays (the client escapes all server strings); apply the existing session and `x-ow` checks to all mutating requests; no secrets or hostnames in responses.

---

## Before enabling (privacy.html and terms.html)

Do these **before** setting `enabled: true` in production. Not done now: `privacy.html` and `terms.html` currently (correctly) say there are no accounts and saves are local-only for the standalone game. Update them in the same release that turns companies on, and bump their `LAST UPDATED` dates:

1. **Privacy: data collected.** The hosted site now stores, per player, for companies: GLL ID name, company membership and role, invites sent and received, the business ids/names/cities assigned, bank ledger entries (with member names), wallet balance and deposits/withdrawals, orders, fills, share positions, dividends, and audit logs including IP and timestamps. State retention periods and who can see what (members see the company's members, businesses and ledger; all players see tickers, prices, the order book and the company name; the cap table shows holders' GLL ID names).
2. **Privacy: server-side computation.** Say the server reads the synced save to compute net worth for founding and to validate deposits and income, and that the game uploads income reports for businesses placed in a company.
3. **Privacy: sharing and deletion.** Say names are visible to other players, how to leave/delete (leaving a company, NEW GAME deleting the account save; what happens to a deleted player's shares, orders, bank contributions and ledger rows: recommend retain pseudonymised ledger rows, liquidate or transfer the shares).
4. **Terms: play money only.** Company bank, wallet, shares, dividends and prices are play money with no cash value; no real-money deposit, withdrawal, trade or transfer; shares are not securities or investments.
5. **Terms: conduct.** Prohibit wash trading, price manipulation, collusion, multi-accounting, impersonation, offensive names, exploiting bugs; state that Gamble Limited may halt stocks, freeze banks, reverse or void trades, remove members/companies and suspend accounts, and that the server's records are authoritative.
6. **Terms: availability.** Companies and stocks may be paused, reset or changed without notice; balances may be adjusted for abuse or rollbacks.
7. **Both pages:** update the "no accounts" and "saves stay in this browser" wording to distinguish the standalone/GitHub Pages game from the hosted site with GLL ID, as the in-game PRIVACY/TERMS boot modals (`js/render/night.js`) already do for saves; keep them true to the behaviour. The CI `legal` check requires the `LAST UPDATED: YYYY-MM-DD` line and the links.
8. **Ops:** confirm Content-Security-Policy allows only same-origin `api/...` for these calls (no new external hosts are used), then enable by returning `enabled: true` from `api/companies/status`.

## Testing

`node scripts/companies-test.mjs` starts the test-only mock (`scripts/companies-mock.mjs`, in-memory `/api` plus this repo's static files) and drives Playwright Chromium: with no `/api`, with an `/api` lacking the endpoint (no UI, no console errors, exactly one status request), with `enabled:false` / an unsupported protocol, and with a full mock and two simulated players for every flow above. The game never loads the mock.
