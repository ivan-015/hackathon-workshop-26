# Build Brief: Greasy Hands Copilot

Paste the prompt at the bottom into a fresh `claude-personal` session started in the repo root (with the Supabase MCP connected). The source of truth is `docs/designs/greasy-hands-copilot.md`. This brief tells an orchestrator how to split that design across agents and adds the database lane the design did not have.

## What we're building

A phone web app. One photo of a car part → Claude identifies it and returns a structured JobPlan (part, tools, safety, ordered steps with torque specs) → the app runs the job hands-free with voice ("next / back / repeat / snap / check") and big tap buttons as fallback. Stretch: "check" sends a photo of your work and gets a pass/fail verdict.

Stack (fixed by the design, don't relitigate):
- **Web app:** static `public/index.html` + vanilla JS, Web Speech API, `getUserMedia`. No framework.
- **Backend:** Vercel functions, `package.json` with `"type":"module"`, raw `fetch` to the Claude API (no SDK), `claude-sonnet-5-5`, `maxDuration: 30`.
- **Database:** Supabase Postgres, schema in `supabase/migrations/20261023000000_init.sql` (`jobs`, `step_checks`, RLS on, no policies). Server-only access via raw `fetch` to PostgREST with the service-role key.
- **Tests:** `node:test` for units/handlers, `@playwright/test` (the only dependency) for E2E.

## The one rule for the database

**The database is best-effort and must never break the demo.** Job position still lives in `sessionStorage`. Every DB write has a short timeout (2s), is wrapped in try/catch, logs on failure, and the request succeeds anyway. With `SUPABASE_URL` unset, all DB functions are no-ops. `?demo=1` with wifi off must still run the full hero job.

## Shared contracts (every agent codes against these)

1. **JobPlan schema**: exactly as in the design doc, section "JobPlan schema".
2. **`/api/identify` response**: `200 { job_id: string | null, plan: JobPlan }`, errors as listed in the design (400/413/429/502 `bad_model_output`/502 `upstream_error`/504 `upstream_timeout`), every error body `{ error, message }`. `job_id` is null when the DB is off or the insert failed.
3. **`/api/check`** (stretch): `POST { image, step, job_id? }` → `{ passed: boolean | null, reason: string }`.
4. **`/api/progress`**: `POST { job_id, current_step, status }` → `204`. Fire-and-forget from the client; the client ignores failures.
5. **DB module** `lib/db.js` exports, all returning promises that never reject:
   - `saveJob(plan) → id | null`
   - `updateProgress(id, currentStep, status) → void`
   - `saveCheck(jobId, stepN, passed, reason) → void`
6. **Injection seam**: `handleIdentify({ body, ip, callClaude, saveJob })` and `handleCheck({ body, ip, callClaude, saveCheck })`. Cores take the DB functions as parameters; the `api/*.js` wrappers pass the real ones from `lib/db.js`.

Env vars (Vercel dashboard + `.env.local`, never committed, never sent to the browser): `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

## Lanes

Run lanes A, B and C in parallel, each in its own worktree. Each lane owns its files and touches nothing else.

### Lane A: Backend (design tasks T1 + T2)
- Owns: `api/identify.js`, `lib/identify.js`, `lib/validate.js`, `lib/limit.js`, `lib/claude.js`, `scripts/eval-photos.mjs`, `public/cached/hero-part.json` (served at `/cached/hero-part.json`; Vercel serves `public/` as the site root), `vercel.json`, `package.json`, `test/identify.test.js`, `test/validate.test.js`.
- Start with one curl probe of `claude-sonnet-5-5` with a tiny image (O12).
- Limiter 200 req / 10 min per IP; 4 MB cap; jpeg/png/webp only; single strict `job_plan` tool with `tool_choice: auto` (forced `tool`/`any` returns 400 on `claude-sonnet-5-5`), no tool call → 502; 25s server abort → 504; `validateJobPlan` → 502.
- Tests use a stubbed `saveJob`. `api/identify.js` imports `saveJob` from `lib/db.js`, which Lane C creates; until the merge, a local stub is fine.
- Done when `node --test` passes and `eval-photos.mjs` writes a `hero-part.json` that passes `validateJobPlan`. If no demo photos exist yet, skip the eval run and say so.

### Lane B: Web app (design tasks T3 + T4)
- Owns: `public/index.html`, `public/app.js`, `public/voice.js`, `public/styles.css`, `test/voice.test.js`.
- All UI states from the design's "UI states" section, built from the wireframe `docs/designs/greasy-hands-copilot-wireframe.png`.
- getUserMedia rear preview with file-input fallback; mandatory downscale to ≤1024px JPEG q≈0.8; 15s client timeout; `?demo=1`-only cached plan; sessionStorage restore.
- Voice state machine `listening | speaking | offline | idle`, `parseCommand`, local voice only.
- After each step change, fire-and-forget `POST /api/progress` when `job_id` is non-null.
- Done when `node --test test/voice.test.js` passes and the page works against a mocked `/api/identify`.

### Lane C: Database
- Owns: `supabase/`, `lib/db.js`, `api/progress.js`, `test/db.test.js`, `.env.example`.
- Using the Supabase MCP: confirm org, region and cost with the user, create project `greasy-hands-copilot`, apply `supabase/migrations/20261023000000_init.sql` with `apply_migration`, run `get_advisors` (security) and fix any finding with a new migration file.
- `lib/db.js`: raw `fetch` to `${SUPABASE_URL}/rest/v1/...` with the service-role key, 2s `AbortController` timeout, never rejects, no-op when env is unset.
- Tests stub `fetch`: success, timeout, 500, env unset.
- Done when the migration is applied, advisors are clean, `node --test test/db.test.js` passes, and one real insert/select round-trip via MCP `execute_sql` succeeds and is cleaned up.
- Hand the user the project URL and where to find the service-role key. Never print the key itself.

### After A, B, C merge (sequential)
1. **Integrate:** wire real `lib/db.js` into the API wrappers; run all `node --test`; deploy a Vercel preview.
2. **Lane D: E2E (T5):** Playwright mobile suite in `e2e/`: full job, demo flag, timeout retry, low confidence, fake-speech "next", reload restore, fake camera snap, plus "DB down still works".
3. **Lane E: Stretch (T7):** `handleCheck`, `api/check.js`, Check screen. Only if 1-2 are solid. Edits `public/app.js`, so it runs after Lane B merged.
4. **Rehearsal (human, 30 min, protected):** never trade it for tests or the stretch.

## Orchestrator rules
- Spawn A, B, C with `isolation: "worktree"`. Give each agent this brief plus the design doc path; tell it which lane it is.
- Lanes stay inside their owned files. A contract change goes through the orchestrator, which updates this brief and tells every lane.
- Merge order: C, then A, then B. Run the full test suite after each merge.
- Commit with conventional commits, no co-author lines. Open one draft PR per lane against `main`; don't merge without the user's OK.
- Report at the end: what's deployed (preview URL), test results, what was skipped and why.

---

## Prompt to paste

> Read `docs/build-brief.md` and `docs/designs/greasy-hands-copilot.md`. You are the orchestrator. Launch three agents in parallel, each in its own worktree: Lane A (backend), Lane B (web app), Lane C (database, uses the Supabase MCP; ask me to confirm org, region and cost before creating the project). Each agent gets the brief and its lane name and stays inside its owned files. When all three finish, merge in the order C, A, B, run the tests, deploy a Vercel preview, then run Lane D (E2E). Ask me before starting the stretch (Lane E). Open draft PRs; don't merge to `main` without my OK.
