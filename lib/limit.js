// In-memory fixed-window rate limiter, per key (IP). Per serverless instance
// only: a runaway-script speed bump, not a global limit (design R3/O2). The
// workspace spend limit in the Anthropic Console is the real guard.

export const DEFAULT_LIMIT = 200;
export const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MAX_KEYS = 10_000;

export function createRateLimiter({
  limit = DEFAULT_LIMIT,
  windowMs = DEFAULT_WINDOW_MS,
  now = Date.now,
  maxKeys = DEFAULT_MAX_KEYS,
} = {}) {
  // Entries are replaced, never mutated in place.
  const windows = new Map();

  function prune(t) {
    for (const [key, entry] of windows) {
      if (entry.resetAt <= t) windows.delete(key);
    }
  }

  /** Record one request for `key`. Returns true if it is allowed. */
  function hit(key) {
    const t = now();
    if (windows.size >= maxKeys) prune(t);

    const current = windows.get(key);
    if (!current || current.resetAt <= t) {
      windows.set(key, { count: 1, resetAt: t + windowMs });
      return true;
    }
    if (current.count >= limit) return false;
    windows.set(key, { ...current, count: current.count + 1 });
    return true;
  }

  return { hit, size: () => windows.size };
}
