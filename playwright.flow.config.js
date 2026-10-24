// Recorded walkthrough of the main flow (landing page -> demo job -> Job done)
// on desktop and iPhone viewports. Every run records a video per project into
// test-results/flow/.
//
// Local (default): starts e2e/server.mjs like the main suite.
// PREVIEW_URL=https://hackathon.ivanavr.com runs against a deployed site; the
// flow uses ?demo=1, so it never calls /api/identify.

import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT) || 4174;
const PREVIEW_URL = process.env.PREVIEW_URL?.trim() || null;
const LOCAL_URL = `http://127.0.0.1:${PORT}`;
const SLOW_MO_MS = 350;

export default defineConfig({
  testDir: './e2e',
  testMatch: 'main-flow.spec.js',
  outputDir: 'test-results/flow',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/flow' }]],
  use: {
    baseURL: PREVIEW_URL ?? LOCAL_URL,
    video: 'on',
    trace: 'retain-on-failure',
    launchOptions: { slowMo: SLOW_MO_MS },
  },
  projects: [
    {
      name: 'desktop-chrome',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, video: { mode: 'on', size: { width: 1440, height: 900 } } },
    },
    {
      name: 'iphone-14',
      use: { ...devices['iPhone 14'], video: { mode: 'on', size: { width: 390, height: 664 } } },
    },
    {
      name: 'iphone-se',
      use: { ...devices['iPhone SE'], video: { mode: 'on', size: { width: 320, height: 568 } } },
    },
  ],
  webServer: PREVIEW_URL
    ? undefined
    : {
        command: 'node e2e/server.mjs',
        url: `${LOCAL_URL}/index.html`,
        reuseExistingServer: false,
        timeout: 15_000,
        stdout: 'pipe',
        env: {
          PORT: String(PORT),
          SUPABASE_URL: 'http://127.0.0.1:9',
          SUPABASE_SERVICE_ROLE_KEY: 'e2e-dummy-service-role-key',
          ANTHROPIC_API_KEY: 'e2e-dummy-anthropic-key',
        },
      },
});
