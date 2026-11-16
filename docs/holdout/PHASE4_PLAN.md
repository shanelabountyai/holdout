# Holdout — Phase 4 plan: JS snippet, server SDK, demo site, README case study

Branch `phase-4`, one PR into `main`, never merged by Claude. Written before any Phase 4 code.

PRD Phases line: "1 pure engine … → 2 schema, experiments UI, ingest → 3 readout page, guardrails, audit → **4 JS snippet
demo site + README case study**". The PRD's Assignment bullet says "a JS snippet and a server SDK (TypeScript) both use the
same function, proven identical by shared test vectors", and D-23 moved the server SDK into this phase alongside the
snippet. Phase 4 is therefore exactly:

| Area | What ships |
|---|---|
| Server SDK (TypeScript) | `src/sdk/server.ts`: `HoldoutServer` loads running experiments from `GET /api/v1/experiments` (all pages), answers `variant(experiment, unitId)` with the engine's own `assign()` (`src/lib/exp/hash.ts`, imported, not copied), queues the exposure, `track(event, unitId, value?)` queues a conversion, and `flush()` posts batches of ≤ 500 to `POST /api/v1/ingest`. Retry-safe ids; reports the ingest's `rejected` list instead of hiding it. |
| JS snippet (browser) | `src/sdk/snippet.ts`, bundled by esbuild into one committed IIFE file `sdk/holdout.js` (global `Holdout`). Same `assign()` compiled in. `Holdout.init({ experiments, unitId, endpoint })`, `Holdout.variant(key)` (logs one exposure per experiment per page), `Holdout.track(event, value?)`, batched sends with `fetch(keepalive)`. It never holds an API key (D-35). |
| Demo site (local only) | `demo-site/`: a small Node `http` server on **port 8101** (a fictional coffee shop, "Northwind Roasters"), run with `npm run demo:site`. It reads the Holdout config with the server SDK and an API key from its environment, inlines the running experiments into the page, serves `sdk/holdout.js`, and relays the snippet's events to Holdout's ingest through `/collect`, stamping the unit id from its own cookie. A `/server` page renders the variant with the server SDK so both paths can be compared for the same visitor. **Nothing is deployed.** |
| README case study | A "Case study" section in `README.md`: how the pieces fit, what the snippet → relay → ingest → readout path looks like, and the numbers from a seeded run of `npm run case-study` (`scripts/case-study.ts`: synthetic visitors with a known true effect, assigned by the server SDK's `variant()`, sent through the real `ingest()` day by day, read by the real `computeReadout()` each day) plus the measured invariant numbers. Only numbers printed by commands run in this session. |

Not in Phase 4 (and not added): CUPED, bandits, Bayesian readouts, warehouse-native analysis, targeting rules, a published
npm package, CORS or a browser-facing key scope on Holdout's API, any deploy of the demo site or of Holdout.

## Binding inputs

- D-11: MurmurHash3 x86_32 of `salt:unitId` mod 10 000; the snippet and the SDK must not reimplement it.
- D-16 / D-28..D-34: the readout, its daily looks by receipt, decision states and stop are used as they are; the case study
  reads them, it does not change them.
- D-17 / D-19 / D-23 / D-26: ingest shape, first exposure per unit, server-side variant check, config endpoint, timestamp
  window. The SDKs send what the ingest already accepts.
- HO-01 golden file (`tests/exp/fixtures/assignment-golden.json`, 1 000 rows from the independent Python MurmurHash3) is the
  shared test vector set.
- Owner LLM rule (2026-11-15): nothing in Phase 4 needs a model, so no interface or fake is added for one.

## Tasks (small commits, in order)

1. This plan.
2. Server SDK + unit tests (fake fetch).
3. Snippet + esbuild bundle (`npm run sdk:build`) + committed `sdk/holdout.js` + freshness and vector tests.
4. Demo site server + page; DB-backed test of the relay path through the real ingest route handler.
5. Playwright: demo site in Chromium against the running Holdout: the snippet's variant equals the server SDK's for the same
   visitor, the exposure and purchase arrive in Holdout, and the snippet reproduces the golden vectors inside the browser.
6. `scripts/case-study.ts` + its DB test; run it; README case study with the printed numbers; DECISIONS rows.

## Acceptance items and the tests that prove them

| Acceptance item | Test (file) |
|---|---|
| Snippet and server SDK use the same function, proven by shared vectors | `tests/sdk/vectors.test.ts`: the committed `sdk/holdout.js`, run in a Node `vm` with no Node globals, and `HoldoutServer.variant()` (fed the vectors as config) both reproduce all 1 000 golden rows. `e2e/demo-site.spec.ts` repeats the 1 000 rows inside Chromium. |
| The committed bundle is the source | `tests/sdk/vectors.test.ts`: rebuilding `src/sdk/snippet.ts` with the same esbuild options gives byte-identical output to `sdk/holdout.js`. |
| Server SDK: config, assignment, events | `tests/sdk/server.test.ts` (fake fetch): follows `nextCursor`; unknown or not-running experiment → `null` with no exposure; one exposure per (experiment, unit) per process with a deterministic id; batches split at 500; `rejected` surfaced; a failed POST keeps the events for the next flush; API key only in the `authorization` header. |
| Snippet behaviour | `tests/sdk/snippet.test.ts` (vm + fake fetch): one exposure per experiment per page, `track` queues conversions with the page's unit id, batches go to the configured endpoint, no key or secret field anywhere in what it sends. |
| Relay: browser events reach Holdout only for the cookie's unit | `tests/sdk/demo-relay.test.ts` (DB): the demo site's relay handler forwards through the real `POST /api/v1/ingest` route; a browser-supplied `unitId` is replaced by the cookie's; oversize or malformed bodies are refused before any call; exposures land with the server-computed variant. |
| End to end | `e2e/demo-site.spec.ts`: Holdout on :8100 (Playwright's server) and the demo site on :8101; a seeded running experiment; the page's button matches the `/server` page's variant for the same cookie; clicking Buy produces the exposure and the purchase in Holdout's database. |
| Case study numbers are real | `tests/sdk/case-study.test.ts` (DB): a smaller seeded run of the same scenario reaches `ship` for a real effect and does not ship an A/A; the README's numbers are the output of `npm run case-study` run in this session. |

Phase 1–3 invariants stay green unchanged: HO-01 golden file and freeze, HO-02 oracle, HO-03 simulation, HO-04, HO-05.

## Gate (then stop)

`npm run lint` (0 errors), `npm run typecheck`, the full vitest suite (now including `tests/sdk`), Playwright (including
`e2e/demo-site.spec.ts`), `foundation:check-modules`, the `oracle` job and the schema drift step, all green in GitHub CI on
the PR head. Numbers go in the PR body. Nothing after Phase 4 is started.
