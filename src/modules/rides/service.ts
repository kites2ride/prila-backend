import { createHash, randomBytes, randomInt, createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { City } from '../app/model.js';
import { Pilot, Rider } from '../auth/model.js';
import { CouponRedemption } from '../coupons/model.js';
import { calculateFare } from './fare.js';
import { reverse as reverseGeocode, routeForEstimate } from '../maps/service.js';
import { isRealPlaceName } from '../places/service.js';
import { assertPilotInServiceArea, assertTripInServiceArea } from '../zones/service.js';
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
import { blockPilotForRider, blockedPilotIds, calculateCancellationFee, isPilotFaultReason } from './cancelPolicy.js';
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

type TripPoint = { lat: number; lng: number; name?: string; address?: string };

/**
 * The drop must carry a real place name (it feeds the rider's recents). When the app sent none or a
 * placeholder, reverse-geocode the exact coordinates; if Google has nothing, the name stays empty
 * (never "Pinned location") and the place simply won't show up in recents.
 */
async function withRealPlace(riderId: string, p: TripPoint): Promise<TripPoint> {
  if (isRealPlaceName(p.name)) return p;
  let address = p.address?.trim() || null;
  if (!address) {
    try {
      address = (await reverseGeocode(riderId, { lat: p.lat, lng: p.lng })).address;
    } catch {
      address = null; // maps down / rate limited: booking must still work
    }
  }
  return { ...p, name: address ? (address.split(',')[0]?.trim() ?? '') : '', address: address ?? '' };
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

  // Geo-fence first (before any paid Google call). When enforced, the city comes from the pickup zone.
  const zoneCityId = await assertTripInServiceArea(
    { lat: body.pickup.lat, lng: body.pickup.lng },
    { lat: body.drop.lat, lng: body.drop.lng },
    body.serviceType,
  );
  body = { ...body, drop: (await withRealPlace(riderId, body.drop)) as typeof body.drop };
  let cityId = zoneCityId ?? body.cityId;
  if (!cityId) {
    const city = await City.findOne({ enabled: true }).lean();
    if (!city) throw new AppError('NO_CITY', 'No serviceable city', 400);
    cityId = String(city._id);
  }

  // One Compute Routes call per estimate (cached per pickup/drop/mode); falls back to
  // straight-line distance if Google is off/down. Reused for the ride — never recomputed live.
  const route = await routeForEstimate(
    { lat: body.pickup.lat, lng: body.pickup.lng },
    { lat: body.drop.lat, lng: body.drop.lng },
    body.serviceType,
  );
  const { distanceM, durationSec, normalDurationSec } = route;

  const shaktiRequested = Boolean(body.shakti && flags.prila_shakti);
  if (shaktiRequested) {
    const rider = await Rider.findById(riderId).lean();
    if (rider?.gender !== 'female') {
      throw new AppError('SHAKTI_INELIGIBLE', 'Prila Shakti requires female rider profile', 403);
    }
  }

  // Live "few pilots nearby" surge is read once here and snapshotted into the quote
  // (never re-read at book/complete). It is applied before the coupon and inside the
  // city's price cap - see calculateFare.
  const liveSurge = await getSurgeMultiplier(cityId, body.pickup.lat, body.pickup.lng);
  const fare = await calculateFare({
    cityId,
    serviceType: body.serviceType,
    distanceM,
    durationSec,
    normalDurationSec,
    liveSurge,
    couponCode: body.couponCode,
    riderId,
    flags,
  });
  void recordDemand(cityId, body.pickup.lat, body.pickup.lng, riderId);

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
    routePolyline: route.polyline,
    routeSource: route.source,
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
    route: { polyline: route.polyline, source: route.source },
    fare,
    shakti: shaktiRequested,
    currency: 'INR',
  };
}

export async function book(
  app: FastifyInstance,
  riderId: string,
  body: { quoteId: string; idempotencyKey: string; paymentMethod: 'cash' | 'upi'; payAt?: 'pickup' | 'drop' },
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
  // Zones may have changed since the estimate (quote TTL) — re-check, no Google calls.
  const [pLng, pLat] = quote.pickup?.location?.coordinates ?? [];
  const [dLng, dLat] = quote.drop?.location?.coordinates ?? [];
  if (pLat !== undefined && pLng !== undefined && dLat !== undefined && dLng !== undefined) {
    await assertTripInServiceArea({ lat: pLat, lng: pLng }, { lat: dLat, lng: dLng }, quote.serviceType);
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
    routePolyline: quote.routePolyline ?? null,
    routeSource: quote.routeSource ?? 'haversine',
    fare: quote.fare,
    fareTotalPaise: quote.fare?.totalPaise ?? 0,
    platformRevenuePaise: quote.fare?.platformFeePaise ?? 0,
    paymentMethod: body.paymentMethod,
    // Parcels: sender pays at pickup (default) or receiver pays at drop.
    payAt: quote.serviceType === 'parcel' ? (body.payAt ?? 'pickup') : null,
    searchStartedAt: new Date(),
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

/**
 * The rider raises the fare while we are finding a pilot, or after "no pilots nearby". The extra goes to
 * the pilot untouched (settlement keeps it out of the commission base) and the search starts again.
 *
 * `boostPaise` is the TOTAL boost wanted, not an increment, so a double tap or a retry can never
 * charge twice. Limits (step, cap, on/off) come from the admin dispatch config.
 */
export async function boostRide(app: FastifyInstance, riderId: string, rideId: string, boostPaise: number) {
  const cfg = await getDispatchConfig();
  const ride = await Ride.findOne({ _id: rideId, riderId });
  if (!ride) throw new AppError('NOT_FOUND', 'Ride not found', 404);
  if (ride.status !== 'searching' && ride.status !== 'no_pilot_found') {
    throw new AppError('RIDE_STATE_INVALID', 'The fare can only be raised while we are finding a pilot', 409);
  }
  if (cfg.boostMaxPaise <= 0) throw new AppError('BOOST_DISABLED', 'Raising the fare is not available right now', 400);

  const current = ride.boostPaise ?? 0;
  if (boostPaise === current) return serializeRide(ride, { includeOtp: true }); // same request again: no-op
  if (boostPaise < current) throw new AppError('BOOST_INVALID', 'The extra can only go up', 400);
  if (boostPaise > cfg.boostMaxPaise) {
    throw new AppError('BOOST_INVALID', `You can add at most ₹${cfg.boostMaxPaise / 100}`, 400);
  }
  if (boostPaise % cfg.boostStepPaise !== 0) {
    throw new AppError('BOOST_INVALID', `Add in steps of ₹${cfg.boostStepPaise / 100}`, 400);
  }

  const baseTotal = (ride.fareTotalPaise ?? 0) - current;
  const newTotal = baseTotal + boostPaise;
  const reopened = ride.status === 'no_pilot_found';
  // Guarded on status + current total, so two quick requests cannot both apply.
  const updated = await Ride.findOneAndUpdate(
    { _id: rideId, riderId, status: ride.status, fareTotalPaise: ride.fareTotalPaise },
    { $set: { boostPaise, fareTotalPaise: newTotal, 'fare.boostPaise': boostPaise, 'fare.totalPaise': newTotal } },
    { new: true },
  );
  if (!updated) throw new AppError('RIDE_STATE_INVALID', 'The ride just changed, please try again', 409);

  if (reopened) {
    const matching = await getMatchingConfig();
    const searchSec = cfg.enabled ? cfg.maxSearchSec : matching.maxSearchTimeSec;
    await transition(
      rideId,
      'no_pilot_found',
      'searching',
      {
        searchStartedAt: new Date(),
        searchExpiresAt: new Date(Date.now() + searchSec * 1000),
        offeredPilotIds: [], // pilots who timed out may take it now that it pays more
      },
      'rider',
      riderId,
    );
    const flags = await getCustomerFlags();
    const shaktiStrict = Boolean(ride.shakti && flags.prila_shakti && flags.prila_shakti_strict !== false);
    if (cfg.enabled) {
      await runBatchOffer(app, rideId, { shaktiStrict });
    } else {
      await offerBatchLegacy(app, rideId, shaktiStrict);
    }
  }
  // A search already running picks the new fare up with its next batch of offers.

  emitToRider(app, riderId, 'ride:updated', { rideId });
  const fresh = await Ride.findById(rideId);
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
  const blocked = (await blockedPilotIds(ride.riderId)).map((id) => new Types.ObjectId(id));
  const exclude = [...(ride.offeredPilotIds ?? []), ...(ride.skippedPilotIds ?? []), ...blocked];
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
  void import('../push/devices.js').then((m) =>
    m.pushRideOffer(
      candidates.map((p) => String(p._id)),
      rideId,
    ),
  );

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

  // Only a pilot this ride was offered to (and who has not skipped / cancelled it) can take it.
  const me = new Types.ObjectId(pilotId);
  if (!(ride.offeredPilotIds ?? []).some((id) => String(id) === pilotId) ||
      (ride.skippedPilotIds ?? []).some((id) => String(id) === pilotId)) {
    throw new AppError('OFFER_NOT_FOR_YOU', 'This ride is no longer offered to you', 409);
  }
  const updated = await Ride.findOneAndUpdate(
    { _id: rideId, status: 'searching', offeredPilotIds: me, skippedPilotIds: { $ne: me } },
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
  cashCollected?: boolean,
) {
  const ride = await Ride.findOne({ _id: rideId, pilotId });
  if (!ride) throw new AppError('NOT_FOUND', 'Ride not found', 404);
  if (ride.startOtpHash !== hashOtp(otp)) {
    throw new AppError('OTP_INVALID', 'Invalid ride OTP', 400);
  }
  // Parcel paid by the sender at pickup: the pilot must confirm the cash before starting.
  const payNow = ride.payAt === 'pickup' && ride.paymentMethod === 'cash';
  if (payNow && cashCollected !== true) {
    throw new AppError('CASH_FIRST', 'Collect the parcel fare from the sender before starting', 400);
  }
  const updated = await transition(
    rideId,
    'pilot_arrived',
    'in_progress',
    payNow ? { startOtpHint: null, paymentStatus: 'paid', cashCollectedAt: new Date() } : { startOtpHint: null },
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
  notCollectedReason?: 'receiver_refused' | 'rider_refused' | 'other',
) {
  const ride = await Ride.findOne({ _id: rideId, pilotId });
  if (!ride) throw new AppError('NOT_FOUND', 'Ride not found', 404);
  const alreadyPaid = ride.paymentStatus === 'paid'; // parcel paid at pickup
  const paid = alreadyPaid || (collectedCash && ride.paymentMethod === 'cash');
  const cashMissing = !paid && ride.paymentMethod === 'cash';
  const updated = await transition(
    rideId,
    'in_progress',
    'completed',
    {
      paymentStatus: paid ? 'paid' : 'unpaid',
      ...(paid && !alreadyPaid ? { cashCollectedAt: new Date() } : {}),
      // Ops follow up with the sender / rider (admin -> Rides -> Payment not collected).
      ...(cashMissing
        ? {
            paymentIssue: {
              code: notCollectedReason ?? (ride.payAt === 'drop' ? 'receiver_refused' : 'other'),
              at: new Date(),
            },
          }
        : {}),
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
  opts: { feePaise?: number } = {},
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
    opts.feePaise ??
    (['pilot_assigned', 'pilot_arriving', 'pilot_arrived'].includes(ride.status) && actor.role === 'rider'
      ? ride.fare?.cancellationFeePaise ?? 0
      : 0);

  const updated = await transition(
    rideId,
    ride.status as RideStatus,
    next,
    {
      cancelReasonCode: reasonCode,
      cancelReasonText: reasonText,
      cancellationFeePaise: fee,
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

/* ───────────────────────── rider cancel (reason + fee + pilot block + rematch) ───────────────────────── */

const RIDER_CANCELLABLE: RideStatus[] = ['requested', 'searching', 'pilot_assigned', 'pilot_arriving', 'pilot_arrived'];

/**
 * Rider cancels. Free while searching, for pilot-fault reasons, and inside the grace window; otherwise the
 * fare rule's fee applies (default 0). A pilot-fault reason blocks that pilot for this rider for 30 minutes
 * and bumps the pilot's cancellationFlags. `rematch` keeps the ride and searches again without that pilot.
 */
export async function riderCancel(
  app: FastifyInstance,
  riderId: string,
  rideId: string,
  body: { reasonCode: string; reasonText?: string; rematch?: boolean },
) {
  const ride = await Ride.findOne({ _id: rideId, riderId });
  if (!ride) throw new AppError('NOT_FOUND', 'Ride not found', 404);
  if (ride.status === 'cancelled_by_rider') return serializeRide(ride); // retry / double tap
  if (ride.status === 'in_progress') {
    throw new AppError('RIDE_IN_PROGRESS', 'The trip has started. Call Prila support to cancel it.', 409);
  }
  if (!RIDER_CANCELLABLE.includes(ride.status as RideStatus)) {
    throw new AppError('RIDE_STATE_INVALID', 'This ride can no longer be cancelled', 409);
  }

  const pilotId = ride.pilotId ? String(ride.pilotId) : null;
  const faultReason = isPilotFaultReason(body.reasonCode);
  if (body.rematch && !(faultReason && pilotId)) {
    throw new AppError('VALIDATION_ERROR', 'Find another Captain needs a Captain-related reason', 400);
  }
  const fee = calculateCancellationFee(ride, body.reasonCode);

  if (pilotId && faultReason) {
    await blockPilotForRider({ riderId, pilotId, rideId, reasonCode: body.reasonCode });
    await Pilot.updateOne({ _id: pilotId }, { $inc: { cancellationFlags: 1 } });
  }

  if (!body.rematch) {
    const ended = await cancel(app, { id: riderId, role: 'rider' }, rideId, body.reasonCode, body.reasonText, { feePaise: fee });
    if (pilotId) {
      void notifyUser('pilot', pilotId, 'Ride cancelled', 'The rider cancelled this ride.', {
        rideId,
        deepLink: 'prilapilot://home',
      });
    }
    return ended;
  }

  // Rematch: same ride goes back to searching, previous pilot excluded.
  const dispatchCfg = await getDispatchConfig();
  const matching = await getMatchingConfig();
  const searchSec = dispatchCfg.enabled ? dispatchCfg.maxSearchSec : matching.maxSearchTimeSec;
  const now = new Date();
  const updated = await Ride.findOneAndUpdate(
    { _id: rideId, riderId, pilotId, status: { $in: ['pilot_assigned', 'pilot_arriving', 'pilot_arrived'] } },
    {
      $set: {
        status: 'searching',
        pilotId: null,
        acceptDeadlineAt: null,
        lastPilotLocation: null,
        lastPilotLocationAt: null,
        pickupEtaSec: null,
        searchStartedAt: now,
        searchExpiresAt: new Date(now.getTime() + searchSec * 1000),
      },
      $addToSet: { skippedPilotIds: new Types.ObjectId(pilotId!) },
      $push: {
        timeline: {
          at: now,
          from: ride.status,
          to: 'searching',
          actor: 'rider',
          actorId: riderId,
          note: `rider_rematch:${body.reasonCode}`,
        },
      },
    },
    { returnDocument: 'after' },
  );
  if (!updated) throw new AppError('RIDE_STATE_INVALID', 'Ride changed. Refresh and try again.', 409);

  await Pilot.updateOne({ _id: pilotId }, { $set: { idle: true } });
  markPilotIdle(pilotId!);
  markDirty(pilotId!);
  emitToPilot(app, pilotId!, 'ride:updated', { rideId });
  emitToRider(app, riderId, 'ride:updated', { rideId });
  void notifyUser('pilot', pilotId!, 'Ride cancelled', 'The rider cancelled this ride.', {
    rideId,
    deepLink: 'prilapilot://home',
  });

  const flags = await getCustomerFlags();
  const shaktiStrict = Boolean(updated.shakti && flags.prila_shakti && flags.prila_shakti_strict !== false);
  if (dispatchCfg.enabled) await runBatchOffer(app, rideId, { shaktiStrict });
  else await offerBatchLegacy(app, rideId, shaktiStrict);
  const fresh = await Ride.findById(rideId);
  return serializeRide(fresh ?? updated);
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
    const pilot = await Pilot.findById(pilotId).select({ vehicleType: 1, kycStatus: 1 }).lean();
    // Only admin-approved pilots can take rides (dispatch ignores others anyway — say so clearly).
    if (pilot?.kycStatus !== 'approved') {
      throw new AppError(
        'KYC_NOT_APPROVED',
        pilot?.kycStatus === 'pending'
          ? 'Your documents are under review. You can go online after Prila approves them.'
          : 'Complete your documents to go online.',
        403,
      );
    }
    await assertPilotInServiceArea(loc, pilot?.vehicleType);
  }
  const patch: Record<string, unknown> = { online, idle: online ? true : false };
  // Only trust a location for going online; going offline must not move the pilot.
  if (loc && online) {
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
  } else {
    app.log.warn({ pilotId, reason: result.reason }, 'pilot location ping rejected');
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
  return {
    ok: result.ok,
    reason: result.ok ? undefined : result.reason,
    // Pilot is online but outside every service zone: the app shows this and they get no rides here.
    outsideServiceArea: result.ok ? Boolean(result.state.outsideAreaMessage) : undefined,
    message: result.ok ? (result.state.outsideAreaMessage ?? null) : null,
  };
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
    routePolyline: o.routePolyline ?? null,
    fare: o.fare,
    fareTotalPaise: o.fareTotalPaise,
    /** What the rider added to attract a pilot; already inside fareTotalPaise. */
    boostPaise: o.boostPaise ?? 0,
    pilotNetPaise: o.pilotNetPaise,
    commissionPaise: o.commissionPaise,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    payAt: o.payAt ?? null,
    paymentIssue: o.paymentIssue ?? null,
    /** True when a pilot cancelled and we are finding another one. */
    reassigned: (o.pilotCancellations?.length ?? 0) > 0,
    pilotCancelCount: o.pilotCancellations?.length ?? 0,
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
    /** Fee (paise) if the rider cancels now for a rider-side reason; pilot-fault reasons are always free. */
    cancelFeePaise: calculateCancellationFee(o, 'PLAN_CHANGED'),
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

/* ───────────────────────── pilot cancel → find another pilot ───────────────────────── */

const PILOT_CANCELLABLE: RideStatus[] = ['pilot_assigned', 'pilot_arriving', 'pilot_arrived'];

/**
 * Pilot cancels after accepting (before the trip starts). The rider is NOT cancelled:
 * the ride goes back to searching (this pilot excluded) and the rider sees
 * "Your pilot cancelled, finding another pilot". No fee, no pilot penalty (counted only).
 * Exception: parcel sender refused to pay at pickup → the request ends.
 */
export async function pilotCancel(
  app: FastifyInstance,
  pilotId: string,
  rideId: string,
  reasonCode: string,
  reasonText?: string,
) {
  const ride = await Ride.findOne({ _id: rideId, pilotId });
  if (!ride) throw new AppError('NOT_FOUND', 'Ride not found', 404);
  if (ride.status === 'in_progress') {
    throw new AppError('RIDE_IN_PROGRESS', 'The trip has started. Call Prila support to cancel it.', 409);
  }
  if (!PILOT_CANCELLABLE.includes(ride.status as RideStatus)) {
    throw new AppError('RIDE_STATE_INVALID', 'This ride can no longer be cancelled', 409);
  }

  if (reasonCode === 'sender_refused_payment') {
    if (ride.payAt !== 'pickup') throw new AppError('VALIDATION_ERROR', 'Only for parcels paid at pickup', 400);
    await Pilot.updateOne({ _id: pilotId }, { $inc: { cancelCount: 1 } });
    const ended = await cancel(app, { id: pilotId, role: 'pilot' }, rideId, reasonCode, reasonText);
    void notifyUser('rider', String(ride.riderId), 'Parcel cancelled', 'The pilot could not collect the parcel fare at pickup.', {
      rideId,
      deepLink: `prila://ride/${rideId}`,
    });
    return ended;
  }

  const dispatchCfg = await getDispatchConfig();
  const matching = await getMatchingConfig();
  const searchSec = dispatchCfg.enabled ? dispatchCfg.maxSearchSec : matching.maxSearchTimeSec;
  const now = new Date();
  const updated = await Ride.findOneAndUpdate(
    { _id: rideId, pilotId, status: { $in: PILOT_CANCELLABLE } },
    {
      $set: {
        status: 'searching',
        pilotId: null,
        acceptDeadlineAt: null,
        lastPilotLocation: null,
        lastPilotLocationAt: null,
        pickupEtaSec: null,
        searchStartedAt: now,
        searchExpiresAt: new Date(now.getTime() + searchSec * 1000),
      },
      $addToSet: { skippedPilotIds: new Types.ObjectId(pilotId) },
      $push: {
        pilotCancellations: { pilotId: new Types.ObjectId(pilotId), at: now, reasonCode, reasonText },
        timeline: { at: now, from: ride.status, to: 'searching', actor: 'pilot', actorId: pilotId, note: `pilot_cancel:${reasonCode}` },
      },
    },
    { returnDocument: 'after' },
  );
  if (!updated) throw new AppError('RIDE_STATE_INVALID', 'Ride changed. Refresh and try again.', 409);

  await Pilot.updateOne({ _id: pilotId }, { $set: { idle: true }, $inc: { cancelCount: 1 } });
  markPilotIdle(pilotId);
  markDirty(pilotId);

  emitToPilot(app, pilotId, 'ride:updated', { rideId });
  emitToRider(app, String(updated.riderId), 'ride:pilot_cancelled', { rideId });
  emitToRider(app, String(updated.riderId), 'ride:updated', { rideId });
  void notifyUser('rider', String(updated.riderId), 'Finding another pilot', 'Your pilot cancelled. We are finding you another pilot.', {
    rideId,
    deepLink: `prila://ride/${rideId}`,
  });

  const flags = await getCustomerFlags();
  const shaktiStrict = Boolean(updated.shakti && flags.prila_shakti && flags.prila_shakti_strict !== false);
  if (dispatchCfg.enabled) {
    await runBatchOffer(app, rideId, { shaktiStrict });
  } else {
    await offerBatchLegacy(app, rideId, shaktiStrict);
  }
  return { ok: true, rideId, status: 'searching' };
}

/* ───────────────────────── parcel: call the sender ───────────────────────── */

/**
 * Sender's phone for the assigned pilot of an active parcel (e.g. receiver refuses to pay).
 * Only while the parcel is active; each lookup is counted. Real number (no masking yet).
 */
export async function senderContact(pilotId: string, rideId: string) {
  const ride = await Ride.findOne({ _id: rideId, pilotId });
  if (!ride) throw new AppError('NOT_FOUND', 'Ride not found', 404);
  if (ride.serviceType !== 'parcel') throw new AppError('FORBIDDEN', 'Only for parcels', 403);
  if (!['pilot_arriving', 'pilot_arrived', 'in_progress'].includes(ride.status)) {
    throw new AppError('RIDE_STATE_INVALID', 'Only during an active parcel delivery', 409);
  }
  const rider = await Rider.findById(ride.riderId).select('phone name').lean();
  if (!rider?.phone) throw new AppError('NOT_FOUND', 'Sender number not available', 404);
  await Ride.updateOne({ _id: rideId }, { $inc: { senderContactViews: 1 } });
  return { name: rider.name ?? null, phone: rider.phone };
}

/* ───────────────────────── rider: who is coming ───────────────────────── */

const PILOT_CARD_STATUSES = ['pilot_assigned', 'pilot_arriving', 'pilot_arrived', 'in_progress'];

/** Pilot card for the rider: name, approved photo, vehicle, rating. Never the pilot's phone. */
export async function pilotCardFor(ride: { status?: string | null; pilotId?: unknown }) {
  if (!ride.pilotId || !PILOT_CARD_STATUSES.includes(ride.status ?? '')) return null;
  const p = await Pilot.findById(ride.pilotId).select('name vehicleType vehicleNumber ratingAvg ratingCount photoKey').lean();
  if (!p) return null;
  const { signedGetUrl } = await import('../uploads/service.js');
  return {
    name: p.name ?? null,
    vehicleType: p.vehicleType ?? null,
    vehicleNumber: p.vehicleNumber ?? null,
    rating: p.ratingAvg ? Math.round(p.ratingAvg * 10) / 10 : null,
    ratingCount: p.ratingCount ?? 0,
    photoUrl: p.photoKey ? await signedGetUrl(p.photoKey, 3600) : null,
  };
}

const FINISHED_WITH_PILOT = ['completed', 'paid'];

/**
 * Finished trips show who drove in the rider's history. Only the first name-level detail is shared:
 * no photo, plate, rating or phone (the full card is for rides in progress).
 */
export async function pilotNamesFor(rides: { status?: string | null; pilotId?: unknown }[]) {
  const ids = [
    ...new Set(
      rides.filter((r) => r.pilotId && FINISHED_WITH_PILOT.includes(r.status ?? '')).map((r) => String(r.pilotId)),
    ),
  ];
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const pilots = await Pilot.find({ _id: { $in: ids } }).select('name').lean();
  for (const p of pilots) if (p.name) names.set(String(p._id), p.name);
  return names;
}

/** Rider's view of a ride: the ride + the pilot card (name only once the trip is finished). */
export async function riderRideView(rideId: string, riderId: string) {
  const data = await getRide(rideId, { id: riderId, role: 'access' });
  const card = await pilotCardFor({ status: data.status, pilotId: data.pilotId });
  if (card) return { ...data, pilot: card };
  const name = (await pilotNamesFor([data])).get(String(data.pilotId));
  return { ...data, pilot: name ? { name } : null };
}

/** Rider's ride history with the driver's name on finished trips. */
export async function riderRideHistory(riderId: string, page: number, limit: number) {
  const data = await listRides({ riderId }, page, limit);
  const names = await pilotNamesFor(data.items);
  return {
    ...data,
    items: data.items.map((r) => {
      const name = r.pilotId ? names.get(String(r.pilotId)) : undefined;
      return name ? { ...r, pilot: { name } } : r;
    }),
  };
}

/* ───────────────────────── admin: cash not collected ───────────────────────── */

export async function listPaymentIssues(open: boolean, page: number, limit: number) {
  const filter = open
    ? { 'paymentIssue.code': { $exists: true }, 'paymentIssue.resolvedAt': null }
    : { 'paymentIssue.resolvedAt': { $ne: null } };
  return listRides(filter, page, limit);
}

export async function resolvePaymentIssue(actor: string, rideId: string, note: string) {
  const updated = await Ride.findOneAndUpdate(
    { _id: rideId, 'paymentIssue.code': { $exists: true }, 'paymentIssue.resolvedAt': null },
    {
      $set: {
        'paymentIssue.resolvedAt': new Date(),
        'paymentIssue.resolvedBy': actor,
        'paymentIssue.resolutionNote': note,
      },
    },
    { returnDocument: 'after' },
  );
  if (!updated) throw new AppError('NOT_FOUND', 'No open payment issue on this ride', 404);
  return serializeRide(updated);
}
