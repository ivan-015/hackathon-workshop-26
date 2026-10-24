import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { saveJob, updateProgress, saveCheck, DB_TIMEOUT_MS, jobRowFromPlan } from '../lib/db.js';
import { handleProgress, validateProgress } from '../api/progress.js';

const URL_BASE = 'https://example.supabase.co';
const KEY = 'test-service-role-key';
const JOB_ID = '0b5f8c1e-2a3d-4e5f-9a8b-7c6d5e4f3a2b';
const PLAN = Object.freeze({
  part: { name: 'Front brake caliper', variant: 'floating', confidence: 0.92 },
  job: 'Replace front brake pads',
  tools: ['14 mm socket'],
  safety: ['Jack stands'],
  steps: [{ n: 1, text: 'Remove bolts.', spec: '25-35 Nm', warning: null, check_goal: 'Bolts out' }],
  unidentified: false,
});

const originalFetch = globalThis.fetch;
const originalEnv = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };

function setEnv() {
  process.env.SUPABASE_URL = URL_BASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = KEY;
}

function clearEnv() {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
}

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function stubFetch(impl) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init);
  };
  return calls;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function hangUntilAbort(_url, init) {
  return new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
}

let errorLog;

beforeEach(() => {
  setEnv();
  errorLog = mock.method(console, 'error', () => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restore('SUPABASE_URL', originalEnv.url);
  restore('SUPABASE_SERVICE_ROLE_KEY', originalEnv.key);
  errorLog.mock.restore();
  mock.timers.reset();
});

describe('saveJob', () => {
  test('success: inserts the row and returns the id', async () => {
    const calls = stubFetch(() => jsonResponse(201, [{ id: JOB_ID }]));
    const id = await saveJob(PLAN);
    assert.equal(id, JOB_ID);
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, `${URL_BASE}/rest/v1/jobs?select=id`);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.apikey, KEY);
    assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(init.headers.Prefer, 'return=representation');
    assert.ok(init.signal instanceof AbortSignal);
    const body = JSON.parse(init.body);
    assert.equal(body.part_name, 'Front brake caliper');
    assert.equal(body.part_variant, 'floating');
    assert.equal(body.part_confidence, 0.92);
    assert.equal(body.unidentified, false);
    assert.equal(body.job, 'Replace front brake pads');
    assert.deepEqual(body.plan, PLAN);
  });

  test('trailing slash in SUPABASE_URL is tolerated', async () => {
    process.env.SUPABASE_URL = `${URL_BASE}/`;
    const calls = stubFetch(() => jsonResponse(201, [{ id: JOB_ID }]));
    await saveJob(PLAN);
    assert.equal(calls[0].url, `${URL_BASE}/rest/v1/jobs?select=id`);
  });

  test('timeout: aborts after 2s and resolves null', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    stubFetch(hangUntilAbort);
    const pending = saveJob(PLAN);
    mock.timers.tick(DB_TIMEOUT_MS);
    assert.equal(await pending, null);
    assert.match(errorLog.mock.calls[0].arguments[0], /saveJob failed: timeout/);
  });

  test('500: resolves null and logs', async () => {
    stubFetch(() => jsonResponse(500, { message: 'boom' }));
    assert.equal(await saveJob(PLAN), null);
    assert.match(errorLog.mock.calls[0].arguments[0], /saveJob failed: HTTP 500/);
  });

  test('network error: resolves null', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    assert.equal(await saveJob(PLAN), null);
  });

  test('response without id: resolves null', async () => {
    stubFetch(() => jsonResponse(201, []));
    assert.equal(await saveJob(PLAN), null);
  });

  test('env unset: no fetch, resolves null', async () => {
    clearEnv();
    const calls = stubFetch(() => jsonResponse(201, [{ id: JOB_ID }]));
    assert.equal(await saveJob(PLAN), null);
    assert.equal(calls.length, 0);
  });

  test('only the key unset: still a no-op', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const calls = stubFetch(() => jsonResponse(201, [{ id: JOB_ID }]));
    assert.equal(await saveJob(PLAN), null);
    assert.equal(calls.length, 0);
  });
});

describe('jobRowFromPlan', () => {
  test('out-of-range confidence and missing fields become null', () => {
    const row = jobRowFromPlan({ part: { confidence: 1.7 }, unidentified: true });
    assert.equal(row.part_confidence, null);
    assert.equal(row.part_name, null);
    assert.equal(row.job, null);
    assert.equal(row.unidentified, true);
  });

  test('does not mutate the plan', () => {
    const plan = structuredClone(PLAN);
    jobRowFromPlan(plan);
    assert.deepEqual(plan, PLAN);
  });
});

describe('updateProgress', () => {
  test('success: PATCHes the job row', async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    assert.equal(await updateProgress(JOB_ID, 3, 'active'), undefined);
    const { url, init } = calls[0];
    assert.equal(url, `${URL_BASE}/rest/v1/jobs?id=eq.${JOB_ID}`);
    assert.equal(init.method, 'PATCH');
    assert.equal(init.headers.Prefer, 'return=minimal');
    assert.deepEqual(JSON.parse(init.body), { current_step: 3, status: 'active' });
  });

  test('timeout: resolves without rejecting', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    stubFetch(hangUntilAbort);
    const pending = updateProgress(JOB_ID, 1, 'active');
    mock.timers.tick(DB_TIMEOUT_MS);
    assert.equal(await pending, undefined);
    assert.match(errorLog.mock.calls[0].arguments[0], /updateProgress failed: timeout/);
  });

  test('500: resolves and logs', async () => {
    stubFetch(() => jsonResponse(500, { message: 'boom' }));
    assert.equal(await updateProgress(JOB_ID, 1, 'completed'), undefined);
    assert.match(errorLog.mock.calls[0].arguments[0], /updateProgress failed: HTTP 500/);
  });

  test('env unset: no fetch', async () => {
    clearEnv();
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    await updateProgress(JOB_ID, 1, 'active');
    assert.equal(calls.length, 0);
  });

  test('invalid id: no fetch (no filter injection)', async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    await updateProgress('x&id=neq.null', 1, 'active');
    assert.equal(calls.length, 0);
  });
});

describe('saveCheck', () => {
  test('success: inserts a step_checks row', async () => {
    const calls = stubFetch(() => new Response(null, { status: 201 }));
    assert.equal(await saveCheck(JOB_ID, 4, false, 'bolt still in'), undefined);
    const { url, init } = calls[0];
    assert.equal(url, `${URL_BASE}/rest/v1/step_checks`);
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { job_id: JOB_ID, step_n: 4, passed: false, reason: 'bolt still in' });
  });

  test('passed null is preserved', async () => {
    const calls = stubFetch(() => new Response(null, { status: 201 }));
    await saveCheck(JOB_ID, 4, null, 'cannot tell');
    assert.equal(JSON.parse(calls[0].init.body).passed, null);
  });

  test('timeout: resolves without rejecting', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    stubFetch(hangUntilAbort);
    const pending = saveCheck(JOB_ID, 1, true, 'ok');
    mock.timers.tick(DB_TIMEOUT_MS);
    assert.equal(await pending, undefined);
  });

  test('500: resolves and logs', async () => {
    stubFetch(() => jsonResponse(500, { message: 'boom' }));
    assert.equal(await saveCheck(JOB_ID, 1, true, 'ok'), undefined);
    assert.match(errorLog.mock.calls[0].arguments[0], /saveCheck failed: HTTP 500/);
  });

  test('env unset: no fetch', async () => {
    clearEnv();
    const calls = stubFetch(() => new Response(null, { status: 201 }));
    await saveCheck(JOB_ID, 1, true, 'ok');
    assert.equal(calls.length, 0);
  });
});

describe('handleProgress', () => {
  function spy() {
    const calls = [];
    const fn = async (...args) => {
      calls.push(args);
    };
    return { fn, calls };
  }

  const VALID = Object.freeze({ job_id: JOB_ID, current_step: 2, status: 'active' });

  test('valid POST → 204 and calls updateProgress', async () => {
    const { fn, calls } = spy();
    const result = await handleProgress({ method: 'POST', body: VALID, updateProgress: fn });
    assert.deepEqual(result, { status: 204 });
    assert.deepEqual(calls, [[JOB_ID, 2, 'active']]);
  });

  test('accepts a JSON string body (e.g. sendBeacon text/plain)', async () => {
    const { fn, calls } = spy();
    const result = await handleProgress({ method: 'POST', body: JSON.stringify(VALID), updateProgress: fn });
    assert.equal(result.status, 204);
    assert.equal(calls.length, 1);
  });

  test('non-POST → 405, no DB call', async () => {
    const { fn, calls } = spy();
    const result = await handleProgress({ method: 'GET', body: VALID, updateProgress: fn });
    assert.equal(result.status, 405);
    assert.equal(calls.length, 0);
  });

  const BAD_BODIES = [
    ['missing body', undefined],
    ['invalid JSON string', '{nope'],
    ['array', [VALID]],
    ['bad job_id', { ...VALID, job_id: 'abc' }],
    ['null job_id', { ...VALID, job_id: null }],
    ['negative step', { ...VALID, current_step: -1 }],
    ['fractional step', { ...VALID, current_step: 1.5 }],
    ['string step', { ...VALID, current_step: '2' }],
    ['huge step', { ...VALID, current_step: 1e9 }],
    ['unknown status', { ...VALID, status: 'paused' }],
  ];

  for (const [label, body] of BAD_BODIES) {
    test(`400 on ${label}`, async () => {
      const { fn, calls } = spy();
      const result = await handleProgress({ method: 'POST', body, updateProgress: fn });
      assert.equal(result.status, 400);
      assert.equal(result.body.error, 'bad_request');
      assert.equal(calls.length, 0);
    });
  }

  test('204 even when the real updateProgress hits a DB 500', async () => {
    stubFetch(() => jsonResponse(500, { message: 'boom' }));
    const result = await handleProgress({ method: 'POST', body: VALID, updateProgress });
    assert.equal(result.status, 204);
  });

  test('validateProgress returns normalized value', () => {
    assert.deepEqual(validateProgress(VALID).value, { jobId: JOB_ID, currentStep: 2, status: 'active' });
  });
});
