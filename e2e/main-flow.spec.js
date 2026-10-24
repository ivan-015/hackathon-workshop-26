// Main flow walkthrough, run by playwright.flow.config.js on desktop and
// iPhone projects with video on. Asserts no horizontal overflow on each screen.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { choosePhoto, expectStep, screens, useFakeSpeech } from './helpers.mjs';

const HERO = JSON.parse(readFileSync(new URL('../public/cached/hero-part.json', import.meta.url), 'utf8'));
const LINGER_MS = 800;

async function expectNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'page scrolls horizontally').toBeLessThanOrEqual(0);
}

test.beforeEach(async ({ page }) => {
  await useFakeSpeech(page);
});

test('landing page -> Try the demo -> full brake job -> Job done', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  const s = screens(page);

  await page.goto('/');
  await expect(page.locator('#title')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Try the demo' })).toBeInViewport();
  await expectNoHorizontalOverflow(page);
  await page.waitForTimeout(LINGER_MS * 2);

  await page.getByRole('link', { name: 'Try the demo' }).click();
  await expect(page).toHaveURL(/\/demo\/\?demo=1$/);
  await expect(s.capture).toBeVisible();
  await expect(page.locator('#capture-note')).toHaveText(`Demo part ready: ${HERO.part.name} (cached)`);
  await expectNoHorizontalOverflow(page);
  await page.waitForTimeout(LINGER_MS);

  await choosePhoto(page);
  await expect(s.identified).toBeVisible();
  await expect(page.locator('#part-name')).toHaveText(HERO.part.name);
  await expectNoHorizontalOverflow(page);
  await page.waitForTimeout(LINGER_MS);
  // The tools + safety lists push START JOB below the fold on short phones
  // (iPhone SE); scroll to it the way a user would.
  await page.locator('#start-btn').scrollIntoViewIfNeeded();
  await expect(page.locator('#start-btn')).toBeInViewport();
  await page.waitForTimeout(LINGER_MS);

  await page.locator('#start-btn').click();
  await expect(s.job).toBeVisible();
  const total = HERO.steps.length;
  for (let n = 1; n <= total; n += 1) {
    await expectStep(page, n, total);
    await expect(page.locator('#next-btn')).toBeInViewport();
    await expectNoHorizontalOverflow(page);
    await page.locator('#next-btn').click();
  }

  await expect(s.done).toBeVisible();
  await expect(page.locator('#done-job')).toHaveText(HERO.job);
  await expectNoHorizontalOverflow(page);
  await page.waitForTimeout(LINGER_MS * 2);

  expect(errors).toEqual([]);
});
