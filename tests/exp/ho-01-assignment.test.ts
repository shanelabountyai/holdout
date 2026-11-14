// HO-01: a unit's assignment never changes for a running experiment. assign() is a pure function of
// (salt, unit id, weights); the golden file was produced by an independent Python MurmurHash3 and is frozen.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assign, bucketOf, murmur3, validateWeights, type Variant } from '@/lib/exp';

const G = JSON.parse(readFileSync('tests/exp/fixtures/assignment-golden.json', 'utf8')) as {
  rows: { salt: string; unit: string; hash: number; bucket: number; variants: Variant[]; variant: string }[];
};

describe('HO-01 sticky deterministic assignment', () => {
  it('reproduces all 1 000 golden rows (hash, bucket, variant)', () => {
    expect(G.rows).toHaveLength(1000);
    for (const r of G.rows) {
      expect(murmur3(`${r.salt}:${r.unit}`), `${r.salt}:${r.unit}`).toBe(r.hash);
      expect(bucketOf(r.salt, r.unit)).toBe(r.bucket);
      expect(assign(r.salt, r.unit, r.variants)).toBe(r.variant);
    }
  });

  it('published MurmurHash3_x86_32 reference values', () => {
    expect(murmur3('', 0)).toBe(0);
    expect(murmur3('', 1)).toBe(0x514e28b7);
    expect(murmur3('hello')).toBe(0x248bfa47);
    expect(murmur3('Hello, world!', 1234)).toBe(0xfaf6cdb3);
  });

  it('is unaffected by call order, repetition, or other experiments', () => {
    const split: Variant[] = [{ key: 'control', weight: 5000 }, { key: 'treatment', weight: 5000 }];
    const units = Array.from({ length: 500 }, (_, i) => `unit-${i}`);
    const first = units.map((u) => assign('exp-1', u, split));
    // Interleave a second experiment and walk the units backwards, three times over.
    for (let pass = 0; pass < 3; pass++) {
      for (let i = units.length - 1; i >= 0; i--) {
        assign('exp-2', units[i]!, [{ key: 'x', weight: 1000 }, { key: 'y', weight: 9000 }]);
        expect(assign('exp-1', units[i]!, split)).toBe(first[i]);
      }
    }
  });

  it('different salts give independent splits (no unit lands in "treatment" everywhere)', () => {
    const split: Variant[] = [{ key: 'c', weight: 5000 }, { key: 't', weight: 5000 }];
    let both = 0;
    for (let i = 0; i < 4000; i++) if (assign('salt-a', `u${i}`, split) === 't' && assign('salt-b', `u${i}`, split) === 't') both++;
    expect(both / 4000).toBeGreaterThan(0.22);
    expect(both / 4000).toBeLessThan(0.28);
  });

  it('buckets are uniform enough: chi-square over 10 deciles of 100 000 units', () => {
    const counts = new Array(10).fill(0);
    for (let i = 0; i < 100_000; i++) counts[Math.floor(bucketOf('uniformity', String(i)) / 1000)]++;
    const chi2 = counts.reduce((s, c) => s + (c - 10_000) ** 2 / 10_000, 0);
    expect(chi2).toBeLessThan(27.88); // χ²(9) at p = 0.001
  });

  it('rejects malformed weights', () => {
    expect(() => validateWeights([{ key: 'a', weight: 10_000 }])).toThrow(/two variants/);
    expect(() => validateWeights([{ key: 'a', weight: 5000 }, { key: 'b', weight: 4999 }])).toThrow(/sum to 9999/);
    expect(() => validateWeights([{ key: 'a', weight: 5000.5 }, { key: 'b', weight: 4999.5 }])).toThrow(/integer/);
    expect(() => validateWeights([{ key: 'a', weight: 5000 }, { key: 'a', weight: 5000 }])).toThrow(/duplicate/);
  });

  it('a 0-weight variant never receives traffic', () => {
    const v: Variant[] = [{ key: 'a', weight: 0 }, { key: 'b', weight: 10_000 }];
    for (let i = 0; i < 2000; i++) expect(assign('zero', `u${i}`, v)).toBe('b');
  });
});
