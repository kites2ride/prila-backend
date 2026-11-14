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
    'suggestions.placePrediction.structuredFormat.secondaryText.text',
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

export type Suggestion = { placeId: string; mainText: string; secondaryText: string };

export async function autocomplete(input: {
  q: string;
  sessionToken: string;
  bias: LatLng;
  biasRadiusM: number;
  languageCode: string;
  regionCode: string;
  timeoutMs: number;
}): Promise<Suggestion[]> {
  const body = {
    input: input.q,
    sessionToken: input.sessionToken,
    languageCode: input.languageCode,
    regionCode: input.regionCode.toLowerCase(),
    includedRegionCodes: [input.regionCode.toLowerCase()],
    locationBias: {
      circle: {
        center: { latitude: input.bias.lat, longitude: input.bias.lng },
        radius: input.biasRadiusM,
      },
    },
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
  const best = (json?.results ?? []).find(
    (r) => r.formatted_address && !(r.types ?? []).includes('plus_code'),
  );
  return best?.formatted_address ?? null;
}

export type TravelMode = 'DRIVE' | 'TWO_WHEELER';
export type RouteResult = { distanceM: number; durationSec: number; polyline: string | null };

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
    { method: 'POST', headers: headers(FIELD_MASKS.computeRoutes), body: JSON.stringify(body) },
    input.timeoutMs,
  )) as {
    routes?: Array<{ distanceMeters?: number; duration?: string; polyline?: { encodedPolyline?: string } }>;
  } | null;

  const r = json?.routes?.[0];
  if (!r) return null;
  // proto3 JSON omits zero values: same/very close points give no distanceMeters.
  const durationSec = Number.parseInt((r.duration ?? '0s').replace(/s$/, ''), 10);
  return {
    distanceM: Math.max(0, Math.round(r.distanceMeters ?? 0)),
    durationSec: Number.isFinite(durationSec) ? Math.max(0, durationSec) : 0,
    polyline: r.polyline?.encodedPolyline ?? null,
  };
}
