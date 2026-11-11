import { z } from 'zod';

export const trackEventSchema = z.object({
  name: z.string().min(1).max(64),
  sessionId: z.string().max(64).optional(),
  props: z.record(z.string(), z.unknown()).optional(),
  platform: z.enum(['android', 'ios', 'web']).optional(),
  build: z.number().int().optional(),
  durationSec: z.number().nonnegative().optional(),
});

export const analyticsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
  name: z.string().optional(),
  app: z.enum(['customer', 'pilot', 'admin']).optional(),
});
