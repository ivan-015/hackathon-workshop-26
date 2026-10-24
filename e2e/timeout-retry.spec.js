import { test, expect } from '@playwright/test';
import { STUB_PLAN } from './fixtures/plans.mjs';
import { IDENTIFY_GLOB, choosePhoto, identifyOk, screens, trackRequests, useFakeSpeech } from './helpers.mjs';

const CLIENT_TIMEOUT_MS = 15_000;
const RETRY_TEXT = "Couldn't identify your part. Tap to retry.";

test.beforeEach(async ({ page }) => {
  await useFakeSpeech(page);
});

test('15s client timeout shows the retry screen, never the cached plan; retry succeeds', async ({ page }) => {
  await page.clock.install();
  const requests = trackRequests(page);
  const s = screens(page);
  let calls = 0;
  await page.route(IDENTIFY_GLOB, (route) => {
    calls += 1;
    if (calls === 1) return; // hang: the client must give up on its own
    return identifyOk(STUB_PLAN)(route);
  });

  await page.goto('/demo/');
  await choosePhoto(page);
  await expect(page.locator('#uploading')).toBeVisible();
  await expect.poll(() => calls).toBe(1);

  await page.clock.fastForward(CLIENT_TIMEOUT_MS - 1_000);
  await expect(page.locator('#uploading')).toBeVisible();
  await page.clock.fastForward(1_500);

  await expect(page.locator('#capture-error')).toHaveText(RETRY_TEXT);
  await expect(page.locator('#uploading')).toBeHidden();
  await expect(page.locator('#snap-btn')).toHaveText('↻ RETRY');
  await expect(s.capture).toBeVisible();
  await expect(s.identified).toBeHidden();
  expect(requests.count('/cached/hero-part.json')).toBe(0);

  await page.locator('#snap-btn').tap();
  await expect(s.identified).toBeVisible();
  await expect(page.locator('#part-name')).toHaveText(STUB_PLAN.part.name);
  expect(calls).toBe(2);
  expect(requests.count('/cached/hero-part.json')).toBe(0);
});

const ERROR_CASES = [
  { status: 504, body: { error: 'upstream_timeout' }, text: RETRY_TEXT },
  { status: 502, body: { error: 'bad_model_output' }, text: 'Something went wrong on our side. Tap to retry.' },
  { status: 429, body: { error: 'rate_limited' }, text: 'Too many requests, wait a minute.' },
  { status: 413, body: { error: 'too_large' }, text: 'Photo too large. Tap to retake.' },
];

for (const { status, body, text } of ERROR_CASES) {
  test(`HTTP ${status} from /api/identify shows "${text}" without the cached plan`, async ({ page }) => {
    const requests = trackRequests(page);
    await page.route(IDENTIFY_GLOB, (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }));
    await page.goto('/demo/');
    await choosePhoto(page);
    await expect(page.locator('#capture-error')).toHaveText(text);
    await expect(screens(page).identified).toBeHidden();
    expect(requests.count('/cached/hero-part.json')).toBe(0);
  });
}

test('network failure shows the retry screen', async ({ page }) => {
  await page.route(IDENTIFY_GLOB, (route) => route.abort('internetdisconnected'));
  await page.goto('/demo/');
  await choosePhoto(page);
  await expect(page.locator('#capture-error')).toHaveText(RETRY_TEXT);
  await expect(page.locator('#snap-btn')).toHaveText('↻ RETRY');
});
