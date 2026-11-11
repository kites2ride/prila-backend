import { z } from 'zod';

const latLng = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  name: z.string().optional(),
  address: z.string().optional(),
});

export const estimateSchema = z.object({
  serviceType: z.enum(['bike', 'auto', 'parcel', 'logistics']),
  pickup: latLng,
  drop: latLng,
  cityId: z.string().optional(),
  couponCode: z.string().optional(),
  shakti: z.boolean().optional(),
  paymentMethod: z.enum(['cash', 'upi']).default('cash'),
});

export const bookSchema = z.object({
  quoteId: z.string().min(8),
  idempotencyKey: z.string().min(8).max(64),
  paymentMethod: z.enum(['cash', 'upi']).default('cash'),
});

export const cancelSchema = z.object({
  reasonCode: z.string().min(1),
  reasonText: z.string().optional(),
  idempotencyKey: z.string().min(8).max(64).optional(),
});

export const acceptSchema = z.object({
  idempotencyKey: z.string().min(8).max(64),
});

export const skipSchema = z.object({
  idempotencyKey: z.string().min(8).max(64).optional(),
});

export const startSchema = z.object({
  otp: z.string().regex(/^\d{4}$/),
  idempotencyKey: z.string().min(8).max(64),
});

export const completeSchema = z.object({
  idempotencyKey: z.string().min(8).max(64),
  collectedCash: z.boolean().default(true),
});

export const rateSchema = z.object({
  rating: z.number().int().min(1).max(5),
  tags: z.array(z.string()).default([]),
});

export const locationSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  heading: z.number().optional(),
  speedMps: z.number().optional(),
});

export const pilotOnlineSchema = locationSchema.extend({
  online: z.boolean(),
});

export const placesSuggestSchema = z.object({
  q: z.string().min(2).max(80),
});
