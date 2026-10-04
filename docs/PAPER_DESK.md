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
| `POST /build/price` | owner | Live preview price + risk for a structure being built on the Build tab — `{ symbol, structure, expiry, credit_or_debit, quantity?, legs: [{action,type,strike,expiry,qty}] }` → `{ symbol, underlying, dte, legs: [...with occ/bid/ask/mid/delta/iv/gamma/theta/vega], entry, risk }`. Each leg carries its own `qty` (a leg missing it falls back to the top-level `quantity`, then 1) — most structures keep every leg equal, but a butterfly's body is legitimately double a wing's. Same `openingPrice`/`riskProfile` math as `/price-check` and approve, so nothing shown here can disagree with what Submit enforces. No side effects. |
| `POST /build/submit` | owner | Submits a Build tab structure — `{ ...same leg/price fields (each leg's own qty), limit_price, quantity?, thesis?, destination: "ideas" \| "broker", confirm? }`. `destination: "ideas"` creates a pending idea (201) exactly like `POST /trade-ideas`; `destination: "broker"` creates the idea and immediately runs the same `approve()` path the Execute tab's Approve button uses (202 with `{ idea, order }`; 409 `reprice_required` on a stale price, same as approve) |
| `GET/POST /build/templates` · `DELETE /build/templates/:id` | owner | Reusable structure shapes — each leg stored as a strike *offset* from the underlying at save time, re-snapped to the nearest live listed strike whenever loaded |
| `GET/POST /build/drafts` · `DELETE /build/drafts/:id` | owner | One concrete saved order (exact strikes/price/quantity/thesis) to revisit later, unlike a template |
| `GET /settings[?meta=1]` · `PUT /settings` | both · owner | `{ version, values: { "risk.max_loss_per_trade": 800 }, modes: {…}, exit_per_structure: {…} }` |
| `GET /settings/history` · `POST /settings/reset` | owner | Change log · defaults |
| `POST /positions/apply-settings` | owner | Re-apply exit rules to open positions |
| `POST /sync` · `POST /engine/run` · `POST /kill-switch` | owner | Refresh now · run the rules now · `{ on, reason? }` |
| `GET /status` | both | Fill model, paper account (mirror) status and balance, data source, clock, kill switch, counts |

## 6. Files and tests

- `data/paper/`: `ideas.json`, `orders.json`, `positions.json`, `settings.json`, `state.json`, `scorecard.json` (the scorecard's fills and ledger) and `mirror.json` (each order's paper-account copy). The append-only logs are `events.jsonl`, `signals.jsonl`, `audit.jsonl` (every call to tastytrade included) and `settings-history.jsonl`. All of it is git-ignored. A daily copy goes to `backup/YYYY-MM-DD/` after 5 PM ET, and 30 days are kept.
- `npm test` runs 41 offline tests with no network and no credentials. They use a test-only market (`FakeMarket`) and a fake paper account that follows tastytrade's published sandbox rules. The app refuses both at runtime.
- The website's **Build** tab (`/build/`, owner-only) is a manual structure builder on top of this same API — pick a structure (or go `custom`, up to 4 free legs), strikes auto-load from the live chain, and the P&L chart draws both an at-expiration payoff line and a modeled T+0/time-decay line (Black-Scholes, `src/paper/blackscholes.js` — used only for that line; every other number on the page and everything Submit enforces comes from live bid/ask). A `custom` structure's risk (max profit/loss, breakevens) is computed generically from the legs themselves (`genericRiskProfile` in `src/paper/pricing.js`), not assumed, so an unbalanced/naked combination correctly comes back undefined-risk.
  - Expiry and Qty live in the per-leg Legs table, not as top-level controls. Expiry is editable on every leg: Custom/Calendar/Diagonal allow each leg its own independent expiry; every other structure (including Butterfly and RSB) syncs all legs to whichever expiry was just changed, re-snapping strikes to that expiry's chain. Qty is editable per leg too, syncing across all legs on change — except Butterfly, whose body qty is read-only and always exactly double its wings'.
  - The Legs panel also shows a net delta / net theta readout for whatever's currently built, from each leg's live Greeks weighted by its qty and buy/sell sign.
  - **Butterfly** is 3 legs (two wings at qty N, one body at qty 2N, body strike between the wings, one expiry, debit only). **RSB (Ratio Superbull)** is 3 legs (a debit call spread plus a short put, one shared expiry, no forced credit/debit direction). Both reuse `genericRiskProfile`/`payoffAtExpiry` (`src/paper/pricing.js`), which are weighted by each leg's own qty so a butterfly's 1-wing/2-body shape prices and risks exactly, not via an approximation.
  - **Custom and RSB have no shape rule forcing a credit/debit direction** (every other structure does), so which way a given set of legs actually nets is never trusted from the caller — `/build/price` and `/build/submit` both recompute it from the live quotes just fetched (`naturalCreditOrDebit()` in `src/paper/pricing.js`) and use that instead, because `openingPrice`/`riskProfile` assume whatever direction they're handed is already correct and silently produce a wrong max profit/loss/breakevens otherwise. The Build tab's "Price is Credit/Debit" field shows the server's answer for these two but can't be hand-picked for them.
  - **Calendar** and **Diagonal** list the long (buy) leg first, short (sell) leg second, and both legs get a real strike selector and an editable Call/Put pill (Diagonal is not call-only — `checkShape`'s diagonal case in `src/paper/validate.js` accepts either type, same shape rule as Calendar, just without the same-strike requirement). Calendar's two legs must always match, so changing either leg's strike or type syncs the other leg to match. Diagonal's legs keep independent strikes — only expiry and qty sync, same as every other non-crossExpiry structure.
