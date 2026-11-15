import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dbSystem as db } from '@/core/db/system';

// The Holdout migration is hand-written (the sandbox that built Phase 2 cannot download Prisma's schema engine, D-06/D-27),
// so this checks the migrated database against prisma/schema/holdout.prisma: every scalar field is a column with the right
// type and nullability, and every @@unique/@@index exists under Prisma's name. CI also runs `prisma migrate diff`.

const src = readFileSync('prisma/schema/holdout.prisma', 'utf8');
const enums = new Set([...src.matchAll(/^enum (\w+) \{/gm)].map((m) => m[1]!));
const models = [...src.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map((m) => ({ name: m[1]!, body: m[2]! }));
const modelNames = new Set([...models.map((m) => m.name), 'Org']);

const PG: Record<string, string> = { String: 'text', Float: 'double precision', Int: 'integer', DateTime: 'timestamp with time zone', Boolean: 'boolean' };

describe('Holdout schema: migrated database matches holdout.prisma', () => {
  for (const m of models) {
    it(`${m.name}: columns and indexes`, async () => {
      const expected: Record<string, [string, boolean]> = {};
      for (const line of m.body.split('\n')) {
        const f = /^\s{2}(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/.exec(line);
        if (!f || line.trim().startsWith('@@') || line.trim().startsWith('//')) continue;
        const [, name, type, list, opt, rest] = f;
        if (modelNames.has(type!) || list) continue; // relation fields
        const pg = rest!.includes('@db.Uuid') ? 'uuid' : enums.has(type!) ? 'USER-DEFINED' : PG[type!]!;
        expected[name!] = [pg, !!opt];
      }
      const cols = await db.$queryRaw<{ c: string; t: string; n: string }[]>`SELECT column_name AS c, data_type AS t, is_nullable AS n FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ${m.name}`;
      expect(Object.fromEntries(cols.map((c) => [c.c, [c.t, c.n === 'YES']]))).toEqual(expected);

      const want = [`${m.name}_pkey`];
      for (const [, kind, fields] of m.body.matchAll(/@@(unique|index)\(\[([^\]]+)\]\)/g)) want.push(`${m.name}_${fields!.split(',').map((s) => s.trim()).join('_')}_${kind === 'unique' ? 'key' : 'idx'}`);
      const idx = await db.$queryRaw<{ i: string }[]>`SELECT indexname AS i FROM pg_indexes WHERE schemaname = current_schema() AND tablename = ${m.name}`;
      expect(idx.map((r) => r.i).sort()).toEqual(want.sort());
    });
  }
});
