import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { choosePhoto, screens, tapThroughJob, trackRequests, useFakeSpeech } from './helpers.mjs';

const HERO = JSON.parse(readFileSync(new URL('../public/cached/hero-part.json', import.meta.url), 'utf8'));

test.beforeEach(async ({ page }) => {
  await useFakeSpeech(page);
});

test('?demo=1 runs the cached hero job offline and never calls /api/identify', { tag: '@smoke' }, async ({ page, context }) => {
  const requests = trackRequests(page);
  const s = screens(page);

  await page.goto('/demo/?demo=1');
  await expect(page.locator('#demo-badge')).toBeVisible();
  await expect(page.locator('#capture-note')).toHaveText(`Demo part ready: ${HERO.part.name} (cached)`);

  // Wifi drops after the page is open.
  await context.setOffline(true);

  await choosePhoto(page);
  await expect(page.locator('#uploading')).toBeVisible();
  await expect(s.identified).toBeVisible();
  await expect(page.locator('#part-name')).toHaveText(HERO.part.name);

  await page.locator('#start-btn').tap();
  await tapThroughJob(page, HERO.steps.length);
  await expect(page.locator('#done-job')).toHaveText(HERO.job);

  expect(requests.count('/api/identify')).toBe(0);
  expect(requests.count('/cached/hero-part.json')).toBe(1);
});

test('without the flag the cached plan is never fetched and no DEMO badge shows', { tag: '@smoke' }, async ({ page }) => {
  const requests = trackRequests(page);
  await page.goto('/demo/');
  await expect(page.locator('#screen-capture')).toBeVisible();
  await expect(page.locator('#demo-badge')).toBeHidden();
  await expect(page.locator('#capture-note')).toHaveText('');
  expect(requests.count('/cached/hero-part.json')).toBe(0);
});
