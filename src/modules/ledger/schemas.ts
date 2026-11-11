import { z } from 'zod';

export const earningsQuerySchema = z.object({
  range: z.enum(['today', 'week', 'month']).default('today'),
});

export const payoutRequestSchema = z.object({
  amountPaise: z.number().int().positive(),
  method: z.enum(['upi', 'bank', 'manual']).default('upi'),
  upiId: z.string().min(3).max(100).optional(),
});

export const payoutProcessSchema = z.object({
  action: z.enum(['approve', 'pay', 'reject']),
  adminNote: z.string().max(500).optional(),
});

export const duesSettleSchema = z.object({
  amountPaise: z.number().int().positive(),
  note: z.string().max(500).optional(),
});

export const suspendSchema = z.object({
  reason: z.string().min(3).max(500),
});

export const pageSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(20),
});
