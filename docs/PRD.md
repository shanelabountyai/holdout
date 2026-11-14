# #28 Holdout — experimentation platform

Status: **kickoff** (2026-11-13). Repo: `shanelabountyai/holdout` (public). Port 8100.
Base: saas-foundation v1.6.2 clone (D-01) — experiments belong to an org, and the audit log matters for
"who stopped the test early".

**Why:** A/B testing is a marketing-ops staple and the stats are where most tools (and most portfolios) cut
corners. Holdout does assignment, exposure logging and analysis honestly: it handles peeking, catches broken
splits, and says "not enough data" when that's the truth.

**Scope v1:**
- **Flags & experiments:** an experiment has variants with traffic weights, a primary metric, guardrail metrics,
  a minimum detectable effect, and a planned sample size computed up front (power 0.8, α 0.05 defaults).
- **Assignment:** deterministic hash of (experiment salt, unit id) → bucket; sticky; a JS snippet and a server
  SDK (TypeScript) both use the same function, proven identical by shared test vectors.
- **Events:** exposure + conversion events via an authenticated ingest endpoint (foundation `apikeys` module).
- **Analysis engine (pure TypeScript, Python oracle):** difference in proportions and in means with CIs;
  **sequential testing** using an always-valid method (mixture SPRT / confidence sequences) so results can be
  checked any time without inflating false positives; **sample-ratio mismatch** check (chi-square) that blocks
  the readout when traffic split is off; CUPED variance reduction as a stretch.
- **Readout page:** decision-oriented ("ship B", "keep running", "stop: SRM detected", "no detectable effect at
  planned sample size") with the numbers behind it.
- **Simulator:** generate synthetic traffic with known true effects; used in tests to measure false-positive rate
  and power empirically.

**Out of scope:** multi-armed bandits, Bayesian readouts, warehouse-native analysis, feature-flag targeting rules
beyond a percentage rollout.

**Invariants:** HO-01 a unit's assignment never changes for a running experiment; HO-02 TS and Python analysis
agree to 1e-9 on shared vectors; HO-03 simulated A/A tests at α 0.05 reject ≤ 6% over 2,000 runs (sequential
method included); HO-04 SRM at p < 0.001 blocks the readout; HO-05 stopping an experiment writes an audit event
with the readout state at that moment.

**Phases:** 1 pure engine (hashing, stats, SRM, sequential, simulator) + Python oracle → 2 schema, experiments
UI, ingest → 3 readout page, guardrails, audit → 4 JS snippet demo site + README case study.
