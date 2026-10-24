// Shared helpers for the Playwright specs: fake Web Speech, a generated photo,
// /api/identify mocks and common screen locators.

import { deflateSync, crc32 } from 'node:zlib';
import { expect } from '@playwright/test';

export const IDENTIFY_GLOB = '**/api/identify';
export const PROGRESS_GLOB = '**/api/progress';

// ---- Photo ----------------------------------------------------------------
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}

/** A solid-colour RGB PNG; the app re-encodes it to JPEG before upload. */
export function makePng(width = 64, height = 48, rgb = [200, 80, 30]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit, truecolour, no interlace
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export const PHOTO = Object.freeze({ name: 'part.png', mimeType: 'image/png', buffer: makePng() });

/** Choose a photo through the hidden file input (the camera-denied fallback). */
export async function choosePhoto(page) {
  await page.locator('#file-input').setInputFiles(PHOTO);
}

// ---- Fake Web Speech ------------------------------------------------------
// Installed with page.addInitScript before app.js runs. speechSynthesis ends
// each utterance after a few ms; SpeechRecognition is driven from the test via
// window.__voice.say("next").
function installFakeSpeech() {
  const spoken = [];
  const recognizers = [];

  class FakeRecognition {
    constructor() {
      this.running = false;
      this.onresult = null;
      this.onerror = null;
      this.onend = null;
      recognizers.push(this);
    }
    start() {
      if (this.running) throw new DOMException('already started', 'InvalidStateError');
      this.running = true;
    }
    stop() { this.abort(); }
    abort() {
      if (!this.running) return;
      this.running = false;
      setTimeout(() => this.onend?.({}), 0);
    }
  }

  class FakeUtterance {
    constructor(text) {
      this.text = text;
      this.onend = null;
      this.onerror = null;
    }
  }

  const fakeSynth = {
    speak(utterance) {
      spoken.push(utterance.text);
      setTimeout(() => utterance.onend?.({}), 5);
    },
    cancel() {},
    getVoices: () => [],
  };

  const define = (name, value) => Object.defineProperty(window, name, { value, configurable: true, writable: true });
  define('SpeechRecognition', FakeRecognition);
  define('webkitSpeechRecognition', FakeRecognition);
  define('SpeechSynthesisUtterance', FakeUtterance);
  define('speechSynthesis', fakeSynth);

  window.__voice = {
    spoken,
    listening: () => recognizers.some((r) => r.running),
    say(transcript) {
      const result = Object.assign([{ transcript, confidence: 0.95 }], { isFinal: true });
      recognizers.filter((r) => r.running).forEach((r) => r.onresult?.({ resultIndex: 0, results: [result] }));
    },
    fail(error) {
      recognizers.filter((r) => r.running).forEach((r) => r.onerror?.({ error }));
    },
  };
}

export async function useFakeSpeech(page) {
  await page.addInitScript(installFakeSpeech);
}

// ---- API mocks ------------------------------------------------------------
export function identifyOk(plan, jobId = null) {
  return (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ job_id: jobId, plan }) });
}

/** Records every request the page makes to /api/*, /cached/* and others. */
export function trackRequests(page) {
  const urls = [];
  page.on('request', (req) => urls.push(new URL(req.url()).pathname));
  return {
    urls,
    count: (pathname) => urls.filter((u) => u === pathname).length,
  };
}

/** Swallow progress beacons and record their bodies. */
export async function captureProgress(page) {
  const bodies = [];
  await page.route(PROGRESS_GLOB, (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ status: 204 });
  });
  return bodies;
}

// ---- Screens --------------------------------------------------------------
export const screens = (page) => ({
  capture: page.locator('#screen-capture'),
  identified: page.locator('#screen-identified'),
  job: page.locator('#screen-job'),
  done: page.locator('#screen-done'),
});

export async function expectStep(page, n, total) {
  await expect(page.locator('#job-meta')).toContainText(`Step ${n} of ${total}`);
}

/** Tap Next until the Job done screen shows. */
export async function tapThroughJob(page, total) {
  for (let n = 1; n <= total; n += 1) {
    await expectStep(page, n, total);
    await page.locator('#next-btn').tap();
  }
  await expect(screens(page).done).toBeVisible();
}
