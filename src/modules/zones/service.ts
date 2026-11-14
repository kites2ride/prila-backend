/**
 * Geo-fencing. ONE decision function (checkPoint) is shared by estimate, booking,
 * pilot go-online, bootstrap and the admin "Test a point" box — so they can never disagree.
 *
 * Rules:
 *  - Pickup must be inside an enabled `service` zone (of an enabled city) that offers the
 *    service, and NOT inside an enabled `blocked` zone for that service. Blocked wins.
 *  - Drop (zones.requireDropInside) must be inside a service zone of the SAME city.
 *    Blocked zones restrict pickups only.
 *  - Pilots (zones.pilotMustBeInside) go online only inside a service zone for their vehicle type.
 *  - Enforcement is off while zones.enforce=false or no enabled service zone exists yet.
 */
import { cellToLatLng, latLngToCell } from 'h3-js';
import type { z } from 'zod';
import { configCache } from '../../lib/cache.js';
import { createLogger } from '../../lib/logger.js';
import { AppError } from '../../lib/errors.js';
import { City, Zone } from '../app/model.js';
import { zonesValueSchema } from '../app/schemas.js';
import { getConfigValue } from '../app/service.js';
import { OutOfAreaDemand } from './model.js';

export type ZonesConfig = z.infer<typeof zonesValueSchema>;
type LatLng = { lat: number; lng: number };

export type OutReason = 'pickup_outside' | 'pickup_blocked' | 'drop_outside' | 'drop_other_city' | 'pilot_outside';

export type PointCheck = {
  /** Inside an enabled service zone (of an enabled city) that offers the service. */
  inService: boolean;
  /** Inside an enabled blocked zone that applies to the service. */
  blocked: boolean;
  cityId: string | null;
  cityName: string | null;
  zone: { id: string; name: string; district: string } | null;
  blockedBy: { id: string; name: string } | null;
};

const CACHE_TTL_MS = 30_000;
const DEMAND_H3_RES = 8;

let logger: ReturnType<typeof createLogger> | null = null;
function log() {
  logger ??= createLogger();
  return logger;
}

export async function getZonesConfig(): Promise<ZonesConfig> {
  const raw = await getConfigValue('zones');
  const parsed = zonesValueSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : zonesValueSchema.parse({});
}

/** Call after any zone or city write. */
export function invalidateZoneCaches() {
  configCache.invalidatePrefix('zones:');
  configCache.invalidatePrefix('bootstrap:');
}

async function enabledCities(): Promise<Map<string, { name: string }>> {
  const hit = configCache.get<Map<string, { name: string }>>('zones:cities');
  if (hit) return hit;
  const cities = await City.find({ enabled: true }).select({ name: 1 }).lean();
  const map = new Map(cities.map((c) => [String(c._id), { name: c.name }]));
  configCache.set('zones:cities', map, CACHE_TTL_MS);
  return map;
}

/**
 * True once ops have drawn at least one enabled service zone (any city).
 * Deliberately ignores city.enabled: disabling cities must CLOSE service, never
 * switch enforcement off and open it everywhere.
 */
export async function zonesConfigured(): Promise<boolean> {
  const hit = configCache.get<boolean>('zones:configured');
  if (hit !== undefined) return hit;
  const n = await Zone.countDocuments({ enabled: true, type: { $ne: 'blocked' } });
  configCache.set('zones:configured', n > 0, CACHE_TTL_MS);
  return n > 0;
}

export async function enforcementActive(cfg?: ZonesConfig): Promise<boolean> {
  const c = cfg ?? (await getZonesConfig());
  return c.enforce && (await zonesConfigured());
}

/** serviceType undefined = "any service". */
export async function checkPoint(p: LatLng, serviceType?: string): Promise<PointCheck> {
  const [zones, cities] = await Promise.all([
    Zone.find({
      enabled: true,
      polygon: { $geoIntersects: { $geometry: { type: 'Point', coordinates: [p.lng, p.lat] } } },
    })
      .sort({ createdAt: 1 })
      .lean(),
    enabledCities(),
  ]);
  const applies = (z: { services?: string[] | null }) =>
    !serviceType || !z.services?.length || z.services.includes(serviceType);
  const live = zones.filter((z) => cities.has(String(z.cityId)) && applies(z));
  const service = live.find((z) => (z.type ?? 'service') === 'service');
  const blocked = live.find((z) => z.type === 'blocked');
  const cityId = service ? String(service.cityId) : null;
  return {
    inService: Boolean(service),
    blocked: Boolean(blocked),
    cityId,
    cityName: cityId ? (cities.get(cityId)?.name ?? null) : null,
    zone: service ? { id: String(service._id), name: service.name, district: service.district ?? '' } : null,
    blockedBy: blocked ? { id: String(blocked._id), name: blocked.name } : null,
  };
}

function outOfArea(cfg: ZonesConfig, reason: OutReason): AppError {
  const message =
    reason === 'pickup_blocked'
      ? cfg.blockedMessage
      : reason === 'drop_outside' || reason === 'drop_other_city'
        ? cfg.dropOutOfAreaMessage
        : reason === 'pilot_outside'
          ? cfg.pilotOutOfAreaMessage
          : cfg.outOfAreaMessage;
  return new AppError('OUT_OF_SERVICE_AREA', message, 422, { reason });
}

function istDay(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** Fire-and-forget: never blocks or fails the request. */
export function recordOutOfAreaDemand(p: LatLng, kind: 'pickup' | 'drop', reason: OutReason) {
  try {
    const cell = latLngToCell(p.lat, p.lng, DEMAND_H3_RES);
    const [lat, lng] = cellToLatLng(cell);
    void OutOfAreaDemand.updateOne(
      { day: istDay(), cell, kind, reason },
      { $inc: { count: 1 }, $set: { lat, lng, lastAt: new Date() } },
      { upsert: true },
    ).catch((err: unknown) => log().warn({ err: (err as Error)?.message }, 'out-of-area demand write failed'));
  } catch {
    /* invalid coords — ignore */
  }
}

/**
 * Throws OUT_OF_SERVICE_AREA (422, details.reason) when the trip is not allowed.
 * @returns the pickup zone's cityId, or null when enforcement is off.
 */
export async function assertTripInServiceArea(pickup: LatLng, drop: LatLng, serviceType: string): Promise<string | null> {
  const cfg = await getZonesConfig();
  if (!(await enforcementActive(cfg))) return null;

  const [p, d] = await Promise.all([
    checkPoint(pickup, serviceType),
    cfg.requireDropInside ? checkPoint(drop, serviceType) : Promise.resolve(null),
  ]);

  if (p.blocked) {
    recordOutOfAreaDemand(pickup, 'pickup', 'pickup_blocked');
    throw outOfArea(cfg, 'pickup_blocked');
  }
  if (!p.inService) {
    recordOutOfAreaDemand(pickup, 'pickup', 'pickup_outside');
    throw outOfArea(cfg, 'pickup_outside');
  }
  if (d) {
    if (!d.inService) {
      recordOutOfAreaDemand(drop, 'drop', 'drop_outside');
      throw outOfArea(cfg, 'drop_outside');
    }
    if (d.cityId !== p.cityId) {
      recordOutOfAreaDemand(drop, 'drop', 'drop_other_city');
      throw outOfArea(cfg, 'drop_other_city');
    }
  }
  return p.cityId;
}

export async function assertPilotInServiceArea(loc: LatLng | undefined, vehicleType?: string | null): Promise<void> {
  const cfg = await getZonesConfig();
  if (!cfg.pilotMustBeInside || !(await enforcementActive(cfg))) return;
  if (!loc) throw new AppError('LOCATION_REQUIRED', 'Turn on location to go online', 400);
  const c = await checkPoint(loc, vehicleType ?? undefined);
  if (!c.inService) throw outOfArea(cfg, 'pilot_outside');
}

/** Bootstrap hint for apps (display only — the server still enforces on estimate/book/online). */
export async function serviceAreaFor(app: 'customer' | 'pilot', p: LatLng) {
  const cfg = await getZonesConfig();
  const enforced = await enforcementActive(cfg);
  if (!enforced) {
    return { enforced: false, inService: true, cityId: null, cityName: null, message: null, showOutline: cfg.showOutlineOnMap };
  }
  const c = await checkPoint(p);
  // Pilots may wait inside blocked spots (blocked restricts rider pickups only).
  const ok = app === 'pilot' ? c.inService : c.inService && !c.blocked;
  const message = ok
    ? null
    : app === 'pilot'
      ? cfg.pilotOutOfAreaMessage
      : c.blocked
        ? cfg.blockedMessage
        : cfg.outOfAreaMessage;
  return {
    enforced: true,
    inService: ok,
    cityId: c.cityId,
    cityName: c.cityName,
    message,
    showOutline: cfg.showOutlineOnMap,
  };
}

/** Admin "Test a point": same decision the server makes for that role. */
export async function testPoint(input: { lat: number; lng: number; serviceType?: string; role: 'pickup' | 'drop' | 'pilot' }) {
  const cfg = await getZonesConfig();
  const enforced = await enforcementActive(cfg);
  const c = await checkPoint(input, input.serviceType);
  let allowed: boolean;
  let reason: OutReason | null = null;
  if (input.role === 'pickup') {
    allowed = c.inService && !c.blocked;
    reason = c.blocked ? 'pickup_blocked' : c.inService ? null : 'pickup_outside';
  } else if (input.role === 'drop') {
    allowed = !cfg.requireDropInside || c.inService;
    reason = allowed ? null : 'drop_outside';
  } else {
    allowed = !cfg.pilotMustBeInside || c.inService;
    reason = allowed ? null : 'pilot_outside';
  }
  return {
    enforced,
    /** What the server would do right now (always allowed while enforcement is off). */
    allowedNow: enforced ? allowed : true,
    /** What it will do once enforcement is on. */
    allowedWhenEnforced: allowed,
    reason,
    message: reason ? outOfArea(cfg, reason).message : null,
    ...c,
  };
}

/** Outlines for apps (only when zones.showOutlineOnMap). Small payload, cached. */
export async function outlines(cityId?: string) {
  const cfg = await getZonesConfig();
  if (!cfg.showOutlineOnMap) return { zones: [] };
  const key = `zones:outline:${cityId ?? 'all'}`;
  const hit = configCache.get<{ zones: unknown[] }>(key);
  if (hit) return hit;
  const cities = [...(await enabledCities()).keys()];
  const filter: Record<string, unknown> = { enabled: true, cityId: { $in: cityId ? cities.filter((c) => c === cityId) : cities } };
  const zones = await Zone.find(filter).select({ name: 1, type: 1, services: 1, polygon: 1, cityId: 1 }).lean();
  const out = {
    zones: zones.map((z) => ({
      id: String(z._id),
      cityId: String(z.cityId),
      name: z.name,
      type: z.type ?? 'service',
      services: z.services ?? [],
      coordinates: z.polygon?.coordinates ?? [],
    })),
  };
  configCache.set(key, out, 60_000);
  return out;
}

export async function demandOutside(days: number, limit: number) {
  const from = new Date(Date.now() - (days - 1) * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const rows = await OutOfAreaDemand.aggregate([
    { $match: { day: { $gte: from } } },
    {
      $group: {
        _id: { cell: '$cell', kind: '$kind' },
        count: { $sum: '$count' },
        lat: { $first: '$lat' },
        lng: { $first: '$lng' },
        lastAt: { $max: '$lastAt' },
        reasons: { $addToSet: '$reason' },
      },
    },
    { $sort: { count: -1 } },
    { $limit: limit },
  ]);
  return {
    from,
    items: rows.map((r) => ({
      cell: r._id.cell as string,
      kind: r._id.kind as 'pickup' | 'drop',
      count: r.count as number,
      lat: r.lat as number,
      lng: r.lng as number,
      lastAt: r.lastAt as Date,
      reasons: r.reasons as string[],
    })),
  };
}
