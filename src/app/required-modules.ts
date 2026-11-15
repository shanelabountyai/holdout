// Clone-owned, like cron-jobs.ts and org-hooks.ts: modules this clone's own code depends on
// outside the marked lines (an import `foundation:check-modules` wouldn't otherwise see coming).
// foundation:check-modules leaves these in place and still removes the rest.
// Holdout: /api/v1/ingest and /api/v1/experiments authenticate with the apikeys module (D-0B, D-17).
export const REQUIRED_MODULES: string[] = ['apikeys'];
