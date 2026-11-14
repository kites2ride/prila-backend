/**
 * In-process counters for Google calls (billable) vs cache hits (free).
 * Per instance, reset on restart — enough to measure "Google calls per ride"
 * and spot cost spikes. Exposed at GET /admin/maps/usage.
 */
export type MapsOp = 'autocomplete' | 'placeDetails' | 'reverseGeocode' | 'computeRoutes';

const OPS: MapsOp[] = ['autocomplete', 'placeDetails', 'reverseGeocode', 'computeRoutes'];

function zero(): Record<MapsOp, number> {
  return { autocomplete: 0, placeDetails: 0, reverseGeocode: 0, computeRoutes: 0 };
}

let startedAt = new Date();
let googleCalls = zero();
let cacheHits = zero();
let errors = zero();
let skipped = { belowMinChars: 0, rateLimited: 0, routeFallback: 0 };

export const usage = {
  google(op: MapsOp) {
    googleCalls[op] += 1;
  },
  cacheHit(op: MapsOp) {
    cacheHits[op] += 1;
  },
  error(op: MapsOp) {
    errors[op] += 1;
  },
  skip(kind: keyof typeof skipped) {
    skipped[kind] += 1;
  },
  snapshot() {
    const total = OPS.reduce((n, op) => n + googleCalls[op], 0);
    return {
      since: startedAt.toISOString(),
      googleCallsTotal: total,
      googleCalls: { ...googleCalls },
      cacheHits: { ...cacheHits },
      errors: { ...errors },
      skipped: { ...skipped },
    };
  },
  reset() {
    startedAt = new Date();
    googleCalls = zero();
    cacheHits = zero();
    errors = zero();
    skipped = { belowMinChars: 0, rateLimited: 0, routeFallback: 0 };
  },
};
