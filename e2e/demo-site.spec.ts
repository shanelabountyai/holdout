import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// Holdout Phase 4: the demo site (demo-site/, :8101) against the real Holdout on :8100 (Playwright's webServer).
// A visitor's variant from the browser snippet equals the server SDK's for the same cookie; clicking Buy lands the
// exposure and the purchase in Holdout through the /collect relay; and sdk/holdout.js reproduces the 1 000 golden
// assignment rows inside Chromium (PRD: snippet and SDK proven identical by shared test vectors).
// Seeding runs as a child process (F-08): Playwright's loader cannot import the app's modules.

const SITE = 'http://localhost:8101';
const ENV_FILE = '.env.demo-site.e2e';
const run = (cmd: string) => execSync(cmd, { encoding: 'utf8' });
let site: ChildProcess | null = null;
let experimentId = '';
let siteLog = '';

test.beforeAll(async () => {
  run('npm run seed:demo:test');
  const key = `demo-e2e-${Date.now().toString(36)}`;
  run(`npx dotenv -e .env.test -e .env.local -- tsx scripts/demo-site-setup.ts --out ${ENV_FILE} --key ${key}`);
  const env = Object.fromEntries(
    readFileSync(ENV_FILE, 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  rmSync(ENV_FILE);
  experimentId = env.DEMO_EXPERIMENT_ID!;
  site = spawn('npx', ['tsx', 'demo-site/server.ts'], {
    env: { ...process.env, HOLDOUT_API_KEY: env.HOLDOUT_API_KEY, DEMO_EXPERIMENT: env.DEMO_EXPERIMENT, DEMO_PORT: '8101', HOLDOUT_URL: 'http://localhost:8100', DEMO_REFRESH_MS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  site.stdout!.on('data', (d) => (siteLog += d));
  site.stderr!.on('data', (d) => (siteLog += d));
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${SITE}/health`);
      if (r.ok && ((await r.json()) as { experiments: number }).experiments >= 0) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`demo site did not start:\n${siteLog}`);
});

test.afterAll(() => {
  site?.kill();
});

test('a visitor sees the same variant from the snippet and the server SDK, and the purchase reaches Holdout', async ({ page, context }) => {
  await page.goto(`${SITE}/`);
  const buy = page.locator('#buy');
  await expect(buy).not.toHaveAttribute('data-variant', '');
  const variant = (await buy.getAttribute('data-variant'))!;
  expect(['control', 'treatment']).toContain(variant);
  await expect(buy).toHaveText(variant === 'treatment' ? 'Buy now: free shipping' : 'Add to cart');
  const uid = (await context.cookies(SITE)).find((c) => c.name === 'nw_uid')!.value;
  expect(uid).toMatch(/^[0-9a-f-]{36}$/);

  await buy.click();
  await expect(page.getByRole('status')).toHaveText('Thanks! Your order is on its way.');

  await page.goto(`${SITE}/server`);
  await expect(page.locator('#buy')).toHaveAttribute('data-variant', variant);
  await expect(page.locator('#variant')).toHaveText(variant);

  const stored = JSON.parse(run(`npx dotenv -e .env.test -e .env.local -- tsx scripts/demo-site-setup.ts events ${experimentId} ${uid}`).trim().split('\n').pop()!) as {
    exposures: { variant: string; eventId: string }[];
    conversions: { event: string; eventId: string }[];
  };
  expect(stored.exposures.map((e) => e.variant), siteLog).toEqual([variant]);
  expect(stored.exposures[0]!.eventId.startsWith(`${uid}.`)).toBe(true); // the snippet's exposure, relayed for this cookie
  expect(stored.conversions.map((c) => c.event), siteLog).toEqual(['purchase']);
});

test('sdk/holdout.js reproduces the 1 000 golden assignment rows inside Chromium', async ({ page }) => {
  const rows = (JSON.parse(readFileSync('tests/exp/fixtures/assignment-golden.json', 'utf8')) as { rows: { salt: string; unit: string; variants: { key: string; weight: number }[]; variant: string }[] }).rows;
  await page.goto(`${SITE}/`);
  const got = await page.evaluate((rs) => rs.map((r) => (window as unknown as { Holdout: { assign: (s: string, u: string, v: unknown) => string } }).Holdout.assign(r.salt, r.unit, r.variants)), rows);
  expect(got).toHaveLength(1000);
  const mismatches = rows.filter((r, i) => got[i] !== r.variant).length;
  expect(mismatches).toBe(0);
});
