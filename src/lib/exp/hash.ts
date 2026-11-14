// Deterministic assignment (PRD "Assignment", HO-01). Pure and synchronous, no Node or DOM APIs, so the browser
// snippet (Phase 4) and the server SDK run this exact function. Changing anything here re-buckets every unit of
// every running experiment: tests/exp/fixtures/assignment-golden.json exists to make that fail loudly.

export const BUCKETS = 10_000;

function utf8(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/** MurmurHash3 x86_32 (Austin Appleby, public domain) over the UTF-8 bytes of `key`. Unsigned 32-bit result. */
export function murmur3(key: string, seed = 0): number {
  const b = utf8(key);
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let h = seed >>> 0;
  const nblocks = b.length >> 2;
  for (let i = 0; i < nblocks; i++) {
    const j = i * 4;
    let k = b[j]! | (b[j + 1]! << 8) | (b[j + 2]! << 16) | (b[j + 3]! << 24);
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  let k = 0;
  const tail = nblocks * 4;
  switch (b.length & 3) {
    case 3:
      k ^= b[tail + 2]! << 16;
    // falls through
    case 2:
      k ^= b[tail + 1]! << 8;
    // falls through
    case 1:
      k ^= b[tail]!;
      k = Math.imul(k, c1);
      k = (k << 15) | (k >>> 17);
      k = Math.imul(k, c2);
      h ^= k;
  }
  h ^= b.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Bucket in [0, 10 000). Modulo bias is (2^32 mod 10^4) / 2^32 ≈ 1.7e-6 per bucket: negligible. */
export function bucketOf(salt: string, unitId: string): number {
  return murmur3(`${salt}:${unitId}`) % BUCKETS;
}

export interface Variant {
  key: string;
  /** Traffic share in basis points; an experiment's weights sum to 10 000 (`validateWeights`). */
  weight: number;
}

export function validateWeights(variants: readonly Variant[]): void {
  if (variants.length < 2) throw new Error('an experiment needs at least two variants');
  const keys = new Set<string>();
  let sum = 0;
  for (const v of variants) {
    if (!Number.isInteger(v.weight) || v.weight < 0) throw new Error(`weight of "${v.key}" must be a non-negative integer (basis points)`);
    if (keys.has(v.key)) throw new Error(`duplicate variant key "${v.key}"`);
    keys.add(v.key);
    sum += v.weight;
  }
  if (sum !== BUCKETS) throw new Error(`weights sum to ${sum}, expected ${BUCKETS}`);
}

/** The variant a unit sees: cumulative weights in the order given. Same inputs, same answer, forever (HO-01). */
export function assign(salt: string, unitId: string, variants: readonly Variant[]): string {
  validateWeights(variants);
  const b = bucketOf(salt, unitId);
  let edge = 0;
  for (const v of variants) {
    edge += v.weight;
    if (b < edge) return v.key;
  }
  throw new Error('unreachable: weights validated to sum to BUCKETS');
}
