/**
 * Polygon validation for service / blocked zones (pure, no DB).
 * Mirrors prila-admin/src/lib/polygon.ts — keep both in sync.
 */
export type Position = [number, number]; // [lng, lat] (GeoJSON order)

export const ZONE_LIMITS = {
  minVertices: 3,
  maxVertices: 500,
  /** ~140 m × 140 m — smaller is almost certainly a mis-click. */
  minAreaKm2: 0.02,
  /** Bigger than any single city service area we expect. */
  maxAreaKm2: 2500,
} as const;

export type RingCheck =
  | { ok: true; ring: Position[]; areaKm2: number }
  | { ok: false; message: string };

const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LNG_EQ = 111.32;

/** Local equirectangular projection (km) — accurate enough for city-sized zones. */
function project(ring: Position[]): Array<[number, number]> {
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const kx = KM_PER_DEG_LNG_EQ * Math.cos((lat0 * Math.PI) / 180);
  return ring.map(([lng, lat]) => [lng * kx, lat * KM_PER_DEG_LAT]);
}

/** Signed shoelace area of an OPEN ring (no repeated closing vertex). >0 = counter-clockwise. */
function signedArea(pts: Array<[number, number]>): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]!;
    const [x2, y2] = pts[(i + 1) % pts.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function orient(a: [number, number], b: [number, number], c: [number, number]): number {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const eps = 1e-12;
  return v > eps ? 1 : v < -eps ? -1 : 0;
}

function onSegment(a: [number, number], b: [number, number], p: [number, number]): boolean {
  return (
    Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1])
  );
}

/** True if segments ab and cd touch or cross (collinear overlap included). */
function segmentsIntersect(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a, b, c)) return true;
  if (o2 === 0 && onSegment(a, b, d)) return true;
  if (o3 === 0 && onSegment(c, d, a)) return true;
  if (o4 === 0 && onSegment(c, d, b)) return true;
  return false;
}

/** Any two non-adjacent edges of the (open) ring touching = self-crossing. O(n²), n ≤ 500. */
export function hasSelfIntersection(open: Array<[number, number]>): boolean {
  const n = open.length;
  for (let i = 0; i < n; i++) {
    const a = open[i]!;
    const b = open[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      // skip adjacent edges (they share a vertex by construction)
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      const c = open[j]!;
      const d = open[(j + 1) % n]!;
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

/**
 * Validate + normalise GeoJSON Polygon coordinates (single outer ring, no holes).
 * Accepts open or closed rings; returns a closed, counter-clockwise ring.
 */
export function checkPolygon(coordinates: unknown): RingCheck {
  if (!Array.isArray(coordinates) || coordinates.length !== 1 || !Array.isArray(coordinates[0])) {
    return { ok: false, message: 'Zone must be a single outline (holes are not supported)' };
  }
  const raw = coordinates[0] as unknown[];
  const pts: Position[] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2) return { ok: false, message: 'Each point must be [lng, lat]' };
    const lng = Number(p[0]);
    const lat = Number(p[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) {
      return { ok: false, message: 'Point outside valid lng/lat range' };
    }
    const prev = pts[pts.length - 1];
    if (prev && prev[0] === lng && prev[1] === lat) continue; // drop consecutive duplicates
    pts.push([lng, lat]);
  }
  // open the ring for analysis
  if (pts.length > 1) {
    const f = pts[0]!;
    const l = pts[pts.length - 1]!;
    if (f[0] === l[0] && f[1] === l[1]) pts.pop();
  }
  if (pts.length < ZONE_LIMITS.minVertices) {
    return { ok: false, message: `A zone needs at least ${ZONE_LIMITS.minVertices} points` };
  }
  if (pts.length > ZONE_LIMITS.maxVertices) {
    return { ok: false, message: `A zone can have at most ${ZONE_LIMITS.maxVertices} points` };
  }
  const projected = project(pts);
  if (hasSelfIntersection(projected)) {
    return { ok: false, message: 'Zone outline crosses itself. Move the points so the edges do not cross.' };
  }
  const area = signedArea(projected);
  const areaKm2 = Math.abs(area);
  if (areaKm2 < ZONE_LIMITS.minAreaKm2) {
    return { ok: false, message: `Zone is too small (${areaKm2.toFixed(3)} km²; minimum ${ZONE_LIMITS.minAreaKm2} km²)` };
  }
  if (areaKm2 > ZONE_LIMITS.maxAreaKm2) {
    return { ok: false, message: `Zone is too large (${Math.round(areaKm2)} km²; maximum ${ZONE_LIMITS.maxAreaKm2} km²)` };
  }
  const ccw = area > 0 ? pts : [...pts].reverse(); // RFC 7946: exterior ring counter-clockwise
  return { ok: true, ring: [...ccw, ccw[0]!], areaKm2: Math.round(areaKm2 * 1000) / 1000 };
}
