import { z } from 'zod';
import {
  APP_CONFIG_LIMITS as L,
  FLAG_KEY_RE,
  KYC_DOC_ID_RE,
  LANGUAGE_CODES,
  SERVICE_TYPES,
} from './configMeta.js';
import {
  APP_UPDATE_LIMITS,
  MAINTENANCE_MESSAGE_MAX,
  PHONE_RE,
  SOS_NUMBER_RE,
  SURGE_TABLE_LIMITS,
  ZONE_MESSAGE_DEFAULTS,
  ZONE_MESSAGE_MAX,
  isHttpsUrl,
  isStoreUrl,
} from './settingsCatalog.js';

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

const flagsSchema = z.record(z.string().regex(FLAG_KEY_RE, 'Invalid flag key'), z.boolean()).optional();
const languagesSchema = z
  .array(z.enum(LANGUAGE_CODES))
  .min(L.languages.min)
  .max(L.languages.max)
  .refine((a) => new Set(a).size === a.length, 'Duplicate language');

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
  languages: languagesSchema.default(['en', 'te']),
  home: z
    .object({
      tilesOrder: z
        .array(z.enum(SERVICE_TYPES))
        .min(L.tilesOrder.min)
        .refine((a) => new Set(a).size === a.length, 'Duplicate tile')
        .default(['bike', 'auto', 'parcel', 'logistics']),
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
  languages: languagesSchema.default(['en', 'te']),
  locationUpdateIntervalSec: z.number().int().min(L.locationUpdateIntervalSec.min).max(L.locationUpdateIntervalSec.max).default(4),
  locationDistanceFilterM: z.number().int().min(L.locationDistanceFilterM.min).max(L.locationDistanceFilterM.max).default(20),
  kycDocumentsByVehicle: z
    .partialRecord(
      z.enum(SERVICE_TYPES),
      z
        .array(
          z.object({
            id: z.string().regex(KYC_DOC_ID_RE, 'Lowercase id, letters/digits/_'),
            label: z.string().trim().min(1).max(L.kyc.labelMax),
            required: z.boolean(),
          }),
        )
        .max(L.kyc.maxDocsPerVehicle)
        .refine((a) => new Set(a.map((d) => d.id)).size === a.length, 'Duplicate document id'),
    )
    .default({}),
});

const platformUpdateSchema = z
  .object({
    minBuild: z.number().int().min(APP_UPDATE_LIMITS.build.min).max(APP_UPDATE_LIMITS.build.max),
    latestBuild: z.number().int().min(APP_UPDATE_LIMITS.build.min).max(APP_UPDATE_LIMITS.build.max),
    storeUrl: z
      .string()
      .trim()
      .max(2048)
      .refine((v) => v === '' || isStoreUrl(v), 'Must be a Google Play or App Store https:// link'),
  })
  .superRefine((v, ctx) => {
    if (v.latestBuild < v.minBuild) {
      ctx.addIssue({ code: 'custom', path: ['latestBuild'], message: 'Latest build cannot be below the minimum build' });
    }
    if (v.minBuild > 0 && !v.storeUrl) {
      ctx.addIssue({
        code: 'custom',
        path: ['storeUrl'],
        message: 'A store link is required when a minimum build is enforced',
      });
    }
  });

/** minBuild > 0 force-updates every older install; validated hard because a mistake locks users out. */
export const appUpdateValueSchema = z.object({
  customer: z.object({ android: platformUpdateSchema, ios: platformUpdateSchema }),
  pilot: z.object({ android: platformUpdateSchema, ios: platformUpdateSchema }),
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
  languageCode: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/).max(10).default('en'),
  regionCode: z.string().regex(/^[A-Z]{2}$/).default('IN'),
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

const zoneMessage = (key: keyof typeof ZONE_MESSAGE_DEFAULTS) =>
  z.string().trim().min(1).max(ZONE_MESSAGE_MAX).default(ZONE_MESSAGE_DEFAULTS[key]);

/** Geo-fencing rules. Zones themselves are a collection (admin Zones screen). Bounds mirror ZONES_FIELDS. */
export const zonesValueSchema = z.object({
  /** Master switch. Enforcement is also skipped while no enabled service zone exists (fresh install). */
  enforce: z.boolean().default(true),
  /** Drop must also be inside a service zone of the same city as the pickup. */
  requireDropInside: z.boolean().default(true),
  /** Pilots can go online only inside a service zone for their vehicle type. */
  pilotMustBeInside: z.boolean().default(true),
  /** Apps may draw zone outlines (GET /app/zones). */
  showOutlineOnMap: z.boolean().default(false),
  outOfAreaMessage: zoneMessage('outOfAreaMessage'),
  dropOutOfAreaMessage: zoneMessage('dropOutOfAreaMessage'),
  blockedMessage: zoneMessage('blockedMessage'),
  pilotOutOfAreaMessage: zoneMessage('pilotOutOfAreaMessage'),
});

/** H3 in-memory dispatch — tune with real data. Rollback via enabled:false → $geoNear path. Bounds mirror DISPATCH_FIELDS. */
export const dispatchValueSchema = z
  .object({
    enabled: z.boolean().default(true),
    h3Resolution: z.number().int().min(6).max(10).default(8),
    maxRingK: z.number().int().min(0).max(10).default(3),
    minCandidates: z.number().int().min(1).max(50).default(5),
    maxPickupDistanceM: z.number().int().min(200).max(20000).default(3000),
    offerTimeoutSec: z.number().int().min(5).max(60).default(15),
    batchSize: z.number().int().min(1).max(20).default(5),
    researchDelaySec: z.number().int().min(0).max(60).default(5),
    maxSearchSec: z.number().int().min(30).max(600).default(120),
    etaRefineTopN: z.number().int().min(0).max(20).default(0),
    locationTtlSec: z.number().int().min(5).max(300).default(30),
    sweepIntervalSec: z.number().int().min(1).max(120).default(10),
    persistIntervalSec: z.number().int().min(5).max(600).default(30),
    maxAccuracyM: z.number().int().min(5).max(500).default(50),
    maxSpeedMps: z.number().min(5).max(120).default(55),
    boostStepPaise: z.number().int().min(100).max(10000).default(1000),
    boostMaxPaise: z.number().int().min(0).max(50000).default(5000),
  })
  .refine((v) => v.offerTimeoutSec < v.maxSearchSec, {
    path: ['maxSearchSec'],
    message: 'Max search time must be longer than the offer timeout',
  });

/** Bounds mirror SURGE_FIELDS / SURGE_TABLE_LIMITS. */
export const surgeValueSchema = z
  .object({
    enabled: z.boolean().default(true),
    h3Resolution: z.number().int().min(5).max(9).default(7),
    windowMin: z.number().int().min(1).max(60).default(10),
    maxMultiplier: z.number().min(1).max(2).default(1.5),
    table: z
      .array(
        z.object({
          minRatio: z.number().min(SURGE_TABLE_LIMITS.minRatio.min).max(SURGE_TABLE_LIMITS.minRatio.max),
          multiplier: z.number().min(SURGE_TABLE_LIMITS.multiplier.min).max(SURGE_TABLE_LIMITS.multiplier.max),
        }),
      )
      .min(1)
      .max(SURGE_TABLE_LIMITS.maxRows)
      .default([
        { minRatio: 0, multiplier: 1 },
        { minRatio: 1.5, multiplier: 1.2 },
        { minRatio: 2.5, multiplier: 1.4 },
        { minRatio: 4, multiplier: 1.5 },
      ]),
  })
  .superRefine((v, ctx) => {
    const t = v.table;
    if (t[0] && t[0].minRatio !== 0) {
      ctx.addIssue({ code: 'custom', path: ['table', 0, 'minRatio'], message: 'First row must start at ratio 0' });
    }
    t.forEach((row, i) => {
      if (i > 0 && row.minRatio <= t[i - 1]!.minRatio) {
        ctx.addIssue({ code: 'custom', path: ['table', i, 'minRatio'], message: 'Ratios must be strictly increasing' });
      }
      if (i > 0 && row.multiplier < t[i - 1]!.multiplier) {
        ctx.addIssue({ code: 'custom', path: ['table', i, 'multiplier'], message: 'Multipliers must not decrease' });
      }
      if (row.multiplier > v.maxMultiplier) {
        ctx.addIssue({ code: 'custom', path: ['table', i, 'multiplier'], message: 'Exceeds the maximum multiplier' });
      }
    });
  });

/** Bounds mirror PILOT_QUALITY_FIELDS. */
export const pilotQualityValueSchema = z.object({
  minRatingToGoOnline: z.number().min(1).max(5).default(3.0),
  maxCancelRate7d: z.number().min(0).max(1).default(0.5),
  minTripsForCancelRate: z.number().int().min(1).max(100).default(5),
  autoSuspendEnabled: z.boolean().default(false),
});

const phoneOrEmpty = z
  .string()
  .trim()
  .refine((v) => v === '' || PHONE_RE.test(v), 'Digits only (7–15), optional leading +');
const httpsOrEmpty = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => v === '' || isHttpsUrl(v), 'Must be a valid https:// URL');

export const supportValueSchema = z.object({
  phone: phoneOrEmpty.default(''),
  whatsapp: phoneOrEmpty.default(''),
  sosNumbers: z
    .array(z.string().trim().regex(SOS_NUMBER_RE, 'Digits only (3–15), optional leading +'))
    .max(5)
    .refine((a) => new Set(a).size === a.length, 'Duplicate number')
    .default([]),
  termsUrl: httpsOrEmpty.default(''),
  privacyUrl: httpsOrEmpty.default(''),
});

export const maintenanceValueSchema = z
  .object({
    enabled: z.boolean().default(false),
    message: z.string().trim().max(MAINTENANCE_MESSAGE_MAX).optional(),
    /** Stored for compatibility; not enforced by the backend today. */
    allowAdmin: z.boolean().default(true),
  })
  .refine((v) => !v.enabled || Boolean(v.message), {
    path: ['message'],
    message: 'A message is required while maintenance is on',
  });

const promoHttpsUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' && !u.username && !u.password;
    } catch {
      return false;
    }
  }, 'Must be a valid https:// URL');

/** In-app route (`prila://rides`) or https link. Blocks javascript:, data:, http: and other schemes. */
const promoDeepLink = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => {
    if (/^prila:\/\/[a-z0-9][a-z0-9/_?=&.-]*$/i.test(v)) return true;
    try {
      const u = new URL(v);
      return u.protocol === 'https:' && !u.username && !u.password;
    } catch {
      return false;
    }
  }, 'Must be prila://<route> or an https:// URL');

const promoSlotSchema = z
  .object({
    enabled: z.boolean().default(false),
    campaignId: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'Lowercase letters, digits, - or _ (max 40)')
      .optional(),
    imageUrl: promoHttpsUrl.optional(),
    title: z.string().trim().min(1).max(60).optional(),
    body: z.string().trim().min(1).max(140).optional(),
    cta: z.string().trim().min(1).max(24).optional(),
    deepLink: promoDeepLink.optional(),
    frequency: z.enum(['every_open', 'daily', 'weekly', 'once']).default('once'),
    audience: z.enum(['all', 'new', 'city']).default('all'),
    cityIds: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
    startsAt: z.string().datetime({ offset: true }).optional(),
    endsAt: z.string().datetime({ offset: true }).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.enabled && !v.title && !v.imageUrl) {
      ctx.addIssue({ code: 'custom', path: ['title'], message: 'Enabled promo needs a title or an image' });
    }
    if (v.enabled && v.cta && !v.deepLink) {
      ctx.addIssue({ code: 'custom', path: ['deepLink'], message: 'A CTA button needs a link' });
    }
    if (v.enabled && v.frequency === 'once' && !v.campaignId) {
      ctx.addIssue({
        code: 'custom',
        path: ['campaignId'],
        message: 'Campaign ID is required so "once" can be tracked per user',
      });
    }
    if (v.audience === 'city' && !(v.cityIds && v.cityIds.length > 0)) {
      ctx.addIssue({ code: 'custom', path: ['cityIds'], message: 'Pick at least one city' });
    }
    if (v.startsAt && v.endsAt && Date.parse(v.endsAt) <= Date.parse(v.startsAt)) {
      ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'End must be after start' });
    }
  });

const promoSlotDefault = { enabled: false, frequency: 'once' as const, audience: 'all' as const };

export const homePromoValueSchema = z.object({
  customer: promoSlotSchema.default(promoSlotDefault),
  pilot: promoSlotSchema.default(promoSlotDefault),
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
