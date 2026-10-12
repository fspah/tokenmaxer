import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  timeout: 45000,
  expect: { timeout: 10000 },
  fullyParallel: true,
  workers: 2,
  reporter: 'list',
  use: { headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
