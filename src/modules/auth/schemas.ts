import { z } from 'zod';

export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9]{10,15}$/, 'Invalid phone number');

export const otpRequestSchema = z.object({
  phone: phoneSchema,
  app: z.enum(['customer', 'pilot']),
});

export const otpVerifySchema = z.object({
  phone: phoneSchema,
  app: z.enum(['customer', 'pilot']),
  code: z.string().regex(/^\d{4,6}$/),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});

export const adminLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});
