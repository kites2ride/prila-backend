/**
 * Thin Google client (Places API New, Routes API, Geocoding API).
 *
 * Rules:
 *  - Every Places / Routes call sends an X-Goog-FieldMask (we pay only for what we read).
 *  - The key goes in the X-Goog-Api-Key header. Geocoding only accepts `key=` in the
 *    query string, so that URL is never logged or put into errors.
 *  - Errors expose the Google status code only (GoogleError.status), never bodies/URLs.
 */
import { googleKey } from './config.js';
import { usage, type MapsOp } from './usage.js';

const PLACES = 'https://places.googleapis.com/v1';
const ROUTES = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const GEOCODE = 'https://maps.googleapis.com/maps/api/geocode/json';

export const FIELD_MASKS = {
  autocomplete:
    'suggestions.placePrediction.placeId,' +
    'suggestions.placePrediction.structuredFormat.mainText.text,' +
    'suggestions.placePrediction.structuredFormat.secondaryText.text,' +
    'suggestions.placePrediction.distanceMeters',
  // Essentials SKU only. displayName (Pro SKU) is skipped on purpose: the app already
  // has the place name from the autocomplete suggestion's mainText.
  placeDetails: 'location,formattedAddress',
  computeRoutes: 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
} as const;

export class GoogleError extends Error {
  constructor(
    readonly op: MapsOp,
    /** Google status (e.g. PERMISSION_DENIED, OVER_QUERY_LIMIT) or TIMEOUT / NETWORK / HTTP_<n>. */
    readonly status: string,
    readonly httpStatus = 0,
  ) {
    super(`google ${op} failed: ${status}`);
    this.name = 'GoogleError';
  }
}

type LatLng = { lat: number; lng: number };

async function call(op: MapsOp, url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  usage.google(op);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    usage.error(op);
    const name = err instanceof Error ? err.name : '';
    throw new GoogleError(op, name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'NETWORK');
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    usage.error(op);
    const status =
      (body as { error?: { status?: string } } | null)?.error?.status ?? `HTTP_${res.status}`;
    throw new GoogleError(op, status, res.status);
  }
  return body;
}

function headers(fieldMask: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Goog-Api-Key': googleKey(),
    'X-Goog-FieldMask': fieldMask,
  };
}

export type Suggestion = { placeId: string; mainText: string; secondaryText: string; distanceM?: number };

export async function autocomplete(input: {
  q: string;
  sessionToken: string;
  bias: LatLng;
  biasRadiusM: number;
  /** true = hard-limit results to the circle (locationRestriction); false = soft locationBias. */
  restrict?: boolean;
  languageCode: string;
  regionCode: string;
  timeoutMs: number;
}): Promise<Suggestion[]> {
  const circle = {
    circle: {
      center: { latitude: input.bias.lat, longitude: input.bias.lng },
      radius: input.biasRadiusM,
    },
  };
  const body = {
    input: input.q,
    sessionToken: input.sessionToken,
    languageCode: input.languageCode,
    regionCode: input.regionCode.toLowerCase(),
    includedRegionCodes: [input.regionCode.toLowerCase()],
    // origin makes Google return distanceMeters so we can sort nearest-first.
    origin: { latitude: input.bias.lat, longitude: input.bias.lng },
    ...(input.restrict ? { locationRestriction: circle } : { locationBias: circle }),
  };
  const json = (await call(
    'autocomplete',
    `${PLACES}/places:autocomplete`,
    { method: 'POST', headers: headers(FIELD_MASKS.autocomplete), body: JSON.stringify(body) },
    input.timeoutMs,
  )) as {
    suggestions?: Array<{
      placePrediction?: {
        placeId?: string;
        distanceMeters?: number;
        structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
      };
    }>;
  } | null;

  const out: Suggestion[] = [];
  for (const s of json?.suggestions ?? []) {
    const p = s.placePrediction;
    if (!p?.placeId) continue; // query predictions are not requested; skip anything partial
    out.push({
      placeId: p.placeId,
      mainText: p.structuredFormat?.mainText?.text ?? '',
      secondaryText: p.structuredFormat?.secondaryText?.text ?? '',
      distanceM: typeof p.distanceMeters === 'number' ? p.distanceMeters : undefined,
    });
  }
  return out;
}

export type PlaceDetails = { placeId: string; lat: number; lng: number; address: string };

/** placeId must already be validated (charset) by the caller — it goes into the URL path. */
export async function placeDetails(input: {
  placeId: string;
  sessionToken?: string;
  languageCode: string;
  regionCode: string;
  timeoutMs: number;
}): Promise<PlaceDetails | null> {
  const qs = new URLSearchParams({ languageCode: input.languageCode, regionCode: input.regionCode.toLowerCase() });
  if (input.sessionToken) qs.set('sessionToken', input.sessionToken);
  let json: { location?: { latitude?: number; longitude?: number }; formattedAddress?: string } | null;
  try {
    json = (await call(
      'placeDetails',
      `${PLACES}/places/${encodeURIComponent(input.placeId)}?${qs.toString()}`,
      { method: 'GET', headers: headers(FIELD_MASKS.placeDetails) },
      input.timeoutMs,
    )) as typeof json;
  } catch (err) {
    // Unknown / stale place id is a client problem, not an outage.
    if (err instanceof GoogleError && (err.status === 'NOT_FOUND' || err.status === 'INVALID_ARGUMENT')) {
      return null;
    }
    throw err;
  }
  const lat = json?.location?.latitude;
  const lng = json?.location?.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  return { placeId: input.placeId, lat, lng, address: json?.formattedAddress ?? '' };
}

/** @returns best human address, or null when Google has nothing for this point. */
export async function reverseGeocode(input: {
  lat: number;
  lng: number;
  languageCode: string;
  timeoutMs: number;
}): Promise<string | null> {
  const qs = new URLSearchParams({
    latlng: `${input.lat},${input.lng}`,
    language: input.languageCode,
    key: googleKey(),
  });
  // Geocoding has no field mask; it is a flat per-request price.
  const json = (await call('reverseGeocode', `${GEOCODE}?${qs.toString()}`, { method: 'GET' }, input.timeoutMs)) as {
    status?: string;
    results?: Array<{ formatted_address?: string; types?: string[] }>;
  } | null;

  const status = json?.status ?? 'UNKNOWN_ERROR';
  if (status === 'ZERO_RESULTS') return null;
  if (status !== 'OK') {
    usage.error('reverseGeocode');
    throw new GoogleError('reverseGeocode', status);
  }
  // Skip plus-code-only results ("XQ9+2V Hanamkonda") — not useful to riders.
  // Address results can also START with a plus code ("692V+94P, Main Rd, Huzurabad…") when the spot has
  // no street number; strip it, and skip results that are nothing but a code.
  for (const r of json?.results ?? []) {
    if (!r.formatted_address || (r.types ?? []).includes('plus_code')) continue;
    const cleaned = stripLeadingPlusCode(r.formatted_address);
    if (cleaned) return cleaned;
  }
  return null;
}

const LEADING_PLUS_CODE = /^[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}\s*(?:,\s*|\s+|$)/i;

/** "6C29+C67, Ranganayakula Gutta Rd, Karimnagar" → "Ranganayakula Gutta Rd, Karimnagar"; code-only → "". */
export function stripLeadingPlusCode(address: string): string {
  return address.trim().replace(LEADING_PLUS_CODE, '').trim();
}

export type TravelMode = 'DRIVE' | 'TWO_WHEELER';
export type RouteResult = {
  distanceM: number;
  /** With live traffic when trafficAware, else typical time. */
  durationSec: number;
  /** Time without traffic (only returned when trafficAware). */
  staticDurationSec: number | null;
  polyline: string | null;
};

/** @returns null when Google finds no route between the points. */
export async function computeRoute(input: {
  origin: LatLng;
  destination: LatLng;
  travelMode: TravelMode;
  trafficAware: boolean;
  languageCode: string;
  regionCode: string;
  timeoutMs: number;
}): Promise<RouteResult | null> {
  const wp = (p: LatLng) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
  const body = {
    origin: wp(input.origin),
    destination: wp(input.destination),
    travelMode: input.travelMode,
    routingPreference: input.trafficAware ? 'TRAFFIC_AWARE' : 'TRAFFIC_UNAWARE',
    computeAlternativeRoutes: false,
    units: 'METRIC',
    languageCode: input.languageCode,
    regionCode: input.regionCode.toLowerCase(),
  };
  const json = (await call(
    'computeRoutes',
    ROUTES,
    {
      method: 'POST',
      // staticDuration only when traffic-aware (that call is already on the pricier SKU).
      headers: headers(input.trafficAware ? `${FIELD_MASKS.computeRoutes},routes.staticDuration` : FIELD_MASKS.computeRoutes),
      body: JSON.stringify(body),
    },
    input.timeoutMs,
  )) as {
    routes?: Array<{ distanceMeters?: number; duration?: string; staticDuration?: string; polyline?: { encodedPolyline?: string } }>;
  } | null;

  const r = json?.routes?.[0];
  if (!r) return null;
  // proto3 JSON omits zero values: same/very close points give no distanceMeters.
  const secs = (v?: string) => {
    const n = Number.parseInt((v ?? '0s').replace(/s$/, ''), 10);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  };
  return {
    distanceM: Math.max(0, Math.round(r.distanceMeters ?? 0)),
    durationSec: secs(r.duration),
    staticDurationSec: r.staticDuration ? secs(r.staticDuration) : null,
    polyline: r.polyline?.encodedPolyline ?? null,
  };
}
