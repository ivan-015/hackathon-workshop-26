import { test, expect } from '@playwright/test';
import { STUB_PLAN, MOCK_JOB_ID } from './fixtures/plans.mjs';
import { IDENTIFY_GLOB, choosePhoto, identifyOk, captureProgress, screens, expectStep, tapThroughJob, useFakeSpeech } from './helpers.mjs';

test.beforeEach(async ({ page }) => {
  await useFakeSpeech(page);
});

test('full job: photo -> identified -> tap Next through to Job done', async ({ page }) => {
  await page.route(IDENTIFY_GLOB, identifyOk(STUB_PLAN, MOCK_JOB_ID));
  const progress = await captureProgress(page);
  const s = screens(page);

  await page.goto('/demo/');
  await expect(s.capture).toBeVisible();
  await choosePhoto(page);

  await expect(s.identified).toBeVisible();
  await expect(page.locator('#part-name')).toHaveText('Oil filter');
  await expect(page.locator('#part-detail')).toContainText('88% confident');
  await expect(page.locator('#tools-list li')).toHaveText(STUB_PLAN.tools);
  await expect(page.locator('#safety-list li')).toHaveText(STUB_PLAN.safety);
  await expect(page.locator('#low-confidence')).toBeHidden();
  await expect(page.locator('#part-thumb')).toBeVisible();

  await page.locator('#start-btn').tap();
  await expect(s.job).toBeVisible();
  await expectStep(page, 1, 3);
  await expect(page.locator('#step-text')).toHaveText(STUB_PLAN.steps[0].text);
  await expect(page.locator('#back-btn')).toBeDisabled();

  await page.locator('#next-btn').tap();
  await expect(page.locator('#step-warning')).toHaveText('⚠ Hot oil burns');
  await page.locator('#back-btn').tap();
  await expectStep(page, 1, 3);

  await page.locator('#next-btn').tap();
  await page.locator('#next-btn').tap();
  await expect(page.locator('#spec-text')).toHaveText('30 Nm');
  await expect(page.locator('#next-btn')).toHaveText('DONE ✔');

  await page.locator('#next-btn').tap();
  await expect(s.done).toBeVisible();
  await expect(page.locator('#done-job')).toHaveText(STUB_PLAN.job);

  await expect.poll(() => progress.at(-1)).toEqual({ job_id: MOCK_JOB_ID, current_step: 3, status: 'completed' });
  expect(progress[0]).toEqual({ job_id: MOCK_JOB_ID, current_step: 0, status: 'active' });

  await page.locator('#new-part-btn').tap();
  await expect(s.capture).toBeVisible();
});

test('full job without a job_id sends no progress beacons', async ({ page }) => {
  await page.route(IDENTIFY_GLOB, identifyOk(STUB_PLAN, null));
  const progress = await captureProgress(page);

  await page.goto('/demo/');
  await choosePhoto(page);
  await page.locator('#start-btn').tap();
  await tapThroughJob(page, 3);
  expect(progress).toEqual([]);
});
