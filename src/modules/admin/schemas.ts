import { z } from 'zod';
import { checkPolygon } from '../zones/geo.js';

export const dateRangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const pageSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const cityUpsertSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
  enabled: z.boolean().default(true),
  timezone: z.string().default('Asia/Kolkata'),
  center: z.object({
    lng: z.number(),
    lat: z.number(),
  }),
  services: z.array(z.enum(['bike', 'auto', 'parcel', 'logistics'])).default([]),
});

export const zoneUpsertSchema = z
  .object({
    cityId: z.string().min(1),
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean().default(true),
    type: z.enum(['service', 'blocked']).default('service'),
    /** Empty = applies to all services. */
    services: z.array(z.enum(['bike', 'auto', 'parcel', 'logistics'])).max(4).default([]),
    district: z.string().trim().max(60).default(''),
    /** GeoJSON Polygon coordinates: [[[lng,lat], ...]] — one outer ring, open or closed. */
    coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))).min(1),
    /** Optimistic lock for edits: the version the editor loaded. */
    expectedVersion: z.number().int().positive().optional(),
  })
  .superRefine((v, ctx) => {
    const res = checkPolygon(v.coordinates);
    if (!res.ok) ctx.addIssue({ code: 'custom', path: ['coordinates'], message: res.message });
  });

export const servicePatchSchema = z.object({
  name: z.string().min(1).optional(),
  iconUrl: z.string().optional(),
  order: z.number().int().optional(),
  enabled: z.boolean().optional(),
  capacity: z.number().int().positive().optional(),
  maxWeightKg: z.number().nullable().optional(),
  minWeightKg: z.number().nullable().optional(),
});

export const fareUpsertSchema = z.object({
  cityId: z.string().min(1),
  serviceType: z.enum(['bike', 'auto', 'parcel', 'logistics']),
  baseFarePaise: z.number().int().nonnegative(),
  perKmPaise: z.number().int().nonnegative(),
  perMinutePaise: z.number().int().nonnegative(),
  minimumFarePaise: z.number().int().nonnegative(),
  nightMultiplier: z.number().positive().default(1),
  surgeMultiplier: z.number().positive().default(1),
  waitingPerMinutePaise: z.number().int().nonnegative().default(0),
  cancellationFeePaise: z.number().int().nonnegative().default(0),
  platformFeePaise: z.number().int().nonnegative().default(0),
});

export const farePreviewSchema = z.object({
  cityId: z.string().min(1),
  serviceType: z.enum(['bike', 'auto', 'parcel', 'logistics']),
  distanceM: z.number().nonnegative(),
  durationSec: z.number().nonnegative(),
  waitingSec: z.number().nonnegative().default(0),
  isNight: z.boolean().default(false),
  applySurge: z.boolean().default(true),
});

export const commissionUpsertSchema = z.object({
  cityId: z.string().min(1),
  serviceType: z.enum(['bike', 'auto', 'parcel', 'logistics', 'all']).default('all'),
  mode: z.enum(['percentage', 'fixed', 'subscription']),
  value: z.number().int().nonnegative(),
  subscriptionPeriod: z.enum(['day', 'week', 'month']).optional(),
  enabled: z.boolean().default(true),
});
