import { z } from 'zod';

export const pushTokenSchema = z.object({
  pushToken: z.string().min(8).max(512),
  platform: z.enum(['android', 'ios', 'web']),
});

export const permissionsSchema = z.object({
  locationPermission: z.enum(['denied', 'whileInUse', 'always', 'unknown']).optional(),
  notificationPermission: z.enum(['granted', 'denied', 'unknown']).optional(),
});

export const adminPushSchema = z.object({
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(500),
  topic: z.string().min(1).max(120).optional(),
  userId: z.string().min(8).optional(),
  userTyp: z.enum(['rider', 'pilot']).optional(),
  deepLink: z.string().max(300).optional(),
  data: z.record(z.string(), z.string()).optional(),
});
