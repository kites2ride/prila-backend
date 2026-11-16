import { Types } from 'mongoose';
import { Pilot } from '../auth/model.js';
import { Ride } from '../rides/model.js';
import { getDispatchConfig } from './config.js';
import { locationStore } from './locationStore.js';

/** Rides that belong on the live map (not finished, not cancelled). */
export const LIVE_RIDE_STATUSES = [
  'requested',
  'searching',
  'pilot_assigned',
  'pilot_arriving',
  'pilot_arrived',
  'in_progress',
] as const;

const SEARCHING = new Set(['requested', 'searching']);
const MAX_RIDES = 1000;

type Point = { name: string | null; lat: number; lng: number } | null;

function point(place: unknown): Point {
  const p = place as { name?: string; location?: { coordinates?: number[] } } | undefined;
  const c = p?.location?.coordinates;
  if (!c || c.length < 2) return null;
  return { name: p?.name ?? null, lat: c[1]!, lng: c[0]! };
}

/**
 * One city's live picture for the admin map, polled every 5 s.
 * Pilots come from the in-memory LocationStore (no DB scan); names / vehicle
 * numbers are one indexed lookup by id. Rider PII is never included.
 */
export async function liveSnapshot(cityId: string, now = Date.now()) {
  const cfg = await getDispatchConfig();
  const staleAfterSec = cfg.locationTtlSec;
  const staleMs = staleAfterSec * 1000;

  const live = locationStore.listAll().filter((p) => p.online && p.cityId === cityId);
  const rides = await Ride.find({ cityId: new Types.ObjectId(cityId), status: { $in: LIVE_RIDE_STATUSES } })
    .select('status serviceType pickup drop pilotId createdAt lastPilotLocationAt')
    .sort({ createdAt: -1 })
    .limit(MAX_RIDES)
    .lean();

  const pilotIds = new Set<string>(live.map((p) => p.pilotId));
  for (const r of rides) if (r.pilotId) pilotIds.add(String(r.pilotId));
  const docs = pilotIds.size
    ? await Pilot.find({ _id: { $in: [...pilotIds].filter((id) => Types.ObjectId.isValid(id)) } })
        .select('name vehicleNumber vehicleType')
        .lean()
    : [];
  const byId = new Map(docs.map((d) => [String(d._id), d]));

  const pilots = live.map((p) => {
    const d = byId.get(p.pilotId);
    const ageSec = Math.max(0, Math.round((now - p.updatedAt) / 1000));
    return {
      id: p.pilotId,
      name: d?.name ?? null,
      vehicleType: p.vehicleType ?? d?.vehicleType ?? null,
      vehicleNumber: d?.vehicleNumber ?? null,
      status: p.status,
      stale: now - p.updatedAt > staleMs,
      lat: p.lat,
      lng: p.lng,
      headingDeg: p.headingDeg ?? null,
      lastSeenSec: ageSec,
      offerRideId: p.offerRideId ?? null,
    };
  });

  const rideItems = rides.map((r) => {
    const pid = r.pilotId ? String(r.pilotId) : null;
    return {
      id: String(r._id),
      status: r.status,
      searching: SEARCHING.has(r.status),
      serviceType: r.serviceType,
      pickup: point(r.pickup),
      drop: point(r.drop),
      pilotId: pid,
      pilotName: pid ? (byId.get(pid)?.name ?? null) : null,
      ageSec: Math.max(0, Math.round((now - new Date(r.createdAt as Date).getTime()) / 1000)),
    };
  });

  return {
    at: new Date(now).toISOString(),
    staleAfterSec,
    counts: {
      idle: pilots.filter((p) => !p.stale && p.status === 'idle').length,
      offered: pilots.filter((p) => !p.stale && p.status === 'offered').length,
      onRide: pilots.filter((p) => !p.stale && p.status === 'on_ride').length,
      stale: pilots.filter((p) => p.stale).length,
      searching: rideItems.filter((r) => r.searching).length,
      activeRides: rideItems.filter((r) => !r.searching).length,
    },
    pilots,
    rides: rideItems,
    truncated: rides.length >= MAX_RIDES,
  };
}
