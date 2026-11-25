import { Schema, Types, model } from 'mongoose';

/**
 * Rider-side cancellation policy (reasons, fee rule, 30-minute pilot rematch block).
 * Fee amount itself comes from the fare rule (`fare.cancellationFeePaise`, admin-configurable per
 * city/service, default 0), so fees can be switched on later without code changes.
 */

/** Reasons that are the pilot's fault or a wait issue: always free, and the pilot is blocked for this rider. */
export const PILOT_FAULT_REASONS = [
  'CAPTAIN_ASKED_TO_CANCEL',
  'CAPTAIN_ASKED_EXTRA_MONEY',
  'CAPTAIN_UNREACHABLE',
  'CAPTAIN_NOT_MOVING',
  'LONG_WAIT_TIME',
] as const;

export const RIDER_SIDE_REASONS = ['WRONG_LOCATION', 'PLAN_CHANGED', 'BOOKED_BY_MISTAKE', 'OTHER'] as const;

export const RIDER_CANCEL_REASONS = [...PILOT_FAULT_REASONS, ...RIDER_SIDE_REASONS] as const;
export type RiderCancelReason = (typeof RIDER_CANCEL_REASONS)[number];

export const isPilotFaultReason = (code: string): boolean =>
  (PILOT_FAULT_REASONS as readonly string[]).includes(code);

/** Free cancellation window after the pilot accepted. */
export const CANCEL_GRACE_SEC = 120;
/** How long a pilot is kept away from a rider after a pilot-fault cancel. */
export const REMATCH_BLOCK_MIN = 30;

type FeeRide = {
  status: string;
  fare?: { cancellationFeePaise?: number | null } | null;
  timeline?: Array<{ at?: Date | string | null; to?: string | null }> | null;
};

/** When the current pilot was assigned (latest timeline entry into pilot_assigned). */
export function assignedAt(ride: FeeRide): Date | null {
  const hits = (ride.timeline ?? []).filter((t) => t.to === 'pilot_assigned' && t.at);
  const last = hits[hits.length - 1];
  return last?.at ? new Date(last.at) : null;
}

/** @returns cancellation fee in paise (0 = free). */
export function calculateCancellationFee(ride: FeeRide, reasonCode: string, now = new Date()): number {
  if (ride.status === 'requested' || ride.status === 'searching') return 0; // no pilot yet
  if (isPilotFaultReason(reasonCode)) return 0;
  const at = assignedAt(ride);
  if (at && now.getTime() - at.getTime() <= CANCEL_GRACE_SEC * 1000) return 0;
  return Math.max(0, ride.fare?.cancellationFeePaise ?? 0);
}

/* ───────────────────────── rider ↔ pilot blocks ───────────────────────── */

const blockSchema = new Schema(
  {
    riderId: { type: Schema.Types.ObjectId, ref: 'Rider', required: true },
    pilotId: { type: Schema.Types.ObjectId, ref: 'Pilot', required: true },
    rideId: { type: Schema.Types.ObjectId, ref: 'Ride' },
    reasonCode: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
blockSchema.index({ riderId: 1, expiresAt: 1 });
blockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // Mongo TTL cleanup

export const RiderPilotBlock = model('RiderPilotBlock', blockSchema, 'rider_driver_blocks');

export async function blockPilotForRider(input: {
  riderId: string;
  pilotId: string;
  rideId: string;
  reasonCode: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  await RiderPilotBlock.create({
    riderId: new Types.ObjectId(input.riderId),
    pilotId: new Types.ObjectId(input.pilotId),
    rideId: new Types.ObjectId(input.rideId),
    reasonCode: input.reasonCode,
    expiresAt: new Date(now.getTime() + REMATCH_BLOCK_MIN * 60_000),
  });
}

/** Pilot ids this rider must not be matched with right now. */
export async function blockedPilotIds(riderId: string | Types.ObjectId): Promise<string[]> {
  const rows = await RiderPilotBlock.find(
    { riderId: new Types.ObjectId(String(riderId)), expiresAt: { $gt: new Date() } },
    { pilotId: 1 },
  ).lean();
  return rows.map((r) => String(r.pilotId));
}
