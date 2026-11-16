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
  /** Parcels: who pays — sender at pickup or receiver at drop. Ignored for rides. */
  payAt: z.enum(['pickup', 'drop']).optional(),
});

export const PILOT_CANCEL_REASONS = [
  'vehicle_problem',
  'pickup_too_far',
  'rider_not_reachable',
  'personal_emergency',
  'sender_refused_payment', // parcel, pay at pickup: ends the request instead of re-searching
  'other',
] as const;

export const pilotCancelSchema = z
  .object({
    reasonCode: z.enum(PILOT_CANCEL_REASONS),
    reasonText: z.string().trim().max(200).optional(),
  })
  .refine((v) => v.reasonCode !== 'other' || (v.reasonText?.length ?? 0) >= 3, {
    message: 'Tell us the reason',
    path: ['reasonText'],
  });

export const resolvePaymentIssueSchema = z.object({
  note: z.string().trim().min(3).max(300),
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
  /** Parcel, pay at pickup: pilot confirms the sender paid before starting. */
  cashCollected: z.boolean().optional(),
});

export const completeSchema = z.object({
  idempotencyKey: z.string().min(8).max(64),
  collectedCash: z.boolean().default(true),
  /** Why cash was not collected (collectedCash=false). */
  notCollectedReason: z.enum(['receiver_refused', 'rider_refused', 'other']).optional(),
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
