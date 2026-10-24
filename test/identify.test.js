import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handleIdentify } from '../lib/identify.js';
import { createRateLimiter, DEFAULT_LIMIT, DEFAULT_WINDOW_MS } from '../lib/limit.js';
import { callClaude, buildRequest, MODEL, JOB_PLAN_TOOL } from '../lib/claude.js';
import { MAX_IMAGE_BASE64_BYTES } from '../lib/validate.js';

const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]).toString('base64');
const IMAGE = `data:image/jpeg;base64,${JPEG_B64}`;

const PLAN = Object.freeze({
  part: { name: 'Front brake caliper', variant: 'floating, single piston', confidence: 0.92 },
  job: 'Replace front brake pads',
  tools: ['14 mm socket + ratchet'],
  safety: ['Car on jack stands'],
  steps: [{ n: 1, text: 'Remove the guide pin bolts.', spec: '25-35 Nm', warning: null, check_goal: 'Bolts out' }],
  unidentified: false,
});

const silentLog = { error() {}, warn() {} };

function run(overrides = {}) {
  return handleIdentify({
    body: { image: IMAGE },
    ip: '1.2.3.4',
    callClaude: async () => structuredClone(PLAN),
    saveJob: async () => 'job-123',
    limiter: createRateLimiter(),
    log: silentLog,
    ...overrides,
  });
}

describe('handleIdentify', () => {
  test('200 with job_id and validated plan', async () => {
    const res = await run();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { job_id: 'job-123', plan: PLAN });
  });

  test('passes the parsed image and an abort signal to callClaude', async () => {
    let seen;
    await run({
      callClaude: async (args) => {
        seen = args;
        return structuredClone(PLAN);
      },
    });
    assert.deepEqual(seen.image, { mediaType: 'image/jpeg', data: JPEG_B64 });
    assert.ok(seen.signal instanceof AbortSignal);
  });

  test('saveJob receives the validated plan', async () => {
    let saved;
    await run({
      callClaude: async () => ({ ...structuredClone(PLAN), junk: 1 }),
      saveJob: async (plan) => {
        saved = plan;
        return 'id';
      },
    });
    assert.deepEqual(saved, PLAN);
  });

  test('job_id is null when saveJob returns null', async () => {
    const res = await run({ saveJob: async () => null });
    assert.equal(res.status, 200);
    assert.equal(res.body.job_id, null);
  });

  test('job_id is null when saveJob rejects', async () => {
    const res = await run({
      saveJob: async () => {
        throw new Error('db down');
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.job_id, null);
    assert.deepEqual(res.body.plan, PLAN);
  });

  test('job_id is null when saveJob throws synchronously', async () => {
    const res = await run({
      saveJob: () => {
        throw new Error('boom');
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.job_id, null);
  });

  test('job_id is null when saveJob returns a non-string', async () => {
    const res = await run({ saveJob: async () => ({ id: 1 }) });
    assert.equal(res.body.job_id, null);
  });

  test('job_id is null when saveJob is missing', async () => {
    const res = await run({ saveJob: undefined });
    assert.equal(res.status, 200);
    assert.equal(res.body.job_id, null);
  });

  test('job_id is null when saveJob hangs past its timeout', async () => {
    const res = await run({ saveJob: () => new Promise(() => {}), saveTimeoutMs: 20 });
    assert.equal(res.status, 200);
    assert.equal(res.body.job_id, null);
  });

  test('saveJob is not called when the plan is invalid', async () => {
    let called = false;
    await run({
      callClaude: async () => ({ nope: true }),
      saveJob: async () => {
        called = true;
        return 'x';
      },
    });
    assert.equal(called, false);
  });

  test('400 on missing image', async () => {
    const res = await run({ body: {} });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'bad_request');
  });

  test('400 on unsupported image type', async () => {
    const gif = Buffer.from('GIF89a\x01\x00', 'latin1').toString('base64');
    const res = await run({ body: { image: gif } });
    assert.equal(res.status, 400);
  });

  test('413 on oversize image, without calling Claude', async () => {
    let called = false;
    const res = await run({
      body: { image: 'A'.repeat(MAX_IMAGE_BASE64_BYTES + 4) },
      callClaude: async () => {
        called = true;
        return PLAN;
      },
    });
    assert.equal(res.status, 413);
    assert.deepEqual(res.body, { error: 'too_large', message: 'Photo too large' });
    assert.equal(called, false);
  });

  test('429 once the per-IP limit is exhausted, other IPs unaffected', async () => {
    const limiter = createRateLimiter({ limit: 2 });
    assert.equal((await run({ limiter })).status, 200);
    assert.equal((await run({ limiter })).status, 200);
    const blocked = await run({ limiter });
    assert.equal(blocked.status, 429);
    assert.deepEqual(blocked.body, { error: 'rate_limited', message: 'Too many requests, wait a minute' });
    assert.equal((await run({ limiter, ip: '5.6.7.8' })).status, 200);
  });

  test('429 is checked before input validation', async () => {
    const limiter = createRateLimiter({ limit: 1 });
    await run({ limiter, body: {} });
    const res = await run({ limiter, body: {} });
    assert.equal(res.status, 429);
  });

  test('502 bad_model_output on invalid plan, logs the raw output', async () => {
    const logged = [];
    const res = await run({
      callClaude: async () => ({ part: { name: 'X' }, steps: [] }),
      log: { error: (...args) => logged.push(args), warn() {} },
    });
    assert.equal(res.status, 502);
    assert.equal(res.body.error, 'bad_model_output');
    assert.ok(logged.length > 0);
    assert.match(logged.flat().join(' '), /"name":"X"/);
  });

  test('502 bad_model_output when Claude returns no tool call (null)', async () => {
    const res = await run({ callClaude: async () => null });
    assert.equal(res.status, 502);
    assert.equal(res.body.error, 'bad_model_output');
  });

  test('502 upstream_error when callClaude throws', async () => {
    const res = await run({
      callClaude: async () => {
        throw new Error('Anthropic 500');
      },
    });
    assert.equal(res.status, 502);
    assert.equal(res.body.error, 'upstream_error');
  });

  test('504 upstream_timeout when Claude is slower than the timeout', async () => {
    let signal;
    const res = await run({
      timeoutMs: 20,
      callClaude: (args) => {
        signal = args.signal;
        return new Promise(() => {});
      },
    });
    assert.equal(res.status, 504);
    assert.equal(res.body.error, 'upstream_timeout');
    assert.equal(signal.aborted, true, 'aborts the upstream request');
  });

  test('504 when callClaude rejects with AbortError from the signal', async () => {
    const res = await run({
      timeoutMs: 20,
      callClaude: ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    });
    assert.equal(res.status, 504);
  });

  test('error bodies always carry a human message', async () => {
    const res = await run({ callClaude: async () => null });
    assert.equal(typeof res.body.message, 'string');
  });
});

describe('createRateLimiter', () => {
  test('defaults are 200 requests per 10 minutes', () => {
    assert.equal(DEFAULT_LIMIT, 200);
    assert.equal(DEFAULT_WINDOW_MS, 10 * 60 * 1000);
    const limiter = createRateLimiter();
    for (let i = 0; i < 200; i += 1) assert.equal(limiter.hit('ip'), true);
    assert.equal(limiter.hit('ip'), false);
  });

  test('window resets after windowMs', () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => now });
    assert.equal(limiter.hit('a'), true);
    assert.equal(limiter.hit('a'), false);
    now = 1000;
    assert.equal(limiter.hit('a'), true);
  });

  test('prunes expired keys so memory stays bounded', () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 10, now: () => now, maxKeys: 5 });
    for (let i = 0; i < 5; i += 1) limiter.hit(`k${i}`);
    now = 100;
    limiter.hit('fresh');
    assert.ok(limiter.size() <= 2);
  });
});

describe('callClaude', () => {
  const image = { mediaType: 'image/jpeg', data: JPEG_B64 };

  test('buildRequest uses the model, a strict job_plan tool and no forced tool_choice', () => {
    const req = buildRequest(image);
    assert.equal(MODEL, 'claude-sonnet-5-5');
    assert.equal(req.model, MODEL);
    assert.equal(req.tools.length, 1);
    assert.equal(req.tools[0].name, JOB_PLAN_TOOL.name);
    assert.equal(req.tools[0].strict, true);
    assert.deepEqual(req.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
    assert.equal('temperature' in req, false);
    const [imgBlock] = req.messages[0].content;
    assert.deepEqual(imgBlock, {
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: JPEG_B64 },
    });
  });

  test('sends headers and returns the tool input', async () => {
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: 'Here you go' },
            { type: 'tool_use', name: 'job_plan', input: PLAN },
          ],
        }),
        { status: 200 },
      );
    };
    const out = await callClaude({ image, apiKey: 'test-key', fetchImpl });
    assert.deepEqual(out, PLAN);
    assert.equal(captured.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(captured.init.method, 'POST');
    assert.equal(captured.init.headers['x-api-key'], 'test-key');
    assert.equal(captured.init.headers['anthropic-version'], '2026-10-21');
    assert.equal(JSON.parse(captured.init.body).model, 'claude-sonnet-5-5');
  });

  test('returns null when the response has no job_plan tool call', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hmm' }] }), {
        status: 200,
      });
    const out = await callClaude({ image, apiKey: 'k', fetchImpl, log: silentLog });
    assert.equal(out, null);
  });

  test('throws with the HTTP status on a non-2xx response', async () => {
    const fetchImpl = async () => new Response('{"error":{"type":"overloaded_error"}}', { status: 529 });
    await assert.rejects(callClaude({ image, apiKey: 'k', fetchImpl, log: silentLog }), (err) => {
      assert.equal(err.status, 529);
      return true;
    });
  });

  test('throws when the API key is missing, without calling fetch', async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
    };
    await assert.rejects(callClaude({ image, apiKey: '', fetchImpl }), /ANTHROPIC_API_KEY/);
    assert.equal(called, false);
  });
});
