import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const adminLoginsSchema = z
  .string()
  .transform((raw, ctx) => {
    try {
      const parsed: unknown = JSON.parse(raw);
      const map = z.record(z.string(), z.string().min(6)).parse(parsed);
      if (Object.keys(map).length === 0) {
        ctx.addIssue({ code: 'custom', message: 'ADMIN_LOGINS must have at least one entry' });
        return z.NEVER;
      }
      return map;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'ADMIN_LOGINS must be valid JSON object' });
      return z.NEVER;
    }
  });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  MONGODB_URI: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  JWT_ADMIN_TTL: z.string().default('8h'),
  ADMIN_LOGINS: adminLoginsSchema,
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  ALLOW_OTP_DEBUG: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  /**
   * TEMPORARY demo switch (business review, SMS not configured yet).
   * ON unless set to 'false'/'0'. Returns the OTP in the request response so the
   * app autofills it. REMOVE / set DEMO_OTP_AUTOFILL=false once SMS is live.
   */
  DEMO_OTP_AUTOFILL: z
    .string()
    .optional()
    .transform((v) => !(v === 'false' || v === '0')),
  SMS_PROVIDER: z.string().optional().default(''),
  SMS_API_KEY: z.string().optional().default(''),
  SMS_SENDER_ID: z.string().optional().default(''),
  SMS_TEMPLATE_OTP: z.string().optional().default(''),
  R2_ACCOUNT_ID: z.string().optional().default(''),
  R2_ACCESS_KEY_ID: z.string().optional().default(''),
  R2_SECRET_ACCESS_KEY: z.string().optional().default(''),
  R2_BUCKET: z.string().optional().default(''),
  R2_PUBLIC_BASE_URL: z.string().optional().default(''),
  FIREBASE_SERVICE_ACCOUNT_PATH: z.string().optional().default(''),
  /** Server-only Google key (Places New, Routes, Geocoding). Empty = maps disabled, haversine fallback. */
  GOOGLE_MAPS_SERVER_KEY: z.string().optional().default(''),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(overrides?: Record<string, string | undefined>): Env {
  const source = { ...process.env, ...overrides };
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${msg}`);
  }
  cached = parsed.data;
  return cached;
}

export function env(): Env {
  if (!cached) return loadEnv();
  return cached;
}

export function resetEnvCache(): void {
  cached = null;
}
