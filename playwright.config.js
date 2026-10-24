// Playwright mobile E2E suite (design T5). Specs live in e2e/*.spec.js.
//
// Local (default): starts e2e/server.mjs, which serves public/ and the real
// api/* handlers with a stubbed Claude upstream and an unreachable Supabase.
// PREVIEW_URL=https://... runs only the @smoke specs (no mocks, no local
// server) against a deployed preview.

import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT) || 4173;
const PREVIEW_URL = process.env.PREVIEW_URL?.trim() || null;
const LOCAL_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.js',
  testIgnore: 'main-flow.spec.js', // recorded walkthrough: playwright.flow.config.js
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  grep: PREVIEW_URL ? /@smoke/ : undefined,
  use: {
    baseURL: PREVIEW_URL ?? LOCAL_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'pixel-7',
      use: { ...devices['Pixel 7'] },
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
          // "DB down": real lib/db.js against a port nothing listens on.
          SUPABASE_URL: 'http://127.0.0.1:9',
          SUPABASE_SERVICE_ROLE_KEY: 'e2e-dummy-service-role-key',
          // Never used upstream: e2e/server.mjs answers the Claude URL itself.
          ANTHROPIC_API_KEY: 'e2e-dummy-anthropic-key',
        },
      },
});
