import { expect, test } from '@playwright/test';

/**
 * Browser journey against a running dev stack (see docs/development.md):
 *   register -> connect local repos -> import -> deploy -> watch logs -> visit the deployed site.
 * Run with: npx playwright test   (BASE_URL defaults to http://app.localhost:8080)
 * Requires `./scripts/dev.sh repo static-site` to have been run.
 */
const stamp = Date.now().toString(36);

test('register, import a repository, deploy, and open the live site', async ({ page, context }) => {
  await page.goto('/register');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(`e2e-${stamp}@example.com`);
  await page.getByLabel('Password').fill('e2e-password-12345');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

  await page.goto('/github');
  await page.getByRole('button', { name: 'Use local dev repositories' }).click();
  await expect(page.getByText('Local development repositories').first()).toBeVisible();

  await page.goto('/projects/new');
  await page.getByRole('button', { name: 'Select' }).first().click();
  await expect(page.getByText(/Detected:/)).toBeVisible();
  await page.getByLabel('Project name').fill(`e2e-${stamp}`);
  await page.getByLabel('Build command').fill('node build.mjs');
  await page.getByLabel('Output directory').fill('dist');
  await page.getByRole('button', { name: 'Create & deploy' }).click();

  await expect(page).toHaveURL(/\/deployments\//);
  await expect(page.getByText('ready', { exact: true }).first()).toBeVisible({ timeout: 180_000 });
  await expect(page.getByLabel('Build log output')).toContainText('Deployment is live');

  const [site] = await Promise.all([context.waitForEvent('page'), page.getByRole('link', { name: 'Visit' }).click()]);
  await expect(site.getByRole('heading', { name: /Hello from DeployForge/ })).toBeVisible();
});

test('protected pages redirect to sign-in', async ({ page }) => {
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/login/);
});
