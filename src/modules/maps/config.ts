import type { z } from 'zod';
import { env } from '../../config/env.js';
import { mapsValueSchema } from '../app/schemas.js';
import { getConfigValue } from '../app/service.js';

export type MapsConfig = z.infer<typeof mapsValueSchema>;

/** Admin `maps` config merged over safe defaults (invalid stored value → defaults). */
export async function getMapsConfig(): Promise<MapsConfig> {
  const raw = await getConfigValue('maps');
  const parsed = mapsValueSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : mapsValueSchema.parse({});
}

/** Google is usable only when ops enabled it AND the server key is configured. */
export function googleKey(): string {
  return env().GOOGLE_MAPS_SERVER_KEY;
}

export async function isMapsActive(cfg?: MapsConfig): Promise<boolean> {
  const c = cfg ?? (await getMapsConfig());
  return c.enabled && googleKey().length > 0;
}
