import { test, expect } from '@playwright/test';
import { STUB_PLAN } from './fixtures/plans.mjs';
import { IDENTIFY_GLOB, identifyOk, screens, useFakeSpeech } from './helpers.mjs';

// launchOptions forces a dedicated worker, so it must be file-level.
test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

test.describe('fake camera (Chromium fake media stream)', () => {
  test.use({ permissions: ['camera'] });

  test('snap grabs a downscaled JPEG frame from the live preview and identifies it', async ({ page }) => {
    await useFakeSpeech(page);
    const bodies = [];
    await page.route(IDENTIFY_GLOB, (route) => {
      bodies.push(route.request().postDataJSON());
      return identifyOk(STUB_PLAN)(route);
    });

    await page.goto('/demo/');
    const btn = page.locator('#snap-btn');
    // Camera permission is pre-granted, so the app starts the preview on load.
    await expect(btn).toHaveText('📷 SNAP PART');
    await expect(page.locator('#preview')).toBeVisible();
    await expect.poll(() => page.locator('#preview').evaluate((v) => v.videoWidth)).toBeGreaterThan(0);

    await btn.tap();
    await expect(screens(page).identified).toBeVisible();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].image).toMatch(/^data:image\/jpeg;base64,/);

    const size = await page.evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      return { w: img.naturalWidth, h: img.naturalHeight };
    }, bodies[0].image);
    expect(Math.max(size.w, size.h)).toBeLessThanOrEqual(1024);

    // The stream is released once the part is identified.
    await expect(page.locator('#preview')).toBeHidden();
  });
});

test('camera denied falls back to the file input', async ({ page, context }) => {
  await useFakeSpeech(page);
  await context.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
  });
  await page.goto('/demo/');
  await page.locator('#snap-btn').tap();
  await expect(page.locator('#snap-btn')).toHaveText('📷 CHOOSE PHOTO');
  await expect(page.locator('#capture-error')).toHaveText('Camera blocked. Tap to choose a photo instead.');

  const chooser = page.waitForEvent('filechooser');
  await page.locator('#snap-btn').tap();
  await chooser;
});
