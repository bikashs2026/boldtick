# Changelog

Every BoldTick release, newest first. Release numbers are **MAJOR.MINOR**. [docs/RELEASING.md](docs/RELEASING.md) says what bumps which number and how to cut a release. Work that isn't released yet goes under **Unreleased**.

The running version is shown in the website header, in the `npm start` summary and as `version` in `GET /api/paper/status`.

## [Unreleased]

### Fixed
- Trade idea cards: an idea that couldn't be priced (for example, a malformed iron condor) showed max profit "open-ended" and max loss "stock risk". It now shows "—" for both; "stock risk" appears only on covered structures.
- tastytrade error messages: a rejection's specific reason (tastytrade's nested `errors` list) was dropped, leaving only its generic wrapper message (for example "One or more preflight checks failed" with no detail). The specific reason is now included.

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
