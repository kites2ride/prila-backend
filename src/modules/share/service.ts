import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { Ride } from '../rides/model.js';

function sign(payload: string): string {
  return createHmac('sha256', env().JWT_SECRET).update(payload).digest('base64url');
}

export async function createShareToken(riderId: string, rideId: string) {
  const ride = await Ride.findById(rideId).lean();
  if (!ride || String(ride.riderId) !== riderId) {
    throw new AppError('NOT_FOUND', 'Ride not found', 404);
  }
  const shareable = [
    'pilot_assigned',
    'pilot_arriving',
    'pilot_arrived',
    'in_progress',
  ].includes(ride.status as string);
  if (!shareable) {
    throw new AppError('RIDE_STATE_INVALID', 'Ride not shareable', 400);
  }
  const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 6; // 6h
  const body = `${rideId}.${exp}`;
  const token = `${body}.${sign(body)}`;
  return {
    token,
    expiresAt: new Date(exp * 1000).toISOString(),
    path: `/api/v1/share/rides/${token}`,
  };
}

export async function readSharedRide(token: string) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AppError('SHARE_INVALID', 'Invalid share link', 400);
  const rideId = parts[0]!;
  const expStr = parts[1]!;
  const sig = parts[2]!;
  const body = `${rideId}.${expStr}`;
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AppError('SHARE_INVALID', 'Invalid share signature', 400);
  }
  if (Number(expStr) * 1000 < Date.now()) {
    throw new AppError('SHARE_EXPIRED', 'Share link expired', 410);
  }
  const ride = await Ride.findById(rideId).lean();
  if (!ride) throw new AppError('NOT_FOUND', 'Ride not found', 404);
  const pickup = ride.pickup as { name?: string; location?: { coordinates?: number[] } } | undefined;
  const drop = ride.drop as { name?: string } | undefined;
  return {
    status: ride.status,
    serviceType: ride.serviceType,
    pickupName: pickup?.name ?? 'Pickup',
    dropName: drop?.name ?? 'Drop',
    // coarse only — round to ~1km
    pickupApprox: pickup?.location?.coordinates
      ? {
          lng: Math.round((pickup.location.coordinates[0] ?? 0) * 100) / 100,
          lat: Math.round((pickup.location.coordinates[1] ?? 0) * 100) / 100,
        }
      : null,
    fareTotalPaise: undefined as number | undefined, // never expose fare on public share
    updatedAt: ride.updatedAt,
  };
}
