// PRD "Assignment": the JS snippet and the server SDK use the same function, proven identical by shared test vectors.
// The vectors are HO-01's frozen golden file (1 000 rows from the independent Python MurmurHash3 in tools/oracle).
// e2e/demo-site.spec.ts runs the same 1 000 rows through sdk/holdout.js inside Chromium.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildSnippet, SNIPPET_OUT } from '@/sdk/build';
import { HoldoutServer } from '@/sdk/server';
import { loadSnippet, SNIPPET_JS } from './load-snippet';

type Row = { salt: string; unit: string; hash: number; bucket: number; variants: { key: string; weight: number }[]; variant: string };
const G = JSON.parse(readFileSync('tests/exp/fixtures/assignment-golden.json', 'utf8')) as { rows: Row[] };

describe('shared assignment vectors: snippet = server SDK = golden file', () => {
  it('has the 1 000 frozen rows', () => expect(G.rows).toHaveLength(1000));

  it('the committed snippet bundle reproduces every row, run with no Node globals', () => {
    const { api, context } = loadSnippet();
    expect(vm.runInContext('typeof require + typeof process + typeof Buffer + typeof module', context)).toBe('undefinedundefinedundefinedundefined');
    let n = 0;
    for (const r of G.rows) {
      expect(api.assign(r.salt, r.unit, r.variants), `${r.salt}:${r.unit}`).toBe(r.variant);
      n++;
    }
    expect(n).toBe(1000);
  });

  it('the snippet’s public variant() gives the golden variant for each row’s unit', () => {
    for (const r of G.rows.slice(0, 250)) {
      const { api } = loadSnippet({ setTimeout: () => 0, clearTimeout: () => undefined });
      api.init({ experiments: [{ key: 'x', salt: r.salt, variants: r.variants }], unitId: r.unit, endpoint: '/collect' });
      expect(api.variant('x')).toBe(r.variant);
    }
  });

  it('the server SDK reproduces every row through variant()', () => {
    const h = new HoldoutServer({ baseUrl: 'http://h', apiKey: 'k', fetch: (() => Promise.reject(new Error('no network'))) as typeof fetch });
    G.rows.forEach((r, i) => {
      h.load([{ key: `x${i}`, salt: r.salt, variants: r.variants }]);
      expect(h.variant(`x${i}`, r.unit, { log: false }), `${r.salt}:${r.unit}`).toBe(r.variant);
    });
  });

  it(`the committed ${SNIPPET_OUT} is byte-identical to a fresh build of src/sdk/snippet.ts (run npm run sdk:build)`, () => {
    expect(SNIPPET_JS()).toBe(buildSnippet());
  });
});
