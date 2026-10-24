import { test, expect } from '@playwright/test';
import { STUB_PLAN, MOCK_JOB_ID } from './fixtures/plans.mjs';
import { IDENTIFY_GLOB, choosePhoto, identifyOk, captureProgress, screens, expectStep, trackRequests, useFakeSpeech } from './helpers.mjs';

test.beforeEach(async ({ page }) => {
  await useFakeSpeech(page);
});

test('reload mid-job resumes at the same step with the same job id', async ({ page }) => {
  let identifyCalls = 0;
  await page.route(IDENTIFY_GLOB, (route) => {
    identifyCalls += 1;
    return identifyOk(STUB_PLAN, MOCK_JOB_ID)(route);
  });
  const progress = await captureProgress(page);

  await page.goto('/demo/');
  await choosePhoto(page);
  await page.locator('#start-btn').tap();
  await page.locator('#next-btn').tap();
  await expectStep(page, 2, 3);

  await page.reload();
  await expect(screens(page).job).toBeVisible();
  await expectStep(page, 2, 3);
  await expect(page.locator('#step-text')).toHaveText(STUB_PLAN.steps[1].text);
  expect(identifyCalls).toBe(1);

  await page.locator('#next-btn').tap();
  await expectStep(page, 3, 3);
  await expect.poll(() => progress.at(-1)).toEqual({ job_id: MOCK_JOB_ID, current_step: 2, status: 'active' });
});

test('reload on the Identified screen restores it', async ({ page }) => {
  await page.route(IDENTIFY_GLOB, identifyOk(STUB_PLAN));
  await page.goto('/demo/');
  await choosePhoto(page);
  await expect(screens(page).identified).toBeVisible();
  await page.reload();
  await expect(screens(page).identified).toBeVisible();
  await expect(page.locator('#part-name')).toHaveText(STUB_PLAN.part.name);
});

test('reload after Job done stays on Job done; NEW PART clears the saved job', async ({ page }) => {
  await page.route(IDENTIFY_GLOB, identifyOk(STUB_PLAN));
  await page.goto('/demo/');
  await choosePhoto(page);
  await page.locator('#start-btn').tap();
  for (let i = 0; i < 3; i += 1) await page.locator('#next-btn').tap();
  await expect(screens(page).done).toBeVisible();

  await page.reload();
  await expect(screens(page).done).toBeVisible();
  await page.locator('#new-part-btn').tap();
  await expect(screens(page).capture).toBeVisible();
  await page.reload();
  await expect(screens(page).capture).toBeVisible();
});

test('corrupt sessionStorage falls back to the capture screen', async ({ page }) => {
  const requests = trackRequests(page);
  await page.goto('/demo/');
  await page.evaluate(() => sessionStorage.setItem('ghc:job:v1', '{"plan":{"part":{}},"screen":"job"}'));
  await page.reload();
  await expect(screens(page).capture).toBeVisible();
  expect(requests.count('/api/identify')).toBe(0);
});
