# TODOS

## Infrastructure

### Global rate limit backed by a shared store

**What:** Replace the in-memory per-IP limiter in `handleIdentify` / `handleCheck` with a shared store (e.g. Vercel KV / Upstash) keyed by IP and a per-session token.

**Why:** The in-memory limiter resets per serverless instance, so it only slows runaway scripts; the spend limit is the only hard guard today.

**Context:** Accepted as a known ceiling in eng review R3/O2 (200 req / 10 min per IP, in-memory). Venue NAT means IP alone is a weak key; pair it with a signed session token. Start in the limiter module and its 429 test.

**Pros:** Real abuse protection if the app outlives the hackathon. **Cons:** Adds a paid/hosted dependency and a network hop per request.

**Effort:** S
**Priority:** P3
**Depends on:** The app surviving past the hackathon.

### CI for node:test and Playwright

**What:** GitHub Actions workflow running `node --test` and `npx playwright test` on push.

**Why:** Tests only run locally today; regressions after the hackathon would go unnoticed.

**Context:** Deferred in eng review (Distribution Plan): no CI for a few-hour build. The suites already exist per R6.

**Pros:** Cheap safety net. **Cons:** Playwright browser download slows CI.

**Effort:** S
**Priority:** P3
**Depends on:** R6 test suites landing.

## Voice

### On-device speech recognition for real garages

**What:** Use Chrome's on-device recognition where available so voice commands work without network.

**Why:** Real shops have bad signal; today voice input degrades to buttons offline (R1).

**Context:** Considered as R1 option B in eng review and deferred for the time box. The offline branch (`Voice offline, use buttons`) is the fallback to keep.

**Pros:** Hands-free works offline. **Cons:** Newer API surface, unverified browser support.

**Effort:** M
**Priority:** P3
**Depends on:** None.
