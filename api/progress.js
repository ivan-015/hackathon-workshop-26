// POST /api/progress { job_id, current_step, status } -> 204.
// Fire-and-forget from the client; the DB write is best-effort.
import { updateProgress as realUpdateProgress, isUuid, JOB_STATUSES } from '../lib/db.js';

export const MAX_STEP = 10000;

function parseBody(body) {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export function validateProgress(raw) {
  const body = parseBody(raw);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be a JSON object' };
  const { job_id, current_step, status } = body;
  if (!isUuid(job_id)) return { error: 'job_id must be a uuid' };
  if (!Number.isInteger(current_step) || current_step < 0 || current_step > MAX_STEP) {
    return { error: 'current_step must be a non-negative integer' };
  }
  if (!JOB_STATUSES.includes(status)) return { error: `status must be one of ${JOB_STATUSES.join(', ')}` };
  return { value: { jobId: job_id, currentStep: current_step, status } };
}

export async function handleProgress({ method, body, updateProgress }) {
  if (method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } };
  const { error, value } = validateProgress(body);
  if (error) return { status: 400, body: { error: 'bad_request', detail: error } };
  await updateProgress(value.jobId, value.currentStep, value.status);
  return { status: 204 };
}

export default async function handler(req, res) {
  const result = await handleProgress({
    method: req.method,
    body: req.body,
    updateProgress: realUpdateProgress,
  });
  if (result.status === 405) res.setHeader('Allow', 'POST');
  if (result.body === undefined) return res.status(result.status).end();
  return res.status(result.status).json(result.body);
}
