// Non-mocked smoke checks, safe to run against a deployed preview
// (PREVIEW_URL=https://... npx playwright test).

import { test, expect } from '@playwright/test';

test('app loads on a phone viewport with the capture screen', { tag: '@smoke' }, async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto('/');
  await expect(page.locator('#screen-capture')).toBeVisible();
  await expect(page.locator('#capture-headline')).toContainText('Point at the part.');
  await expect(page.locator('#snap-btn')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test('api rejects bad requests without calling upstream', { tag: '@smoke' }, async ({ request }) => {
  const progress = await request.post('/api/progress', { data: { job_id: 'nope', current_step: 0, status: 'active' } });
  expect(progress.status()).toBe(400);
  const identifyGet = await request.get('/api/identify');
  expect(identifyGet.status()).toBe(405);
});
