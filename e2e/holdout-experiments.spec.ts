import { execSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

// Holdout Phase 2: an owner drafts an experiment through the form, sees the planned sample size (D-16: 2x the
// fixed-horizon n), starts it, and the design is shown as frozen (HO-01). Seeded as a child process (F-08).
test.beforeAll(() => { execSync('npm run seed:demo:test'); });

test('draft, plan and start an experiment', async ({ page }) => {
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

  await page.getByRole('link', { name: 'Experiments' }).click();
  await expect(page.getByRole('row').filter({ hasText: key })).toContainText('running');
});
