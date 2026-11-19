import { execSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

// Holdout Phase 2: an owner drafts an experiment through the form, sees the planned sample size (D-16: 2x the
// fixed-horizon n), starts it, and the design is shown as frozen (HO-01). Phase 3: the readout says there is not enough
// data yet and that the sample-ratio check is not yet checkable (issue #5, D-41), and stopping records the final readout
// and a history line (HO-05). Seeded as a child process (F-08).
// Design pass (D-42): the pages follow docs/design/*.dc.html; the new-experiment form shows the planned sample live, the
// list shows each experiment's decision, and the install page lists running experiments' keys.
test.beforeAll(() => { execSync('npm run seed:demo:test'); });

test('draft, plan, start, read out and stop an experiment', async ({ page }) => {
  const key = `e2e-${Date.now().toString(36)}`;
  // Start, stop and delete ask first (design review, PRD UX-05); this flow accepts every question.
  const asked: string[] = [];
  page.on('dialog', (d) => { asked.push(d.message()); void d.accept(); });
  await page.goto('/demo');
  await page.getByRole('button', { name: 'owner@acme.demo.test' }).click();
  await page.getByRole('link', { name: 'Acme Studio' }).click();
  const nav = page.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('link', { name: 'Experiments', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Experiments', exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Experiments', exact: true })).toHaveAttribute('aria-current', 'page');
  await nav.getByRole('link', { name: 'New experiment' }).click();
  await expect(nav.getByRole('link', { name: 'New experiment' })).toHaveAttribute('aria-current', 'page');

  await page.getByLabel('Name', { exact: true }).fill('Checkout button');
  await page.getByLabel('Key', { exact: true }).fill(key);
  await page.getByLabel('Event name').fill('purchase');
  // A refused save keeps what was typed and says why beside the button (design review, PRD UX-03).
  await page.getByLabel(/^Minimum detectable effect/).fill('2');
  await page.getByLabel('Variant 2 weight').fill('40');
  await page.getByLabel(/^Baseline/).fill('10');
  await page.getByRole('button', { name: 'Create draft and get the snippet' }).click();
  await expect(page.getByTestId('refused')).toHaveText('Not saved: Variant weights must add up to exactly 100%.');
  await expect(page.getByTestId('refused')).toBeFocused();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Checkout button');
  await expect(page.getByLabel('Key', { exact: true })).toHaveValue(key);
  await page.getByLabel('Variant 2 weight').fill('50');
  await page.getByLabel(/^Minimum detectable effect/).fill('2');
  // The planned sample is computed live, by the same planFor the server stores (D-42).
  await expect(page.getByTestId('planned-per-arm')).toHaveText('7,682');
  await expect(page.getByText('units per arm · 15,364 in total')).toBeVisible();
  // The presets fill the same field and show which one is chosen.
  await page.getByRole('button', { name: '+3 pts' }).click();
  await expect(page.getByLabel(/^Minimum detectable effect/)).toHaveValue('3');
  await expect(page.getByRole('button', { name: '+3 pts' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '+2 pts' }).click();
  await expect(page.getByRole('button', { name: '+3 pts' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('planned-per-arm')).toHaveText('7,682');
  await page.getByRole('button', { name: '+ Add guardrail' }).click();
  await page.getByLabel('Guardrail 1 event').fill('refund');
  await page.getByRole('button', { name: 'Create draft and get the snippet' }).click();

  await expect(page.getByRole('heading', { name: 'Checkout button' })).toBeVisible();
  await expect(page.getByText('Draft: not started')).toBeVisible();
  const plan = page.getByRole('region', { name: 'Planned sample' });
  await expect(plan.getByText('2× the fixed-horizon size (3,841 per arm')).toBeVisible();
  await expect(plan.getByText('7,682', { exact: true })).toBeVisible();
  await expect(plan.getByText('units per arm · 15,364 in total')).toBeVisible();

  await page.getByRole('button', { name: 'Start experiment' }).click();
  await expect(page.getByText('Running since today')).toBeVisible();
  expect(asked.at(-1)).toContain('Start this experiment?');
  await expect(page.getByText('The design is frozen')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start experiment' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Edit draft' })).toHaveCount(0);

  // Phase 3 readout: no units yet, so no effect is reported.
  await expect(page.getByRole('heading', { name: 'Decision' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Keep running: not enough data');
  // Issue #5 (D-41): with no traffic the split cannot be judged yet; the page says so instead of "split matches the weights".
  await expect(page.getByText('SRM not yet checkable: 0 of 9,835 units')).toBeVisible();
  await expect(page.getByText('split matches the weights')).toHaveCount(0);
  await expect(page.getByText('Started by owner@acme.demo.test')).toBeVisible();

  // Install page: the running experiment's key is listed for the snippet.
  await nav.getByRole('link', { name: 'Install snippet' }).click();
  await expect(page.getByRole('heading', { name: 'Install the snippet' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: key })).toContainText('purchase');

  await nav.getByRole('link', { name: 'Experiments', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: key })).toContainText('Running');
  await expect(page.getByRole('row').filter({ hasText: key })).toContainText('Keep running: not enough data');
  await expect(page.getByRole('row').filter({ hasText: key })).toContainText('0 of 7,682 units (0%)');
  await page.getByRole('row').filter({ hasText: key }).getByRole('link').first().click();

  await page.getByLabel('Reason (optional)').fill('e2e: checking the stop');
  await page.getByRole('button', { name: 'Stop and store this readout' }).click();
  await expect(page.getByText('Stopped the day it started')).toBeVisible();
  expect(asked.at(-1)).toContain('Stop this experiment for good?');
  await expect(page.getByRole('heading', { name: 'Stopped · decision at the stop' })).toBeVisible();
  await expect(page.getByText('Reason given at the stop: “e2e: checking the stop”')).toBeVisible();
  await expect(page.getByText('Final readout, recorded when the experiment stopped')).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Keep running: not enough data');
  await expect(page.getByText('SRM not yet checkable: 0 of 9,835 units')).toBeVisible();
  await expect(page.getByText('Stopped by owner@acme.demo.test — “e2e: checking the stop”')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop and store this readout' })).toHaveCount(0);
});

// Design review (PRD UX-01): no page of the experiment flow scrolls sideways on a 390 px phone.
test('experiment pages fit a 390 px phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/demo');
  await page.getByRole('button', { name: 'owner@acme.demo.test' }).click();
  await page.getByRole('link', { name: 'Acme Studio' }).click();
  for (const path of ['experiments', 'experiments/new', 'install']) {
    await page.goto(`${new URL(page.url()).pathname.replace(/^(\/o\/[^/]+).*$/, '$1')}/${path}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth), path).toBeLessThanOrEqual(390);
  }
});
