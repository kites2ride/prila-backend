import { haversineM } from '../rides/geo.js';
import { getDispatchConfig } from './config.js';
import { cellsInDisk, toCell } from './h3.js';
import { locationStore } from './locationStore.js';

export const NEARBY_MAX_PILOTS = 12;
export const NEARBY_FRESH_MS = 2 * 60 * 1000;
export const NEARBY_DEFAULT_RADIUS_KM = 5;
export const NEARBY_MAX_RADIUS_KM = 10;

export const NEARBY_SERVICE_TYPES = ['bike', 'auto', 'parcel', 'logistics'] as const;
export type NearbyServiceType = (typeof NEARBY_SERVICE_TYPES)[number];

export type NearbyPilot = {
  id: string;
  lat: number;
  lng: number;
  heading: number;
  vehicleType: string;
};

/** Vehicle types that can be shown for a service. Parcel rides use bikes too. */
function vehicleTypesFor(service: NearbyServiceType): string[] {
  return service === 'parcel' ? ['parcel', 'bike'] : [service];
}

/**
 * Idle, online, fresh pilots around a point for the rider's pre-booking map.
 * Reads the in-memory LocationStore only (no Mongo). Exposes only an opaque id + position.
 */
export async function findNearbyPilots(input: {
  lat: number;
  lng: number;
  serviceType: NearbyServiceType;
  radiusKm?: number;
  now?: number;
}): Promise<NearbyPilot[]> {
  const cfg = await getDispatchConfig();
  const now = input.now ?? Date.now();
  const radiusM =
    Math.min(Math.max(input.radiusKm ?? NEARBY_DEFAULT_RADIUS_KM, 0.1), NEARBY_MAX_RADIUS_KM) * 1000;
  const allowed = new Set(vehicleTypesFor(input.serviceType));

  // Smallest H3 disk that covers the radius, then an exact distance filter.
  const edgeM = cfg.h3Resolution >= 9 ? 174 : cfg.h3Resolution === 8 ? 461 : 1220;
  const k = Math.min(15, Math.ceil(radiusM / (edgeM * 1.5)) + 1);
  const cells = cellsInDisk(toCell(input.lat, input.lng, cfg.h3Resolution), k);

  const found: Array<NearbyPilot & { distanceM: number }> = [];
  for (const p of locationStore.listByCells(cells)) {
    if (!p.online || p.status !== 'idle' || p.flaggedMocked) continue;
    if (now - p.updatedAt > NEARBY_FRESH_MS) continue;
    if (p.kycStatus && p.kycStatus !== 'approved') continue;
    if (!p.vehicleType || !allowed.has(p.vehicleType)) continue;
    const distanceM = haversineM({ lat: input.lat, lng: input.lng }, { lat: p.lat, lng: p.lng });
    if (distanceM > radiusM) continue;
    found.push({
      id: p.pilotId,
      lat: p.lat,
      lng: p.lng,
      heading: normaliseHeading(p.headingDeg),
      vehicleType: p.vehicleType,
      distanceM,
    });
  }

  found.sort((a, b) => a.distanceM - b.distanceM);
  return found.slice(0, NEARBY_MAX_PILOTS).map(({ distanceM: _d, ...rest }) => rest);
}

export function normaliseHeading(h: number | undefined | null): number {
  if (h == null || !Number.isFinite(h)) return 0;
  return ((h % 360) + 360) % 360;
}
