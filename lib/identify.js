// Pure core of POST /api/identify. No I/O of its own: Claude and the DB are
// injected, so tests and scripts/eval-photos.mjs can drive it directly.
//
// Response contract: 200 { job_id: string|null, plan: JobPlan }, or
// { error, message } with 400 | 413 | 429 | 502 (bad_model_output,
// upstream_error) | 504 (upstream_timeout).

import { validateImageBody, validateJobPlan } from './validate.js';
import { createRateLimiter } from './limit.js';

// Vercel maxDuration is 30s (vercel.json); abort Claude at 25s so we can still
// answer with a JSON 504. The client gives up at 15s, so it normally fires first.
export const CLAUDE_TIMEOUT_MS = 25_000;
// lib/db.js has its own 2s timeout; this is a backstop so a hung DB call can
// never hold the response.
export const SAVE_TIMEOUT_MS = 3_000;

const defaultLimiter = createRateLimiter();

const TIMEOUT = Symbol('timeout');

function errorResponse(status, error, message) {
  return { status, body: { error, message } };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function askClaude(callClaude, image, timeoutMs, log) {
  const controller = new AbortController();
  try {
    const result = await withTimeout(
      Promise.resolve().then(() => callClaude({ image, signal: controller.signal })),
      timeoutMs,
    );
    if (result === TIMEOUT) {
      controller.abort();
      return { timedOut: true };
    }
    return { raw: result };
  } catch (err) {
    if (controller.signal.aborted || err?.name === 'AbortError') return { timedOut: true };
    log.error('[identify] Claude call failed', err?.message ?? err);
    return { failed: true };
  }
}

async function safeSave(saveJob, plan, timeoutMs, log) {
  if (typeof saveJob !== 'function') return null;
  try {
    const id = await withTimeout(Promise.resolve().then(() => saveJob(plan)), timeoutMs);
    if (id === TIMEOUT) {
      log.warn('[identify] saveJob timed out');
      return null;
    }
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch (err) {
    log.warn('[identify] saveJob failed', err?.message ?? err);
    return null;
  }
}

/**
 * @param {{ body: unknown, ip: string, callClaude: Function, saveJob?: Function,
 *   limiter?: { hit(key: string): boolean }, timeoutMs?: number,
 *   saveTimeoutMs?: number, log?: Pick<Console, 'error'|'warn'> }} args
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function handleIdentify({
  body,
  ip,
  callClaude,
  saveJob,
  limiter = defaultLimiter,
  timeoutMs = CLAUDE_TIMEOUT_MS,
  saveTimeoutMs = SAVE_TIMEOUT_MS,
  log = console,
}) {
  if (!limiter.hit(ip || 'unknown')) {
    return errorResponse(429, 'rate_limited', 'Too many requests, wait a minute');
  }

  const input = validateImageBody(body);
  if (!input.ok) return errorResponse(input.status, input.error, input.message);

  const answer = await askClaude(callClaude, input.image, timeoutMs, log);
  if (answer.timedOut) {
    return errorResponse(504, 'upstream_timeout', 'The part lookup took too long. Tap to retry.');
  }
  if (answer.failed) {
    return errorResponse(502, 'upstream_error', 'Something went wrong on our side. Tap to retry.');
  }

  const checked = validateJobPlan(answer.raw);
  if (!checked.ok) {
    log.error('[identify] bad_model_output', JSON.stringify({ errors: checked.errors, raw: answer.raw }));
    return errorResponse(502, 'bad_model_output', 'Something went wrong on our side. Tap to retry.');
  }

  const jobId = await safeSave(saveJob, checked.plan, saveTimeoutMs, log);
  return { status: 200, body: { job_id: jobId, plan: checked.plan } };
}
