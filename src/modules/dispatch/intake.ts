import { z } from 'zod';
import { Pilot } from '../auth/model.js';
import { haversineM } from '../rides/geo.js';
import { getDispatchConfig } from './config.js';
import { toCell } from './h3.js';
import { locationStore } from './locationStore.js';
import type { PilotLiveState } from './types.js';

export const pilotLocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().nonnegative().optional(),
  headingDeg: z.number().min(0).max(360).optional(),
  speedMps: z.number().nonnegative().optional(),
  recordedAt: z.union([z.string(), z.number()]).optional(),
  isMocked: z.boolean().optional(),
});

export type PilotLocationPing = z.infer<typeof pilotLocationSchema>;

export type IntakeResult =
  | { ok: true; state: PilotLiveState }
  | { ok: false; reason: string };

/**
 * Validate + apply a pilot location ping into the in-memory LocationStore.
 * Matching never reads Mongo for this.
 */
export async function ingestPilotLocation(
  pilotId: string,
  raw: unknown,
  opts?: { forceOnline?: boolean },
): Promise<IntakeResult> {
  const parsed = pilotLocationSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid_payload' };

  const body = parsed.data;
  const cfg = await getDispatchConfig();
  const recordedAt = body.recordedAt
    ? typeof body.recordedAt === 'number'
      ? body.recordedAt
      : Date.parse(body.recordedAt)
    : Date.now();
  if (Number.isNaN(recordedAt)) return { ok: false, reason: 'bad_timestamp' };

  const existing = locationStore.get(pilotId);
  if (existing && recordedAt < existing.updatedAt) {
    return { ok: false, reason: 'stale_ping' };
  }

  if (body.accuracyM != null && body.accuracyM > cfg.maxAccuracyM) {
    return { ok: false, reason: 'accuracy_too_low' };
  }

  if (body.isMocked) {
    await Pilot.updateOne({ _id: pilotId }, { $set: { locationMockFlagged: true } });
    if (existing) locationStore.setStatus(pilotId, existing.status, { flaggedMocked: true });
    return { ok: false, reason: 'mocked_location' };
  }

  if (existing) {
    const dtSec = Math.max(0.5, (recordedAt - existing.updatedAt) / 1000);
    const dist = haversineM(
      { lat: existing.lat, lng: existing.lng },
      { lat: body.lat, lng: body.lng },
    );
    if (dist / dtSec > cfg.maxSpeedMps) {
      return { ok: false, reason: 'impossible_speed' };
    }
  }

  const pilot = await Pilot.findById(pilotId).lean();
  if (!pilot) return { ok: false, reason: 'pilot_not_found' };
  if (pilot.status !== 'active' || pilot.kycStatus !== 'approved') {
    return { ok: false, reason: 'pilot_not_eligible' };
  }
  const online = opts?.forceOnline ?? pilot.online === true;
  if (!online) return { ok: false, reason: 'pilot_offline' };

  const cell = toCell(body.lat, body.lng, cfg.h3Resolution);
  const prevStatus = existing?.status ?? 'idle';
  // Don't demote on_ride / offered just because of a ping
  const status = prevStatus === 'on_ride' || prevStatus === 'offered' ? prevStatus : 'idle';

  const state: PilotLiveState = {
    pilotId,
    lat: body.lat,
    lng: body.lng,
    cell,
    headingDeg: body.headingDeg,
    speedMps: body.speedMps,
    accuracyM: body.accuracyM,
    updatedAt: recordedAt,
    status,
    offerRideId: existing?.offerRideId,
    offerExpiresAt: existing?.offerExpiresAt,
    serviceTypes: pilot.vehicleType ? [pilot.vehicleType] : [],
    vehicleType: pilot.vehicleType ?? undefined,
    cityId: pilot.cityId ? String(pilot.cityId) : undefined,
    gender: pilot.gender ?? undefined,
    shaktiOptIn: pilot.shaktiOptIn === true,
    kycStatus: pilot.kycStatus,
    online: true,
    flaggedMocked: false,
  };

  locationStore.upsert(state);
  return { ok: true, state };
}

export function markPilotOffline(pilotId: string) {
  locationStore.remove(pilotId);
}

export function markPilotOnRide(pilotId: string, rideId: string) {
  locationStore.setStatus(pilotId, 'on_ride', { offerRideId: rideId });
}

export function markPilotIdle(pilotId: string) {
  const p = locationStore.get(pilotId);
  if (!p) return;
  locationStore.setStatus(pilotId, 'idle');
}
