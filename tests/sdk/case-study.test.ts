// The README case study's numbers are the output of `npm run case-study` (scripts/case-study.ts), committed as
// docs/holdout/case-study.json. This reruns the whole study (three experiments, 14 simulated days, real ingest route and
// readout) and requires the same JSON, so the README cannot drift from what the code produces.
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { advanceClock } from '@/core/clock';
import { runCaseStudy } from '../../scripts/case-study';
import { resetAuthTables } from '../helpers/auth';

afterAll(async () => {
  advanceClock(0);
  await resetAuthTables();
});

describe('README case study (scripts/case-study.ts)', () => {
  it('reproduces docs/holdout/case-study.json exactly', async () => {
    await resetAuthTables();
    const fresh = await runCaseStudy({ slug: 'case-study-test' });
    const committed = JSON.parse(readFileSync('docs/holdout/case-study.json', 'utf8'));
    expect(JSON.parse(JSON.stringify(fresh))).toEqual(committed);
  }, 180_000);

  it('every event the SDK sent was accepted, and the sequential readout never shipped the A/A', () => {
    const { results } = JSON.parse(readFileSync('docs/holdout/case-study.json', 'utf8')) as Awaited<ReturnType<typeof runCaseStudy>>;
    for (const r of results) {
      expect(r.sent.rejected).toBe(0);
      expect(r.sent.accepted).toBe(r.sent.exposures + r.sent.conversions);
    }
    const aa = results.find((r) => r.key === 'a-a')!;
    expect(aa.days.some((d) => d.state === 'ship' || d.state === 'worse')).toBe(false);
    const broken = results.find((r) => r.key === 'broken-client')!;
    expect(broken.days.at(-1)!.state).toBe('srm'); // HO-04: the lost exposures are caught and the effect is withheld
    expect(broken.days.at(-1)!.rates).toEqual([null, null]);
  });

  it('issue #5: the real effect ends "Inconclusive at planned sample size", and no "Ship" before the SRM check can see an 8% loss', () => {
    const { results } = JSON.parse(readFileSync('docs/holdout/case-study.json', 'utf8')) as Awaited<ReturnType<typeof runCaseStudy>>;
    const real = results.find((r) => r.key === 'real-effect')!;
    expect(real.days.slice(12).map((d) => d.headline)).toEqual(['Inconclusive at planned sample size', 'Inconclusive at planned sample size']);
    expect(real.firstDecisive).toEqual({ day: 13, state: 'inconclusive' });
    const aa = results.find((r) => r.key === 'a-a')!;
    expect(aa.days.slice(12).map((d) => d.headline)).toEqual(['No detectable effect at planned sample size', 'No detectable effect at planned sample size']);
    const broken = results.find((r) => r.key === 'broken-client')!;
    for (const d of broken.days) {
      const total = d.units.reduce((s, u) => s + u, 0);
      if (total < 9835) expect(d.headline, `day ${d.day}`).not.toMatch(/^Ship/);
    }
    expect(broken.days.slice(3, 8).map((d) => d.headline)).toEqual(Array(5).fill('Keep running: SRM not yet checkable'));
  });
});
