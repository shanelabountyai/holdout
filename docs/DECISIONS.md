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
