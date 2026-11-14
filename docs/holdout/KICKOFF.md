# #28 Holdout — experimentation platform — Claude Code kickoff

## Session prompt — Phase 0 + Phase 1

Kit location: until Phase 0 runs, this file, PRD.md and DECISIONS.md live on branch `kit` in `docs/`. Phase 0 creates `main` from the foundation tag, copies them into `docs/holdout/`, pushes `main`, and sets it as the default branch (`gh repo edit shanelabountyai/holdout --default-branch main`). Never delete `kit`. Remove the billing module per the foundation README unless DECISIONS.md says otherwise. You cannot push to saas-foundation: put the CLONES.md row you'd add in the PR body under "For Shane".

```text
You are building Holdout (build-log #28) on saas-foundation v1.6.2 (clone with shared history, never "Use this
template"; follow the foundation README quickstart with name holdout, port 8100). Read docs/holdout/PRD.md and
DECISIONS.md. Decisions are in force; new ones: pick, append a row, keep going, never ask.

Phase 0 on main: foundation clone, new-project, gate = foundation CI green. Phase 1 on branch kickoff (PR #1
unmerged), pure engine only, no database writes: write docs/holdout/PHASE1_PLAN.md first; then src/lib/exp/
(hash assignment, proportion/mean tests, SRM, an always-valid sequential method with the reference you used cited
in a comment, simulator) and tools/oracle/ (Python, test-only). Gate: HO-01..HO-03 green, oracle agreement test
green, simulated false-positive rate and power reported as numbers in the PR body. Then stop.
```
