import { z } from 'zod';

/**
 * Per-city price timing (admin → Cities → Pricing).
 * - Night hours: the fare rule's night multiplier (per service) applies inside them.
 * - Rush hours: fixed time bands with their own multiplier (all services, no Google cost).
 * - maxMultiplier: night × rush × demand (and live traffic) can never push the fare above
 *   this many times the normal fare. Owner decision: 1.5× at most.
 * Times are local to the city's timezone, "HH:MM", 24-hour. A window may cross midnight.
 */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const MAX_PRICE_MULTIPLIER = 1.5;

export const rushBandSchema = z
  .object({
    start: z.string().regex(HHMM, 'Use HH:MM, e.g. 08:00'),
    end: z.string().regex(HHMM, 'Use HH:MM, e.g. 11:00'),
    multiplier: z.number().min(1).max(MAX_PRICE_MULTIPLIER),
  })
  .refine((b) => b.start !== b.end, { message: 'Start and end must differ' });

export const cityPricingSchema = z.object({
  /** Same start and end = no night fare in this city. */
  nightStart: z.string().regex(HHMM, 'Use HH:MM, e.g. 22:00').default('22:00'),
  nightEnd: z.string().regex(HHMM, 'Use HH:MM, e.g. 06:00').default('06:00'),
  rushHours: z.array(rushBandSchema).max(6).default([]),
  maxMultiplier: z.number().min(1).max(MAX_PRICE_MULTIPLIER).default(MAX_PRICE_MULTIPLIER),
});
export type CityPricing = z.infer<typeof cityPricingSchema>;

/** Stored value (may be missing on older cities) → complete settings with defaults. */
export function readCityPricing(raw: unknown): CityPricing {
  const parsed = cityPricingSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : cityPricingSchema.parse({});
}

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Minutes since local midnight in the city's timezone. */
export function localMinutes(at: Date, timeZone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  } catch {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  }
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return (h % 24) * 60 + m;
}

/** Start inclusive, end exclusive; handles windows that cross midnight (22:00 → 06:00). */
export function inWindow(minute: number, start: string, end: string): boolean {
  const s = toMin(start);
  const e = toMin(end);
  if (s === e) return false;
  return s < e ? minute >= s && minute < e : minute >= s || minute < e;
}

/** Which time-based charges apply at this moment in this city. */
export function timeCharges(pricing: CityPricing, at: Date, timeZone: string) {
  const minute = localMinutes(at, timeZone);
  const isNight = inWindow(minute, pricing.nightStart, pricing.nightEnd);
  // Overlapping rush bands: the highest one wins (they never stack with each other).
  const rush = pricing.rushHours
    .filter((b) => inWindow(minute, b.start, b.end))
    .reduce((m, b) => Math.max(m, b.multiplier), 1);
  return { isNight, rushMultiplier: rush };
}
