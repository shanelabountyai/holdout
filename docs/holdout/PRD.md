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

## Design, UX and accessibility requirements (design pass, 2026-11-18)

Added after the three independent reviews of the built UI (design fidelity DES-n, UX UX-n, accessibility A11Y-n; findings
table in the design-pass PR). The look is the Claude Design canvas in `docs/design/` (HANDOFF.md; D-42..D-47). Each line is
checked by the test named after it, or by the axe run recorded in the PR.

- **DX-01** No experiment page scrolls sideways at 390 px. (DES-1, UX-3, A11Y-2; `e2e/holdout-experiments.spec.ts` "fit a 390 px phone", axe run)
- **DX-02** Every status is a word, a glyph and a colour; the glyph is hidden from assistive tech and the hold glyph is drawn, not left to a font. (DES-4, UX-20; `tests/holdout/design-pass.test.ts`)
- **DX-03** A refused save keeps everything typed, and the reason appears beside the submit button, which takes focus. (UX-1, UX-2, A11Y-1; e2e)
- **DX-04** A stopped experiment's banner says it is the decision at the stop and shows the stop reason. (UX-4; e2e)
- **DX-05** Start, stop and delete ask for confirmation, saying what becomes permanent. (UX-5; e2e)
- **DX-06** Page copy written by the UI carries no internal codes (D-n, HO-n); the readout's own detail, which is stored with a stop (HO-05), is unchanged. (DES-7, UX-7)
- **DX-07** Event counts that are org-wide are labelled so, and hidden while SRM blocks the readout. (DES-5)
- **DX-08** On a phone the experiment list stacks each experiment with its decision visible. (DES-8, UX-13; axe and reflow run)
- **DX-09** Variant fields have visible labels on a phone. (DES-10, UX-14, A11Y-4)
- **DX-10** The live planned-sample panel announces the plan or the reason it cannot be computed, after typing pauses. (A11Y-5)
- **DX-11** Navigation links and table title links are at least 44 px tall. (A11Y-6, UX-27)
- **DX-12** Every horizontally scrollable region can be reached and scrolled by keyboard and has a name. (A11Y-7)
- **DX-13** The draft page has one "Planned sample" landmark, no card inside a card, and the edit form's headings sit under "Edit draft". (DES-6, A11Y-8)
- **DX-14** Disclosures show whether they are open; focus rings have at least 3:1 contrast against what is around them, code blocks included. (A11Y-3, A11Y-9)
- **DX-15** The org home says how many experiments there are when there are some; org pages have their own not-found and loading states. (DES-3, UX-10, UX-17, UX-18)
- **DX-16** The install page shows the snippet for the experiment it was opened for (`?key=`). (UX-9)
- **DX-17** axe-core (WCAG 2 A/AA, 2.1 A/AA, best practice) reports 0 violations on every org page at 1280 and 390 px, light and with a dark OS setting emulated. (A11Y axe table; see D-48 for why it is not yet a committed spec)
