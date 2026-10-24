// Raw fetch to the Claude Messages API (no SDK). Returns the job_plan tool
// input, or null when the model did not call the tool.
//
// claude-sonnet-5-5 rejects a forced tool_choice ({type:"tool"} / {type:"any"})
// with a 400, so the "forced tool call" from the design is implemented as
// tool_choice auto + a single strict tool + a system instruction to call it.
// validateJobPlan still checks the result, and a missing call becomes a 502.

export const API_URL = 'https://api.anthropic.com/v1/messages';
export const API_VERSION = '2026-10-21';
export const MODEL = 'claude-sonnet-5-5';
const MAX_TOKENS = 4096;
// Latency target is ~8s photo-to-first-step (R8). Raise if identification
// quality suffers; re-measure with scripts/eval-photos.mjs.
const EFFORT = 'low';

const stepSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    n: { type: 'integer', description: '1-based step number' },
    text: { type: 'string', description: 'One short spoken instruction' },
    spec: { type: 'string', description: 'Torque or measurement spec for this step, if any' },
    warning: { type: 'string', description: 'Safety warning for this step, if any' },
    check_goal: { type: 'string', description: 'What a photo of correctly finished work shows' },
  },
  required: ['n', 'text', 'check_goal'],
};

export const JOB_PLAN_TOOL = Object.freeze({
  name: 'job_plan',
  description: 'Report the identified car part and a step-by-step job plan for working on it.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      part: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          variant: { type: 'string' },
          confidence: { type: 'number', description: '0 to 1' },
        },
        required: ['name', 'variant', 'confidence'],
      },
      job: { type: 'string', description: 'The most likely job on this part, e.g. "Replace front brake pads"' },
      tools: { type: 'array', items: { type: 'string' } },
      safety: { type: 'array', items: { type: 'string' } },
      steps: { type: 'array', items: stepSchema },
      unidentified: { type: 'boolean' },
    },
    required: ['part', 'job', 'tools', 'safety', 'steps', 'unidentified'],
  },
});

const SYSTEM_PROMPT = `You are a master mechanic coaching someone with greasy hands through a job, hands-free.
The user sends one photo of a car part. Always answer by calling the job_plan tool exactly once; never reply with plain text.

- part.name: the specific part. part.variant: type or design detail ("" if unknown). part.confidence: 0-1, how sure you are.
- job: the most common DIY job on this part.
- tools: every tool needed, with sizes where typical.
- safety: the critical safety rules for the whole job.
- steps: at most 9 steps, in order, numbered from 1. Each text is one short sentence that is easy to hear read aloud.
  Put torque or measurement values in spec (typical values; the app tells the user to verify with the service manual).
  Put step-specific hazards in warning. check_goal describes what a photo of the correctly finished step looks like.
- If the photo is not a car part or you cannot tell what it is, set unidentified to true, part.name to "Unknown part", confidence below 0.3, and steps to [].`;

export function buildRequest(image) {
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    output_config: { effort: EFFORT },
    system: SYSTEM_PROMPT,
    tools: [JOB_PLAN_TOOL],
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
          { type: 'text', text: 'Identify this part and give me the job plan.' },
        ],
      },
    ],
  };
}

export class UpstreamError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

/**
 * @param {{ image: { mediaType: string, data: string }, signal?: AbortSignal,
 *   apiKey?: string, fetchImpl?: typeof fetch, log?: Pick<Console, 'error'|'warn'> }} args
 * @returns {Promise<object|null>} the job_plan tool input, or null
 */
export async function callClaude({
  image,
  signal,
  apiKey = process.env.ANTHROPIC_API_KEY,
  fetchImpl = fetch,
  log = console,
}) {
  if (!apiKey) throw new UpstreamError('ANTHROPIC_API_KEY is not configured', 500);

  const response = await fetchImpl(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify(buildRequest(image)),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    log.error('[claude] HTTP error', response.status, detail.slice(0, 500));
    throw new UpstreamError(`Claude API returned ${response.status}`, response.status);
  }

  const message = await response.json();
  const call = (message.content ?? []).find((b) => b.type === 'tool_use' && b.name === JOB_PLAN_TOOL.name);
  if (!call) {
    const text = (message.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    log.warn('[claude] no job_plan tool call', { stop_reason: message.stop_reason, text: text.slice(0, 500) });
    return null;
  }
  return call.input ?? null;
}
