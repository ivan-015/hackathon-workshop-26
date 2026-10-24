import { test, expect } from '@playwright/test';
import { STUB_PLAN } from './fixtures/plans.mjs';
import { IDENTIFY_GLOB, choosePhoto, identifyOk, screens, expectStep, useFakeSpeech } from './helpers.mjs';

test.beforeEach(async ({ page }) => {
  await useFakeSpeech(page);
  await page.route(IDENTIFY_GLOB, identifyOk(STUB_PLAN));
});

async function say(page, transcript) {
  await expect.poll(() => page.evaluate(() => window.__voice.listening())).toBe(true);
  await page.evaluate((t) => window.__voice.say(t), transcript);
}

test('fake speech: "next" / "back" / "repeat" drive the job to Job done', async ({ page }) => {
  const s = screens(page);
  await page.goto('/demo/');
  await choosePhoto(page);
  await page.locator('#start-btn').tap(); // first tap grants and activates voice
  await expectStep(page, 1, 3);
  await expect(page.locator('#mic-hint')).toContainText('Listening');

  await say(page, 'next');
  await expectStep(page, 2, 3);
  await say(page, 'Back');
  await expectStep(page, 1, 3);

  // Step prose that merely contains a command word must not trigger it.
  await say(page, 'remove the back cover');
  await say(page, 'next step');
  await expectStep(page, 2, 3);

  const before = await page.evaluate(() => window.__voice.spoken.length);
  await say(page, 'repeat');
  await expect.poll(() => page.evaluate(() => window.__voice.spoken.at(-1))).toContain(STUB_PLAN.steps[1].text);
  expect(await page.evaluate(() => window.__voice.spoken.length)).toBeGreaterThan(before);

  await say(page, 'next');
  await expectStep(page, 3, 3);
  await say(page, 'next');
  await expect(s.done).toBeVisible();
});

test('steps are spoken aloud with spec and warning', async ({ page }) => {
  await page.goto('/demo/');
  await choosePhoto(page);
  await page.locator('#start-btn').tap();
  await page.locator('#next-btn').tap();
  await expect.poll(() => page.evaluate(() => window.__voice.spoken.at(-1)))
    .toBe(`Step 2 of 3. ${STUB_PLAN.steps[1].text} Warning: Hot oil burns.`);
  await page.locator('#next-btn').tap();
  await expect.poll(() => page.evaluate(() => window.__voice.spoken.at(-1)))
    .toBe(`Step 3 of 3. ${STUB_PLAN.steps[2].text} Spec: 30 Nm. Verify with the service manual.`);
});

test('recognition network error shows "Voice offline, use buttons" and buttons still work', async ({ page }) => {
  await page.goto('/demo/');
  await choosePhoto(page);
  await page.locator('#start-btn').tap();
  await expect.poll(() => page.evaluate(() => window.__voice.listening())).toBe(true);
  await page.evaluate(() => window.__voice.fail('network'));
  await expect(page.locator('#mic-hint')).toHaveText('Voice offline, use buttons');
  await expect(page.locator('#mic-hint')).toHaveClass(/is-offline/);
  await page.locator('#next-btn').tap();
  await expectStep(page, 2, 3);
});
