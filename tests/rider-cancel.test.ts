import { beforeEach, describe, expect, it } from 'vitest';
import { app, setupTestApp } from './helpers.js';
import { Pilot } from '../src/modules/auth/model.js';
import { FareRule, City } from '../src/modules/app/model.js';
import { Ride } from '../src/modules/rides/model.js';
import { RiderPilotBlock, calculateCancellationFee } from '../src/modules/rides/cancelPolicy.js';

setupTestApp();

async function login(phone: string, role: 'customer' | 'pilot') {
  const otp = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone, app: role } });
  const verify = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/verify',
    payload: { phone, app: role, code: otp.json().data.debugCode },
  });
  return { token: verify.json().data.accessToken as string, userId: verify.json().data.userId as string };
}

async function setup() {
  const city = await City.findOne();
  await FareRule.findOneAndUpdate(
    { cityId: city!._id, serviceType: 'bike' },
    {
      cityId: city!._id, serviceType: 'bike', version: 1, baseFarePaise: 2000, perKmPaise: 800, perMinutePaise: 100,
      minimumFarePaise: 3000, nightMultiplier: 1, surgeMultiplier: 1, waitingPerMinutePaise: 0,
      cancellationFeePaise: 2000, platformFeePaise: 500,
    },
    { upsert: true },
  );
  const rider = await login('9000000011', 'customer');
  const pilot = await login('9000000012', 'pilot');
  await Pilot.updateOne(
    { _id: pilot.userId },
    { $set: { online: true, idle: true, kycStatus: 'approved', vehicleType: 'bike', vehicleNumber: 'TS09AB1234',
      location: { type: 'Point', coordinates: [79.5941, 17.9689] } } },
  );
  await app.inject({ method: 'POST', url: '/api/v1/pilot/online', headers: { authorization: `Bearer ${pilot.token}` },
    payload: { online: true, lat: 17.9689, lng: 79.5941 } });
  return { city: city!, rider, pilot };
}

async function bookAndAccept(s: Awaited<ReturnType<typeof setup>>, key: string) {
  const est = await app.inject({
    method: 'POST', url: '/api/v1/rides/estimate', headers: { authorization: `Bearer ${s.rider.token}` },
    payload: { serviceType: 'bike', cityId: String(s.city._id), pickup: { lat: 17.9689, lng: 79.5941, name: 'Habsiguda' },
      drop: { lat: 17.99, lng: 79.61, name: 'Hanamkonda' } },
  });
  const book = await app.inject({
    method: 'POST', url: '/api/v1/rides', headers: { authorization: `Bearer ${s.rider.token}` },
    payload: { quoteId: est.json().data.quoteId, idempotencyKey: key, paymentMethod: 'cash' },
  });
  expect(book.statusCode, book.body).toBe(200);
  const rideId = book.json().data.id as string;
  const accept = await app.inject({
    method: 'POST', url: `/api/v1/pilot/rides/${rideId}/accept`, headers: { authorization: `Bearer ${s.pilot.token}` },
    payload: { idempotencyKey: `acc-${key}` },
  });
  expect(accept.json(), JSON.stringify(accept.json())).toMatchObject({ ok: true });
  return rideId;
}

const cancel = (token: string, rideId: string, payload: object) =>
  app.inject({ method: 'POST', url: `/api/v1/rides/${rideId}/cancel`, headers: { authorization: `Bearer ${token}` }, payload });

describe('calculateCancellationFee', () => {
  const base = { fare: { cancellationFeePaise: 2000 } };
  const at = (secAgo: number) => [{ to: 'pilot_assigned', at: new Date(Date.now() - secAgo * 1000) }];
  it('is free while searching', () => {
    expect(calculateCancellationFee({ ...base, status: 'searching' }, 'PLAN_CHANGED')).toBe(0);
  });
  it('is free for pilot-fault reasons', () => {
    expect(calculateCancellationFee({ ...base, status: 'pilot_arriving', timeline: at(600) }, 'CAPTAIN_NOT_MOVING')).toBe(0);
  });
  it('is free inside the grace window, charged after', () => {
    expect(calculateCancellationFee({ ...base, status: 'pilot_arriving', timeline: at(60) }, 'PLAN_CHANGED')).toBe(0);
    expect(calculateCancellationFee({ ...base, status: 'pilot_arriving', timeline: at(600) }, 'PLAN_CHANGED')).toBe(2000);
  });
});

describe('rider cancel', () => {
  beforeEach(async () => {
    await Ride.deleteMany({});
    await RiderPilotBlock.deleteMany({});
    await Pilot.updateMany({}, { $set: { idle: true, cancellationFlags: 0 } });
  });

  it('rejects unknown reason codes', async () => {
    const s = await setup();
    const rideId = await bookAndAccept(s, 'rc-bad-1');
    expect((await cancel(s.rider.token, rideId, { reasonCode: 'nope' })).statusCode).toBe(400);
  });

  it('pilot-fault cancel: free, blocks the pilot for 30 min, flags the pilot', async () => {
    const s = await setup();
    const rideId = await bookAndAccept(s, 'rc-fault-1');
    const res = await cancel(s.rider.token, rideId, { reasonCode: 'CAPTAIN_ASKED_EXTRA_MONEY' });
    expect(res.statusCode).toBe(200);
    const ride = await Ride.findById(rideId);
    expect(ride!.status).toBe('cancelled_by_rider');
    expect(ride!.cancelReasonCode).toBe('CAPTAIN_ASKED_EXTRA_MONEY');
    expect(ride!.cancellationFeePaise).toBe(0);
    const block = await RiderPilotBlock.findOne({ riderId: ride!.riderId, pilotId: s.pilot.userId });
    expect(block).toBeTruthy();
    expect(block!.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
    expect((await Pilot.findById(s.pilot.userId))!.cancellationFlags).toBe(1);
    // retry is safe
    expect((await cancel(s.rider.token, rideId, { reasonCode: 'CAPTAIN_ASKED_EXTRA_MONEY' })).statusCode).toBe(200);
  });

  it('rematch keeps the ride searching and never re-offers it to the same pilot', async () => {
    const s = await setup();
    const rideId = await bookAndAccept(s, 'rc-rematch-1');
    const res = await cancel(s.rider.token, rideId, { reasonCode: 'LONG_WAIT_TIME', rematch: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.id).toBe(rideId);
    const ride = await Ride.findById(rideId);
    expect(ride!.status).toBe('searching');
    expect(ride!.pilotId).toBeNull();
    expect((ride!.skippedPilotIds ?? []).map(String)).toContain(s.pilot.userId);
    expect(await RiderPilotBlock.countDocuments({ pilotId: s.pilot.userId })).toBe(1);
  });

  it('rematch is refused for rider-side reasons', async () => {
    const s = await setup();
    const rideId = await bookAndAccept(s, 'rc-rematch-2');
    expect((await cancel(s.rider.token, rideId, { reasonCode: 'PLAN_CHANGED', rematch: true })).statusCode).toBe(400);
  });

  it('is rejected once the trip is in progress', async () => {
    const s = await setup();
    const rideId = await bookAndAccept(s, 'rc-inprog-1');
    await Ride.updateOne({ _id: rideId }, { $set: { status: 'in_progress' } });
    const res = await cancel(s.rider.token, rideId, { reasonCode: 'PLAN_CHANGED' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code ?? res.json().code).toBe('RIDE_IN_PROGRESS');
  });
});
