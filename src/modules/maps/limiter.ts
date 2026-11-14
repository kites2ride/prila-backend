/**
 * Fixed one-minute window limiter per (bucket, user). The global
 * @fastify/rate-limit is per IP and runs before auth; this one is per user
 * and its limits come from admin config.
 */
const windows = new Map<string, { windowStart: number; count: number }>();
const WINDOW_MS = 60_000;
const MAX_KEYS = 50_000;

/** @returns true when the call is allowed (and counts it). */
export function allow(bucket: string, userId: string, maxPerMin: number, now = Date.now()): boolean {
  const key = `${bucket}:${userId}`;
  const w = windows.get(key);
  if (!w || now - w.windowStart >= WINDOW_MS) {
    if (windows.size >= MAX_KEYS) prune(now);
    windows.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (w.count >= maxPerMin) return false;
  w.count += 1;
  return true;
}

function prune(now: number) {
  for (const [k, w] of windows) {
    if (now - w.windowStart >= WINDOW_MS) windows.delete(k);
  }
  // Still full (abuse burst): drop oldest half rather than grow unbounded.
  if (windows.size >= MAX_KEYS) {
    let n = Math.floor(windows.size / 2);
    for (const k of windows.keys()) {
      if (n-- <= 0) break;
      windows.delete(k);
    }
  }
}

export function resetLimiter() {
  windows.clear();
}
