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
  enabled: z.boolean().default(false),
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
    default: {
      const _exhaustive: never = key;
      return _exhaustive;
    }
  }
}
