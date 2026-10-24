#!/usr/bin/env node
// Run the demo photos through the real handleIdentify + Claude, print latency
// per photo and the median (design R8), and write cached/hero-part.json from
// the hero photo (design O7). Spends real API credits.
//
// Usage:
//   npm run eval -- [photoDir] [--hero <file name>]
//   (equivalent: node --env-file-if-exists=.env.local scripts/eval-photos.mjs ...)
//
// photoDir defaults to ./photos. Photos must be jpeg/png/webp and already
// downscaled (<=1024px, like the app sends); anything over 4 MB of base64 is
// rejected with 413 just as in production. The hero defaults to the first
// photo by name. Exits 1 if any photo fails or the hero plan is invalid.

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { handleIdentify } from '../lib/identify.js';
import { callClaude } from '../lib/claude.js';
import { createRateLimiter } from '../lib/limit.js';
import { validateJobPlan } from '../lib/validate.js';

const MEDIA_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const HERO_PATH = resolve(import.meta.dirname, '../cached/hero-part.json');
const TARGET_MEDIAN_MS = 8_000;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function listPhotos(dir) {
  const names = await readdir(dir).catch((err) => {
    throw new Error(`Cannot read photo directory ${dir}: ${err.message}`);
  });
  return names.filter((n) => MEDIA_TYPES[extname(n).toLowerCase()]).sort();
}

async function runPhoto(dir, name, limiter) {
  const bytes = await readFile(join(dir, name));
  const image = `data:${MEDIA_TYPES[extname(name).toLowerCase()]};base64,${bytes.toString('base64')}`;
  const started = performance.now();
  const res = await handleIdentify({
    body: { image },
    ip: 'eval',
    callClaude,
    saveJob: async () => null,
    limiter,
  });
  return { name, ms: Math.round(performance.now() - started), ...res };
}

function report(r) {
  if (r.status !== 200) {
    console.log(`FAIL ${r.name}  ${r.ms} ms  HTTP ${r.status} ${r.body.error}`);
    return;
  }
  const { part, steps, unidentified } = r.body.plan;
  const flag = unidentified || part.confidence < 0.6 ? '  (low confidence / unidentified)' : '';
  console.log(`ok   ${r.name}  ${r.ms} ms  ${part.name} @ ${part.confidence}  ${steps.length} steps${flag}`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { hero: { type: 'string' } },
  });
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set (put it in .env.local)');

  const dir = resolve(positionals[0] ?? 'photos');
  const photos = await listPhotos(dir);
  if (photos.length === 0) throw new Error(`No jpeg/png/webp photos in ${dir}`);
  const heroName = values.hero ?? photos[0];
  if (!photos.includes(heroName)) throw new Error(`Hero photo ${heroName} not found in ${dir}`);

  const limiter = createRateLimiter();
  const results = [];
  for (const name of photos) {
    const result = await runPhoto(dir, name, limiter);
    report(result);
    results.push(result);
  }

  const med = median(results.map((r) => r.ms));
  console.log(`\nmedian ${med} ms (target <= ${TARGET_MEDIAN_MS} ms)${med > TARGET_MEDIAN_MS ? '  OVER TARGET' : ''}`);

  const hero = results.find((r) => r.name === heroName);
  const heroCheck = hero.status === 200 ? validateJobPlan(hero.body.plan) : { ok: false };
  if (heroCheck.ok && !heroCheck.plan.unidentified) {
    await mkdir(resolve(HERO_PATH, '..'), { recursive: true });
    await writeFile(HERO_PATH, `${JSON.stringify(heroCheck.plan, null, 2)}\n`);
    console.log(`wrote ${HERO_PATH} from ${heroName}`);
  } else {
    console.log(`hero ${heroName} did not produce a usable plan; cached/hero-part.json left unchanged`);
  }

  const failed = results.some((r) => r.status !== 200) || !heroCheck.ok;
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
