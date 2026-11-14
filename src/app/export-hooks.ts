import { moduleExportTables } from '@/app/modules';
import type { ExportTable } from '@/core/tenancy/export';

// Clone-owned (v1.6.0), like org-hooks.ts: which tables a data export holds beyond the template's core ones
// (addendum §5). Add one entry per org-owned table, selecting only columns that are safe to hand over: never a
// sealed column, token hash or recovery code (INV-34 scans the output). Every query runs inside withOrg.
//   { name: 'Booking', rows: (tx, orgId) => tx.booking.findMany({ where: { orgId }, select: { id: true, startsAt: true } }) },
export const exportTables: readonly ExportTable[] = [
  ...moduleExportTables,
  // Holdout (D-22): the experiment designs, whole. The salt is not a secret (D-11: assignment is not a security boundary).
  { name: 'Experiment', rows: (tx, orgId) => tx.experiment.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } }) },
  { name: 'Variant', rows: (tx, orgId) => tx.variant.findMany({ where: { orgId }, orderBy: [{ experimentId: 'asc' }, { position: 'asc' }] }) },
  { name: 'Guardrail', rows: (tx, orgId) => tx.guardrail.findMany({ where: { orgId }, orderBy: [{ experimentId: 'asc' }, { position: 'asc' }] }) },
];

// An org-owned table left out on purpose, with the reason. INV-34 fails on any model with an orgId column that is in
// neither list, so a new table cannot silently drop out of every export.
export const exportSkipped: Readonly<Record<string, string>> = {
  // Holdout D-22: raw event logs grow without bound, and the archive lives in a Postgres row (M11); a whole-log export would
  // not fit. Phase 3's readout and a future streamed export are the way out of the platform for these.
  Exposure: 'raw event log (one row per exposed unit), unbounded volume; not exported (D-22)',
  Conversion: 'raw event log (one row per metric event), unbounded volume; not exported (D-22)',
};
