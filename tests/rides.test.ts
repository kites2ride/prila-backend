import { describe, expect, it } from 'vitest';
import { app, setupTestApp } from './helpers.js';
import { Pilot } from '../src/modules/auth/model.js';
import { FareRule, City } from '../src/modules/app/model.js';

setupTestApp();

async function riderToken() {
  const otp = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/request',
    payload: { phone: '9000000001', app: 'customer' },
  });
  const code = otp.json().data.debugCode;
  const verify = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/verify',
    payload: { phone: '9000000001', app: 'customer', code },
  });
  return verify.json().data.accessToken as string;
}

async function pilotToken() {
  const otp = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/request',
    payload: { phone: '9000000002', app: 'pilot' },
  });
  const code = otp.json().data.debugCode;
  const verify = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/verify',
    payload: { phone: '9000000002', app: 'pilot', code },
  });
  return { token: verify.json().data.accessToken as string, userId: verify.json().data.userId as string };
}

describe('rides e2e core', () => {
  it('estimates, books, accepts, starts with OTP, completes', async () => {
    const city = await City.findOne();
    await FareRule.findOneAndUpdate(
      { cityId: city!._id, serviceType: 'bike' },
      {
        cityId: city!._id,
        serviceType: 'bike',
        version: 1,
        baseFarePaise: 2000,
        perKmPaise: 800,
        perMinutePaise: 100,
        minimumFarePaise: 3000,
        nightMultiplier: 1,
        surgeMultiplier: 1,
        waitingPerMinutePaise: 0,
        cancellationFeePaise: 2000,
        platformFeePaise: 500,
      },
      { upsert: true },
    );

    const rToken = await riderToken();
    const pilot = await pilotToken();
    await Pilot.updateOne(
      { _id: pilot.userId },
      {
        $set: {
          online: true,
          idle: true,
          kycStatus: 'approved',
          vehicleType: 'bike',
          vehicleNumber: 'TS09AB1234',
          location: { type: 'Point', coordinates: [79.5941, 17.9689] },
        },
      },
    );
    // Populate in-memory LocationStore (dispatch hot path)
    await app.inject({
      method: 'POST',
      url: '/api/v1/pilot/online',
      headers: { authorization: `Bearer ${pilot.token}` },
      payload: { online: true, lat: 17.9689, lng: 79.5941 },
    });

    const estimate = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/estimate',
      headers: { authorization: `Bearer ${rToken}` },
      payload: {
        serviceType: 'bike',
        cityId: String(city!._id),
        pickup: { lat: 17.9689, lng: 79.5941, name: 'Habsiguda' },
        drop: { lat: 17.99, lng: 79.61, name: 'Hanamkonda' },
      },
    });
    expect(estimate.statusCode).toBe(200);
    const quoteId = estimate.json().data.quoteId as string;

    const book = await app.inject({
      method: 'POST',
      url: '/api/v1/rides',
      headers: { authorization: `Bearer ${rToken}` },
      payload: { quoteId, idempotencyKey: 'idem-book-1', paymentMethod: 'cash' },
    });
    expect(book.statusCode).toBe(200);
    const rideId = book.json().data.id as string;
    expect(['searching', 'pilot_assigned', 'pilot_arriving']).toContain(book.json().data.status);

    // retry book same key = idempotent
    const book2 = await app.inject({
      method: 'POST',
      url: '/api/v1/rides',
      headers: { authorization: `Bearer ${rToken}` },
      payload: { quoteId, idempotencyKey: 'idem-book-1', paymentMethod: 'cash' },
    });
    expect(book2.json().data.id).toBe(rideId);

    const accept = await app.inject({
      method: 'POST',
      url: `/api/v1/pilot/rides/${rideId}/accept`,
      headers: { authorization: `Bearer ${pilot.token}` },
      payload: { idempotencyKey: 'idem-accept-1' },
    });
    expect(accept.statusCode).toBe(200);
    expect(['pilot_assigned', 'pilot_arriving']).toContain(accept.json().data.status);

    await app.inject({
      method: 'POST',
      url: `/api/v1/pilot/rides/${rideId}/arrived`,
      headers: { authorization: `Bearer ${pilot.token}` },
    });

    const riderView = await app.inject({
      method: 'GET',
      url: `/api/v1/rides/${rideId}`,
      headers: { authorization: `Bearer ${rToken}` },
    });
    const otp = riderView.json().data.startOtp as string;
    expect(otp).toMatch(/^\d{4}$/);

    const start = await app.inject({
      method: 'POST',
      url: `/api/v1/pilot/rides/${rideId}/start`,
      headers: { authorization: `Bearer ${pilot.token}` },
      payload: { otp, idempotencyKey: 'idem-start-1' },
    });
    expect(start.statusCode).toBe(200);
    expect(start.json().data.status).toBe('in_progress');

    const complete = await app.inject({
      method: 'POST',
      url: `/api/v1/pilot/rides/${rideId}/complete`,
      headers: { authorization: `Bearer ${pilot.token}` },
      payload: { idempotencyKey: 'idem-complete-1', collectedCash: true },
    });
    expect(complete.statusCode).toBe(200);
    expect(['completed', 'paid']).toContain(complete.json().data.status);
  });
});
