import { Types } from 'mongoose';
import { FareRule } from '../app/model.js';
import { AppError } from '../../lib/errors.js';
import { CouponRedemption, CouponRule } from '../coupons/model.js';
import { Rider } from '../auth/model.js';
import { Ride } from './model.js';

export type FareInput = {
  cityId: string;
  serviceType: 'bike' | 'auto' | 'parcel' | 'logistics' | string;
  distanceM: number;
  durationSec: number;
  waitingSec?: number;
  isNight?: boolean;
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

export async function calculateFare(input: FareInput) {
  const serviceType = input.serviceType as 'bike' | 'auto' | 'parcel' | 'logistics';
  const rule = (await FareRule.findOne({
    cityId: new Types.ObjectId(input.cityId),
    serviceType,
  }).lean()) as FareRuleLean | null;
  if (!rule) throw new AppError('NOT_FOUND', 'Fare rule not found', 404);

  const distanceKm = input.distanceM / 1000;
  const durationMin = input.durationSec / 60;
  const waitingMin = (input.waitingSec ?? 0) / 60;

  let subtotal =
    rule.baseFarePaise +
    Math.round(rule.perKmPaise * distanceKm) +
    Math.round(rule.perMinutePaise * durationMin) +
    Math.round(rule.waitingPerMinutePaise * waitingMin);

  if (input.isNight) subtotal = Math.round(subtotal * rule.nightMultiplier);
  if (input.applySurge !== false) subtotal = Math.round(subtotal * rule.surgeMultiplier);

  const beforeMin = subtotal;
  subtotal = Math.max(subtotal, rule.minimumFarePaise);

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
    distancePaise: Math.round(rule.perKmPaise * distanceKm),
    timePaise: Math.round(rule.perMinutePaise * durationMin),
    waitingPaise: Math.round(rule.waitingPerMinutePaise * waitingMin),
    nightMultiplier: rule.nightMultiplier,
    surgeMultiplier: rule.surgeMultiplier,
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
