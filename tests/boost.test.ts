import { describe, expect, it } from 'vitest';
import { app, setupTestApp } from './helpers.js';
import { Pilot } from '../src/modules/auth/model.js';
import { City, ConfigSingleton, FareRule } from '../src/modules/app/model.js';
import { Ride } from '../src/modules/rides/model.js';
import { PilotWallet } from '../src/modules/ledger/model.js';

setupTestApp();

async function login(phone: string, kind: 'customer' | 'pilot') {
  const otp = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/request',
    payload: { phone, app: kind },
  });
  const verify = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/verify',
    payload: { phone, app: kind, code: otp.json().data.debugCode },
  });
  return { token: verify.json().data.accessToken as string, id: verify.json().data.userId as string };
}

/** A booked ride whose search found nobody ("no pilots nearby"), with a pilot online for the re-search. */
async function noPilotRide(phones: { rider: string; pilot: string }) {
  const city = await City.findOne();
  await FareRule.findOneAndUpdate(
    { cityId: city!._id, serviceType: 'bike' },
    {
      cityId: city!._id,
      serviceType: 'bike',
      version: 1,
      baseFarePaise: 5000,
      perKmPaise: 0,
      perMinutePaise: 0,
      minimumFarePaise: 5000,
      nightMultiplier: 1,
      surgeMultiplier: 1,
      waitingPerMinutePaise: 0,
      cancellationFeePaise: 0,
      platformFeePaise: 0,
    },
    { upsert: true },
  );
  const rider = await login(phones.rider, 'customer');
  const pilot = await login(phones.pilot, 'pilot');
  await Pilot.updateOne(
    { _id: pilot.id },
    {
      $set: {
        online: true,
        idle: true,
        kycStatus: 'approved',
        vehicleType: 'bike',
        vehicleNumber: 'TS09BST001',
        location: { type: 'Point', coordinates: [79.5941, 17.9689] },
      },
    },
  );
  await app.inject({
    method: 'POST',
    url: '/api/v1/pilot/online',
    headers: { authorization: `Bearer ${pilot.token}` },
    payload: { online: true, lat: 17.9689, lng: 79.5941 },
  });
  const estimate = await app.inject({
    method: 'POST',
    url: '/api/v1/rides/estimate',
    headers: { authorization: `Bearer ${rider.token}` },
    payload: {
      serviceType: 'bike',
      cityId: String(city!._id),
      pickup: { lat: 17.9689, lng: 79.5941, name: 'A' },
      drop: { lat: 17.97, lng: 79.6, name: 'B' },
    },
  });
  const book = await app.inject({
    method: 'POST',
    url: '/api/v1/rides',
    headers: { authorization: `Bearer ${rider.token}` },
    payload: { quoteId: estimate.json().data.quoteId, idempotencyKey: `idem-${phones.rider}`, paymentMethod: 'cash' },
  });
  expect(book.statusCode).toBe(200);
  const rideId = book.json().data.id as string;
  // Nobody accepted in time.
  await Ride.updateOne({ _id: rideId }, { $set: { status: 'no_pilot_found' } });
  return { rider, pilot, rideId, baseTotal: book.json().data.fareTotalPaise as number };
}

const boost = (token: string, rideId: string, boostPaise: number) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/rides/${rideId}/boost`,
    headers: { authorization: `Bearer ${token}` },
    payload: { boostPaise },
  });

describe('fare boost (rider raises the fare when no pilot accepts)', () => {
  it('re-opens the search, adds the extra to the fare, and pays it to the pilot in full', async () => {
    const { rider, pilot, rideId, baseTotal } = await noPilotRide({ rider: '9000000201', pilot: '9000000202' });
    expect(baseTotal).toBe(5000);

    const res = await boost(rider.token, rideId, 2000);
    expect(res.statusCode).toBe(200);
    const ride = res.json().data;
    expect(ride.status).toBe('searching'); // search is running again
    expect(ride.boostPaise).toBe(2000);
    expect(ride.fareTotalPaise).toBe(7000);
    expect(ride.fare.boostPaise).toBe(2000);
    expect(ride.fare.totalPaise).toBe(7000);
    expect(new Date(ride.searchExpiresAt).getTime()).toBeGreaterThan(Date.now());

    // A pilot takes the re-opened ride (assigned directly: dispatch offers are not what is under test),
    // drives it, and the rider pays the new total.
    await Ride.updateOne({ _id: rideId }, { $set: { pilotId: pilot.id, status: 'pilot_arriving' } });
    await app.inject({ method: 'POST', url: `/api/v1/pilot/rides/${rideId}/arrived`, headers: { authorization: `Bearer ${pilot.token}` } });
    const view = await app.inject({ method: 'GET', url: `/api/v1/rides/${rideId}`, headers: { authorization: `Bearer ${rider.token}` } });
    await app.inject({
      method: 'POST',
      url: `/api/v1/pilot/rides/${rideId}/start`,
      headers: { authorization: `Bearer ${pilot.token}` },
      payload: { otp: view.json().data.startOtp, idempotencyKey: 'idem-start-boost' },
    });
    const done = await app.inject({
      method: 'POST',
      url: `/api/v1/pilot/rides/${rideId}/complete`,
      headers: { authorization: `Bearer ${pilot.token}` },
      payload: { idempotencyKey: 'idem-complete-boost', collectedCash: true },
    });
    expect(done.statusCode).toBe(200);

    // Settlement: commission only on the original fare; the whole boost lands with the pilot.
    const wallet = await PilotWallet.findOne({ pilotId: pilot.id });
    expect(wallet!.lifetimeGrossPaise).toBe(7000);
    const commissionOnBase = wallet!.duesPaise;
    expect(commissionOnBase).toBeGreaterThan(0);
    expect(commissionOnBase).toBeLessThan(Math.round(7000 * 0.15)); // would be higher if the boost were charged commission
    expect(wallet!.lifetimeNetPaise).toBe(7000 - commissionOnBase); // = base net + the full ₹20
    expect(wallet!.lifetimeNetPaise - (5000 - commissionOnBase)).toBe(2000);
  });

  it('only allows what the config allows', async () => {
    const { rider, rideId } = await noPilotRide({ rider: '9000000203', pilot: '9000000204' });

    expect((await boost(rider.token, rideId, 6000)).json().error.code).toBe('BOOST_INVALID'); // over the ₹50 cap
    expect((await boost(rider.token, rideId, 1500)).json().error.code).toBe('BOOST_INVALID'); // not a ₹10 step
    expect((await boost(rider.token, rideId, -1000)).statusCode).toBe(400);

    expect((await boost(rider.token, rideId, 3000)).statusCode).toBe(200);
    expect((await boost(rider.token, rideId, 3000)).statusCode).toBe(200); // same request again: no double charge
    const after = await Ride.findById(rideId);
    expect(after!.boostPaise).toBe(3000);
    expect(after!.fareTotalPaise).toBe(8000);

    expect((await boost(rider.token, rideId, 1000)).json().error.code).toBe('BOOST_INVALID'); // cannot go down
    expect((await boost(rider.token, rideId, 5000)).statusCode).toBe(200); // up to the cap in total
    expect((await Ride.findById(rideId))!.fareTotalPaise).toBe(10000);
  });

  it('is only for the rider\'s own ride, and only while we are finding a pilot', async () => {
    const { rider, rideId } = await noPilotRide({ rider: '9000000205', pilot: '9000000206' });
    const stranger = await login('9000000207', 'customer');
    expect((await boost(stranger.token, rideId, 1000)).statusCode).toBe(404);

    await Ride.updateOne({ _id: rideId }, { $set: { status: 'in_progress' } });
    expect((await boost(rider.token, rideId, 1000)).statusCode).toBe(409);
  });

  it('can be switched off by ops (boostMaxPaise = 0)', async () => {
    const { rider, rideId } = await noPilotRide({ rider: '9000000208', pilot: '9000000209' });
    await ConfigSingleton.findOneAndUpdate({ key: 'dispatch' }, { $set: { 'value.boostMaxPaise': 0 } }, { upsert: true });
    const res = await boost(rider.token, rideId, 1000);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BOOST_DISABLED');
    await ConfigSingleton.updateOne({ key: 'dispatch' }, { $set: { 'value.boostMaxPaise': 5000 } });
  });

  it('exposes the step and cap to the app via bootstrap', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/app/bootstrap?app=customer' });
    expect(res.statusCode).toBe(200);
    const hints = res.json().data.matchingHints;
    expect(hints.boostStepPaise).toBe(1000);
    expect(hints.boostMaxPaise).toBe(5000);
  });
});
