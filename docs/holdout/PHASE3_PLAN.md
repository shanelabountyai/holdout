# Holdout — Phase 3 plan: readout page, guardrails, audit

Branch `phase-3`, one PR into `main`, never merged by Claude. Written before any Phase 3 code.

PRD Phases line: "1 pure engine … → 2 schema, experiments UI, ingest → **3 readout page, guardrails, audit** → 4 JS snippet
demo site + README case study". Phase 3 turns the stored exposures and conversions into a decision. It does **not** ship
the JS snippet, the server SDK package, the demo site or the README case study (Phase 4), and none of the PRD's out-of-scope
items (bandits, Bayesian readouts, warehouse-native analysis, targeting rules). CUPED stays a stretch, not in this phase.

## Binding inputs

- **D-16** (owner): the planned horizon is `plannedUnitsPerArm` (2× the fixed-horizon n), stored on the experiment in
  Phase 2. The "no detectable effect at planned sample size" state is measured against that stored number, never against
  `sampleSize*` directly.
- **HO-04** SRM at p < 0.001 blocks the readout. **HO-05** stopping an experiment writes an audit event with the readout
  state at that moment.
- D-02 (sequential primary, fixed-horizon shown alongside), D-10 (mSPRT, τ² = MDE², `MIN_UNITS_PER_ARM` = 100), D-13
  (proportions: pooled p, Wald CI), D-15 (not enough data below 100 per arm), D-18/D-24 (running → stopped is the only
  move left; the trigger already allows it), D-19 (first exposure per unit, server-assigned variant).
- PR #1 review: more than two variants raises multiple comparisons, which the readout must handle.

## Scope

| Area | What ships |
|---|---|
| Readout engine (`src/lib/holdout/readout.ts`) | A pure function from per-look aggregates to a readout: per-arm units and metric level, each treatment against control with the sequential (mSPRT) always-valid p-value and confidence sequence as the primary result and the fixed-horizon test alongside, SRM, guardrails, and one decision. Plus the loader that builds the aggregates from `Exposure` and `Conversion` with SQL, as of a given time. |
| Decision states (PRD) | `srm` "Stop: sample-ratio mismatch" (HO-04, effects withheld) · `not_enough_data` · `ship` "Ship B" · `guardrail` "Hold: a guardrail moved" · `worse` "Stop: no variant beats control" · `no_effect` "No detectable effect at planned sample size" (D-16 horizon) · `keep_running`. |
| Guardrails | Every guardrail is evaluated per treatment with the same always-valid method; a significant move holds a ship for review. |
| Readout page | The experiment detail page (`/o/[org]/experiments/[id]`) shows the readout for running and stopped experiments: the decision in words with the numbers behind it, the per-arm table, each comparison, SRM, guardrails, and the experiment's own audit history. |
| Stop with audit (HO-05) | Owner/admin stop with an optional reason. One transaction locks the row, computes the readout at that instant, sets `stopped`/`stoppedAt`, and writes `experiment.stopped` with the full readout snapshot. A stopped experiment's page shows the readout as of `stoppedAt`. |

## Tasks (small commits, in order)

1. This plan.
2. `readout.ts` pure analysis + unit tests.
3. Loader (SQL aggregates as of a time) + DB tests against the engine on the same counts.
4. Stop (lib + action + fixture ref) + HO-04/HO-05 tests.
5. Readout section, stop form and history on the detail page; e2e.
6. Simulation test of the decision rule; DECISIONS rows; README.

## Invariants and the tests that prove each acceptance item

| Acceptance item | Test (file) |
|---|---|
| Readout numbers are the engine's numbers | `tests/holdout/readout.test.ts`: events ingested through `ingest()`; the readout's per-arm counts equal a direct count, and its fixed-horizon result equals `diffProportions` / `diffMeans` on those counts; the sequential result equals `sequentialPath` over the same looks. Means: a unit's value is the sum of its events after exposure. Conversions before exposure, or for another org, do not count. |
| Decision states | `tests/holdout/readout-decide.test.ts` (pure): one case per state, precedence (SRM over everything; not enough data before any effect), the planned horizon from `plannedUnitsPerArm`, the direction of the MDE, Bonferroni with three or four variants. |
| HO-04 SRM blocks the readout | DB test: a skewed split inserted as the database owner gives `srm`, no effect estimate in the readout, and the page says so; the healthy 50/50 stream does not. |
| HO-05 stop writes the readout state | DB test: stopping writes exactly one `experiment.stopped` audit event whose `readout` deep-equals the readout computed as of `stoppedAt`; later conversions do not change the stopped readout; a member cannot stop; a draft or stopped experiment cannot be stopped; another org's id is 404 (also covered by the INV-01..04 harness through the new action). |
| Guardrails | DB + pure tests: a guardrail with a real harm turns a winning primary into `guardrail`; a quiet guardrail leaves `ship`. |
| The decision rule keeps its error rates | `tests/holdout/readout-sim.test.ts`: simulated A/A experiments with daily looks through the readout's decision: wrong `ship` rate ≤ 6% (HO-03 bound); a real PRD-size effect is shipped in most runs. |
| Page | INV-01..04/22 harness covers the stop action; entry-point guard check covers the page; Playwright extends `e2e/holdout-experiments.spec.ts`: start → readout says not enough data → stop → stopped, history shows the stop. |

Phase 1 and 2 invariants stay green unchanged: HO-01 golden file and freeze tests, HO-02 oracle, HO-03 simulation.

## Gate (then stop)

`npm run lint` (0 errors), `npm run typecheck`, the full vitest suite, Playwright, `foundation:check-modules`, the
`oracle` job and the schema drift step, all green in GitHub CI on the PR head. Numbers go in the PR body. Phase 4 is not
started.
