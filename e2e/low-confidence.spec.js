import { test, expect } from '@playwright/test';
import { LOW_CONFIDENCE_PLAN, UNIDENTIFIED_PLAN } from './fixtures/plans.mjs';
import { IDENTIFY_GLOB, choosePhoto, identifyOk, screens, expectStep, useFakeSpeech } from './helpers.mjs';

const RETAKE_TEXT = 'Not sure. Retake closer, with the part number facing the camera.';

test.beforeEach(async ({ page }) => {
  await useFakeSpeech(page);
});

test('low confidence shows the retake prompt and still allows START ANYWAY', async ({ page }) => {
  await page.route(IDENTIFY_GLOB, identifyOk(LOW_CONFIDENCE_PLAN));
  const s = screens(page);

  await page.goto('/');
  await choosePhoto(page);
  await expect(s.identified).toBeVisible();
  await expect(page.locator('#low-confidence')).toBeVisible();
  await expect(page.locator('#low-confidence')).toHaveText(RETAKE_TEXT);
  await expect(page.locator('#part-detail')).toContainText('42% confident');
  await expect(page.locator('#retake-btn')).toHaveClass(/btn-primary/);
  await expect(page.locator('#start-btn')).toHaveText('START ANYWAY · 3 steps');
  await expect(page.locator('#start-btn')).not.toHaveClass(/btn-primary/);
  await expect.poll(() => page.evaluate(() => window.__voice.spoken)).toContain(RETAKE_TEXT);

  await page.locator('#start-btn').tap();
  await expectStep(page, 1, 3);
});

test('low confidence: RETAKE returns to capture', async ({ page }) => {
  await page.route(IDENTIFY_GLOB, identifyOk(LOW_CONFIDENCE_PLAN));
  await page.goto('/');
  await choosePhoto(page);
  await page.locator('#retake-btn').tap();
  await expect(screens(page).capture).toBeVisible();
  await expect(page.locator('#capture-error')).not.toHaveText(/Couldn't identify/);
});

test('unidentified plan: no START button, retake prompt, retake returns to capture', async ({ page }) => {
  await page.route(IDENTIFY_GLOB, identifyOk(UNIDENTIFIED_PLAN));
  const s = screens(page);

  await page.goto('/');
  await choosePhoto(page);
  await expect(s.identified).toBeVisible();
  await expect(page.locator('#part-name')).toHaveText('Part not identified');
  await expect(page.locator('#low-confidence')).toBeVisible();
  await expect(page.locator('#start-btn')).toBeHidden();
  await expect(page.locator('#tools-card')).toBeHidden();
  await expect(page.locator('#safety-card')).toBeHidden();

  await page.locator('#retake-btn').tap();
  await expect(s.capture).toBeVisible();
});
