import { describe, expect, it } from 'vitest';
import { City, FareRule } from '../src/modules/app/model.js';
import { Rider } from '../src/modules/auth/model.js';
import { CouponRule } from '../src/modules/coupons/model.js';
import { getSurgeMultiplier, recordDemand } from '../src/modules/dispatch/surge.js';
import { calculateFare, priceTrip } from '../src/modules/rides/fare.js';
import { inWindow, localMinutes, readCityPricing, timeCharges } from '../src/modules/rides/pricing.js';
import { app, setupTestApp } from './helpers.js';

setupTestApp();

// Bike: ₹20 base + ₹8/km + ₹1/min, min ₹30, night 1.2×.
const RULE = {
  baseFarePaise: 2000, perKmPaise: 800, perMinutePaise: 100, minimumFarePaise: 3000,
  nightMultiplier: 1.2, surgeMultiplier: 1, waitingPerMinutePaise: 0, cancellationFeePaise: 0, platformFeePaise: 500,
};
const TRIP = { distanceM: 10_000, durationSec: 1200 }; // 10 km, 20 min → normal ₹120

/** IST wall-clock time on a fixed day. */
const ist = (hhmm: string) => new Date(`2026-11-16T${hhmm}:00+05:30`);

async function setup(pricing?: object) {

  const city = (await City.findOne({ slug: 'warangal' }))!;
  if (pricing) await City.updateOne({ _id: city._id }, { $set: { pricing } });
  await FareRule.create({ cityId: city._id, serviceType: 'bike', version: 1, ...RULE });
  return String(city._id);
}

describe('pricing windows', () => {
  it('reads times in the city timezone and handles windows over midnight', () => {
    expect(localMinutes(ist('23:30'), 'Asia/Kolkata')).toBe(23 * 60 + 30);
    expect(inWindow(23 * 60, '22:00', '06:00')).toBe(true);
    expect(inWindow(5 * 60 + 59, '22:00', '06:00')).toBe(true);
    expect(inWindow(6 * 60, '22:00', '06:00')).toBe(false); // end is exclusive
    expect(inWindow(9 * 60, '08:00', '11:00')).toBe(true);
    expect(inWindow(9 * 60, '10:00', '10:00')).toBe(false); // same start/end = off

    const p = readCityPricing({ rushHours: [{ start: '08:00', end: '11:00', multiplier: 1.1 }, { start: '09:00', end: '10:00', multiplier: 1.3 }] });
    expect(timeCharges(p, ist('09:30'), 'Asia/Kolkata')).toEqual({ isNight: false, rushMultiplier: 1.3 }); // highest band wins
    expect(timeCharges(p, ist('23:00'), 'Asia/Kolkata')).toEqual({ isNight: true, rushMultiplier: 1 });
    expect(readCityPricing(undefined)).toMatchObject({ nightStart: '22:00', nightEnd: '06:00', rushHours: [], maxMultiplier: 1.5 });
  });

  it('caps night × rush × demand × traffic at 1.5× the normal fare', () => {
    const plain = priceTrip(RULE, { ...TRIP, nightMultiplier: 1, rushMultiplier: 1, demandMultiplier: 1, maxMultiplier: 1.5 });
    expect(plain).toMatchObject({ normalFarePaise: 12000, farePaise: 12000, priceMultiplier: 1, capped: false, reasons: [] });

    const all = priceTrip(RULE, { ...TRIP, nightMultiplier: 1.2, rushMultiplier: 1.1, demandMultiplier: 1.4, maxMultiplier: 1.5 });
    expect(all).toMatchObject({ farePaise: 18000, priceMultiplier: 1.5, capped: true, reasons: ['night', 'rush_hour', 'high_demand'] });

    // Live traffic: 20 min normally, 35 min now → +₹15 time charge, shown as "traffic".
    const traffic = priceTrip(RULE, { ...TRIP, durationSec: 2100, normalDurationSec: 1200, nightMultiplier: 1, rushMultiplier: 1, demandMultiplier: 1, maxMultiplier: 1.5 });
    expect(traffic).toMatchObject({ normalFarePaise: 12000, farePaise: 13500, trafficExtraSec: 900, reasons: ['traffic'] });
  });
});

describe('fare at quote time', () => {
  it('applies the night multiplier only inside the city night hours, and rush bands from the city', async () => {
    const cityId = await setup({ nightStart: '22:00', nightEnd: '06:00', rushHours: [{ start: '08:00', end: '11:00', multiplier: 1.1 }] });
    const day = await calculateFare({ cityId, serviceType: 'bike', ...TRIP, at: ist('14:00') });
    const night = await calculateFare({ cityId, serviceType: 'bike', ...TRIP, at: ist('23:00') });
    const rush = await calculateFare({ cityId, serviceType: 'bike', ...TRIP, at: ist('09:00') });
    expect(day).toMatchObject({ totalPaise: 12500, reasons: [], nightMultiplier: 1, rushMultiplier: 1 });
    expect(night).toMatchObject({ totalPaise: 14400 + 500, reasons: ['night'], nightMultiplier: 1.2 });
    expect(rush).toMatchObject({ totalPaise: 13200 + 500, reasons: ['rush_hour'], rushMultiplier: 1.1 });
  });

  it('applies surge BEFORE the coupon, so the coupon is never eaten by surge (bug fix)', async () => {
    const cityId = await setup();
    const rider = await Rider.create({ phone: '9000000001', name: 'Asha' });
    await CouponRule.create({ code: 'FLAT20', title: '₹20 off', kind: 'manual', enabled: true, discountMode: 'fixed', discountValue: 2000 });
    const fare = await calculateFare({
      cityId, serviceType: 'bike', ...TRIP, at: ist('14:00'), liveSurge: 1.2,
      couponCode: 'FLAT20', riderId: String(rider._id), flags: { coupons: true },
    });
    // ₹120 × 1.2 = ₹144, minus the full ₹20 coupon = ₹124, + ₹5 platform fee.
    expect(fare).toMatchObject({ beforeMinimumPaise: 14400, discountPaise: 2000, totalPaise: 12900, reasons: ['high_demand'] });
  });

  it('the admin can lower the cap; never above 1.5×', async () => {
    const cityId = await setup({ maxMultiplier: 1.25 });
    const fare = await calculateFare({ cityId, serviceType: 'bike', ...TRIP, at: ist('23:00'), liveSurge: 1.5 });
    expect(fare).toMatchObject({ beforeMinimumPaise: 15000, priceMultiplier: 1.25, capped: true, reasons: ['night', 'high_demand'] });
  });
});

describe('live surge counts different riders, not refreshes', () => {
  it('one rider refreshing does not raise their own price; several riders and no pilots do', async () => {

    const at = { lat: 17.9689, lng: 79.5941 };
    for (let i = 0; i < 10; i++) await recordDemand('c1', at.lat, at.lng, 'rider-1');
    expect(await getSurgeMultiplier('c1', at.lat, at.lng)).toBe(1);
    await recordDemand('c1', at.lat, at.lng, 'rider-2'); // 2 riders / no pilots = ratio 2 → 1.2×
    expect(await getSurgeMultiplier('c1', at.lat, at.lng)).toBe(1.2);
    for (const r of ['rider-3', 'rider-4']) await recordDemand('c1', at.lat, at.lng, r);
    expect(await getSurgeMultiplier('c1', at.lat, at.lng)).toBe(1.5); // 4+ → table max
  });
});

describe('admin city pricing', () => {
  it('saves times and cap, rejects a cap above 1.5×, and keeps pricing when not sent', async () => {

    const city = (await City.findOne({ slug: 'warangal' }))!;
    const token = (await app.inject({
      method: 'POST', url: '/api/v1/admin/login', payload: { email: 'ops@prila.local', password: 'adminpass' },
    })).json().data.accessToken as string;
    const base = { name: 'Warangal', slug: 'warangal', center: { lng: 79.5941, lat: 17.9689 }, services: ['bike'] };
    const patch = (payload: object) => app.inject({
      method: 'PATCH', url: `/api/v1/admin/cities/${city._id}`, headers: { authorization: `Bearer ${token}` }, payload,
    });

    const pricing = { nightStart: '23:00', nightEnd: '05:00', rushHours: [{ start: '08:00', end: '10:30', multiplier: 1.1 }], maxMultiplier: 1.4 };
    expect((await patch({ ...base, pricing })).statusCode).toBe(200);
    expect((await patch({ ...base, pricing: { ...pricing, maxMultiplier: 2 } })).statusCode).toBe(400);
    expect((await patch({ ...base, pricing: { ...pricing, nightStart: '25:00' } })).statusCode).toBe(400);
    expect((await patch(base)).statusCode).toBe(200); // pricing omitted → kept

    const list = await app.inject({ method: 'GET', url: '/api/v1/admin/cities', headers: { authorization: `Bearer ${token}` } });
    expect(list.json().data.items[0].pricing).toEqual(pricing);
  });
});
