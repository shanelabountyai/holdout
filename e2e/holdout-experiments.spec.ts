import { execSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

// Holdout Phase 2: an owner drafts an experiment through the form, sees the planned sample size (D-16: 2x the
// fixed-horizon n), starts it, and the design is shown as frozen (HO-01). Phase 3: the readout says there is not enough
// data yet and that the sample-ratio check is not yet checkable (issue #5, D-41), and stopping records the final readout
// and a history line (HO-05). Seeded as a child process (F-08).
test.beforeAll(() => { execSync('npm run seed:demo:test'); });

test('draft, plan, start, read out and stop an experiment', async ({ page }) => {
  const key = `e2e-${Date.now().toString(36)}`;
  await page.goto('/demo');
  await page.getByRole('button', { name: 'owner@acme.demo.test' }).click();
  await page.getByRole('link', { name: 'Acme Studio' }).click();
  await page.getByRole('link', { name: 'Experiments' }).click();
  await expect(page.getByRole('heading', { name: 'Experiments' })).toBeVisible();
  await page.getByRole('link', { name: 'New experiment' }).click();

  await page.getByLabel('Name', { exact: true }).fill('Checkout button');
  await page.getByLabel('Key', { exact: true }).fill(key);
  await page.getByLabel('Event name').fill('purchase');
  await page.getByLabel(/^Baseline/).fill('10');
  await page.getByLabel(/^Minimum detectable effect/).fill('2');
  await page.getByLabel('Guardrail 1 event').fill('refund');
  await page.getByRole('button', { name: 'Save draft' }).click();

  await expect(page.getByRole('heading', { name: 'Checkout button' })).toBeVisible();
  await expect(page.getByText('Fixed-horizon test: 3,841 units per arm')).toBeVisible();
  await expect(page.getByText('Planned for the sequential readout: 7,682 units per arm')).toBeVisible();
  await expect(page.getByText('Planned total: 15,364 units')).toBeVisible();

  await page.getByRole('button', { name: 'Start experiment' }).click();
  await expect(page.getByText('status running')).toBeVisible();
  await expect(page.getByText('The design is frozen')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start experiment' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Edit draft' })).toHaveCount(0);

  // Phase 3 readout: no units yet, so no effect is reported.
  await expect(page.getByRole('heading', { name: 'Readout' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Keep running: not enough data');
  // Issue #5 (D-41): with no traffic the split cannot be judged yet; the page says so instead of "split matches the weights".
  await expect(page.getByText('SRM not yet checkable: 0 of 9,835 units')).toBeVisible();
  await expect(page.getByText('split matches the weights')).toHaveCount(0);
  await expect(page.getByText('experiment.started by owner@acme.demo.test')).toBeVisible();

  await page.getByRole('link', { name: 'Experiments' }).click();
  await expect(page.getByRole('row').filter({ hasText: key })).toContainText('running');
  await page.getByRole('row').filter({ hasText: key }).getByRole('link').first().click();

  await page.getByLabel('Reason (optional)').fill('e2e: checking the stop');
  await page.getByRole('button', { name: 'Stop experiment' }).click();
  await expect(page.getByText('status stopped')).toBeVisible();
  await expect(page.getByText('Final readout, recorded when the experiment stopped')).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Keep running: not enough data');
  await expect(page.getByText('SRM not yet checkable: 0 of 9,835 units')).toBeVisible();
  await expect(page.getByText('experiment.stopped by owner@acme.demo.test — “e2e: checking the stop”')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop experiment' })).toHaveCount(0);
});
