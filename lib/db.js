// Best-effort persistence to Supabase via PostgREST (raw fetch, service-role key).
// Every export returns a promise that never rejects: the database must never
// break the demo. With SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY unset, all
// functions are no-ops. Env is read at call time so tests can toggle it.

export const DB_TIMEOUT_MS = 2000;
export const JOB_STATUSES = Object.freeze(['active', 'completed', 'abandoned']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function readConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { baseUrl: `${url.replace(/\/+$/, '')}/rest/v1`, key };
}

async function request(config, { method, path, body, prefer }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DB_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        'Content-Type': 'application/json',
        Prefer: prefer,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${detail.slice(0, 200)}`);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function logFailure(op, err) {
  const reason = err?.name === 'AbortError' ? `timeout after ${DB_TIMEOUT_MS}ms` : err?.message;
  console.error(`[db] ${op} failed: ${reason}`);
}

function confidenceOrNull(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

export function jobRowFromPlan(plan) {
  const part = plan?.part ?? {};
  return {
    part_name: typeof part.name === 'string' ? part.name : null,
    part_variant: typeof part.variant === 'string' ? part.variant : null,
    part_confidence: confidenceOrNull(part.confidence),
    unidentified: plan?.unidentified === true,
    job: typeof plan?.job === 'string' ? plan.job : null,
    plan,
  };
}

export async function saveJob(plan) {
  const config = readConfig();
  if (!config) return null;
  try {
    const res = await request(config, {
      method: 'POST',
      path: '/jobs?select=id',
      body: jobRowFromPlan(plan),
      prefer: 'return=representation',
    });
    const rows = await res.json();
    const id = Array.isArray(rows) ? rows[0]?.id : undefined;
    if (!isUuid(id)) throw new Error('insert returned no id');
    return id;
  } catch (err) {
    logFailure('saveJob', err);
    return null;
  }
}

export async function updateProgress(id, currentStep, status) {
  const config = readConfig();
  if (!config) return;
  if (!isUuid(id)) {
    console.error('[db] updateProgress skipped: invalid job id');
    return;
  }
  try {
    await request(config, {
      method: 'PATCH',
      path: `/jobs?id=eq.${encodeURIComponent(id)}`,
      body: { current_step: currentStep, status },
      prefer: 'return=minimal',
    });
  } catch (err) {
    logFailure('updateProgress', err);
  }
}

export async function saveCheck(jobId, stepN, passed, reason) {
  const config = readConfig();
  if (!config) return;
  if (!isUuid(jobId)) {
    console.error('[db] saveCheck skipped: invalid job id');
    return;
  }
  try {
    await request(config, {
      method: 'POST',
      path: '/step_checks',
      body: {
        job_id: jobId,
        step_n: stepN,
        passed: typeof passed === 'boolean' ? passed : null,
        reason: typeof reason === 'string' ? reason : null,
      },
      prefer: 'return=minimal',
    });
  } catch (err) {
    logFailure('saveCheck', err);
  }
}
