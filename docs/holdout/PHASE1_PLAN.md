# Holdout — Phase 1 plan: pure engine + Python oracle

Branch `kickoff`, PR #1 into `main`, never merged by Claude. No database, no schema, no routes, no UI: Phase 1 is
pure TypeScript functions plus a test-only Python oracle. Written before any engine code (KICKOFF).

## Layout

| Path | What |
|---|---|
| `src/lib/exp/hash.ts` | MurmurHash3 x86_32 over UTF-8 of `salt + ":" + unitId`; bucket = hash mod 10 000; `assign()` walks cumulative integer weights (basis points). Pure, sync, no Node APIs, so the same file can ship in the browser snippet (Phase 4). |
| `src/lib/exp/normal.ts` | Standard-normal CDF/survival (erf series + erfc continued fraction), quantile (Acklam start + Halley steps), log-gamma (Lanczos), regularized upper incomplete gamma (series / Lentz continued fraction), chi-square survival. |
| `src/lib/exp/tests.ts` | Difference in proportions (pooled z for the p-value, unpooled Wald CI) and difference in means from summary stats (large-sample z, Welch variance), relative lift; planned sample size per arm for both at power 0.8 / α 0.05 defaults. |
| `src/lib/exp/srm.ts` | Sample-ratio mismatch: Pearson chi-square goodness of fit of observed exposures vs. configured weights, df = k − 1; `blocked` when p < 0.001 (threshold reused by HO-04 in Phase 3). |
| `src/lib/exp/sequential.ts` | Always-valid inference: Gaussian-mixture SPRT (mSPRT) on the difference estimate, always-valid p-value (running min of 1/Λ) and the matching confidence sequence. References cited in the file header. |
| `src/lib/exp/simulator.ts` | Seeded PRNG (mulberry32), synthetic units with known true effect (Bernoulli or normal), assignment through `hash.ts`, peeks every N units; reports fixed-horizon and sequential rejection rates. |
| `src/lib/exp/index.ts` | Re-exports. |
| `tools/oracle/` | Python, test-only (D-03): `oracle.py` recomputes every vector with scipy/statsmodels (+ a pure-Python murmur3 for assignment); `cases.json` holds the inputs; `vectors.json` the oracle's outputs, committed. `test_oracle.py` regenerates in memory and fails if the committed file is stale. |
| `tests/exp/*.test.ts` | vitest: HO-01, HO-02 (oracle agreement), HO-03 (A/A false-positive rate), power report, unit tests. |

## Invariants in this phase

- **HO-01** assignment never changes for a running experiment: `assign` is a pure function of (salt, unit id,
  weights); a golden file of 1 000 assignments is frozen (`tests/exp/fixtures/assignment-golden.json`) and the test
  fails if any changes; the Python murmur3 reproduces every bucket independently; adding an experiment, reordering
  calls or other experiments' salts cannot move a unit (tested).
- **HO-02** TS and Python agree to 1e-9 on every shared vector (absolute, or relative for values > 1).
- **HO-03** simulated A/A at α 0.05 rejects ≤ 6% over 2 000 runs, for fixed-horizon and for the sequential method
  under continuous peeking (every 200 units per arm), proportions and means.

## Gate (then stop)

`npm run lint`, `npm run typecheck`, the full vitest suite (foundation + `tests/exp`) green; the oracle job
(`pytest tools/oracle`) green in CI; simulated false-positive rate and power reported as numbers in the PR body.
Phase 2 (schema, experiments UI, ingest) is not started.

## Choices made up front (rows in DECISIONS.md)

- D-09 means use a large-sample z test on Welch variance, not Student t (experiments run at n in the thousands; the
  sequential method is normal-based anyway; keeps 1e-9 agreement free of an incomplete-beta implementation).
- D-10 sequential method = mSPRT with a normal mixture, τ² = MDE² by default (Johari et al.), monitoring starts
  at 100 units per arm.
- D-11 hash = MurmurHash3 x86_32, 10 000 buckets.
- D-12 CI gets an `oracle` job (Python 3.12, pinned scipy/statsmodels) next to the foundation jobs.
