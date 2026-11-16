import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { Ride } from '../rides/model.js';
import { assertTransition } from '../rides/stateMachine.js';
import { findCandidates } from './candidates.js';
import { getDispatchConfig } from './config.js';
import { locationStore } from './locationStore.js';
import { markDirty } from './persistence.js';
import type { DispatchLogEntry } from './types.js';

/**
 * Batch dispatch (H3 cells + first-accept-wins):
 * Offer to up to batchSize idle pilots in nearby rings at once.
 * Whoever accepts first gets the ride; others get ride:offer_taken and the card clears.
 * Pilots already offered / on_ride are never included.
 */
export async function runBatchOffer(
  app: FastifyInstance,
  rideId: string,
  opts: { shaktiStrict: boolean },
) {
  const ride = await Ride.findById(rideId);
  if (!ride || ride.status !== 'searching') return;

  const cfg = await getDispatchConfig();
  const searchExpired =
    (ride.searchExpiresAt && ride.searchExpiresAt.getTime() < Date.now()) ||
    // Measured from the current search (a pilot cancelling restarts the clock).
    Date.now() - new Date(ride.searchStartedAt ?? ride.createdAt ?? Date.now()).getTime() > cfg.maxSearchSec * 1000;

  if (searchExpired) {
    await markNoPilot(rideId);
    emitRider(app, String(ride.riderId), 'ride:no_pilot_found', { rideId });
    await appendLog(rideId, { at: new Date().toISOString(), event: 'no_pilot_found', note: 'max_search' });
    return;
  }

  const coords = ride.pickup?.location?.coordinates ?? [79.5941, 17.9689];
  const lng = coords[0] ?? 79.5941;
  const lat = coords[1] ?? 17.9689;
  const exclude = [
    ...(ride.offeredPilotIds ?? []).map(String),
    ...(ride.skippedPilotIds ?? []).map(String),
  ];

  emitRider(app, String(ride.riderId), 'dispatch:searching', { rideId });

  const { candidates, log } = await findCandidates({
    pickupLat: lat,
    pickupLng: lng,
    serviceType: ride.serviceType ?? 'bike',
    excludePilotIds: exclude,
    shaktiStrict: opts.shaktiStrict,
  });
  await appendLog(rideId, log);

  if (!candidates.length) {
    emitRider(app, String(ride.riderId), 'dispatch:matching', { rideId, waiting: true });
    setTimeout(() => {
      void runBatchOffer(app, rideId, opts);
    }, cfg.researchDelaySec * 1000);
    return;
  }

  const deadline = new Date(Date.now() + cfg.offerTimeoutSec * 1000);
  const ids = candidates.map((c) => new Types.ObjectId(c.pilotId));

  for (const c of candidates) {
    locationStore.setStatus(c.pilotId, 'offered', {
      offerRideId: rideId,
      offerExpiresAt: deadline.getTime(),
    });
    markDirty(c.pilotId);
  }

  await Ride.updateOne(
    { _id: rideId },
    {
      $addToSet: { offeredPilotIds: { $each: ids } },
      $set: { acceptDeadlineAt: deadline },
      $inc: { matchingAttempt: 1 },
    },
  );

  emitRider(app, String(ride.riderId), 'dispatch:matching', { rideId });

  const payload = {
    rideId,
    serviceType: ride.serviceType,
    pickup: ride.pickup,
    drop: ride.drop,
    distanceM: ride.distanceM,
    fareTotalPaise: ride.fareTotalPaise,
    estFarePaise: ride.fareTotalPaise,
    acceptTimeoutSec: cfg.offerTimeoutSec,
    acceptDeadlineAt: deadline.toISOString(),
    expiresAt: deadline.toISOString(),
  };

  for (const c of candidates) {
    emitPilot(app, c.pilotId, 'ride:offer', payload);
  }

  await appendLog(rideId, {
    at: new Date().toISOString(),
    event: 'batch_offer',
    pilotIds: candidates.map((c) => c.pilotId),
    candidateCount: candidates.length,
  });

  setTimeout(() => {
    void onBatchTimeout(
      app,
      rideId,
      opts,
      candidates.map((c) => c.pilotId),
    );
  }, cfg.offerTimeoutSec * 1000 + 200);
}

async function onBatchTimeout(
  app: FastifyInstance,
  rideId: string,
  opts: { shaktiStrict: boolean },
  offeredIds: string[],
) {
  const ride = await Ride.findById(rideId);
  if (!ride || ride.status !== 'searching') return;

  for (const id of offeredIds) {
    const live = locationStore.get(id);
    if (live?.status === 'offered' && live.offerRideId === rideId) {
      locationStore.setStatus(id, 'idle');
      markDirty(id);
      emitPilot(app, id, 'ride:offer_cancelled', { rideId, reason: 'timeout' });
    }
  }

  await appendLog(rideId, {
    at: new Date().toISOString(),
    event: 'batch_timeout',
    pilotIds: offeredIds,
  });

  await runBatchOffer(app, rideId, opts);
}

/** After first accept: release other offered pilots and notify taken. */
export function releaseOtherOffers(
  app: FastifyInstance,
  rideId: string,
  winnerPilotId: string,
  offeredPilotIds: string[],
) {
  for (const id of offeredPilotIds) {
    if (id === winnerPilotId) continue;
    const live = locationStore.get(id);
    if (live?.status === 'offered' && live.offerRideId === rideId) {
      locationStore.setStatus(id, 'idle');
      markDirty(id);
    }
    emitPilot(app, id, 'ride:offer_taken', { rideId });
  }
}

export async function releaseOfferOnCancel(app: FastifyInstance, rideId: string) {
  const ride = await Ride.findById(rideId);
  if (!ride) return;
  for (const id of ride.offeredPilotIds ?? []) {
    const pid = String(id);
    const live = locationStore.get(pid);
    if (live?.offerRideId === rideId) {
      locationStore.setStatus(pid, 'idle');
      markDirty(pid);
      emitPilot(app, pid, 'ride:offer_cancelled', { rideId, reason: 'cancelled' });
    }
  }
}

async function markNoPilot(rideId: string) {
  const current = await Ride.findById(rideId);
  if (!current || current.status !== 'searching') return;
  assertTransition('searching', 'no_pilot_found');
  await Ride.findOneAndUpdate(
    { _id: rideId, status: 'searching' },
    {
      $set: { status: 'no_pilot_found' },
      $push: {
        timeline: {
          at: new Date(),
          from: 'searching',
          to: 'no_pilot_found',
          actor: 'system',
        },
      },
    },
  );
}

async function appendLog(rideId: string, entry: DispatchLogEntry) {
  await Ride.updateOne({ _id: rideId }, { $push: { dispatchLog: entry } });
}

function emitPilot(app: FastifyInstance, pilotId: string, event: string, payload: unknown) {
  try {
    app.io?.of('/pilot').to(`pilot:${pilotId}`).emit(event, payload);
  } catch {
    /* optional in tests */
  }
}

function emitRider(app: FastifyInstance, riderId: string, event: string, payload: unknown) {
  try {
    app.io?.of('/rider').to(`rider:${riderId}`).emit(event, payload);
  } catch {
    /* optional */
  }
}
