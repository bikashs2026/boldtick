# Changelog

Every BoldTick release, newest first. Release numbers are **MAJOR.MINOR**. [docs/RELEASING.md](docs/RELEASING.md) says what bumps which number and how to cut a release. Work that isn't released yet goes under **Unreleased**.

The running version is shown in the website header, in the `npm start` summary and as `version` in `GET /api/paper/status`.

## [Unreleased]

### Added
- **Analyze tabs** (`/analyze/`): GEX and Chain, read-only live views built on the same tastytrade feed and `src/gex.js` math as the rest of BoldTick — no simulated or sample data. GEX shows the KPI strip (regime, gamma flip, call/put wall, max pain, expected move), a per-strike call/put GEX ladder, a signal read, pin & range, and delta/charm exposure, plus a session log built from what the page itself has observed (not invented history). Chain shows a live two-sided option chain with a strike picker and a selected-strike detail panel. Both poll the live feed every 10–15 s. New `GET /api/analyze/{quote,expirations,chain,gex}/:symbol`, owner-login only, nothing here places or touches an order.
- `src/gex.js`: `computeGexSnapshot()` now also returns `byStrike`, the per-strike GEX profile that powers the Analyze ladder (the math already existed internally; this only exposes it).
- Positions and orders now echo `client_idea_id` (Muse's own id for the idea), so Muse can match a position or order back to the idea it sent without keeping its own server-id map. Already stored on the idea; this denormalizes it the same way `thesis`/`earnings_date` already are.
- GEX ladder (`/analyze/`): defaults to the nearest 25 strikes on each side of spot instead of the full chain (adapts to each symbol's own strike spacing — a %-of-spot window didn't, since SPX's dense strikes and a stock's wide strikes need very different windows), with a "Load more" toggle to expand to every strike (and "Show less" to collapse back). Client-side only — no API change.
- **Net premium flow** (`/analyze/`, GEX tab): a new panel showing live call/put premium flow for the symbol and expiry on screen, built from real tastytrade Trade prints rather than periodic chain polling — each print's size comes from the delta in the contract's cumulative day volume (never DXLink's `size` field alone, which is just the last print and can miss or batch ticks), priced at the print itself, and tagged buy- or sell-aggressor by comparing the print to the prevailing bid/ask at that moment. Bucketed by 5-minute ET slots for the session; resets each new trading day. Stat tiles (call/put premium, net flow, last print), a dual-axis chart (cumulative flow left, spot overlaid right) with aggressor-colored volume bars, and a Raw-volume/Aggressor-adjusted toggle (client-side, no extra call — both are always computed). New `GET /api/analyze/flow/:symbol`, owner-login only, read-only like the rest of Analyze. `src/tastytrade/hub.js` now emits a `trade` event for every Trade tick (previously only underlyings emitted `quote`); `src/analyze/premiumFlow.js` is the new tracker.
- `GET /api/paper/chain/:symbol` (and `/paper/api/chain/:symbol`): Muse can now pull a symbol's full live option chain with its own `X-API-Key`, same auth tier as the existing `/quote` and `/expirations`. Muse had price-check (needs specific legs already in hand) and quote/expirations (no strikes), but no way to see a chain it didn't already know the strikes for — it was hitting the owner-only `/api/analyze/chain/:symbol` instead, which bounces at nginx's Basic Auth before it ever reaches the app. `?expiry=` defaults to the nearest listed expiration; `?strikeLow=&strikeHigh=` narrow the range. Reuses each market source's existing `getChain()` — no new market-data code.

### Fixed
- Trade idea cards: an idea that couldn't be priced (for example, a malformed iron condor) showed max profit "open-ended" and max loss "stock risk". It now shows "—" for both; "stock risk" appears only on covered structures.
- tastytrade error messages: a rejection's specific reason (tastytrade's nested `errors` list) was dropped, leaving only its generic wrapper message (for example "One or more preflight checks failed" with no detail). The specific reason is now included.
- Net premium flow's Raw-volume/Aggressor-adjusted control: the two options were styled as faint dashed-border info pills (meant for passive labels elsewhere on the page), so the unselected one was barely legible. Replaced with an actual switch between the two labels; the active label is highlighted instead.
- A limit price off the exchange's tick (for example 1.28 on an SPX option, which only trades in $0.05/$0.10 increments) was accepted at idea creation and at approve — validation and risk math ran against the un-rounded number, and it was only rounded to a valid tick silently, at the very end, right before the order was sent. Now rejected as invalid at both creation and approve, before any of that runs.

## [0.4] — 2026-10-03

BoldTick becomes its own project.

### Added
- Standalone repository. Releases 0.1–0.3 were built inside the TradeForge workspace; BoldTick no longer depends on TradeForge or its Schwab code.
- Release numbering: this changelog, [docs/RELEASING.md](docs/RELEASING.md), and `npm run release -- minor|major`, which dates the Unreleased section, bumps the version, commits and tags `vMAJOR.MINOR`.
- The version is shown in the website header (next to "Paper Desk"), in the startup summary and as `version` in `/api/paper/status`, so Muse can check which release it is talking to.

### Changed
- The entry point is now `server.js` (`npm start`), previously `server-paper.js`.
- `.env.example` covers only BoldTick: the read-only tastytrade grant, Paper Desk and the paper account.

## [0.3] — 2026-10-03

Live-market scorecard, with the tastytrade paper account as a mirror.

### Added
- **Scorecard** (source of truth for fills, positions and P&L). An order fills only when the live mid (or natural, per Settings) reaches its limit, at the limit, during market hours. It records the live prices at the fill. Day orders expire at 4:00 PM ET, and positions settle at intrinsic value from the live underlying.
- **Paper-account mirror.** Every entry, cancel and close is copied to the tastytrade paper (sandbox) account, and each order shows its paper-account copy. A close is skipped when the entry never filled there. Sandbox resets and outages are recorded and never block or change the scorecard.
- Settings → Fills: fill model (mid / natural).
- `GET /api/paper/expirations/:symbol`.
- The website header shows the fill model and the paper account's status. The Orders tab shows live prices at each fill and the paper-account column.

### Changed
- Fill checks every 10 s (was 30 s).
- Closing prices from mid/natural round toward marketable: up when paying, down when collecting.
- The Muse stand-in (`npm run paper:muse-sim`) builds ideas from live prices and listed expirations.

### Removed
- Simulated market, simulated clock, `paper:sim` and the dev market endpoint. The app refuses simulated data at runtime; the test-only market lives in the tests.

## [0.2] — 2026-10-03

Paper Desk: Muse ideas → approval on the website → paper orders.

### Added
- Muse API with its own key: create ideas, push signals, price structures, read ideas, orders, positions, signals and the event feed (`/api/paper/...`).
- Owner-only actions on the website: approve, reject, close (mid / natural / limit), cancel, sync, kill switch. Muse's key can never do these.
- Idea validation: request schema, shape per structure (iron condor, bull put spread, diagonal, calendar, covered strangle, covered call), strikes listed in the live chain, recomputed max loss and breakevens, live mid and natural, short deltas.
- Settings page: risk limits, entry rules, exit rules (per structure), alerts, timing and Muse switches. Each limit can block, warn or be off. Saves are versioned and have a change history.
- Action engine: take profit, stop, gamma warning, expiry-day close; hysteresis so signals don't flicker; Muse's signals shown alongside.
- Order sync, cancel of unfilled entries (10 min for 0DTE, 3:45 PM otherwise), reconcile against broker positions, a daily-loss kill switch that resets the next day, and idempotent ideas and signals.
- Website: dashboard, trade ideas, orders, action feed, closed trades, settings, browser alerts, a PAPER TRADING banner.
- tastytrade paper-account adapter with paper-only guards (cert host only, `TT_PAPER_*` credentials only, never equal to production, account must be visible), plus `npm run paper:spike` to check the sandbox.
- JSON-file storage with atomic writes, audit log, daily backups.

## [0.1] — 2026-10-03

Live market data from tastytrade.

### Added
- tastytrade client: OAuth refresh (15-min tokens), nested option chains, REST quotes, DXLink quote token. Sends the required User-Agent, re-authenticates on 401, backs off on 429.
- DXLink streaming client: setup, auth, compact feed, keepalive, reconnect with a fresh token, and subscriptions replayed after a reconnect.
- Live market-data hub: Quote / Trade / Greeks / Summary kept in memory, with chains and quotes returned in Schwab's JSON shape (so the existing GEX math in `src/gex.js` works unchanged). Unused contracts are dropped after 10 min.
- `npm run tt:smoke`: live check of quotes, expirations, chain fill and GEX levels, optionally side by side with a running TradeForge.
