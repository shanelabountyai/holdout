# #28 Holdout — experimentation platform — decisions

Made by Claude on 2026-11-13 while Shane was away. Each is a default he can change.

| ID | Problem | Options | Decision | Change it |
|---|---|---|---|---|
| D-01 | Base | foundation clone, standalone | **foundation** — orgs, API keys, audit log already built | standalone if you want a lighter repo |
| D-02 | Peeking | fixed-horizon only, sequential (always-valid) | **sequential**, fixed-horizon shown alongside | — |
| D-03 | Oracle | Python scipy/statsmodels | **yes**, test-only | — |
| D-04 | Bayesian readout | v1, later | **later** | — |
| D-05 | Name / number | Holdout, #28 | as stated | rename before repo creation |
| D-0B | Foundation billing module | keep, remove via `check-modules` | **remove** — nothing here is sold as a subscription; other modules kept (Holdout needs `apikeys` for ingest) | merge the module back |
| D-06 | Local Phase 0 verification: the sandbox's egress blocks `binaries.prisma.sh` (no schema engine for `prisma migrate deploy`) and `apt.postgresql.org` | skip local DB checks and trust CI; build prisma-engines from source; local shim that applies `prisma/migrations/*/migration.sql` with psql and writes `_prisma_migrations` rows with the same sha256 checksum | **shim, local only** (lives in `node_modules/.bin` + `/opt`, never committed); Postgres 17.11 from the `@embedded-postgres/linux-x64` npm binaries. GitHub Actions CI (real Prisma, `postgres:17`) stays the gate | nothing to change in the repo; on a normal laptop the README quickstart runs as written |
| D-07 | Template test `tests/unit/foundation-tools.test.ts` "rls:policies module guard (F-09)" expects every module in `MODULES` to have a schema file, so it fails in any clone that removed billing (D-0B) | keep billing; patch the clone's copy; skip the test | **patch one line**: compare against modules whose `prisma/schema/<m>.prisma` still exists (marked `// holdout:`). `foundation:drift` stays clean (tests/unit is not template-owned). Reported upstream for Shane | revert the line once the template ships the fix |
| D-08 | Setting `main` as the GitHub default branch (KICKOFF says `gh repo edit --default-branch main`) | do it; leave `kit` as default | **left for Shane**: this run may use `gh` for search only and makes no repo-settings changes. `main` is pushed; PR #1 targets `main` explicitly | Settings → General → Default branch → `main` |
