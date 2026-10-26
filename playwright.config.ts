import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 240_000,
  retries: 0,
  use: { baseURL: process.env.BASE_URL ?? 'http://app.localhost:8080', trace: 'retain-on-failure' },
  reporter: [['list']],
});
