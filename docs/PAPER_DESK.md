# Paper Desk — setup and testing

Paper Desk is BoldTick's paper-trading website. Muse sends trade ideas and action signals to its API. Bikash approves, rejects and closes them on the website.

**Everything runs on live market data.** There is no simulated market or clock.

- **The scorecard is the source of truth.** Paper Desk fills each order only when the *live* tastytrade price reaches its limit, during market hours. It marks positions from live bid/ask and keeps the P&L, signals and closed-trade stats.
- **The tastytrade paper account is a mirror.** Every approved order, cancel and close is copied to your tastytrade paper (sandbox) account. The sandbox's fills are artificial: limits under $3 fill at once and $3+ never fill. It also wipes positions every 24 hours. So its results are shown next to each order for comparison and never change the scorecard.

It is part of BoldTick (`server.js`, port 3100) and runs separately from TradeForge (port 3000). Nothing in it can reach a real-money account: prices come from your read-only production grant, and orders go only to the paper host. The running release is shown in the website header and in `/api/paper/status`; see [CHANGELOG.md](../CHANGELOG.md).

## 1. Setup

```powershell
npm install
copy .env.example .env
```

Fill in `.env`:

```ini
# Website login
PAPER_OWNER_USER=bikash
PAPER_OWNER_PASSWORD=<at least 8 characters>

# Muse's key for the Paper Desk API (different from today's MUSE_API_KEY)
MUSE_PAPER_KEY=<64 hex characters>

# Live prices: your existing read-only production grant (already set for TradeForge)
TASTYTRADE_CLIENT_SECRET=...
TASTYTRADE_REFRESH_TOKEN=...

# tastytrade paper (sandbox) account — see step 2
TT_PAPER_CLIENT_SECRET=...
TT_PAPER_REFRESH_TOKEN=...
TT_PAPER_ACCOUNT=...
```

Generate the key on Windows without OpenSSL:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 2. The tastytrade paper account

1. Open tastytrade's [sandbox account tool](https://developer.tastytrade.com/docs/sandbox/tools). Create a **sandbox user**, which is separate from your real login (password of 12+ characters).
2. Signed in there, create a **customer record** and a **funded account**. That account number is `TT_PAPER_ACCOUNT`.
3. In the same tool, create an **OAuth application** (scopes read + trade) and a **personal grant**. Those give you `TT_PAPER_CLIENT_SECRET` and `TT_PAPER_REFRESH_TOKEN`.
4. Check it works before trading:
   ```powershell
   npm run paper:spike             # login, account, chain, and a dry-run order
   npm run paper:spike -- --submit # also places a far-OTM 1-lot, watches it 15 s, cancels it
   ```
   If the dry-run is rejected over the price format, add `TT_PAPER_PRICE_STYLE=signed`.

**Paper-only guards.** The paper connection refuses to start if:
- the host isn't exactly `https://api.cert.tastyworks.com`
- a `TT_PAPER_*` value is missing
- the paper token or secret equals the production one
- the account isn't visible to the paper login

tastytrade also rejects sandbox credentials on production. Without `TT_PAPER_*` in `.env`, Paper Desk runs scorecard-only and says so in the header.

Sandbox facts ([tastytrade docs](https://developer.tastytrade.com/docs/sandbox/)): limits under $3 fill immediately, $3+ never fill, market orders fill at $1, and the environment resets every 24 hours.

## 3. Run it

```powershell
npm start            # http://127.0.0.1:3100/paper/  — log in with PAPER_OWNER_USER / PAPER_OWNER_PASSWORD
```

The startup summary shows the fill model, the paper account, the data source and whether the market is open. Outside 9:30 AM–4:00 PM ET, ideas can be reviewed and approved, but nothing fills until the open (quotes are stale). The entry-window limit in Settings also blocks new ideas outside 9:35 AM–3:30 PM ET. Set that limit to *warn* if you want to try the flow on a weekend; orders will still wait for the open.

Until the real Muse can reach the site, use the Muse stand-in. It builds ideas from **live** prices and sends them through the same API:

```powershell
npm run paper:muse-sim              # 4 ideas, then a signal for each open position every 30 s
npm run paper:muse-sim -- --once    # just the ideas
```

It sends a nearest-expiry SPX iron condor (~12Δ shorts), an AMD bull put spread, an AMD diagonal with an earnings date inside the window, and one deliberately invalid iron condor (to show the 422).

**Things to try (market hours)**

- [ ] Trade ideas: cards with live mid, max loss, breakevens, short deltas and warnings. The invalid one is under *Show → Invalid*.
- [ ] Approve at or below the live mid (credit): the scorecard fills within about 10 s. The Orders tab shows the fill with the live mid/natural at that moment, and the paper account's copy beside it.
- [ ] Approve with a limit richer than the mid: the order works until the live price reaches it, or is cancelled after 10 min (0DTE) or at 3:45 PM.
- [ ] Change the limit by more than 10% from the live mid: you get the "re-confirm" choice.
- [ ] Dashboard: positions mark from live prices; signals fire as the market moves (take profit, stop, gamma warning after 2:00 PM, close signal after 3:30 PM on expiry day).
- [ ] Close at mid, natural or your own limit. The close is mirrored only if the paper account actually filled the entry (otherwise it shows *skipped*).
- [ ] Kill switch on: Approve is refused, Close still works.
- [ ] Settings: fill model (mid or natural), max loss per trade, modes, per-structure exit rules, *Apply exit rules to open positions*.
- [ ] Enable alerts (header button) for browser notifications on new ideas and urgent signals.

## 4. Connecting Muse

Muse runs on its own computer, so it **cannot reach `127.0.0.1` on yours**. To connect the real Muse, either:
- expose port 3100 temporarily through a tunnel (Tailscale Funnel is closest to your current setup), or
- deploy Paper Desk to the AWS box behind nginx (`PAPER_AUTH_MODE=nginx`), as in the design doc.

Give Muse `MUSE_PAPER_KEY` and the API section below. Muse's key can create ideas, push signals, price structures and read state. It can never approve, reject, close, cancel, change settings or touch the kill switch.

## 5. API at a glance

Muse uses `/api/paper/...` with header `X-API-Key`. The website uses `/paper/api/...` with the login plus `X-Requested-With: paper-desk`.

| Method and path | Who | What |
| --- | --- | --- |
| `POST /trade-ideas` | Muse | Create an idea (201; 200 with the original on a repeated `client_idea_id`, so send a new id for a corrected idea; 422 invalid) |
| `GET /trade-ideas[?status=pending,all,…]` | both | List ideas |
| `GET /trade-ideas/:id` | both | One idea, with its order and position |
| `POST /trade-ideas/:id/approve` | owner | `{ quantity?, limit_price?, confirm? }` → 202 with the order |
| `POST /trade-ideas/:id/reject` | owner | `{ reason? }` |
| `GET /orders[?status=…]` · `POST /orders/:id/cancel` | both · owner | Orders; each carries `mirror` (its paper-account copy) and `fill_context` (live prices at the fill) |
| `GET /positions[?status=closed]` · `GET /positions/:id` | both | Positions with live marks, P&L and badge |
| `POST /positions/:id/action` | Muse | Signal `{ action, reason, current_value?, pnl_dollars?, client_signal_id? }` |
| `POST /positions/:id/close-request` | owner | `{ price_mode: mid \| natural \| limit, limit_price? }` |
| `GET /signals` · `GET /events?after=<id>` | both | Action feed · event feed with cursor |
| `POST /price-check` | both | Live mid/natural and risk of a structure, no side effects |
| `GET /quote/:symbol` · `GET /expirations/:symbol` | both | Live underlying price · listed expirations |
| `GET /chain/:symbol[?expiry=YYYY-MM-DD][&strikeLow=&strikeHigh=]` | both | Full option chain, one expiry (defaults to the nearest listed). `{ symbol, expiry, underlying, at, source, contracts: [{ type, strike, occ, bid, ask, mid, delta, gamma, theta, vega, iv, oi }] }` |
| `GET /settings[?meta=1]` · `PUT /settings` | both · owner | `{ version, values: { "risk.max_loss_per_trade": 800 }, modes: {…}, exit_per_structure: {…} }` |
| `GET /settings/history` · `POST /settings/reset` | owner | Change log · defaults |
| `POST /positions/apply-settings` | owner | Re-apply exit rules to open positions |
| `POST /sync` · `POST /engine/run` · `POST /kill-switch` | owner | Refresh now · run the rules now · `{ on, reason? }` |
| `GET /status` | both | Fill model, paper account (mirror) status and balance, data source, clock, kill switch, counts |

## 6. Files and tests

- `data/paper/`: `ideas.json`, `orders.json`, `positions.json`, `settings.json`, `state.json`, `scorecard.json` (the scorecard's fills and ledger) and `mirror.json` (each order's paper-account copy). The append-only logs are `events.jsonl`, `signals.jsonl`, `audit.jsonl` (every call to tastytrade included) and `settings-history.jsonl`. All of it is git-ignored. A daily copy goes to `backup/YYYY-MM-DD/` after 5 PM ET, and 30 days are kept.
- `npm test` runs 27 offline tests with no network and no credentials. They use a test-only market (`FakeMarket`) and a fake paper account that follows tastytrade's published sandbox rules. The app refuses both at runtime.
