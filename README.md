# BoldTick

BoldTick is Bikash's new trading website, built on live tastytrade market data. It has two parts:

- **Analyze** (`/analyze/`) — read-only live views: GEX (gamma exposure by strike, flip, walls, max pain, signal read) and Chain (live two-sided option chain). No simulated or sample data; nothing here places an order.
- **Paper Desk** (`/paper/`) — Muse (an AI trading agent) sends trade ideas and action signals to BoldTick's API; Bikash approves, rejects and closes them on the website.
  - **A live-market scorecard is the source of truth.** Every order fills only when the live price reaches its limit, and positions, P&L and signals come from live prices.
  - **Every order is mirrored to a tastytrade paper (sandbox) account.** Nothing can reach a real-money account.

Current release: **0.4**. See [CHANGELOG.md](CHANGELOG.md) for every release and [docs/RELEASING.md](docs/RELEASING.md) for how numbers are chosen and releases are cut.

## Quick start

```powershell
npm install
copy .env.example .env      # then fill it in (see docs/PAPER_DESK.md, step 1)
npm test                    # offline tests
npm start                   # http://127.0.0.1:3100/analyze/  (GEX, Chain)
                             # http://127.0.0.1:3100/paper/    (Paper Desk)
```

- [docs/PAPER_DESK.md](docs/PAPER_DESK.md): setup, the tastytrade paper account, what to test, connecting Muse, the API reference
- [CHANGELOG.md](CHANGELOG.md): what's in each release
- [docs/RELEASING.md](docs/RELEASING.md): release numbers (MAJOR.MINOR) and `npm run release`

## What's where

| Path | What |
| --- | --- |
| `server.js` | Entry point (port 3100) |
| `src/tastytrade/` | Live market data: OAuth, option chains, DXLink streaming, live chain store |
| `src/paper/` | Paper Desk: API, auth, ideas and validation, settings, action engine, scorecard and paper-account mirror, storage |
| `src/gex.js` | GEX / DEX / charm / max-pain math — used by `tt:smoke`, the Analyze API, and `paper:muse-sim` |
| `src/analyze/` | Read-only live API for the Analyze tabs (GEX, Chain) |
| `public/analyze/` | The Analyze website (GEX, Chain) |
| `public/paper/` | The Paper Desk website |
| `scripts/` | `tt-smoke` (live data check), `paper-spike` (paper account check), `muse-sim` (Muse stand-in), `release` |
| `test/` | Offline tests: a fake tastytrade API, DXLink and sandbox, plus a test-only market |
| `data/paper/` | Records (git-ignored), with daily backups |

## Commands

| Command | Does |
| --- | --- |
| `npm start` | Run BoldTick |
| `npm test` | Offline tests (no network, no credentials) |
| `npm run tt:smoke` | Live tastytrade data check (`-- --compare https://127.0.0.1:3000` to compare with TradeForge) |
| `npm run paper:spike` | Paper-account check (`-- --submit` places and cancels a 1-lot) |
| `npm run paper:muse-sim` | Muse stand-in: sends ideas built from live prices |
| `npm run release -- minor` | Cut the next release (see docs/RELEASING.md) |
