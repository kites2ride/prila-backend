/**
 * Field catalogs for the typed settings configs (dispatch, surge, maps, pilot_quality).
 * Served to the admin panel via GET /admin/config/:key/meta so labels, units, bounds,
 * options and risk badges are never hardcoded in the UI. The Zod schemas in schemas.ts
 * must stay in sync — `catalogMismatches` (see tests/settingsCatalog.test.ts) enforces it.
 */
import type { Risk } from './configMeta.js';

export type FieldSpec = {
  /** Dot path inside the config value, e.g. `routeTravelModeByService.bike`. */
  key: string;
  label: string;
  description: string;
  group: string;
  type: 'boolean' | 'int' | 'number' | 'text' | 'enum' | 'list';
  default: boolean | number | string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { value: string; label: string }[];
  maxLength?: number;
  /** text/list: regex source each value must match (empty text is allowed when `optional`). */
  pattern?: string;
  patternHint?: string;
  format?: 'https-url';
  optional?: boolean;
  multiline?: boolean;
  placeholder?: string;
  /** text: required (non-empty) while this boolean field is true. */
  requiredWhen?: string;
  /** list: max number of items. */
  maxItems?: number;
  risk?: Risk;
  /** Only read at server start — takes effect after a backend restart. */
  restart?: boolean;
};

export type TypedConfigKey = 'dispatch' | 'surge' | 'maps' | 'pilot_quality' | 'support' | 'maintenance' | 'zones';

type Extra = Partial<FieldSpec>;

const bool = (key: string, label: string, description: string, group: string, def: boolean, extra: Extra = {}): FieldSpec => ({
  key,
  label,
  description,
  group,
  type: 'boolean',
  default: def,
  ...extra,
});
const int = (
  key: string,
  label: string,
  description: string,
  group: string,
  def: number,
  min: number,
  max: number,
  unit?: string,
  extra: Extra = {},
): FieldSpec => ({ key, label, description, group, type: 'int', default: def, min, max, unit, ...extra });
const num = (
  key: string,
  label: string,
  description: string,
  group: string,
  def: number,
  min: number,
  max: number,
  step: number,
  unit?: string,
  extra: Extra = {},
): FieldSpec => ({ key, label, description, group, type: 'number', default: def, min, max, step, unit, ...extra });

export const DISPATCH_FIELDS: FieldSpec[] = [
  bool('enabled', 'H3 dispatch engine', 'ON = in-memory H3 matching. OFF = roll back to the legacy database search. Switching affects every live ride request.', 'Engine', true, { risk: 'matching' }),
  int('h3Resolution', 'H3 resolution', 'Hexagon size for pilot lookup. 8 is roughly 0.7 km² cells; higher = smaller cells.', 'Candidate search', 8, 6, 10, undefined, { risk: 'matching' }),
  int('maxRingK', 'Max search rings', 'How many neighbouring rings of cells to widen into when looking for pilots.', 'Candidate search', 3, 0, 10, 'rings', { risk: 'matching' }),
  int('minCandidates', 'Minimum candidates', 'Stop widening the search once this many idle pilots are found.', 'Candidate search', 5, 1, 50, 'pilots'),
  int('maxPickupDistanceM', 'Max pickup distance', 'Pilots further than this from the pickup are never offered the ride.', 'Candidate search', 3000, 200, 20000, 'm', { risk: 'matching' }),
  int('etaRefineTopN', 'ETA refinement (top N)', 'Re-rank the closest N pilots using road ETA (uses Maps calls). 0 = off.', 'Candidate search', 0, 0, 20, 'pilots', { risk: 'cost' }),
  int('offerTimeoutSec', 'Offer timeout', 'How long a pilot has to accept an offer.', 'Offers', 15, 5, 60, 's', { risk: 'matching' }),
  int('batchSize', 'Offer batch size', 'Pilots offered the ride at once. First to accept wins.', 'Offers', 5, 1, 20, 'pilots', { risk: 'matching' }),
  int('researchDelaySec', 'Re-search delay', 'Wait before searching again when nobody accepted.', 'Offers', 5, 0, 60, 's'),
  int('maxSearchSec', 'Max search time', 'Give up and tell the rider there are no pilots after this long. Must be longer than the offer timeout.', 'Offers', 120, 30, 600, 's', { risk: 'matching' }),
  int('locationTtlSec', 'Location freshness', 'A pilot whose last GPS fix is older than this is treated as offline.', 'Location handling', 30, 5, 300, 's', { risk: 'matching' }),
  int('sweepIntervalSec', 'Stale sweep interval', 'How often stale pilot locations are cleared.', 'Location handling', 10, 1, 120, 's', { restart: true }),
  int('persistIntervalSec', 'Location save interval', 'How often in-memory locations are saved to the database.', 'Location handling', 30, 5, 600, 's', { restart: true }),
  int('maxAccuracyM', 'Max GPS error', 'Location fixes less accurate than this are ignored.', 'Spoof protection', 50, 5, 500, 'm'),
  int('boostStepPaise', 'Fare boost step', 'While no pilot accepts, the rider can raise the fare in steps of this amount. 1000 = ₹10.', 'Fare boost', 1000, 100, 10000, 'paise'),
  int('boostMaxPaise', 'Max fare boost', 'The most a rider can add to the fare in total. The whole extra goes to the pilot (no commission). 5000 = ₹50. 0 turns the feature off.', 'Fare boost', 5000, 0, 50000, 'paise'),
  num('maxSpeedMps', 'Max plausible speed', 'Jumps faster than this are rejected as GPS spoofing. 55 m/s is about 200 km/h.', 'Spoof protection', 55, 5, 120, 1, 'm/s'),
];

export const SURGE_FIELDS: FieldSpec[] = [
  bool('enabled', 'Surge pricing', 'ON = the demand/supply ratio can raise the fare at estimate time. Keep OFF until tuned.', 'Engine', true, { risk: 'money' }),
  int('h3Resolution', 'H3 resolution', 'Hexagon size for the demand / supply heatmap.', 'Heatmap', 7, 5, 9, undefined, { risk: 'money' }),
  int('windowMin', 'Demand window', 'Demand = different riders asking within this window.', 'Heatmap', 10, 1, 60, 'min', { risk: 'money' }),
  num('maxMultiplier', 'Maximum multiplier', 'Hard cap on surge. No row in the table may exceed it.', 'Heatmap', 1.5, 1, 2, 0.05, '×', { risk: 'money' }),
];

export const SURGE_TABLE_LIMITS = {
  maxRows: 10,
  minRatio: { min: 0, max: 20 },
  multiplier: { min: 1, max: 2 },
} as const;

export const PILOT_QUALITY_FIELDS: FieldSpec[] = [
  num('minRatingToGoOnline', 'Minimum rating to go online', 'Pilots rated below this cannot go online.', 'Go-online gate', 3, 1, 5, 0.1, '★', { risk: 'pilots' }),
  num('maxCancelRate7d', 'Maximum 7-day cancel rate', 'Fraction of trips cancelled by the pilot (0.5 = 50%).', 'Go-online gate', 0.5, 0, 1, 0.05, undefined, { risk: 'pilots' }),
  int('minTripsForCancelRate', 'Minimum trips before cancel rate counts', 'Avoids penalising new pilots on a few trips.', 'Go-online gate', 5, 1, 100, 'trips'),
  bool('autoSuspendEnabled', 'Auto-suspend', 'Automatically suspend pilots who breach the limits. OFF = suspension is a manual admin action.', 'Enforcement', false, { risk: 'pilots' }),
];

const travelOptions = [
  { value: 'DRIVE', label: 'Car (Drive)' },
  { value: 'TWO_WHEELER', label: 'Two-wheeler' },
];
const travel = (svc: string, label: string, def: string): FieldSpec => ({
  key: `routeTravelModeByService.${svc}`,
  label: `${label} travel mode`,
  description: `Routing mode used for ${label} rides.`,
  group: 'Routing',
  type: 'enum',
  default: def,
  options: travelOptions,
});

export const MAPS_FIELDS: FieldSpec[] = [
  bool('enabled', 'Google Maps', 'Master switch. OFF = no Google calls: search and reverse-geocode are unavailable and estimates use straight-line distance.', 'Master switch', true, { risk: 'cost' }),
  int('autocompleteMinChars', 'Autocomplete min characters', 'Characters typed before a search is sent.', 'Search', 3, 1, 10, 'chars', { risk: 'cost' }),
  int('autocompleteDebounceMs', 'Autocomplete debounce', 'Typing pause before the app searches (client hint).', 'Search', 400, 150, 2000, 'ms', { risk: 'cost' }),
  int('localMinHitsToSkipGoogle', 'Local hits to skip Google', 'If this many ops landmarks match, Google is not called (free).', 'Search', 3, 0, 10, 'hits', { risk: 'cost' }),
  int('biasRadiusM', 'Search bias radius', 'Autocomplete favours results within this distance. Google allows up to 50 km.', 'Search', 20000, 1000, 50000, 'm'),
  { key: 'languageCode', label: 'Language code', description: 'Language of Google results, e.g. en or te.', group: 'Search', type: 'text', default: 'en', maxLength: 10 },
  { key: 'regionCode', label: 'Region code', description: 'Two-letter uppercase country code, e.g. IN.', group: 'Search', type: 'text', default: 'IN', maxLength: 2 },
  int('autocompleteRateLimitPerMin', 'Autocomplete rate limit', 'Requests per minute.', 'Rate limits', 30, 1, 600, '/min', { risk: 'cost' }),
  int('placeRateLimitPerMin', 'Place details rate limit', 'Requests per minute.', 'Rate limits', 20, 1, 600, '/min', { risk: 'cost' }),
  int('reverseRateLimitPerMin', 'Reverse geocode rate limit', 'Requests per minute.', 'Rate limits', 20, 1, 600, '/min', { risk: 'cost' }),
  bool('routeTrafficAware', 'Traffic-aware routes', 'Uses a pricier Google SKU. Keep OFF unless needed.', 'Routing', false, { risk: 'cost' }),
  travel('bike', 'Bike', 'TWO_WHEELER'),
  travel('auto', 'Auto', 'DRIVE'),
  travel('parcel', 'Parcel', 'TWO_WHEELER'),
  travel('logistics', 'Logistics', 'DRIVE'),
  num('routeFallbackRoadFactor', 'Fallback road factor', 'When Google is unavailable: straight-line distance × this. 1 = no uplift.', 'Routing', 1, 1, 2, 0.05, '×', { risk: 'money' }),
  int('timeoutMs', 'Google request timeout', 'Give up on a Google call after this long.', 'Routing', 4000, 1000, 15000, 'ms'),
  int('routeCacheTtlSec', 'Route cache', 'Same pickup and drop reuse a route for this long (saves calls).', 'Caching', 900, 0, 86400, 's', { risk: 'cost' }),
  int('reverseCacheTtlSec', 'Reverse-geocode cache', 'Google terms allow caching lat/lng for at most 30 days.', 'Caching', 86400, 0, 30 * 86400, 's', { risk: 'cost' }),
  int('placeCacheTtlSec', 'Place details cache', 'Google terms allow caching lat/lng for at most 30 days.', 'Caching', 86400, 0, 30 * 86400, 's', { risk: 'cost' }),
];

/* ───────────── support / maintenance / app_update ───────────── */

/** Shared patterns: the Zod schemas and the admin form use the same source. */
export const PHONE_RE = /^\+?[0-9]{7,15}$/;
export const SOS_NUMBER_RE = /^\+?[0-9]{3,15}$/;
export const STORE_HOSTS = ['play.google.com', 'apps.apple.com', 'itunes.apple.com'] as const;

export function isHttpsUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
}

export function isStoreUrl(v: string): boolean {
  if (!isHttpsUrl(v)) return false;
  return (STORE_HOSTS as readonly string[]).includes(new URL(v).hostname);
}

const text = (
  key: string,
  label: string,
  description: string,
  group: string,
  maxLength: number,
  extra: Extra = {},
): FieldSpec => ({ key, label, description, group, type: 'text', default: '', maxLength, optional: true, ...extra });

export const SUPPORT_FIELDS: FieldSpec[] = [
  text('phone', 'Support phone', 'Number riders and pilots can call. Digits only, optional leading +, with country code (e.g. +919876543210).', 'Contact', 16, {
    pattern: PHONE_RE.source,
    patternHint: 'Digits only, 7–15, optional leading +',
    placeholder: '+919876543210',
  }),
  text('whatsapp', 'WhatsApp number', 'Number used for the WhatsApp support link. Same format as the phone.', 'Contact', 16, {
    pattern: PHONE_RE.source,
    patternHint: 'Digits only, 7–15, optional leading +',
    placeholder: '+919876543210',
  }),
  {
    key: 'sosNumbers',
    label: 'Emergency (SOS) numbers',
    description: 'Numbers shown on the SOS screen, in order. 112 is the national emergency number.',
    group: 'Safety',
    type: 'list',
    default: '[]',
    maxItems: 5,
    maxLength: 16,
    pattern: SOS_NUMBER_RE.source,
    patternHint: 'Digits only, 3–15, optional leading +',
    placeholder: '112',
    risk: 'users',
  },
  text('termsUrl', 'Terms & conditions URL', 'Opened from the apps. Must be an https:// link. Leave empty to hide.', 'Legal', 2048, {
    format: 'https-url',
    patternHint: 'Must be a valid https:// URL',
    placeholder: 'https://prila.in/terms',
  }),
  text('privacyUrl', 'Privacy policy URL', 'Opened from the apps. Must be an https:// link. Leave empty to hide.', 'Legal', 2048, {
    format: 'https-url',
    patternHint: 'Must be a valid https:// URL',
    placeholder: 'https://prila.in/privacy',
  }),
];

export const MAINTENANCE_MESSAGE_MAX = 200;

export const MAINTENANCE_FIELDS: FieldSpec[] = [
  bool(
    'enabled',
    'Maintenance mode',
    'ON = customer and pilot apps show the message below and block use until it is turned off.',
    'Status',
    false,
    { risk: 'users' },
  ),
  text('message', 'Message shown to users', 'Required while maintenance is on. Keep it short and say when to come back.', 'Status', MAINTENANCE_MESSAGE_MAX, {
    multiline: true,
    requiredWhen: 'enabled',
    placeholder: 'We are upgrading Prila. Back by 6 AM.',
  }),
];

export const APP_UPDATE_LIMITS = {
  build: { min: 0, max: 10_000_000 },
  storeHosts: STORE_HOSTS,
} as const;

/* ───────────── zone rules ───────────── */

export const ZONE_MESSAGE_MAX = 240;
export const ZONE_MESSAGE_DEFAULTS = {
  outOfAreaMessage: "We're not in your area yet. Prila is live in Warangal, Hanamkonda and Kazipet — more places soon!",
  dropOutOfAreaMessage: "We can't drop you there yet. Please choose a drop inside our service area.",
  blockedMessage: "Pickups aren't allowed at this spot. Please move a little and try again.",
  pilotOutOfAreaMessage: "You're outside the Prila service area. Move inside a service zone to go online.",
} as const;

const msg = (key: keyof typeof ZONE_MESSAGE_DEFAULTS, label: string, description: string): FieldSpec => ({
  key,
  label,
  description,
  group: 'Messages',
  type: 'text',
  default: ZONE_MESSAGE_DEFAULTS[key],
  maxLength: ZONE_MESSAGE_MAX,
  multiline: true,
});

export const ZONES_FIELDS: FieldSpec[] = [
  bool('enforce', 'Enforce service area', 'Master switch. Rides can only be booked inside a service zone. Skipped automatically until at least one enabled service zone exists (fresh install).', 'Enforcement', true, { risk: 'matching' }),
  bool('requireDropInside', 'Drop must be inside too', 'The drop must also be inside a service zone of the same city as the pickup.', 'Enforcement', true, { risk: 'matching' }),
  bool('pilotMustBeInside', 'Pilots must be inside to go online', 'Pilots can go online only inside a service zone for their vehicle type.', 'Enforcement', true, { risk: 'pilots' }),
  bool('showOutlineOnMap', 'Show zone outline in apps', 'Apps draw the service area outline on the map. Zones themselves are drawn on the Zones page.', 'Display', false),
  msg('outOfAreaMessage', 'Pickup outside service area', 'Shown to a rider whose pickup is outside the service area.'),
  msg('dropOutOfAreaMessage', 'Drop outside service area', 'Shown to a rider who picks a drop outside the service area.'),
  msg('blockedMessage', 'Blocked pickup spot', 'Shown when the pickup is inside a blocked zone (airport gate, restricted area, etc.).'),
  msg('pilotOutOfAreaMessage', 'Pilot outside service area', 'Shown to a pilot who tries to go online outside a service zone.'),
];

export const TYPED_CONFIG_FIELDS: Record<TypedConfigKey, FieldSpec[]> = {
  dispatch: DISPATCH_FIELDS,
  surge: SURGE_FIELDS,
  maps: MAPS_FIELDS,
  pilot_quality: PILOT_QUALITY_FIELDS,
  support: SUPPORT_FIELDS,
  maintenance: MAINTENANCE_FIELDS,
  zones: ZONES_FIELDS,
};

export function typedConfigMeta(key: TypedConfigKey | 'app_update') {
  if (key === 'app_update') return { appUpdate: APP_UPDATE_LIMITS };
  return {
    fields: TYPED_CONFIG_FIELDS[key],
    ...(key === 'surge' ? { surgeTable: SURGE_TABLE_LIMITS } : {}),
  };
}

/** Returns mismatches between a catalog and its Zod schema (empty array = in sync). */
export function catalogMismatches(
  fields: FieldSpec[],
  parse: (v: unknown) => { success: boolean },
  /** A valid starting value, for schemas with cross-field rules or required nested objects. */
  base: Record<string, unknown> = {},
): string[] {
  const out: string[] = [];
  const withPath = (path: string, v: unknown) => {
    const root = structuredClone(base);
    const parts = path.split('.');
    let cur = root;
    for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {}) as Record<string, unknown>;
    cur[parts[parts.length - 1]!] = v;
    return root;
  };
  const ok = (path: string, v: unknown) => parse(withPath(path, v)).success;
  if (!parse(base).success) out.push('base value must parse');
  for (const f of fields) {
    const dflt = f.type === 'list' ? JSON.parse(String(f.default)) : f.default;
    if (!ok(f.key, dflt)) out.push(`${f.key}: default rejected`);
    if (f.type === 'int' || f.type === 'number') {
      if (!ok(f.key, f.min)) out.push(`${f.key}: min ${f.min} rejected`);
      if (!ok(f.key, f.max)) out.push(`${f.key}: max ${f.max} rejected`);
      const below = f.type === 'int' ? f.min! - 1 : f.min! - f.step! / 2;
      const above = f.type === 'int' ? f.max! + 1 : f.max! + f.step! / 2;
      if (ok(f.key, below)) out.push(`${f.key}: below-min accepted`);
      if (ok(f.key, above)) out.push(`${f.key}: above-max accepted`);
      if (f.type === 'int' && ok(f.key, (f.default as number) + 0.5)) out.push(`${f.key}: fraction accepted`);
    }
    if (f.type === 'boolean' && ok(f.key, 'yes')) out.push(`${f.key}: non-boolean accepted`);
    if (f.type === 'enum') {
      for (const o of f.options ?? []) if (!ok(f.key, o.value)) out.push(`${f.key}: option ${o.value} rejected`);
      if (ok(f.key, '__bad__')) out.push(`${f.key}: bad option accepted`);
    }
    if (f.type === 'text' && ok(f.key, 'x'.repeat((f.maxLength ?? 10) + 5))) out.push(`${f.key}: over-length accepted`);
    if (f.type === 'list' && f.maxItems && ok(f.key, Array.from({ length: f.maxItems + 1 }, (_, i) => String(100 + i)))) out.push(`${f.key}: too many items accepted`);
  }
  return out;
}

/** Valid base values for schemas whose rules span several fields. */
export const CATALOG_BASES: Partial<Record<TypedConfigKey, Record<string, unknown>>> = {
  surge: { table: [{ minRatio: 0, multiplier: 1 }] },
  maps: { routeTravelModeByService: { bike: 'TWO_WHEELER', auto: 'DRIVE', parcel: 'TWO_WHEELER', logistics: 'DRIVE' } },
};
