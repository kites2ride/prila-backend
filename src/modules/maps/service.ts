import { TtlCache } from '../../lib/cache.js';
import { createLogger } from '../../lib/logger.js';
import { AppError } from '../../lib/errors.js';
import { City } from '../app/model.js';
import { estimateDurationSec, haversineM } from '../rides/geo.js';
import { getMapsConfig, isMapsActive, type MapsConfig } from './config.js';
import * as google from './google.js';
import { allow } from './limiter.js';
import { usage, type MapsOp } from './usage.js';
import { searchLandmarks } from '../places/service.js';

type LatLng = { lat: number; lng: number };
type ServiceType = 'bike' | 'auto' | 'parcel' | 'logistics';

// Bounded so a burst of unique points can never exhaust memory.
const placeCache = new TtlCache(86_400_000, 5_000);
const reverseCache = new TtlCache(86_400_000, 20_000);
const routeCache = new TtlCache(900_000, 5_000);
const cityCentreCache = new TtlCache(60_000, 1);

let logger: ReturnType<typeof createLogger> | null = null;
function log() {
  logger ??= createLogger();
  return logger;
}

/** ~11 m grid: identical-enough points share cache entries. */
export function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

function unavailable(): AppError {
  return new AppError('MAPS_UNAVAILABLE', 'Maps service is unavailable. Please try again.', 503);
}

/** Google failure → MAPS_UNAVAILABLE. Logs the Google status only (never URLs, bodies or keys). */
function wrapGoogle(op: MapsOp, err: unknown): AppError {
  if (err instanceof google.GoogleError) {
    log().warn({ op, googleStatus: err.status, httpStatus: err.httpStatus }, 'google maps call failed');
    return unavailable();
  }
  if (err instanceof AppError) return err;
  log().warn({ op, googleStatus: 'UNEXPECTED' }, 'google maps call failed');
  return unavailable();
}

function rateLimit(bucket: string, userId: string, maxPerMin: number) {
  if (!allow(bucket, userId, maxPerMin)) {
    usage.skip('rateLimited');
    throw new AppError('RATE_LIMITED', 'Too many requests. Please wait a moment.', 429);
  }
}

async function requireActive(): Promise<MapsConfig> {
  const cfg = await getMapsConfig();
  if (!(await isMapsActive(cfg))) throw unavailable();
  return cfg;
}

/** Bias around the user if we know where they are, else the launch city centre. */
async function biasCentre(lat?: number, lng?: number): Promise<LatLng | null> {
  if (lat !== undefined && lng !== undefined) return { lat, lng };
  const cached = cityCentreCache.get<LatLng | null>('first');
  if (cached !== undefined) return cached;
  const city = await City.findOne({ enabled: true }).sort({ createdAt: 1 }).lean();
  const coords = city?.center?.coordinates;
  const centre = coords && coords.length === 2 ? { lat: coords[1]!, lng: coords[0]! } : null;
  cityCentreCache.set('first', centre);
  return centre;
}

export type SuggestionItem = {
  source: 'landmark' | 'google';
  placeId: string | null;
  mainText: string;
  secondaryText: string;
  lat?: number;
  lng?: number;
};

/**
 * Ops landmarks first (free, our data), Google only when local hits are few.
 * Landmarks still answer when Google is disabled, missing a key, or failing.
 */
export async function autocomplete(
  userId: string,
  input: { q: string; sessionToken: string; lat?: number; lng?: number },
): Promise<{ suggestions: SuggestionItem[] }> {
  const cfg = await getMapsConfig();
  const q = input.q.trim();
  // Below min chars: answer locally, no Google call, no rate-limit charge.
  if ([...q].length < cfg.autocompleteMinChars) {
    usage.skip('belowMinChars');
    return { suggestions: [] };
  }

  const local: SuggestionItem[] = (await searchLandmarks(q, 5)).map((l) => ({
    source: 'landmark',
    placeId: null,
    mainText: l.name,
    secondaryText: l.address,
    lat: l.lat,
    lng: l.lng,
  }));
  if (local.length > 0 && local.length >= cfg.localMinHitsToSkipGoogle) {
    usage.skip('localHits');
    return { suggestions: local };
  }

  if (!(await isMapsActive(cfg))) {
    if (local.length) return { suggestions: local };
    throw unavailable();
  }
  try {
    rateLimit('autocomplete', userId, cfg.autocompleteRateLimitPerMin);
  } catch (err) {
    if (local.length) return { suggestions: local };
    throw err;
  }

  const bias = await biasCentre(input.lat, input.lng);
  let googleItems: google.Suggestion[];
  try {
    const base = {
      q,
      sessionToken: input.sessionToken,
      bias: bias ?? { lat: 20.5937, lng: 78.9629 }, // India centroid if no city configured yet
      biasRadiusM: bias ? cfg.biasRadiusM : 50_000,
      languageCode: cfg.languageCode,
      regionCode: cfg.regionCode,
      timeoutMs: cfg.timeoutMs,
    };
    // locationBias is only a soft hint: a prominent place 30 km away can outrank a nearby one
    // for partial text. When we know where the rider is, hard-limit to the radius first and
    // only fall back to the soft bias (far places) when nothing nearby matches.
    googleItems = bias ? await google.autocomplete({ ...base, restrict: true }) : [];
    if (googleItems.length === 0) googleItems = await google.autocomplete(base);
    // Nearest first (stable for items without a distance).
    googleItems = googleItems
      .map((g, i) => ({ g, i }))
      .sort((a, b) => (a.g.distanceM ?? Infinity) - (b.g.distanceM ?? Infinity) || a.i - b.i)
      .map((x) => x.g);
  } catch (err) {
    const wrapped = wrapGoogle('autocomplete', err); // logs status only
    if (local.length) return { suggestions: local };
    throw wrapped;
  }
  const localNames = new Set(local.map((l) => l.mainText.trim().toLowerCase()));
  const remote: SuggestionItem[] = googleItems
    .filter((g) => !localNames.has(g.mainText.trim().toLowerCase()))
    .map((g) => ({ source: 'google', placeId: g.placeId, mainText: g.mainText, secondaryText: g.secondaryText }));
  return { suggestions: [...local, ...remote] };
}

export async function place(
  userId: string,
  input: { placeId: string; sessionToken?: string },
): Promise<google.PlaceDetails> {
  const cfg = await requireActive();
  const cacheKey = `${cfg.languageCode}:${input.placeId}`;
  const hit = placeCache.get<google.PlaceDetails>(cacheKey);
  if (hit) {
    usage.cacheHit('placeDetails');
    return hit;
  }
  rateLimit('place', userId, cfg.placeRateLimitPerMin);
  let details: google.PlaceDetails | null;
  try {
    details = await google.placeDetails({
      placeId: input.placeId,
      sessionToken: input.sessionToken,
      languageCode: cfg.languageCode,
      regionCode: cfg.regionCode,
      timeoutMs: cfg.timeoutMs,
    });
  } catch (err) {
    throw wrapGoogle('placeDetails', err);
  }
  if (!details) throw new AppError('PLACE_NOT_FOUND', 'This place could not be found. Please search again.', 404);
  placeCache.set(cacheKey, details, cfg.placeCacheTtlSec * 1000);
  return details;
}

export async function reverse(
  userId: string,
  input: LatLng,
): Promise<{ lat: number; lng: number; address: string | null }> {
  const cfg = await requireActive();
  const lat = round4(input.lat);
  const lng = round4(input.lng);
  const cacheKey = `${cfg.languageCode}:${lat},${lng}`;
  const hit = reverseCache.get<{ address: string | null }>(cacheKey);
  if (hit) {
    usage.cacheHit('reverseGeocode');
    return { lat: input.lat, lng: input.lng, address: hit.address };
  }
  rateLimit('reverse', userId, cfg.reverseRateLimitPerMin);
  let address: string | null;
  try {
    address = await google.reverseGeocode({ lat, lng, languageCode: cfg.languageCode, timeoutMs: cfg.timeoutMs });
  } catch (err) {
    throw wrapGoogle('reverseGeocode', err);
  }
  reverseCache.set(cacheKey, { address }, cfg.reverseCacheTtlSec * 1000);
  return { lat: input.lat, lng: input.lng, address };
}

export type EstimateRoute = {
  distanceM: number;
  durationSec: number;
  /** Trip time without traffic. Equals durationSec unless live traffic is on (maps.routeTrafficAware). */
  normalDurationSec: number;
  /** Google encoded polyline; null when the route is a straight-line fallback. */
  polyline: string | null;
  source: 'google' | 'haversine';
};

/**
 * Route for a fare estimate. Never throws: if Google is disabled, down, or finds
 * no route, falls back to straight-line distance × routeFallbackRoadFactor so
 * booking keeps working. Called once per estimate; never during a live ride.
 */
export async function routeForEstimate(pickup: LatLng, drop: LatLng, serviceType: string): Promise<EstimateRoute> {
  const cfg = await getMapsConfig();
  const fallback = (): EstimateRoute => {
    usage.skip('routeFallback');
    const distanceM = Math.round(haversineM(pickup, drop) * cfg.routeFallbackRoadFactor);
    const durationSec = estimateDurationSec(distanceM);
    return { distanceM, durationSec, normalDurationSec: durationSec, polyline: null, source: 'haversine' };
  };
  if (!(await isMapsActive(cfg))) return fallback();

  const travelMode = cfg.routeTravelModeByService[serviceType as ServiceType] ?? 'DRIVE';
  const cacheKey = [
    round4(pickup.lat), round4(pickup.lng), round4(drop.lat), round4(drop.lng),
    travelMode, cfg.routeTrafficAware ? 't' : 'u',
  ].join(':');
  const hit = routeCache.get<EstimateRoute>(cacheKey);
  if (hit) {
    usage.cacheHit('computeRoutes');
    return hit;
  }
  try {
    const r = await google.computeRoute({
      origin: pickup,
      destination: drop,
      travelMode,
      trafficAware: cfg.routeTrafficAware,
      languageCode: cfg.languageCode,
      regionCode: cfg.regionCode,
      timeoutMs: cfg.timeoutMs,
    });
    if (!r) {
      log().warn({ op: 'computeRoutes', googleStatus: 'NO_ROUTE', travelMode }, 'no route; using fallback');
      return fallback();
    }
    const durationSec = Math.max(60, r.durationSec);
    const route: EstimateRoute = {
      distanceM: r.distanceM,
      durationSec,
      // Traffic can only add time to the normal trip, never make it cheaper than normal.
      normalDurationSec: r.staticDurationSec != null ? Math.min(durationSec, Math.max(60, r.staticDurationSec)) : durationSec,
      polyline: r.polyline,
      source: 'google',
    };
    routeCache.set(cacheKey, route, cfg.routeCacheTtlSec * 1000);
    return route;
  } catch (err) {
    wrapGoogle('computeRoutes', err); // logs status
    return fallback();
  }
}

/** Test helper. */
export function clearMapsCaches() {
  placeCache.clear();
  reverseCache.clear();
  routeCache.clear();
  cityCentreCache.clear();
}
