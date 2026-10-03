# Releasing BoldTick

## Release numbers: MAJOR.MINOR

Every release has a two-part number such as **0.4** or **1.2**, tagged in git as `v0.4`. `package.json` stores it as `0.4.0` only because npm requires three numbers; the last number is always 0.

| Bump | When | Examples |
| --- | --- | --- |
| **MAJOR** | Something that needs action from Muse or from you before it works again, or a product milestone | A Muse API endpoint or field removed, renamed or changed in meaning · stored data in `data/paper/` that needs migrating · going from paper testing to daily use (1.0) |
| **MINOR** | Everything else: features, fixes, UI, settings, docs that ship with code | A new setting with a default · a new optional field in an API response · a new endpoint · a bug fix |

**Milestones.** 0.x is the build-and-test stage. **1.0** marks Paper Desk in daily use with the real Muse, deployed behind nginx. Any move toward real-money trading would be its own major release, and only after an explicit decision; the code has no path to a real account today.

**Muse compatibility.** Within one major release, the Muse API only grows: new endpoints and new optional fields, never removals or changed meanings. Muse can read `version` from `GET /api/paper/status` and should stop and report a major it doesn't know.

## Recording changes

Every change adds a line under `## [Unreleased]` in [CHANGELOG.md](../CHANGELOG.md), grouped as **Added**, **Changed**, **Fixed**, **Removed** or **Security**. Write it for the person using BoldTick, not for the code: what changed and what it means for them.

## Cutting a release

1. `npm test` passes, and the change has been tried on your machine (live data, market hours when it matters).
2. `CHANGELOG.md` has the release's lines under `## [Unreleased]`.
3. Run one of:
   ```powershell
   npm run release -- minor              # 0.4 → 0.5
   npm run release -- major              # 0.5 → 1.0
   npm run release -- minor --dry-run    # show what would happen, change nothing
   ```
   The command refuses to run with uncommitted changes, an empty Unreleased section or failing tests. It then:
   - turns `## [Unreleased]` into `## [X.Y] — today's date` and opens a fresh, empty Unreleased section
   - sets `version` in `package.json` (and `package-lock.json`) to `X.Y.0`
   - commits as `Release vX.Y` and creates the annotated tag `vX.Y`
4. Push when you're ready: `git push --follow-tags`.
5. Restart BoldTick. The header, the startup summary and `/api/paper/status` show the new number.

## Fixing a release

There are no patch numbers. A fix ships as the next minor release (for example, 0.5 fixes 0.4) with a **Fixed** entry. To go back, check out the previous tag (`git checkout v0.4`) and restart.
