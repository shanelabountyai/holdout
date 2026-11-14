# Holdout — Phase 2 plan: schema, experiments UI, ingest

Branch `phase-2`, one PR into `main`, never merged by Claude. Written before any Phase 2 code.

PRD Phases line: "1 pure engine … → **2 schema, experiments UI, ingest** → 3 readout page, guardrails, audit → 4 JS snippet
demo site + README case study". Phase 2 therefore stores experiments and events and lets people configure experiments;
it does **not** analyse them. No readout page, no SRM block on a page (HO-04), no stop-with-readout audit (HO-05), no
guardrail evaluation, no JS snippet, no demo site. Those stay in Phases 3 and 4.

## Binding inputs

- **D-16** (owner, 2026-11-14): sequential experiments plan at 2× the fixed-horizon n. The experiment's planned horizon is
  computed with `plannedUnitsPerArm(sampleSize*(…), 'sequential')` at creation and stored; never from `sampleSize*` alone.
- **PR #1 review**: assignment depends on variant weights *and their order*, so Phase 2 freezes both once an experiment is
  running; ramping must not move existing units (HO-01).
- D-02 (sequential primary), D-10 (`MIN_UNITS_PER_ARM`), D-11 (hash), D-0B (billing removed; `apikeys` kept for ingest).

## Scope

| Area | What ships |
|---|---|
| Schema (`prisma/schema/holdout.prisma`) | `Experiment` (key, name, description, salt, status `draft`/`running`/`stopped`, primary metric event + kind, baseline, MDE, α, power, fixed-horizon and planned units per arm, planned total units, `startedAt`), `Variant` (key, name, weight in basis points, position), `Guardrail` (event, kind, position), `Exposure` (first exposure of a unit to an experiment), `Conversion` (metric event per unit, optional value, client event id). Every table carries `orgId`; RLS policies regenerated with `npm run rls:policies`. |
| Freeze (HO-01 in the database) | A Postgres trigger refuses, once an experiment has left `draft`: any insert, update or delete of its variants or guardrails; any change to its key, salt, metric, baseline, MDE, α, power or plan; any status change back to `draft`. The app refuses the same edits with a readable message first. |
| Experiments UI (`/o/[org]/experiments`) | List; create; edit and delete while draft; detail page showing variants, metric, MDE and the **planned sample size** (fixed-horizon n, planned n per arm at 2×, planned total units); Start (owner/admin) which freezes the design; counts of exposures and conversions received so far (ingest health only, no per-arm analysis). Nav link. Audit events on create, update, delete, start. |
| Ingest (`POST /api/v1/ingest`) | API key with scope `ingest` (foundation `apikeys` module). Batch of up to 500 events: `exposure` (experiment key, unit id, optional variant the client rendered) and `conversion` (event name, unit id, optional numeric value). Per-event `id` for retry-safe dedupe. Server recomputes each exposure's variant with `assign()` over the frozen variant order and rejects a mismatching client variant. Partial acceptance: `{ accepted, duplicates, rejected: [{ index, code, detail }] }`. |
| Config read (`GET /api/v1/experiments`) | Scope `read`: running experiments with key, salt and variants (key, weight) in their frozen order, so a client can run the same `assign()` locally. |

## Tasks (small commits, in order)

1. This plan.
2. Schema + hand-written migration (sandbox has no schema engine, D-06) + freeze trigger migration + regenerated RLS
   migration; `seedApp` rows for every new model; export hooks.
3. `src/lib/holdout/experiments.ts`: validation, planning (D-16), create/update/delete/start, all through `withOrg`.
4. Server actions + pages + nav link.
5. Ingest route + config route + `ingest` scope + `REQUIRED_MODULES = ['apikeys']`.
6. Tests (below), DECISIONS rows, docs touch-ups.

## Invariants and the tests that prove each acceptance item

| Acceptance item | Test (file) |
|---|---|
| Schema migrates and every new table is org-scoped | CI `prisma migrate deploy`; INV-30 (RLS on every `orgId` model, enforce leg) and INV-29 seed rows via `seedApp`; INV-34 (every `orgId` model exported or skipped with a reason); new CI step: `prisma migrate diff` from the migrated database to `prisma/schema` must be empty for Holdout's tables (`tests/holdout/schema.test.ts` asserts the live columns locally as well). |
| Planned sample size up front, D-16 at 2× | `tests/holdout/experiments.test.ts`: PRD conversion case 10% → 12% stores fixed 3 841 / planned 7 682 per arm; means case 10 ± 5 → +0.5 stores 1 570 / 3 140; unequal split plans on the smallest arm. |
| HO-01 freeze: weights and order cannot change once running | `tests/holdout/ho-01-freeze.test.ts`: as the database owner (bypassing the app), every edit to a running experiment's variants (weight, order, key, insert, delete), guardrails, salt, key, plan, and status → draft is refused by the trigger; the same edits succeed in draft; app-level edits are refused with a message; property test: 2 000 random unit ids keep their variant across every refused ramp attempt, and ingest's server-side variant equals `assign(salt, unit, variants by position)`. |
| Experiments UI is authorised and org-scoped | INV-01..04/22 harness discovers the new actions automatically (needs the `seedApp` refs); `tests/holdout/experiments.test.ts` covers member-can-draft, member-cannot-start, cross-org id → 404. Pages pass the entry-point guard check. Playwright `e2e/holdout-experiments.spec.ts`: create an experiment through the form, see its planned n, start it. |
| Ingest is authenticated, scoped and org-bounded | `tests/holdout/ingest.test.ts`: no key 401, key without `ingest` 403; an experiment key from another org is `unknown_experiment` (same answer as a key that does not exist); accepted/duplicate/rejected counts; retrying a batch accepts nothing new; variant mismatch, draft experiment, timestamp out of window, oversize batch, malformed body. |
| Config read | `tests/holdout/ingest.test.ts`: only running experiments, variants in frozen order, other org's experiments absent. |

Phase 1 invariants stay green unchanged: HO-01 golden file, HO-02 oracle agreement, HO-03 simulation.

## Gate (then stop)

`npm run lint` (0 errors), `npm run typecheck`, the full vitest suite (foundation + invariants + `tests/exp` +
`tests/holdout`), Playwright, `foundation:check-modules`, the `oracle` job, and the schema drift step, all green in GitHub
CI on the PR head. Numbers go in the PR body. Phase 3 is not started.
