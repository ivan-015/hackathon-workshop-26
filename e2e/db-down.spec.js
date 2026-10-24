// "DB down still works": no page.route mocks. The real api/identify.js and
// api/progress.js run in e2e/server.mjs with SUPABASE_URL pointing at a port
// nothing listens on (playwright.config.js) and the Claude upstream stubbed.

import { test, expect } from '@playwright/test';
import { STUB_PLAN } from './fixtures/plans.mjs';
import { choosePhoto, screens, tapThroughJob, useFakeSpeech } from './helpers.mjs';

test.skip(Boolean(process.env.PREVIEW_URL), 'needs the local e2e server with an unreachable SUPABASE_URL');

test('identify returns 200 with job_id null and the full job still runs', async ({ page, request }) => {
  await useFakeSpeech(page);
  const { claudeCalls: before } = await (await request.get('/api/__e2e')).json();

  await page.goto('/');
  const responsePromise = page.waitForResponse((r) => r.url().endsWith('/api/identify'));
  await choosePhoto(page);
  const response = await responsePromise;

  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.job_id).toBeNull();
  expect(body.plan.part.name).toBe(STUB_PLAN.part.name);
  expect(body.plan.steps).toHaveLength(STUB_PLAN.steps.length);

  const { claudeCalls: after } = await (await request.get('/api/__e2e')).json();
  expect(after).toBe(before + 1);

  await expect(screens(page).identified).toBeVisible();
  await page.locator('#start-btn').tap();
  await tapThroughJob(page, STUB_PLAN.steps.length);
});

test('progress endpoint answers 204 fast while the DB is unreachable', async ({ request }) => {
  const started = Date.now();
  const res = await request.post('/api/progress', {
    data: { job_id: '11111111-2222-4333-8444-555555555555', current_step: 1, status: 'active' },
  });
  expect(res.status()).toBe(204);
  expect(Date.now() - started).toBeLessThan(3_000);
});

test('identify validates input through the real handler', async ({ request }) => {
  const res = await request.post('/api/identify', { data: { image: 'not-an-image' } });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toBe('bad_request');
});
