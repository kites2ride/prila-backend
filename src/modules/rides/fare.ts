import { Types } from 'mongoose';
import { City, FareRule } from '../app/model.js';
import { readCityPricing, timeCharges } from './pricing.js';
import { AppError } from '../../lib/errors.js';
import { CouponRedemption, CouponRule } from '../coupons/model.js';
import { Rider } from '../auth/model.js';
import { Ride } from './model.js';

export type FareInput = {
  cityId: string;
  serviceType: 'bike' | 'auto' | 'parcel' | 'logistics' | string;
  distanceM: number;
  /** Trip time used for the per-minute charge (includes live traffic when that is on). */
  durationSec: number;
  /** Trip time without traffic; defaults to durationSec. The price cap is measured against this. */
  normalDurationSec?: number;
  waitingSec?: number;
  /** Quote time; night and rush-hour windows are checked in the city's timezone. */
  at?: Date;
  /** Live "few pilots nearby" multiplier (H3 surge), snapshotted into the quote. */
  liveSurge?: number;
  applySurge?: boolean;
  couponCode?: string;
  riderId?: string;
  flags?: Record<string, boolean>;
};

type FareRuleLean = {
  baseFarePaise: number;
  perKmPaise: number;
  perMinutePaise: number;
  waitingPerMinutePaise: number;
  nightMultiplier: number;
  surgeMultiplier: number;
  minimumFarePaise: number;
  platformFeePaise: number;
  cancellationFeePaise: number;
  version: number;
};

/** Why the price is above normal; shown to the rider on the fare screen. */
export type PriceReason = 'night' | 'rush_hour' | 'high_demand' | 'traffic';

/** Traffic shows as a reason only when it adds at least this much time. */
const TRAFFIC_REASON_MIN_SEC = 180;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Pure price maths shared by the rider estimate and the admin preview.
 * Order: trip parts -> x night x rush hour x demand -> cap (maxMultiplier x normal fare).
 * Minimum fare, coupon and platform fee are applied after this by the caller.
 */
export function priceTrip(
  rule: Pick<FareRuleLean, 'baseFarePaise' | 'perKmPaise' | 'perMinutePaise' | 'waitingPerMinutePaise'>,
  p: {
    distanceM: number;
    durationSec: number;
    normalDurationSec?: number;
    waitingSec?: number;
    nightMultiplier: number;
    rushMultiplier: number;
    demandMultiplier: number;
    maxMultiplier: number;
  },
) {
  const distancePaise = Math.round(rule.perKmPaise * (p.distanceM / 1000));
  const timePaise = Math.round(rule.perMinutePaise * (p.durationSec / 60));
  const normalDurationSec = Math.min(p.normalDurationSec ?? p.durationSec, p.durationSec);
  const normalTimePaise = Math.round(rule.perMinutePaise * (normalDurationSec / 60));
  const waitingPaise = Math.round((rule.waitingPerMinutePaise ?? 0) * ((p.waitingSec ?? 0) / 60));

  const normalPaise = rule.baseFarePaise + distancePaise + normalTimePaise + waitingPaise;
  const withTrafficPaise = rule.baseFarePaise + distancePaise + timePaise + waitingPaise;
  const night = Math.max(1, p.nightMultiplier);
  const rush = Math.max(1, p.rushMultiplier);
  const demand = Math.max(1, p.demandMultiplier);

  const raw = Math.round(withTrafficPaise * night * rush * demand);
  const ceiling = Math.round(normalPaise * Math.max(1, p.maxMultiplier));
  const fare = Math.min(raw, ceiling);
  const trafficExtraSec = Math.max(0, p.durationSec - normalDurationSec);

  const reasons: PriceReason[] = [];
  if (night > 1) reasons.push('night');
  if (rush > 1) reasons.push('rush_hour');
  if (demand > 1) reasons.push('high_demand');
  if (trafficExtraSec >= TRAFFIC_REASON_MIN_SEC && timePaise > normalTimePaise) reasons.push('traffic');

  return {
    distancePaise,
    timePaise,
    waitingPaise,
    normalFarePaise: normalPaise,
    farePaise: fare,
    nightMultiplier: night,
    rushMultiplier: rush,
    surgeMultiplier: round2(demand),
    trafficExtraSec,
    /** Final price / normal price, after the cap (1 = normal). */
    priceMultiplier: normalPaise > 0 ? round2(fare / normalPaise) : 1,
    capped: raw > ceiling,
    reasons,
  };
}

export async function calculateFare(input: FareInput) {
  const serviceType = input.serviceType as 'bike' | 'auto' | 'parcel' | 'logistics';
  const [rule, city] = await Promise.all([
    FareRule.findOne({ cityId: new Types.ObjectId(input.cityId), serviceType }).lean() as Promise<FareRuleLean | null>,
    City.findById(input.cityId).select('timezone pricing').lean(),
  ]);
  if (!rule) throw new AppError('NOT_FOUND', 'Fare rule not found', 404);

  const pricing = readCityPricing(city?.pricing);
  const { isNight, rushMultiplier } = timeCharges(pricing, input.at ?? new Date(), city?.timezone ?? 'Asia/Kolkata');
  const demandMultiplier = input.applySurge === false ? 1 : (rule.surgeMultiplier ?? 1) * (input.liveSurge ?? 1);

  const priced = priceTrip(rule, {
    distanceM: input.distanceM,
    durationSec: input.durationSec,
    normalDurationSec: input.normalDurationSec,
    waitingSec: input.waitingSec,
    nightMultiplier: isNight ? (rule.nightMultiplier ?? 1) : 1,
    rushMultiplier,
    demandMultiplier,
    maxMultiplier: pricing.maxMultiplier,
  });

  const beforeMin = priced.farePaise;
  // Minimum fare, then the coupon on the final (already surged) fare, then the platform fee.
  const subtotal = Math.max(beforeMin, rule.minimumFarePaise);

  let discountPaise = 0;
  let couponCode: string | undefined;
  if (input.couponCode && input.flags?.coupons && input.riderId) {
    const applied = await applyCoupon({
      code: input.couponCode,
      riderId: input.riderId,
      farePaise: subtotal,
      serviceType: input.serviceType,
      cityId: input.cityId,
      flags: input.flags,
    });
    discountPaise = applied.discountPaise;
    couponCode = applied.code;
  }

  const afterDiscount = Math.max(0, subtotal - discountPaise);
  const total = afterDiscount + rule.platformFeePaise;

  return {
    baseFarePaise: rule.baseFarePaise,
    distancePaise: priced.distancePaise,
    timePaise: priced.timePaise,
    waitingPaise: priced.waitingPaise,
    nightMultiplier: priced.nightMultiplier,
    rushMultiplier: priced.rushMultiplier,
    surgeMultiplier: priced.surgeMultiplier,
    trafficExtraSec: priced.trafficExtraSec,
    normalFarePaise: priced.normalFarePaise,
    priceMultiplier: priced.priceMultiplier,
    capped: priced.capped,
    reasons: priced.reasons,
    minimumFarePaise: rule.minimumFarePaise,
    platformFeePaise: rule.platformFeePaise,
    cancellationFeePaise: rule.cancellationFeePaise,
    beforeMinimumPaise: beforeMin,
    discountPaise,
    couponCode,
    totalPaise: total,
    configVersion: rule.version,
  };
}

async function applyCoupon(input: {
  code: string;
  riderId: string;
  farePaise: number;
  serviceType: string;
  cityId: string;
  flags: Record<string, boolean>;
}) {
  const rule = await CouponRule.findOne({ code: input.code.toUpperCase(), enabled: true }).lean();
  if (!rule) throw new AppError('COUPON_INVALID', 'Coupon not found or disabled', 400);

  const now = new Date();
  if (rule.startsAt && rule.startsAt > now) throw new AppError('COUPON_INVALID', 'Coupon not started', 400);
  if (rule.endsAt && rule.endsAt < now) throw new AppError('COUPON_INVALID', 'Coupon expired', 400);
  if (input.farePaise < (rule.minFarePaise ?? 0)) {
    throw new AppError('COUPON_INVALID', 'Fare below coupon minimum', 400);
  }

  const uses = await CouponRedemption.countDocuments({
    couponCode: rule.code,
    riderId: input.riderId,
  });
  if (uses >= (rule.perUserLimit ?? 1)) {
    throw new AppError('COUPON_INVALID', 'Coupon already used', 400);
  }

  const rider = await Rider.findById(input.riderId).lean();
  const completed = await Ride.countDocuments({
    riderId: input.riderId,
    status: { $in: ['completed', 'paid'] },
  });

  if (rule.kind === 'first_ride' && completed > 0) {
    throw new AppError('COUPON_INVALID', 'First-ride coupon only', 400);
  }
  if (rule.kind === 'ride_milestone') {
    const need = rule.milestoneRideCount ?? 5;
    if (completed < need) {
      throw new AppError('COUPON_INVALID', `Complete ${need} rides first`, 400);
    }
  }
  if (rule.kind === 'student_first') {
    if (!input.flags.student_coupon) {
      throw new AppError('COUPON_INVALID', 'Student coupons disabled', 400);
    }
    if (!rider?.studentVerified) {
      throw new AppError('COUPON_INVALID', 'Student verification required', 400);
    }
    if (completed > 0) {
      throw new AppError('COUPON_INVALID', 'Student first-ride only', 400);
    }
  }

  let discount =
    rule.discountMode === 'percentage'
      ? Math.round((input.farePaise * rule.discountValue) / 10_000)
      : rule.discountValue;
  if (rule.maxDiscountPaise != null) discount = Math.min(discount, rule.maxDiscountPaise);
  discount = Math.min(discount, input.farePaise);

  return { code: rule.code, discountPaise: discount };
}
