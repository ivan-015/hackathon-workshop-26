// Pure validators for the /api/identify boundary: the incoming photo and the
// model's JobPlan. Neither function mutates its input.

// Vercel rejects request bodies over ~4.5 MB before our code runs (unverified,
// see design O12), so the cap sits below it. The client always downscales to
// <=1024px JPEG (~150-300 KB), so this only fires on a misbehaving client.
export const MAX_IMAGE_BASE64_BYTES = 4 * 1024 * 1024;
export const MAX_STEPS = 20;

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DATA_URL = /^data:([a-z0-9.+/-]+);base64,/i;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function fail(status, error, message) {
  return { ok: false, status, error, message };
}

function badRequest(message) {
  return fail(400, 'bad_request', message);
}

function sniffMediaType(base64) {
  const head = Buffer.from(base64.slice(0, 24), 'base64');
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function splitDataUrl(image) {
  const match = DATA_URL.exec(image);
  if (!match) return { declared: null, data: image };
  return { declared: match[1].toLowerCase(), data: image.slice(match[0].length) };
}

/**
 * Validate `{ image }` where image is a data URL or bare base64 of a
 * jpeg/png/webp. Returns `{ ok: true, image: { mediaType, data } }` or
 * `{ ok: false, status: 400|413, error, message }`.
 */
export function validateImageBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest('Request body must be a JSON object');
  }
  const { image } = body;
  if (typeof image !== 'string' || image.length === 0) {
    return badRequest('Missing image');
  }

  const { declared, data } = splitDataUrl(image);
  if (data.length > MAX_IMAGE_BASE64_BYTES) {
    return fail(413, 'too_large', 'Photo too large');
  }
  if (declared && !ALLOWED_TYPES.has(declared)) {
    return badRequest('Image must be JPEG, PNG or WebP');
  }
  if (data.length % 4 !== 0 || !BASE64.test(data)) {
    return badRequest('Image is not valid base64');
  }

  const mediaType = sniffMediaType(data);
  if (!mediaType) return badRequest('Image must be JPEG, PNG or WebP');
  if (declared && declared !== mediaType) {
    return badRequest('Image type does not match its contents');
  }
  return { ok: true, image: { mediaType, data } };
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isStringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');

function optionalString(value, path, errors) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    errors.push(`${path} must be a string or null`);
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function validatePart(part, errors) {
  if (!isObject(part)) {
    errors.push('part must be an object');
    return null;
  }
  if (!isNonEmptyString(part.name)) errors.push('part.name must be a non-empty string');
  if (part.variant !== undefined && part.variant !== null && typeof part.variant !== 'string') {
    errors.push('part.variant must be a string');
  }
  const { confidence } = part;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    errors.push('part.confidence must be a number between 0 and 1');
  }
  return {
    name: typeof part.name === 'string' ? part.name.trim() : '',
    variant: typeof part.variant === 'string' ? part.variant.trim() : '',
    confidence,
  };
}

function validateStep(step, i, errors) {
  const path = `steps[${i}]`;
  if (!isObject(step)) {
    errors.push(`${path} must be an object`);
    return null;
  }
  if (!Number.isInteger(step.n) || step.n < 1) errors.push(`${path}.n must be a positive integer`);
  if (!isNonEmptyString(step.text)) errors.push(`${path}.text must be a non-empty string`);
  return {
    n: step.n,
    text: typeof step.text === 'string' ? step.text.trim() : '',
    spec: optionalString(step.spec, `${path}.spec`, errors),
    warning: optionalString(step.warning, `${path}.warning`, errors),
    check_goal: optionalString(step.check_goal, `${path}.check_goal`, errors),
  };
}

function validateSteps(steps, unidentified, errors) {
  if (!Array.isArray(steps)) {
    errors.push('steps must be an array');
    return [];
  }
  const min = unidentified === true ? 0 : 1;
  if (steps.length < min || steps.length > MAX_STEPS) {
    errors.push(`steps must have ${min}-${MAX_STEPS} items`);
  }
  return steps.map((step, i) => validateStep(step, i, errors));
}

/**
 * Validate the model's JobPlan. Returns `{ ok: true, plan }` with a new,
 * normalized plan holding only schema fields (missing spec/warning/check_goal
 * become null), or `{ ok: false, errors: string[] }`.
 *
 * Steps may be empty only when `unidentified` is true.
 */
export function validateJobPlan(raw) {
  if (!isObject(raw)) return { ok: false, errors: ['plan must be an object'] };

  const errors = [];
  const part = validatePart(raw.part, errors);
  if (!isNonEmptyString(raw.job)) errors.push('job must be a non-empty string');
  if (!isStringArray(raw.tools)) errors.push('tools must be an array of strings');
  if (!isStringArray(raw.safety)) errors.push('safety must be an array of strings');
  if (typeof raw.unidentified !== 'boolean') errors.push('unidentified must be a boolean');
  const steps = validateSteps(raw.steps, raw.unidentified, errors);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    plan: {
      part,
      job: raw.job.trim(),
      tools: [...raw.tools],
      safety: [...raw.safety],
      steps,
      unidentified: raw.unidentified,
    },
  };
}
