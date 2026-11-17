# holdout

> Cloned from saas-foundation v1.6.2. Port 8100. Upgrade with `npm run foundation:status`; template-owned paths are listed in the template's plan §3.2.

A Next.js 16 + Prisma 7 + Postgres template with the parts every multi-tenant app rebuilds: magic-link sign-in with TOTP,
orgs and roles, one authorization path, an append-only audit log, share links, cron, and optional billing (Stripe) and
notifications (SMS). Its safety rules are executable: `tests/invariants/` holds INV-01 to INV-28, and CI fails if one breaks.

Design and decisions: `FOUNDATION_SPEC.md`. Milestones and the sync model: `IMPLEMENTATION_PLAN.md`. Releases: `CHANGELOG.md`. Clones: `CLONES.md`.

## Holdout (build log #28)

An experimentation platform on this foundation: PRD, decisions and phase plans are in `docs/holdout/`. Phase 1 is the pure
engine (`src/lib/exp/`, Python oracle in `tools/oracle/`). Phase 2 adds:

- **Experiments** at `/o/[org]/experiments`: variants with weights, a primary metric, guardrails, a minimum detectable
  effect and a planned sample size computed up front (2× the fixed-horizon n for the sequential readout, D-16). Starting an
  experiment freezes its design in the database (HO-01, D-18).
- **Ingest**: `POST /api/v1/ingest` with an API key carrying the `ingest` scope (Settings → API keys):

  ```json
  { "events": [
    { "type": "exposure", "id": "evt-1", "experiment": "checkout-button", "unitId": "user-42", "variant": "treatment" },
    { "type": "conversion", "id": "evt-2", "event": "purchase", "unitId": "user-42", "value": 19.99 }
  ] }
  ```

  Up to 500 events; each `id` makes retries safe. The answer is `{ accepted, duplicates, rejected: [{ index, code, detail }] }`.
- **Assignment config**: `GET /api/v1/experiments` (`read` scope) returns running experiments' salt and variants in order, for
  the same `assign()` the server checks exposures with.

Phase 3 adds the readout on each experiment's page:

- **A decision first**: "Ship B", "Hold: a guardrail moved", "Stop: no variant beats control", "Stop: sample-ratio mismatch",
  "No detectable effect at planned sample size" (against the stored 2× horizon, D-16), "Inconclusive at planned sample size"
  (the same horizon, but the reference fixed-horizon p is below α; D-40), "Keep running", "Keep running: SRM not yet
  checkable" (a winner is not shipped while the split is too small for the SRM check to see an 8% exposure loss; D-41), or
  "not enough data" below 100 units per arm. The numbers behind it follow: units per arm against the weights, the SRM check, each variant
  against control with the always-valid (mSPRT) confidence sequence and p-value, the fixed-horizon test for reference, and
  each guardrail. Looks are daily, by when events were received (D-28). More than two variants use Bonferroni (D-30).
- **SRM blocks the readout** (HO-04): at p < 0.001 no effect is shown. Below the sample where that test has 80% power
  against an 8% loss of one arm's exposures (9 835 units in total for 50/50), the page says "SRM not yet checkable" (D-41).
- **Stop** (owner/admin): ends the experiment and writes `experiment.stopped` to the audit log with the readout as it stood
  at that moment (HO-05). The page then shows that recorded readout and the experiment's history.

Phase 4 adds the client side and a demo:

- **Server SDK** (`src/sdk/server.ts`, TypeScript): `refresh()` loads running experiments from `GET /api/v1/experiments`,
  `variant(experiment, unitId)` assigns locally with the engine's own `assign()` and queues one exposure per unit,
  `track(event, unitId, value?)` queues a conversion, `flush()` posts batches of up to 500 to `POST /api/v1/ingest`. Retries
  keep event ids, so the ingest answers duplicates instead of double counting (D-37). Server-side only: it holds the key.
- **JS snippet** (`sdk/holdout.js`, built from `src/sdk/snippet.ts` by `npm run sdk:build`, 6 747 bytes, global
  `Holdout`): `Holdout.init({ experiments, unitId, endpoint })`, `Holdout.variant(key)`, `Holdout.track(event, value?)`.
  Same `assign()` compiled in. It never holds an API key: the page's server renders the config into the page and relays the
  snippet's events (D-35).
- **Demo site** (`demo-site/`, http://localhost:8101, local only): "Northwind Roasters", a fictional coffee shop testing its
  buy button, "Add to cart" against "Buy now: free shipping". `/` uses the snippet, `/server` renders the variant with the
  server SDK, `/collect` relays events to Holdout with the visitor's id from an HttpOnly cookie (D-38).

  ```bash
  npm run dev            # Holdout on :8100 (after the quickstart below and npm run seed:demo)
  npm run demo:setup     # starts the checkout-button experiment in the demo org, writes a read+ingest key to .env.demo-site
  npm run demo:site      # http://localhost:8101; buy something, then open the experiment in Holdout
  ```

## Holdout case study: the snippet → relay → ingest → readout path, with real numbers

Every number in this section was printed by a command in the repository, run for the Phase 4 PR on 2026-11-16 and rerun
for issue #5 on 2026-11-17 (the readout's wording changed, D-40 and D-41; the case study's statistics did not). The case
study's tables are `npm run case-study` output, committed as `docs/holdout/case-study.json`; CI reruns the study and fails if
the output changes (`tests/sdk/case-study.test.ts`, D-39).

**One function, three places.** HO-01's 1 000 frozen assignment rows (generated by an independent Python MurmurHash3) are
reproduced exactly by the committed snippet run with no Node globals, by the server SDK's `variant()`, and by the snippet
inside Chromium on the demo site (`tests/sdk/vectors.test.ts`, `e2e/demo-site.spec.ts`). In the browser test a visitor's
button from the snippet matches the server-rendered page for the same cookie, and their exposure and purchase arrive in
Holdout through the relay.

**The study.** Three experiments on the demo shop's buy button, planned exactly as the app plans them: baseline 10%, MDE +2
points, α 0.05, power 0.8, so 3 841 units per arm for a fixed-horizon test and **7 682 per arm** (15 364 in total) for the
sequential readout (D-16). Each runs 14 simulated days with 1 200 visitors a day. Visitors are assigned by the server SDK,
every event goes through the real ingest route with a real API key, and the real readout is read at the end of each day.
Traffic and salts are seeded; the seeds were not picked for the story (D-39).

| Experiment | Events sent (exposures + conversions) | Accepted | Rejected | First decisive readout |
|---|---|---|---|---|
| Real effect, 10% → 12% | 16 800 + 2 256 | 19 056 | 0 | day 13: "Inconclusive at planned sample size" |
| A/A, 10% in both | 16 800 + 2 003 | 18 803 | 0 | day 13: "No detectable effect at planned sample size" |
| Broken client, 10% → 12%, 8% of treatment exposures lost | 16 115 + 2 157 | 18 272 | 0 | days 4–8: "Keep running: SRM not yet checkable"; day 9: "Ship"; day 13: "Stop: sample-ratio mismatch" |

What it shows:

- **The A/A never cried wolf.** The always-valid p-value stayed at 1.0000 on all 14 daily looks, and the readout reached
  "No detectable effect" once both arms passed 7 682 units (day 13). In 2 000 simulated A/A experiments with the same daily
  looks, a wrong ship or stop happened in 0.55% + 0.50% of runs (`tests/holdout/readout-sim.test.ts`). Peeking at a
  fixed-horizon test instead rejects 24.90% of A/A runs, against 1.05% for the sequential test (`tests/exp/ho-03-simulation.test.ts`, 2 000 runs).
- **A real effect is not always found, and the readout says so.** This seeded run of a true +2-point lift ended at the
  planned horizon without the sequential test rejecting (day 13: always-valid p 0.1809, observed +1.30 points; day 14:
  p 0.0767, confidence sequence −0.07 to +2.82 points). At the fixed-horizon sample size (day 7, 4 198 / 4 202 units) a
  fixed-horizon test would have said p 0.1634, also not significant. Across 2 000 simulated runs of the same design the
  readout shipped the winner in **85.25%**, ended "Inconclusive" in 11.45% and "No detectable effect" in 2.25%: this run
  is one of the 11%. The readout says "Inconclusive at planned sample size", not "No detectable effect", because the
  fixed-horizon p-value on the last look is below α (0.0106 on day 13, 0.0036 on day 14; D-40). The page shows that
  p-value labelled "reference only, not a decision": reading it after looking every day is the peeking the sequential
  test exists to prevent (D-02), so it never ships a variant.
- **A broken client is caught, late, and is no longer shipped before the split can be judged.** Losing 8% of treatment
  exposures skews the split. The SRM check flagged it and withheld every effect number once p fell under 0.001 (day 13:
  7 683 / 7 278 units, SRM p 0.0009; day 14: p 0.0002). HO-04's p < 0.001 threshold is strict by design (few false
  alarms), so on a small sample it cannot see an 8% loss. The readout now waits until the test has 80% power against that
  loss, **9 835 units in total** for a 50/50 split (D-41): on days 4 to 8 (4 582 to 9 203 units) the sequential test had
  already rejected, and the readout said "Keep running: SRM not yet checkable" instead of "Ship". From day 9 to day 12
  (10 338 to 13 804 units) it said "Ship": at 80% power the check misses one loss in five, and this seeded run is one of
  those until day 13. The lost exposures here were random, so the effect estimate was not biased and "ship" was the
  right call on the underlying data, but a real loss that correlates with the outcome would bias it. Holding the ship
  longer also gives guardrails more data: with refunds 2% → 4%, the simulated true winners are now held in 85.70% of runs
  (67.75% before D-41).

Daily readouts as printed by `npm run case-study` (the effect columns are blank when SRM blocks the readout, HO-04):

#### Real effect: 10% → 12%

| Day | Units (control / treatment) | Purchase rate (control / treatment) | Diff (pts) | Always-valid p | 95% confidence sequence (pts) | Fixed-horizon p | SRM p | Decision |
|---|---|---|---|---|---|---|---|---|
| 1 | 579 / 621 | 10.88% / 10.95% | +0.07 | 1.0000 | −6.25 to +6.39 | 0.9693 | 0.2253 | Keep running |
| 2 | 1,186 / 1,214 | 10.37% / 10.87% | +0.50 | 1.0000 | −3.50 to +4.50 | 0.6898 | 0.5676 | Keep running |
| 3 | 1,774 / 1,826 | 10.09% / 11.39% | +1.30 | 1.0000 | −1.89 to +4.49 | 0.2078 | 0.3861 | Keep running |
| 4 | 2,398 / 2,402 | 10.38% / 11.66% | +1.27 | 1.0000 | −1.49 to +4.04 | 0.1590 | 0.9540 | Keep running |
| 5 | 3,037 / 2,963 | 10.96% / 11.85% | +0.88 | 1.0000 | −1.49 to +3.38 | 0.2828 | 0.3394 | Keep running |
| 6 | 3,629 / 3,571 | 10.91% / 11.93% | +1.02 | 1.0000 | −1.26 to +3.29 | 0.1747 | 0.4943 | Keep running |
| 7 | 4,198 / 4,202 | 10.89% / 11.85% | +0.97 | 1.0000 | −1.14 to +3.07 | 0.1634 | 0.9652 | Keep running |
| 8 | 4,747 / 4,853 | 11.00% / 12.16% | +1.16 | 0.7720 | −0.82 to +3.07 | 0.0755 | 0.2793 | Keep running |
| 9 | 5,321 / 5,479 | 10.92% / 12.10% | +1.18 | 0.6269 | −0.68 to +3.05 | 0.0544 | 0.1284 | Keep running |
| 10 | 5,943 / 6,057 | 10.77% / 12.04% | +1.27 | 0.3981 | −0.50 to +3.03 | 0.0291 | 0.2980 | Keep running |
| 11 | 6,552 / 6,648 | 10.82% / 11.96% | +1.14 | 0.3981 | −0.50 to +2.82 | 0.0398 | 0.4034 | Keep running |
| 12 | 7,181 / 7,219 | 10.69% / 12.05% | +1.36 | 0.1809 | −0.26 to +2.82 | 0.0104 | 0.7515 | Keep running |
| 13 | 7,779 / 7,821 | 10.70% / 11.99% | +1.30 | 0.1809 | −0.26 to +2.82 | 0.0106 | 0.7367 | Inconclusive at planned sample size |
| 14 | 8,371 / 8,429 | 10.57% / 11.99% | +1.42 | 0.0767 | −0.07 to +2.82 | 0.0036 | 0.6545 | Inconclusive at planned sample size |

#### A/A: 10% in both arms

| Day | Units (control / treatment) | Purchase rate (control / treatment) | Diff (pts) | Always-valid p | 95% confidence sequence (pts) | Fixed-horizon p | SRM p | Decision |
|---|---|---|---|---|---|---|---|---|
| 1 | 595 / 605 | 9.41% / 9.26% | −0.16 | 1.0000 | −5.91 to +5.60 | 0.9262 | 0.7728 | Keep running |
| 2 | 1,190 / 1,210 | 9.16% / 9.26% | +0.10 | 1.0000 | −3.62 to +3.81 | 0.9348 | 0.6831 | Keep running |
| 3 | 1,787 / 1,813 | 9.57% / 8.83% | −0.74 | 1.0000 | −3.62 to +2.22 | 0.4399 | 0.6648 | Keep running |
| 4 | 2,385 / 2,415 | 10.19% / 9.15% | −1.04 | 1.0000 | −3.62 to +1.56 | 0.2239 | 0.6650 | Keep running |
| 5 | 3,011 / 2,989 | 10.00% / 9.23% | −0.76 | 1.0000 | −3.07 to +1.55 | 0.3163 | 0.7764 | Keep running |
| 6 | 3,614 / 3,586 | 10.10% / 9.51% | −0.59 | 1.0000 | −2.72 to +1.54 | 0.3996 | 0.7414 | Keep running |
| 7 | 4,213 / 4,187 | 10.04% / 9.72% | −0.32 | 1.0000 | −2.30 to +1.54 | 0.6234 | 0.7767 | Keep running |
| 8 | 4,816 / 4,784 | 9.90% / 9.95% | +0.05 | 1.0000 | −1.81 to +1.54 | 0.9408 | 0.7440 | Keep running |
| 9 | 5,396 / 5,404 | 9.93% / 9.92% | −0.01 | 1.0000 | −1.77 to +1.54 | 0.9796 | 0.9386 | Keep running |
| 10 | 5,992 / 6,008 | 9.88% / 9.84% | −0.04 | 1.0000 | −1.70 to +1.54 | 0.9371 | 0.8839 | Keep running |
| 11 | 6,590 / 6,610 | 9.82% / 9.94% | +0.12 | 1.0000 | −1.47 to +1.54 | 0.8149 | 0.8618 | Keep running |
| 12 | 7,180 / 7,220 | 9.78% / 9.93% | +0.15 | 1.0000 | −1.37 to +1.54 | 0.7572 | 0.7389 | Keep running |
| 13 | 7,749 / 7,851 | 9.91% / 10.04% | +0.13 | 1.0000 | −1.35 to +1.54 | 0.7929 | 0.4141 | No detectable effect at planned sample size |
| 14 | 8,358 / 8,442 | 9.79% / 9.95% | +0.16 | 1.0000 | −1.25 to +1.54 | 0.7228 | 0.5169 | No detectable effect at planned sample size |

#### Broken client: 8% of treatment exposures lost

| Day | Units (control / treatment) | Purchase rate (control / treatment) | Diff (pts) | Always-valid p | 95% confidence sequence (pts) | Fixed-horizon p | SRM p | Decision |
|---|---|---|---|---|---|---|---|---|
| 1 | 591 / 551 | 8.80% / 11.43% | +2.64 | 0.8203 | −3.62 to +8.89 | 0.1392 | 0.2365 | Keep running |
| 2 | 1,184 / 1,109 | 8.70% / 12.17% | +3.47 | 0.1352 | −0.61 to +7.55 | 0.0064 | 0.1173 | Keep running |
| 3 | 1,759 / 1,686 | 8.93% / 12.04% | +3.11 | 0.0655 | −0.12 to +6.35 | 0.0028 | 0.2136 | Keep running |
| 4 | 2,375 / 2,207 | 9.18% / 12.51% | +3.33 | 0.0109 | +0.51 to +6.14 | 0.0003 | 0.0131 | Keep running: SRM not yet checkable |
| 5 | 2,973 / 2,762 | 9.55% / 12.82% | +3.26 | 0.0038 | +0.72 to +5.80 | < 0.0001 | 0.0053 | Keep running: SRM not yet checkable |
| 6 | 3,564 / 3,323 | 9.57% / 13.24% | +3.67 | 0.0001 | +1.34 to +5.80 | < 0.0001 | 0.0037 | Keep running: SRM not yet checkable |
| 7 | 4,110 / 3,931 | 9.61% / 13.20% | +3.59 | < 0.0001 | +1.44 to +5.74 | < 0.0001 | 0.0459 | Keep running: SRM not yet checkable |
| 8 | 4,676 / 4,527 | 9.64% / 12.88% | +3.23 | < 0.0001 | +1.44 to +5.23 | < 0.0001 | 0.1204 | Keep running: SRM not yet checkable |
| 9 | 5,292 / 5,046 | 9.73% / 12.56% | +2.83 | < 0.0001 | +1.44 to +4.72 | < 0.0001 | 0.0155 | Ship Buy now: free shipping |
| 10 | 5,888 / 5,603 | 9.88% / 12.71% | +2.82 | < 0.0001 | +1.44 to +4.62 | < 0.0001 | 0.0078 | Ship Buy now: free shipping |
| 11 | 6,493 / 6,152 | 9.86% / 12.61% | +2.76 | < 0.0001 | +1.44 to +4.47 | < 0.0001 | 0.0024 | Ship Buy now: free shipping |
| 12 | 7,083 / 6,721 | 9.78% / 12.47% | +2.68 | < 0.0001 | +1.44 to +4.32 | < 0.0001 | 0.0021 | Ship Buy now: free shipping |
| 13 | 7,683 / 7,278 | — / — | — | — | — | — | 0.0009 | Stop: sample-ratio mismatch |
| 14 | 8,294 / 7,821 | — / — | — | — | — | — | 0.0002 | Stop: sample-ratio mismatch |

## Quickstart (about 10 minutes)

Needs Node 22 and a local Postgres 17 you can create databases in (Homebrew `postgresql@17` works with no password).

```bash
git clone git@github.com:shanelabountyai/saas-foundation.git my-app
cd my-app
git remote rename origin template
git checkout -B main v1.0.0   # -B: a fresh clone already has a main
npm ci
npm run new-project -- my-app 4200   # name and port; rewrites package.json, CI, Playwright, README
npm run db:setup                     # creates my_app and my_app_test, writes .env.local and .env.test, migrates both
npm run seed:demo                    # two orgs, owner/admin/member each; owners and admins have TOTP
npm run dev                          # http://localhost:4200/demo
```

**Do not use GitHub's "Use this template" button.** It drops the shared history, so later fixes can't be merged.
Working on the template itself: `npm run dev:template` serves on :4100.

`db:setup` never overwrites an existing `.env.*` and never prints a value. It uses your OS user against `localhost:5432`;
set `PGUSER`/`PGPASSWORD` or `LOCAL_PG_URL_BASE` for a different Postgres. Real keys (Resend, Stripe, Twilio) are optional
and go in `.env.local`; without them email is captured in the database, billing uses a mock, and SMS is off.

### Row-level security on Neon (optional, `RLS_MODE=enforce`)

`db:setup` gives you two roles locally: the owner (`DATABASE_URL` while RLS is off, `DATABASE_URL_SYSTEM`, `DIRECT_URL`) and
`<name>_app_rw` with `NOBYPASSRLS` (`DATABASE_URL_APP_RW`). To enforce locally, set `DATABASE_URL` to the app_rw URL and
`RLS_MODE=enforce` together: app_rw with RLS off sees no org rows, because off mode sets no org. On Neon, the role the console creates is a `neon_superuser` with `BYPASSRLS`, so the app role is made
in SQL, as the owner, on the branch:

```sql
CREATE ROLE app_rw LOGIN PASSWORD '<generate one>' NOBYPASSRLS NOSUPERUSER;
GRANT USAGE ON SCHEMA public TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_rw;
```

Then in Vercel: `DATABASE_URL` = app_rw through the pooler (`-pooler` host), `DATABASE_URL_SYSTEM` = the owner through the pooler,
`DIRECT_URL` = the owner without the pooler, `RLS_MODE=enforce`. Run `npm run rls:policies` once for your own org-owned models and
commit the migration; INV-30 fails until you do. The pooler accepts an SQL-created role (spike S4a ran through it).

## Commands

| Command | What it does |
|---|---|
| `npm test` | vitest against the local test database: unit, integration and all invariants |
| `npm run test:e2e` | Playwright against a production build (`E2E_DEV=1` runs the dev server for debugging one spec) |
| `npm run lint` / `typecheck` | ESLint (including the core-boundary rule) and `tsc` |
| `npm run db:migrate` | create a migration in dev; `db:migrate:test` applies to the test database |
| `npm run seed:demo` | idempotent demo accounts; refuses a cloud database |
| `npm run foundation:drift` | in a clone: fails if a template-owned file was edited |
| `npm run foundation:status` | in a clone: current vs latest release, and any `security:` changelog entries between |
| `npm run foundation:check-modules` | builds a scratch copy with both modules deleted (CI runs it) |

## Layout

- `src/core/`: env, db, auth, tenancy, authz, audit, tokens, email, share links, cron. Never imports from `src/modules` or `src/app` (lint-enforced).
- `src/modules/{billing,notifications}/`: optional, deletable.
- `src/app/`: routes. `src/app/cron-jobs.ts` is where a clone adds its own cron work. `src/app/org-hooks.ts` holds the
  clone's org hooks: `beforeOrgDelete` (runs before an org is deleted; throwing stops it) and `filterListedOrgs` (which of a
  user's orgs `/onboarding` and `/demo` list; default all, and it can only hide, never add — D-22).
- `prisma/schema/`: `core.prisma` plus one file per module. A clone's tables get their own file and migrations.
- `tests/invariants/`: the security rules as tests. `tests/fixtures/app.ts` holds a clone's harness rows.

## Removing a module

Delete the paths listed for it in `scripts/foundation-modules.ts`, and the lines marked `// billing` or `// notifications`
(`{/* billing */}` in `layout.tsx`) in `prisma/schema/core.prisma`, `src/app/cron-jobs.ts` and `src/app/o/[org]/layout.tsx` —
that includes the module's nav link, so it goes with the rest.
`foundation:check-modules` does exactly this in a scratch copy and requires validate, typecheck, build and drift to pass.
The module's tables stay in the migration history; drop them with a clone migration if you want them gone. Date that
migration after the template's newest migration: the RLS policy migrations up to `20261108000002` `ALTER` module tables
unguarded. Policy migrations from 1.6.2 on skip a module table that no longer exists.

If your own code imports a module outside the marked lines (a clone's own routes or lib files, not just
`cron-jobs.ts`/`org-hooks.ts`), list it in `src/app/required-modules.ts`. `check-modules` leaves a required module in
place and still removes the rest.

## Staying current

Template-owned paths (core, modules, invariants, security routes) are never edited in a clone, so `git merge vX.Y.Z` is clean.
An urgent local patch goes in `FOUNDATION_PATCHES.md` as `` `path` `hash` — reason `` (drift prints the hash to paste in) and moves upstream at the next release. The excuse stops matching, and drift fails again, once that path changes further.
Upgrade steps and versioning rules: `IMPLEMENTATION_PLAN.md` §3.3.

## Not included

Legal pages are stubs (`/legal/privacy`, `/legal/terms`) and are not legal advice. There is no audit-log viewer and no
`/o/[org]/settings/security` page yet.

No cookie banner: the foundation sets only strictly necessary cookies (`session`, `totp_pending`), and those need no consent.
If you add analytics, ads or any other non-essential tracker, you need consent first (spec D-20).
