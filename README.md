# Greasy Hands Copilot

A phone web app for mechanics with oily hands. Take one photo of a car part, and Claude identifies it and returns a structured job plan: the part, the tools you need, safety notes, and ordered steps with torque specs. The app then runs the job hands-free. Say "next", "back", "repeat", or "snap", and big tap buttons work as a fallback when voice does not.

Built live for the workshop talk **From Vibecoded to Demo-Ready** by Ivan Vigliante. The deployed site is at [hackathon.ivanavr.com](https://hackathon.ivanavr.com).

## What is where on the site

| Path | What it is |
| --- | --- |
| `/` | The workshop links page: slides, the app, and the tools used in the talk |
| `/demo/` | The original app |
| `/v2/` | A polished skin on the same app |
| `/compare.html` | The two skins side by side |

Append `?demo=1` to the app URL to use the cached hero-part plan instead of calling the model. That flag exists so the on-stage demo survives bad venue wifi. Without the flag, a failed call shows a retry screen and never falls back to the cache.

## How it works

```
phone browser (public/, vanilla JS, no framework)
  camera via getUserMedia, file input as fallback
  downscale to <=1024px JPEG, POST /api/identify
  Web Speech API for reading steps aloud and hearing commands
  step position kept in sessionStorage

Vercel functions (api/)
  /api/identify  photo in, JobPlan out (Claude vision, strict tool call)
  /api/progress  fire-and-forget step tracking

Supabase Postgres (supabase/)
  best-effort persistence of jobs and step checks
  never blocks the demo: 2s timeout, no-op when unconfigured
```

The backend calls the Claude API with raw `fetch` and no SDK. The model must answer with a single `job_plan` tool call, which is validated before it reaches the browser. Anything else returns a `502 bad_model_output`.

Every torque spec renders with a "verify with service manual" note. Model-generated specs can be wrong, and the app says so.

## Project layout

```
api/        Vercel function wrappers (thin, over pure cores in lib/)
lib/        identify core, validation, rate limiter, Claude client, DB client
public/     the site: links page at root, app in demo/, v2 skin, compare page
supabase/   SQL migrations
scripts/    eval-photos.mjs, regenerates the cached hero-part plan
test/       node:test unit tests
e2e/        Playwright mobile suite plus a local server that stubs Claude
docs/       design doc, wireframe, and the multi-agent build brief
```

## Running locally

Requires Node 22.9 or newer.

```sh
npm install
cp .env.example .env.local   # fill in the keys below
```

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude API key. Server-only, never sent to the browser |
| `SUPABASE_URL` | Supabase project URL. Leave unset to disable persistence |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key, used server-side only |

The fastest way to run the whole thing locally is the end-to-end server. It serves `public/` and mounts the real API handlers, with the Claude upstream stubbed in-process:

```sh
node e2e/server.mjs
# open http://127.0.0.1:4173/demo/
```

To run against the real model, use the Vercel CLI from the repo root:

```sh
vercel dev
```

## Tests

```sh
npm test                     # unit tests (node:test)
npx playwright install       # once, downloads the Pixel 7 emulation browser
npm run test:e2e             # Playwright mobile suite against the local server
```

The end-to-end suite covers the full job flow, the demo flag, timeout and retry, low-confidence results, voice commands, reload restore, camera capture, and the app still working when the database is unreachable.

To run only the smoke specs against a deployed preview:

```sh
PREVIEW_URL=https://your-preview.vercel.app npm run test:e2e
```

## Regenerating the cached hero plan

Put the demo photos in `photos/` (gitignored), then:

```sh
npm run eval -- photos --hero caliper.jpg
```

This runs every photo through the real identify handler, prints latency per photo, and writes a validated plan for the hero photo to `public/cached/hero-part.json`. The directory defaults to `photos/` and the hero defaults to the first file. It spends real API credits.

## Deploying

Production is the Vercel project `greasy-hands-copilot`. Deploys are made from the CLI, not from git, so merging to `main` does not deploy by itself:

```sh
vercel deploy --prod
```

Set the three environment variables in the Vercel dashboard. Redirects and the function timeout live in `vercel.json`.

## Design notes

- `docs/designs/greasy-hands-copilot.md` is the approved design, including the JobPlan schema, UI states, and the reviewed risks.
- `docs/build-brief.md` is the orchestration brief used to build the app in parallel lanes with Claude Code.
- `TODOS.md` lists the known ceilings that were accepted for the time box: an in-memory rate limiter, no CI, and no offline speech recognition.

## Known limits

- Speech recognition is flaky or absent on iOS Safari. Demo on Android Chrome or a laptop. The buttons always work.
- The rate limiter is per serverless instance, so the Anthropic workspace spend limit is the real guard.
- The `check` step (snap a photo of your work and get a pass/fail verdict) is designed but not built.
