// Vercel function: thin (req, res) wrapper over handleIdentify.
//
// Platform limits (unverified, design O12): Vercel rejects request bodies over
// ~4.5 MB before this runs; vercel.json sets maxDuration 30s; the Claude call
// aborts at 25s inside handleIdentify.

import { handleIdentify } from '../lib/identify.js';
import { callClaude } from '../lib/claude.js';
import { saveJob } from '../lib/db.js';

function clientIp(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || req.socket?.remoteAddress || 'unknown';
}

function parseBody(body) {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed', message: 'Use POST' });
  }

  try {
    const { status, body } = await handleIdentify({
      body: parseBody(req.body),
      ip: clientIp(req),
      callClaude,
      saveJob,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(status).json(body);
  } catch (err) {
    console.error('[identify] unhandled error', err);
    return res.status(502).json({ error: 'upstream_error', message: 'Something went wrong on our side. Tap to retry.' });
  }
}
