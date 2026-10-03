# Roadmap

Ideas and scoped-but-not-built features, so they survive between sessions
instead of living only in chat history. Nothing here is committed to a
release until it's actually built — see [CHANGELOG.md](../CHANGELOG.md)
Unreleased for what's real.

## Scoped, not yet built

- **Suggested quantity on approve.** Next to the Quantity field on a
  pending idea, show `floor(risk.max_loss_per_trade / max-loss-per-contract)`
  (capped by `risk.max_contracts`) as a hint, with a one-click "Use" to fill
  it in. No new setting — just surfaces the existing risk limit as a number
  instead of leaving sizing purely up to whatever Muse (or a manual order)
  sent. Mockup: https://claude.ai/artifact/LhF4SsiLuQDcskNF3PQ2UD

- **Pre-order margin check.** Before an order can be approved/submitted,
  check the broker's real buying power against the order's real margin
  requirement (tastytrade `dry-run`'s `buying-power-effect`, already
  fetched but currently non-blocking — see "Known gaps" below) and block
  if it doesn't fit, instead of relying on the scorecard's fixed virtual
  cash. Same mockup as above shows the UI (margin-required vs.
  available-buying-power block, OK/tight/insufficient states).
  Open questions before building: should "Use suggested" auto-cap at
  `min(suggested, max-affordable-by-margin)`, or show both numbers and
  let the owner decide; does "tight" (>80% of buying power) deserve a
  visible warning or only true insufficiency should block.

- **Conflicting-leg guard on opening orders.** Before accepting ANY
  opening order (BTO/STO) — from a Muse idea or a manual order, once
  Build exists — check its legs against currently open positions. If a
  leg's symbol+expiry+strike+type already exists in an open position
  (either side), reject the opening order; only a closing order (BTC/STC)
  against that exact existing leg is allowed. Example: already short the
  SPX 7600P — a new idea or manual order that would also open the 7600P
  (buy or sell) is blocked; only closing the existing 7600P short is
  allowed. Prevents Muse (or a manual mistake) from quietly doubling up
  or fighting an existing position on the same contract.

## Known gaps (found, not yet closed)

- The tastytrade paper-account mirror's `dry-run` already returns a real
  margin/buying-power check, but `mirrored.js` only appends a rejection as
  a warning string — it never blocks the order. The scorecard (BoldTick's
  real source of truth for fills) has its own fixed virtual cash pool and
  doesn't check real margin at all. This is the gap the margin-check item
  above closes; it needs to exist before this touches a live (non-paper)
  account.
