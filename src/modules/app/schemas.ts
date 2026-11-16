import { z } from 'zod';

export const bootstrapQuerySchema = z.object({
  app: z.enum(['customer', 'pilot']),
  platform: z.enum(['android', 'ios', 'web']).default('android'),
  build: z.coerce.number().int().nonnegative().default(0),
  lat: z.coerce.number().optional(),
  lng: z.coerce.number().optional(),
});

export const configKeySchema = z.enum([
  'app_config_customer',
  'app_config_pilot',
  'app_update',
  'home_promo',
  'matching',
  'dispatch',
  'surge',
  'pilot_quality',
  'support',
  'maintenance',
  'maps',
  'zones',
]);

export const patchConfigSchema = z.object({
  value: z.unknown(),
});

const flagsSchema = z.record(z.string(), z.boolean()).optional();

export const appConfigCustomerValueSchema = z.object({
  flags: flagsSchema.default({
    wallet: false,
    parcel: true,
    logistics: true,
    online_payments: false,
    upi: false,
    coupons: false,
    student_coupon: false,
    prila_shakti: false,
    prila_shakti_strict: true,
    referrals: false,
    scheduled_rides: false,
    chat: false,
  }),
  languages: z.array(z.string()).default(['en', 'te']),
  home: z
    .object({
      tilesOrder: z.array(z.string()).default(['bike', 'auto', 'parcel', 'logistics']),
      recentPlacesEnabled: z.boolean().default(true),
      promoSectionEnabled: z.boolean().default(true),
    })
    .default({
      tilesOrder: ['bike', 'auto', 'parcel', 'logistics'],
      recentPlacesEnabled: true,
      promoSectionEnabled: true,
    }),
});

export const appConfigPilotValueSchema = z.object({
  flags: flagsSchema.default({ wallet: true, chat: false }),
  languages: z.array(z.string()).default(['en', 'te']),
  locationUpdateIntervalSec: z.number().int().positive().default(4),
  locationDistanceFilterM: z.number().int().nonnegative().default(20),
  kycDocumentsByVehicle: z
    .record(z.string(), z.array(z.object({ id: z.string(), label: z.string(), required: z.boolean() })))
    .default({}),
});

export const appUpdateValueSchema = z.object({
  customer: z.object({
    android: z.object({ minBuild: z.number(), latestBuild: z.number(), storeUrl: z.string() }),
    ios: z.object({ minBuild: z.number(), latestBuild: z.number(), storeUrl: z.string() }),
  }),
  pilot: z.object({
    android: z.object({ minBuild: z.number(), latestBuild: z.number(), storeUrl: z.string() }),
    ios: z.object({ minBuild: z.number(), latestBuild: z.number(), storeUrl: z.string() }),
  }),
});

export const matchingValueSchema = z.object({
  searchRadiusM: z.number().int().positive().default(3000),
  batchSize: z.number().int().positive().default(5),
  acceptTimeoutSec: z.number().int().positive().default(15),
  retries: z.number().int().nonnegative().default(3),
  maxSearchTimeSec: z.number().int().positive().default(120),
  quoteTtlSec: z.number().int().positive().default(120),
});

const travelMode = z.enum(['DRIVE', 'TWO_WHEELER']);

/**
 * Google Maps cost controls (server-side only). Defaults are the cheapest safe
 * settings. Places/Geocoding ToS allow caching lat/lng for at most 30 days.
 */
export const mapsValueSchema = z.object({
  /** Master switch. false = no Google calls: autocomplete/place/reverse return MAPS_UNAVAILABLE, estimate uses haversine. */
  enabled: z.boolean().default(true),
  autocompleteMinChars: z.number().int().min(1).max(10).default(3),
  autocompleteRateLimitPerMin: z.number().int().min(1).max(600).default(30),
  placeRateLimitPerMin: z.number().int().min(1).max(600).default(20),
  reverseRateLimitPerMin: z.number().int().min(1).max(600).default(20),
  /** Client debounce hint (ms) — apps read it from bootstrap. */
  autocompleteDebounceMs: z.number().int().min(150).max(2000).default(400),
  /** Ops landmarks are searched first (free). This many local hits → Google is not called at all. */
  localMinHitsToSkipGoogle: z.number().int().min(0).max(10).default(3),
  languageCode: z.string().min(2).max(10).default('en'),
  regionCode: z.string().length(2).default('IN'),
  /** Autocomplete bias circle radius around user location (or city centre). Max allowed by Google: 50 km. */
  biasRadiusM: z.number().int().min(1000).max(50_000).default(20_000),
  timeoutMs: z.number().int().min(1000).max(15_000).default(4000),
  /** TRAFFIC_AWARE moves Compute Routes to a pricier SKU — keep false until needed. */
  routeTrafficAware: z.boolean().default(false),
  routeTravelModeByService: z
    .object({ bike: travelMode, auto: travelMode, parcel: travelMode, logistics: travelMode })
    .default({ bike: 'TWO_WHEELER', auto: 'DRIVE', parcel: 'TWO_WHEELER', logistics: 'DRIVE' }),
  /** Same pickup/drop (~11 m grid) + mode reuses the route: refresh / service switch cost 0 calls. */
  routeCacheTtlSec: z.number().int().min(0).max(86_400).default(900),
  /** When Google is down/disabled: use straight-line distance × this factor (1 = legacy behaviour). */
  routeFallbackRoadFactor: z.number().min(1).max(2).default(1),
  reverseCacheTtlSec: z.number().int().min(0).max(30 * 86_400).default(86_400),
  placeCacheTtlSec: z.number().int().min(0).max(30 * 86_400).default(86_400),
});

/** Geo-fencing rules. Zones themselves are a collection (admin Zones screen). */
export const zonesValueSchema = z.object({
  /** Master switch. Enforcement is also skipped while no enabled service zone exists (fresh install). */
  enforce: z.boolean().default(true),
  /** Drop must also be inside a service zone of the same city as the pickup. */
  requireDropInside: z.boolean().default(true),
  /** Pilots can go online only inside a service zone for their vehicle type. */
  pilotMustBeInside: z.boolean().default(true),
  /** Apps may draw zone outlines (GET /app/zones). */
  showOutlineOnMap: z.boolean().default(false),
  outOfAreaMessage: z
    .string()
    .min(1)
    .max(240)
    .default("We're not in your area yet. Prila is live in Warangal, Hanamkonda and Kazipet — more places soon!"),
  dropOutOfAreaMessage: z
    .string()
    .min(1)
    .max(240)
    .default("We can't drop you there yet. Please choose a drop inside our service area."),
  blockedMessage: z
    .string()
    .min(1)
    .max(240)
    .default("Pickups aren't allowed at this spot. Please move a little and try again."),
  pilotOutOfAreaMessage: z
    .string()
    .min(1)
    .max(240)
    .default("You're outside the Prila service area. Move inside a service zone to go online."),
});

/** H3 in-memory dispatch — tune with real data. Rollback via enabled:false → $geoNear path. */
export const dispatchValueSchema = z.object({
  enabled: z.boolean().default(true),
  h3Resolution: z.number().int().min(0).max(15).default(8),
  maxRingK: z.number().int().nonnegative().default(3),
  minCandidates: z.number().int().positive().default(5),
  maxPickupDistanceM: z.number().int().positive().default(3000),
  offerTimeoutSec: z.number().int().positive().default(15),
  batchSize: z.number().int().positive().default(5),
  researchDelaySec: z.number().int().nonnegative().default(5),
  maxSearchSec: z.number().int().positive().default(120),
  etaRefineTopN: z.number().int().nonnegative().default(0),
  locationTtlSec: z.number().int().positive().default(30),
  sweepIntervalSec: z.number().int().positive().default(10),
  persistIntervalSec: z.number().int().positive().default(30),
  maxAccuracyM: z.number().int().positive().default(50),
  maxSpeedMps: z.number().positive().default(55),
});

export const surgeValueSchema = z.object({
  enabled: z.boolean().default(true),
  h3Resolution: z.number().int().min(0).max(15).default(7),
  windowMin: z.number().int().positive().default(10),
  maxMultiplier: z.number().positive().default(1.5),
  table: z
    .array(z.object({ minRatio: z.number().nonnegative(), multiplier: z.number().positive() }))
    .default([
      { minRatio: 0, multiplier: 1 },
      { minRatio: 1.5, multiplier: 1.2 },
      { minRatio: 2.5, multiplier: 1.4 },
      { minRatio: 4, multiplier: 1.5 },
    ]),
});

export const pilotQualityValueSchema = z.object({
  minRatingToGoOnline: z.number().min(1).max(5).default(3.0),
  maxCancelRate7d: z.number().min(0).max(1).default(0.5),
  minTripsForCancelRate: z.number().int().positive().default(5),
  autoSuspendEnabled: z.boolean().default(false),
});

export const supportValueSchema = z.object({
  phone: z.string().default(''),
  whatsapp: z.string().default(''),
  sosNumbers: z.array(z.string()).default([]),
  termsUrl: z.string().default(''),
  privacyUrl: z.string().default(''),
});

export const maintenanceValueSchema = z.object({
  enabled: z.boolean().default(false),
  message: z.string().optional(),
  allowAdmin: z.boolean().default(true),
});

export const homePromoValueSchema = z.object({
  customer: z
    .object({
      enabled: z.boolean().default(false),
      campaignId: z.string().optional(),
      imageUrl: z.string().optional(),
      title: z.string().optional(),
      cta: z.string().optional(),
      frequency: z.enum(['every_open', 'daily', 'weekly', 'once']).default('once'),
      audience: z.enum(['all', 'new', 'city']).default('all'),
    })
    .default({ enabled: false, frequency: 'once', audience: 'all' }),
  pilot: z
    .object({
      enabled: z.boolean().default(false),
      campaignId: z.string().optional(),
      imageUrl: z.string().optional(),
      title: z.string().optional(),
      cta: z.string().optional(),
      frequency: z.enum(['every_open', 'daily', 'weekly', 'once']).default('once'),
      audience: z.enum(['all', 'new', 'city']).default('all'),
    })
    .default({ enabled: false, frequency: 'once', audience: 'all' }),
});

export function validateConfigValue(key: z.infer<typeof configKeySchema>, value: unknown) {
  switch (key) {
    case 'app_config_customer':
      return appConfigCustomerValueSchema.parse(value);
    case 'app_config_pilot':
      return appConfigPilotValueSchema.parse(value);
    case 'app_update':
      return appUpdateValueSchema.parse(value);
    case 'home_promo':
      return homePromoValueSchema.parse(value);
    case 'matching':
      return matchingValueSchema.parse(value);
    case 'dispatch':
      return dispatchValueSchema.parse(value);
    case 'surge':
      return surgeValueSchema.parse(value);
    case 'pilot_quality':
      return pilotQualityValueSchema.parse(value);
    case 'support':
      return supportValueSchema.parse(value);
    case 'maintenance':
      return maintenanceValueSchema.parse(value);
    case 'maps':
      return mapsValueSchema.parse(value);
    case 'zones':
      return zonesValueSchema.parse(value);
    default: {
      const _exhaustive: never = key;
      return _exhaustive;
    }
  }
}
