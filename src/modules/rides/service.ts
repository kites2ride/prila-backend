import { createHash, randomBytes, randomInt, createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { City } from '../app/model.js';
import { Pilot, Rider } from '../auth/model.js';
import { CouponRedemption } from '../coupons/model.js';
import { calculateFare } from './fare.js';
import { estimateDurationSec, haversineM } from './geo.js';
import {
  getDispatchConfig,
  getSurgeMultiplier,
  ingestPilotLocation,
  markDirty,
  markPilotIdle,
  markPilotOffline,
  markPilotOnRide,
  recordDemand,
  releaseOfferOnCancel,
  releaseOtherOffers,
  runBatchOffer,
} from '../dispatch/index.js';
import { findCandidatePilots, getCustomerFlags, getMatchingConfig } from './matching.js';
import { Ride, RideQuote, type RideStatus } from './model.js';
import {
  ACTIVE_PILOT_STATUSES,
  ACTIVE_RIDER_STATUSES,
  assertTransition,
  canTransition,
} from './stateMachine.js';

function hashOtp(otp: string) {
  return createHash('sha256').update(otp).digest('hex');
}

function signQuote(payload: string) {
  return createHmac('sha256', env().JWT_SECRET).update(payload).digest('hex');
}

function point(lng: number, lat: number) {
  return { type: 'Point' as const, coordinates: [lng, lat] };
}

async function appendTimeline(
  rideId: Types.ObjectId,
  from: string | undefined,
  to: string,
  actor: 'rider' | 'pilot' | 'system' | 'admin',
  actorId?: string,
) {
  await Ride.updateOne(
    { _id: rideId },
    {
      $push: {
        timeline: {
          at: new Date(),
          from,
          to,
          actor,
          actorId,
        },
      },
    },
  );
}

async function transition(
  rideId: string,
  expected: RideStatus | RideStatus[],
  next: RideStatus,
  patch: Record<string, unknown>,
  actor: 'rider' | 'pilot' | 'system' | 'admin',
  actorId?: string,
) {
  const expectedList = Array.isArray(expected) ? expected : [expected];
  const current = await Ride.findById(rideId);
  if (!current) throw new AppError('NOT_FOUND', 'Ride not found', 404);
  if (!expectedList.includes(current.status as RideStatus)) {
    throw new AppError('RIDE_STATE_INVALID', `Expected ${expectedList.join('|')}, got ${current.status}`, 409);
  }
  assertTransition(current.status as RideStatus, next);

  const updated = await Ride.findOneAndUpdate(
    { _id: rideId, status: { $in: expectedList } },
    {
      $set: { status: next, ...patch },
      $push: {
        timeline: {
          at: new Date(),
          from: current.status,
          to: next,
          actor,
          actorId,
        },
      },
    },
    { returnDocument: 'after' },
  );
  if (!updated) throw new AppError('RIDE_STATE_INVALID', 'Concurrent update — retry', 409);
  return updated;
}

export async function estimate(riderId: string, body: {
  serviceType: string;
  pickup: { lat: number; lng: number; name?: string; address?: string };
  drop: { lat: number; lng: number; name?: string; address?: string };
  cityId?: string;
  couponCode?: string;
  shakti?: boolean;
}) {
  const flags = await getCustomerFlags();
  const matching = await getMatchingConfig();

  let cityId = body.cityId;
  if (!cityId) {
    const city = await City.findOne({ enabled: true }).lean();
    if (!city) throw new AppError('NO_CITY', 'No serviceable city', 400);
    cityId = String(city._id);
  }

  const distanceM = Math.round(
    haversineM(
      { lat: body.pickup.lat, lng: body.pickup.lng },
      { lat: body.drop.lat, lng: body.drop.lng },
    ),
  );
  const durationSec = estimateDurationSec(distanceM);

  const shaktiRequested = Boolean(body.shakti && flags.prila_shakti);
  if (shaktiRequested) {
    const rider = await Rider.findById(riderId).lean();
    if (rider?.gender !== 'female') {
      throw new AppError('SHAKTI_INELIGIBLE', 'Prila Shakti requires female rider profile', 403);
    }
  }

  const fare = await calculateFare({
    cityId,
    serviceType: body.serviceType,
    distanceM,
    durationSec,
    couponCode: body.couponCode,
    riderId,
    flags,
  });

  // H3 surge snapshotted into quote (never re-read live at book/complete)
  const surgeMult = await getSurgeMultiplier(cityId, body.pickup.lat, body.pickup.lng);
  if (surgeMult !== 1) {
    const baseTotal = fare.totalPaise - (fare.platformFeePaise ?? 0);
    const surged = Math.round(baseTotal * surgeMult) + (fare.platformFeePaise ?? 0);
    fare.surgeMultiplier = (fare.surgeMultiplier ?? 1) * surgeMult;
    fare.totalPaise = surged;
  }
  void recordDemand(cityId, body.pickup.lat, body.pickup.lng);

  const quoteId = randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + matching.quoteTtlSec * 1000);
  const signature = signQuote(`${quoteId}:${riderId}:${fare.totalPaise}:${expiresAt.toISOString()}`);

  await RideQuote.create({
    quoteId,
    riderId: new Types.ObjectId(riderId),
    cityId: new Types.ObjectId(cityId),
    serviceType: body.serviceType,
    pickup: {
      name: body.pickup.name,
      address: body.pickup.address,
      location: point(body.pickup.lng, body.pickup.lat),
    },
    drop: {
      name: body.drop.name,
      address: body.drop.address,
      location: point(body.drop.lng, body.drop.lat),
    },
    distanceM,
    durationSec,
    fare,
    expiresAt,
    couponCode: fare.couponCode,
    shakti: shaktiRequested,
    signature,
  } as never);

  return {
    quoteId,
    expiresAt: expiresAt.toISOString(),
    expiresInSec: matching.quoteTtlSec,
    distanceM,
    durationSec,
    fare,
    shakti: shaktiRequested,
    currency: 'INR',
  };
}

export async function book(
  app: FastifyInstance,
  riderId: string,
  body: { quoteId: string; idempotencyKey: string; paymentMethod: 'cash' | 'upi' },
) {
  const existing = await Ride.findOne({ riderId, idempotencyKey: body.idempotencyKey });
  if (existing) return serializeRide(existing);

  const active = await Ride.findOne({ riderId, status: { $in: ACTIVE_RIDER_STATUSES } });
  if (active) throw new AppError('ACTIVE_RIDE_EXISTS', 'You already have an active ride', 409);

  const quote = await RideQuote.findOne({ quoteId: body.quoteId });
  if (!quote || String(quote.riderId) !== riderId) {
    throw new AppError('QUOTE_INVALID', 'Invalid quote', 400);
  }
  if (quote.usedAt) throw new AppError('QUOTE_USED', 'Quote already used', 400);
  if (quote.expiresAt.getTime() < Date.now()) {
    throw new AppError('QUOTE_EXPIRED', 'Quote expired', 400);
  }
  const expectedSig = signQuote(
    `${quote.quoteId}:${riderId}:${quote.fare?.totalPaise}:${quote.expiresAt.toISOString()}`,
  );
  if (quote.signature !== expectedSig) {
    throw new AppError('QUOTE_INVALID', 'Quote signature mismatch', 400);
  }

  const otp = String(randomInt(1000, 9999));
  const matching = await getMatchingConfig();
  const dispatchCfg = await getDispatchConfig();
  const flags = await getCustomerFlags();
  const shaktiStrict = Boolean(quote.shakti && flags.prila_shakti && flags.prila_shakti_strict !== false);
  const searchSec = dispatchCfg.enabled ? dispatchCfg.maxSearchSec : matching.maxSearchTimeSec;

  const ride = await Ride.create({
    status: 'requested',
    riderId: new Types.ObjectId(riderId),
    cityId: quote.cityId,
    serviceType: quote.serviceType,
    quoteId: quote.quoteId,
    pickup: quote.pickup,
    drop: quote.drop,
    distanceM: quote.distanceM ?? 0,
    durationSec: quote.durationSec ?? 0,
    fare: quote.fare,
    fareTotalPaise: quote.fare?.totalPaise ?? 0,
    platformRevenuePaise: quote.fare?.platformFeePaise ?? 0,
    paymentMethod: body.paymentMethod,
    startOtpHash: hashOtp(otp),
    startOtpHint: otp,
    searchExpiresAt: new Date(Date.now() + searchSec * 1000),
    shakti: quote.shakti,
    idempotencyKey: body.idempotencyKey,
    timeline: [
      {
        at: new Date(),
        to: 'requested',
        actor: 'rider',
        actorId: riderId,
      },
    ],
  } as never);

  quote.usedAt = new Date();
  await quote.save();

  if (quote.fare?.couponCode && quote.fare.discountPaise) {
    await CouponRedemption.create({
      couponCode: quote.fare.couponCode,
      riderId,
      rideId: ride._id,
      discountPaise: quote.fare.discountPaise,
    });
  }

  await transition(String(ride._id), 'requested', 'searching', {}, 'system');

  if (dispatchCfg.enabled) {
    await runBatchOffer(app, String(ride._id), { shaktiStrict });
  } else {
    await offerBatchLegacy(app, String(ride._id), shaktiStrict);
  }

  const fresh = await Ride.findById(ride._id);
  return serializeRide(fresh!, { includeOtp: true });
}

/** Rollback path when dispatch.enabled=false — Mongo $geoNear batch offer. */
async function offerBatchLegacy(app: FastifyInstance, rideId: string, shaktiStrict: boolean) {
  const ride = await Ride.findById(rideId);
  if (!ride || ride.status !== 'searching') return;
  if (ride.searchExpiresAt && ride.searchExpiresAt.getTime() < Date.now()) {
    await transition(rideId, 'searching', 'no_pilot_found', {}, 'system');
    emitToRider(app, String(ride.riderId), 'ride:updated', { rideId });
    return;
  }

  const matching = await getMatchingConfig();
  const coords = ride.pickup?.location?.coordinates ?? [79.5941, 17.9689];
  const lng = coords[0] ?? 79.5941;
  const lat = coords[1] ?? 17.9689;
  const exclude = [...(ride.offeredPilotIds ?? []), ...(ride.skippedPilotIds ?? [])];
  const candidates = await findCandidatePilots({
    lng,
    lat,
    serviceType: ride.serviceType ?? 'bike',
    excludeIds: exclude,
    shaktiStrict,
    limit: matching.batchSize,
    radiusM: matching.searchRadiusM,
  });

  if (!candidates.length) {
    const attempt = (ride.matchingAttempt ?? 0) + 1;
    if (attempt > matching.retries) {
      await transition(rideId, 'searching', 'no_pilot_found', { matchingAttempt: attempt }, 'system');
      emitToRider(app, String(ride.riderId), 'ride:updated', { rideId });
      return;
    }
    await Ride.updateOne({ _id: rideId }, { $set: { matchingAttempt: attempt } });
    setTimeout(() => {
      void offerBatchLegacy(app, rideId, shaktiStrict);
    }, 3000);
    return;
  }

  const ids = candidates.map((c) => c._id);
  const deadline = new Date(Date.now() + matching.acceptTimeoutSec * 1000);
  await Ride.updateOne(
    { _id: rideId },
    {
      $addToSet: { offeredPilotIds: { $each: ids } },
      $set: { acceptDeadlineAt: deadline },
      $inc: { matchingAttempt: 1 },
    },
  );

  const payload = {
    rideId,
    serviceType: ride.serviceType,
    pickup: ride.pickup,
    drop: ride.drop,
    distanceM: ride.distanceM,
    fareTotalPaise: ride.fareTotalPaise,
    acceptTimeoutSec: matching.acceptTimeoutSec,
    acceptDeadlineAt: deadline.toISOString(),
    expiresAt: deadline.toISOString(),
  };

  for (const p of candidates) {
    emitToPilot(app, String(p._id), 'ride:offer', payload);
  }

  setTimeout(() => {
    void onOfferTimeoutLegacy(app, rideId, shaktiStrict);
  }, matching.acceptTimeoutSec * 1000 + 200);
}

async function onOfferTimeoutLegacy(app: FastifyInstance, rideId: string, shaktiStrict: boolean) {
  const ride = await Ride.findById(rideId);
  if (!ride || ride.status !== 'searching') return;
  await offerBatchLegacy(app, rideId, shaktiStrict);
}

export async function accept(
  app: FastifyInstance,
  pilotId: string,
  rideId: string,
  idempotencyKey: string,
) {
  const already = await Ride.findOne({
    _id: rideId,
    pilotId,
    status: { $in: ACTIVE_PILOT_STATUSES },
  });
  if (already) return serializeRide(already);

  const busy = await Ride.findOne({ pilotId, status: { $in: ACTIVE_PILOT_STATUSES } });
  if (busy) throw new AppError('PILOT_BUSY', 'You already have an active ride', 409);

  const ride = await Ride.findById(rideId);
  if (!ride || ride.status !== 'searching') {
    throw new AppError('RIDE_STATE_INVALID', 'Ride not open for accept', 409);
  }

  const updated = await Ride.findOneAndUpdate(
    { _id: rideId, status: 'searching' },
    {
      $set: {
        status: 'pilot_assigned',
        pilotId,
        acceptDeadlineAt: null,
        pickupEtaSec: Math.round((ride.distanceM ?? 3000) / 8), // rough
      },
      $push: {
        timeline: {
          at: new Date(),
          from: 'searching',
          to: 'pilot_assigned',
          actor: 'pilot',
          actorId: pilotId,
        },
      },
    },
    { returnDocument: 'after' },
  );
  if (!updated) throw new AppError('RIDE_TAKEN', 'Another pilot accepted', 409);

  await Pilot.updateOne({ _id: pilotId }, { $set: { idle: false } });
  markPilotOnRide(pilotId, rideId);
  markDirty(pilotId);
  await transition(rideId, 'pilot_assigned', 'pilot_arriving', {}, 'system');

  emitToRider(app, String(updated.riderId), 'ride:assigned', { rideId });
  emitToRider(app, String(updated.riderId), 'ride:updated', { rideId });
  emitToPilot(app, pilotId, 'ride:updated', { rideId });
  void notifyUser('rider', String(updated.riderId), 'Pilot assigned', 'Your pilot is on the way', {
    rideId,
    deepLink: `prila://ride/${rideId}`,
  });
  releaseOtherOffers(
    app,
    rideId,
    pilotId,
    (updated.offeredPilotIds ?? []).map(String),
  );

  void idempotencyKey;
  const fresh = await Ride.findById(rideId);
  return serializeRide(fresh!);
}

export async function skip(app: FastifyInstance, pilotId: string, rideId: string) {
  const ride = await Ride.findById(rideId);
  if (!ride || ride.status !== 'searching') {
    throw new AppError('RIDE_STATE_INVALID', 'Nothing to skip', 409);
  }
  await Ride.updateOne(
    { _id: rideId },
    { $addToSet: { skippedPilotIds: new Types.ObjectId(pilotId) } },
  );
  emitToPilot(app, pilotId, 'ride:offer_cleared', { rideId });
  return { ok: true };
}

export async function arrived(app: FastifyInstance, pilotId: string, rideId: string) {
  const ride = await Ride.findOne({ _id: rideId, pilotId });
  if (!ride) throw new AppError('NOT_FOUND', 'Ride not found', 404);
  const updated = await transition(rideId, ['pilot_assigned', 'pilot_arriving'], 'pilot_arrived', {}, 'pilot', pilotId);
  emitToRider(app, String(updated.riderId), 'ride:updated', { rideId });
  void notifyUser('rider', String(updated.riderId), 'Pilot arrived', 'Your pilot has arrived', {
    rideId,
    deepLink: `prila://ride/${rideId}`,
  });
  return serializeRide(updated);
}

export async function start(
  app: FastifyInstance,
  pilotId: string,
  rideId: string,
  otp: string,
) {
  const ride = await Ride.findOne({ _id: rideId, pilotId });
  if (!ride) throw new AppError('NOT_FOUND', 'Ride not found', 404);
  if (ride.startOtpHash !== hashOtp(otp)) {
    throw new AppError('OTP_INVALID', 'Invalid ride OTP', 400);
  }
  const updated = await transition(
    rideId,
    'pilot_arrived',
    'in_progress',
    { startOtpHint: null },
    'pilot',
    pilotId,
  );
  emitToRider(app, String(updated.riderId), 'ride:updated', { rideId });
  return serializeRide(updated);
}

export async function complete(
  app: FastifyInstance,
  pilotId: string,
  rideId: string,
  collectedCash: boolean,
) {
  const ride = await Ride.findOne({ _id: rideId, pilotId });
  if (!ride) throw new AppError('NOT_FOUND', 'Ride not found', 404);
  const updated = await transition(
    rideId,
    'in_progress',
    'completed',
    {
      paymentStatus: collectedCash && ride.paymentMethod === 'cash' ? 'paid' : 'unpaid',
    },
    'pilot',
    pilotId,
  );
  if (updated.paymentStatus === 'paid') {
    await transition(rideId, 'completed', 'paid', {}, 'system');
  }
  const { settleRideCompletion } = await import('../ledger/service.js');
  await settleRideCompletion(rideId);
  await Pilot.updateOne({ _id: pilotId }, { $set: { idle: true } });
  markPilotIdle(pilotId);
  emitToRider(app, String(updated.riderId), 'ride:updated', { rideId });
  void notifyUser('rider', String(updated.riderId), 'Trip completed', 'Thanks for riding with Prila', {
    rideId,
    deepLink: `prila://ride/${rideId}/rate`,
  });
  void notifyUser('pilot', pilotId, 'Trip completed', 'Earnings updated', {
    rideId,
    deepLink: `prilapilot://earnings`,
  });
  const fresh = await Ride.findById(rideId);
  return serializeRide(fresh!);
}

export async function cancel(
  app: FastifyInstance,
  actor: { id: string; role: 'rider' | 'pilot' | 'admin' },
  rideId: string,
  reasonCode: string,
  reasonText?: string,
) {
  const ride = await Ride.findById(rideId);
  if (!ride) throw new AppError('NOT_FOUND', 'Ride not found', 404);

  let next: RideStatus;
  if (actor.role === 'rider') next = 'cancelled_by_rider';
  else if (actor.role === 'pilot') next = 'cancelled_by_pilot';
  else next = 'cancelled_by_system';

  if (!canTransition(ride.status as RideStatus, next)) {
    throw new AppError('RIDE_STATE_INVALID', 'Cannot cancel in this state', 409);
  }

  const fee =
    ['pilot_assigned', 'pilot_arriving', 'pilot_arrived'].includes(ride.status) && actor.role === 'rider'
      ? ride.fare?.cancellationFeePaise ?? 0
      : 0;

  const updated = await transition(
    rideId,
    ride.status as RideStatus,
    next,
    {
      cancelReasonCode: reasonCode,
      cancelReasonText: reasonText,
      platformRevenuePaise: (ride.platformRevenuePaise ?? 0) + fee,
    },
    actor.role === 'admin' ? 'admin' : actor.role,
    actor.id,
  );

  await releaseOfferOnCancel(app, rideId);
  if (ride.pilotId) {
    await Pilot.updateOne({ _id: ride.pilotId }, { $set: { idle: true } });
    markPilotIdle(String(ride.pilotId));
    emitToPilot(app, String(ride.pilotId), 'ride:updated', { rideId });
  }
  emitToRider(app, String(ride.riderId), 'ride:updated', { rideId });
  return serializeRide(updated);
}

export async function rate(
  actor: { id: string; role: 'rider' | 'pilot' },
  rideId: string,
  rating: number,
  tags: string[],
) {
  const ride = await Ride.findById(rideId);
  if (!ride) throw new AppError('NOT_FOUND', 'Ride not found', 404);
  if (!['completed', 'paid'].includes(ride.status)) {
    throw new AppError('RIDE_STATE_INVALID', 'Rate after completion', 409);
  }
  if (actor.role === 'rider') {
    if (String(ride.riderId) !== actor.id) throw new AppError('FORBIDDEN', 'Forbidden', 403);
    ride.pilotRating = rating;
    ride.pilotRatingTags = tags;
    await ride.save();
    if (ride.pilotId) {
      const { refreshPilotRating } = await import('../ledger/service.js');
      await refreshPilotRating(String(ride.pilotId));
    }
  } else {
    if (String(ride.pilotId) !== actor.id) throw new AppError('FORBIDDEN', 'Forbidden', 403);
    ride.riderRating = rating;
    ride.riderRatingTags = tags;
    await ride.save();
  }
  return serializeRide(ride);
}

export async function getRide(rideId: string, viewer: { id: string; role: string }) {
  const ride = await Ride.findById(rideId);
  if (!ride) throw new AppError('NOT_FOUND', 'Ride not found', 404);
  if (viewer.role === 'access' && String(ride.riderId) !== viewer.id) {
    throw new AppError('FORBIDDEN', 'Forbidden', 403);
  }
  if (viewer.role === 'pilot') {
    const isAssigned = ride.pilotId && String(ride.pilotId) === viewer.id;
    const offered = (ride.offeredPilotIds ?? []).some((id) => String(id) === viewer.id);
    if (!isAssigned && !offered) throw new AppError('FORBIDDEN', 'Forbidden', 403);
  }
  // admin: allowed
  return serializeRide(ride, {
    includeOtp: viewer.role === 'access' && ['pilot_assigned', 'pilot_arriving', 'pilot_arrived'].includes(ride.status),
  });
}

export async function listRides(filter: Record<string, unknown>, page: number, limit: number) {
  const [items, total] = await Promise.all([
    Ride.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Ride.countDocuments(filter),
  ]);
  return { items: items.map((r) => serializeRide(r)), page, limit, total };
}

/** REST poll fallback when socket offer missed (industry: REST source of truth). */
export async function listPilotOffers(pilotId: string) {
  const rides = await Ride.find({
    status: 'searching',
    offeredPilotIds: new Types.ObjectId(pilotId),
    skippedPilotIds: { $ne: new Types.ObjectId(pilotId) },
    $or: [{ acceptDeadlineAt: null }, { acceptDeadlineAt: { $gt: new Date() } }],
  })
    .sort({ updatedAt: -1 })
    .limit(5);
  return {
    items: rides.map((r) => ({
      ...serializeRide(r),
      acceptDeadlineAt: r.acceptDeadlineAt,
    })),
  };
}

export async function setPilotOnline(pilotId: string, online: boolean, loc?: { lat: number; lng: number }) {
  if (online) {
    const { assertPilotCanGoOnline } = await import('../ledger/service.js');
    await assertPilotCanGoOnline(pilotId);
  }
  const patch: Record<string, unknown> = { online, idle: online ? true : false };
  if (loc) {
    patch.location = point(loc.lng, loc.lat);
  }
  await Pilot.updateOne({ _id: pilotId }, { $set: patch });
  if (!online) {
    markPilotOffline(pilotId);
  } else if (loc) {
    await ingestPilotLocation(pilotId, { ...loc, recordedAt: Date.now() }, { forceOnline: true });
    markDirty(pilotId);
  }
  return { online };
}

export async function updatePilotLocation(
  app: FastifyInstance,
  pilotId: string,
  loc: {
    lat: number;
    lng: number;
    accuracyM?: number;
    headingDeg?: number;
    speedMps?: number;
    recordedAt?: string | number;
    isMocked?: boolean;
  },
) {
  const result = await ingestPilotLocation(pilotId, loc);
  if (result.ok) {
    markDirty(pilotId);
  }

  const ride = await Ride.findOne({
    pilotId,
    status: { $in: ['pilot_assigned', 'pilot_arriving', 'pilot_arrived', 'in_progress'] },
  });
  if (ride && result.ok) {
    await Ride.updateOne(
      { _id: ride._id },
      {
        $set: {
          lastPilotLocation: point(loc.lng, loc.lat),
          lastPilotLocationAt: new Date(),
        },
      },
    );
    app.io?.of('/rider').to(`ride:${ride._id}`).emit('ride:location', {
      rideId: String(ride._id),
      lat: loc.lat,
      lng: loc.lng,
      at: new Date().toISOString(),
    });
  }
  return { ok: result.ok, reason: result.ok ? undefined : result.reason };
}

export function serializeRide(
  ride: InstanceType<typeof Ride>,
  opts?: { includeOtp?: boolean },
) {
  const o = ride.toObject();
  return {
    id: String(o._id),
    status: o.status,
    riderId: String(o.riderId),
    pilotId: o.pilotId ? String(o.pilotId) : null,
    serviceType: o.serviceType,
    pickup: o.pickup,
    drop: o.drop,
    distanceM: o.distanceM,
    durationSec: o.durationSec,
    fare: o.fare,
    fareTotalPaise: o.fareTotalPaise,
    pilotNetPaise: o.pilotNetPaise,
    commissionPaise: o.commissionPaise,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    pickupEtaSec: o.pickupEtaSec,
    shakti: o.shakti,
    acceptDeadlineAt: o.acceptDeadlineAt,
    searchExpiresAt: o.searchExpiresAt,
    timeline: o.timeline,
    lastPilotLocation: o.lastPilotLocation,
    lastPilotLocationAt: o.lastPilotLocationAt,
    startOtp: opts?.includeOtp ? o.startOtpHint : undefined,
    riderRating: o.riderRating,
    pilotRating: o.pilotRating,
    cancelReasonCode: o.cancelReasonCode,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

async function notifyUser(
  typ: 'rider' | 'pilot',
  userId: string,
  title: string,
  body: string,
  data?: Record<string, string>,
) {
  try {
    const { pushToUser } = await import('../push/devices.js');
    const { createInboxNotification } = await import('../push/inbox.js');
    await pushToUser(typ, userId, title, body, data);
    await createInboxNotification({ userId, typ, title, body, data });
  } catch {
    /* push optional */
  }
}

function emitToRider(app: FastifyInstance, riderId: string, event: string, payload: unknown) {
  try {
    app.io?.of('/rider').to(`rider:${riderId}`).emit(event, payload);
  } catch {
    /* socket optional in tests */
  }
}

function emitToPilot(app: FastifyInstance, pilotId: string, event: string, payload: unknown) {
  try {
    app.io?.of('/pilot').to(`pilot:${pilotId}`).emit(event, payload);
  } catch {
    /* socket optional in tests */
  }
}
