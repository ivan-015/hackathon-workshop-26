import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  validateJobPlan,
  validateImageBody,
  MAX_IMAGE_BASE64_BYTES,
} from '../lib/validate.js';

const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]).toString('base64');
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
const WEBP_B64 = Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1').toString('base64');
const GIF_B64 = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1').toString('base64');

function makePlan(overrides = {}) {
  return {
    part: { name: 'Front brake caliper', variant: 'floating, single piston', confidence: 0.92 },
    job: 'Replace front brake pads',
    tools: ['14 mm socket + ratchet', 'C-clamp'],
    safety: ['Car on jack stands, never just the jack'],
    steps: [
      {
        n: 1,
        text: 'Remove the two caliper guide pin bolts.',
        spec: '25-35 Nm on reinstall',
        warning: 'Support the caliper',
        check_goal: 'Both guide pin bolts removed',
      },
    ],
    unidentified: false,
    ...overrides,
  };
}

describe('validateJobPlan', () => {
  test('accepts the design-doc example and returns a normalized copy', () => {
    const raw = makePlan();
    const result = validateJobPlan(raw);
    assert.equal(result.ok, true);
    assert.deepEqual(result.plan, raw);
    assert.notEqual(result.plan, raw, 'returns a new object');
  });

  test('does not mutate its input', () => {
    const raw = makePlan({ extra: 'x' });
    const snapshot = structuredClone(raw);
    validateJobPlan(raw);
    assert.deepEqual(raw, snapshot);
  });

  test('strips unknown fields and fills missing optional step fields with null', () => {
    const raw = makePlan({
      extra: 'drop me',
      steps: [{ n: 1, text: '  Loosen the lug nuts.  ', bogus: true }],
    });
    const { ok, plan } = validateJobPlan(raw);
    assert.equal(ok, true);
    assert.equal('extra' in plan, false);
    assert.deepEqual(plan.steps[0], {
      n: 1,
      text: 'Loosen the lug nuts.',
      spec: null,
      warning: null,
      check_goal: null,
    });
  });

  test('defaults a missing variant to an empty string', () => {
    const raw = makePlan({ part: { name: 'Alternator', confidence: 0.8 } });
    const { ok, plan } = validateJobPlan(raw);
    assert.equal(ok, true);
    assert.equal(plan.part.variant, '');
  });

  const rejects = [
    ['null', null],
    ['an array', []],
    ['a string', 'plan'],
    ['missing part', makePlan({ part: undefined })],
    ['empty part name', makePlan({ part: { name: ' ', variant: '', confidence: 0.5 } })],
    ['confidence above 1', makePlan({ part: { name: 'X', variant: '', confidence: 1.5 } })],
    ['confidence below 0', makePlan({ part: { name: 'X', variant: '', confidence: -0.1 } })],
    ['confidence as string', makePlan({ part: { name: 'X', variant: '', confidence: '0.9' } })],
    ['confidence NaN', makePlan({ part: { name: 'X', variant: '', confidence: Number.NaN } })],
    ['missing job', makePlan({ job: undefined })],
    ['tools not array', makePlan({ tools: 'socket' })],
    ['tools with non-string', makePlan({ tools: ['socket', 3] })],
    ['safety not array', makePlan({ safety: null })],
    ['zero steps', makePlan({ steps: [] })],
    ['21 steps', makePlan({ steps: Array.from({ length: 21 }, (_, i) => ({ n: i + 1, text: 's' })) })],
    ['step without text', makePlan({ steps: [{ n: 1, text: '' }] })],
    ['step with non-integer n', makePlan({ steps: [{ n: 1.5, text: 'a' }] })],
    ['step with numeric spec', makePlan({ steps: [{ n: 1, text: 'a', spec: 30 }] })],
    ['unidentified not boolean', makePlan({ unidentified: 'no' })],
  ];

  for (const [label, raw] of rejects) {
    test(`rejects ${label}`, () => {
      const result = validateJobPlan(raw);
      assert.equal(result.ok, false);
      assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
    });
  }

  test('allows zero steps only when unidentified is true', () => {
    const result = validateJobPlan(
      makePlan({ unidentified: true, steps: [], part: { name: 'Unknown part', variant: '', confidence: 0.1 } }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.plan.steps, []);
  });

  test('accepts exactly 20 steps', () => {
    const steps = Array.from({ length: 20 }, (_, i) => ({ n: i + 1, text: `Step ${i + 1}` }));
    assert.equal(validateJobPlan(makePlan({ steps })).ok, true);
  });

  test('cached/hero-part.json passes validation', async () => {
    const url = new URL('../cached/hero-part.json', import.meta.url);
    const raw = JSON.parse(await readFile(url, 'utf8'));
    const result = validateJobPlan(raw);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.plan.unidentified, false);
    assert.ok(result.plan.steps.length >= 1 && result.plan.steps.length <= 9);
  });
});

describe('validateImageBody', () => {
  test('accepts a jpeg data URL', () => {
    const result = validateImageBody({ image: `data:image/jpeg;base64,${JPEG_B64}` });
    assert.deepEqual(result, { ok: true, image: { mediaType: 'image/jpeg', data: JPEG_B64 } });
  });

  test('accepts raw base64 and sniffs the type (png, webp)', () => {
    assert.equal(validateImageBody({ image: PNG_B64 }).image.mediaType, 'image/png');
    assert.equal(validateImageBody({ image: WEBP_B64 }).image.mediaType, 'image/webp');
  });

  const badRequests = [
    ['no body', undefined],
    ['body not an object', 'image'],
    ['missing image', {}],
    ['image not a string', { image: 42 }],
    ['empty image', { image: '' }],
    ['invalid base64', { image: 'not base64!!' }],
    ['gif', { image: GIF_B64 }],
    ['declared png but bytes are jpeg', { image: `data:image/png;base64,${JPEG_B64}` }],
    ['unsupported declared type', { image: `data:image/gif;base64,${GIF_B64}` }],
  ];

  for (const [label, body] of badRequests) {
    test(`rejects ${label} with 400`, () => {
      const result = validateImageBody(body);
      assert.equal(result.ok, false);
      assert.equal(result.status, 400);
      assert.equal(result.error, 'bad_request');
    });
  }

  test('rejects base64 over 4 MB with 413 before decoding', () => {
    const big = 'A'.repeat(MAX_IMAGE_BASE64_BYTES + 4);
    const result = validateImageBody({ image: big });
    assert.equal(result.status, 413);
    assert.equal(result.error, 'too_large');
    assert.equal(result.message, 'Photo too large');
  });

  test('cap is 4 MB of base64', () => {
    assert.equal(MAX_IMAGE_BASE64_BYTES, 4 * 1024 * 1024);
  });
});
