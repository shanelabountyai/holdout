import { assign, mulberry32 } from '@/lib/exp';
import type { Look, ReadoutDesign } from '@/lib/holdout/readout';
import { DAYS, SCENARIOS, VISITORS_PER_DAY, type Scenario } from '../../scripts/case-study';

// The README case study's traffic (scripts/case-study.ts, D-39) rebuilt without the database: the same seeds, the same
// salts, the same assign() the server SDK calls, and the same order of random draws per visitor (lost exposure, purchase,
// refund). A unit counts once its exposure arrives; a lost exposure means the unit never enters the readout (D-19, D-29).
// tests/holdout/readout-clarity.test.ts checks these looks against docs/holdout/case-study.json before using them.

export const caseStudyDesign = (): ReadoutDesign => ({
  metricEvent: 'purchase',
  metricKind: 'proportion',
  mde: 0.02,
  alpha: 0.05,
  plannedUnitsPerArm: 7682, // what the app plans for 10% → 12% (D-16, D-20); the JSON records it per scenario
  variants: [
    { key: 'control', name: 'Add to cart', weight: 5000 },
    { key: 'treatment', name: 'Buy now: free shipping', weight: 5000 },
  ],
  guardrails: [{ event: 'refund', kind: 'proportion' }],
});

export function caseStudyLooks(key: Scenario['key']): Look[] {
  const s = SCENARIOS.find((x) => x.key === key)!;
  const salt = `case-study-${s.key}-${s.seed}`;
  const variants = caseStudyDesign().variants.map((v) => ({ key: v.key, weight: v.weight }));
  const rand = mulberry32(s.seed);
  const arms = [0, 1].map(() => ({ units: 0, purchase: 0, refund: 0 }));
  const looks: Look[] = [];
  for (let d = 0; d < DAYS; d++) {
    for (let i = 0; i < VISITORS_PER_DAY; i++) {
      const unit = `${s.key}-v${d}-${i}`;
      const lost = rand() < s.dropTreatmentExposures;
      const arm = assign(salt, unit, variants) === 'control' ? 0 : 1;
      const exposed = !(arm === 1 && lost);
      const a = arms[arm]!;
      if (exposed) a.units++;
      if (rand() < s.rates[arm]! && exposed) a.purchase++;
      if (rand() < s.refunds[arm]! && exposed) a.refund++;
    }
    looks.push({
      at: `day-${d + 1}`,
      arms: arms.map((a) => ({ units: a.units, metrics: { purchase: { sum: a.purchase, sumSq: a.purchase }, refund: { sum: a.refund, sumSq: a.refund } } })),
    });
  }
  return looks;
}
