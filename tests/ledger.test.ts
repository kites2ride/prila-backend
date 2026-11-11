import { describe, expect, it } from 'vitest';
import { app, setupTestApp } from './helpers.js';
import { Pilot } from '../src/modules/auth/model.js';
import { City, FareRule } from '../src/modules/app/model.js';
import { PilotWallet, LedgerEntry } from '../src/modules/ledger/model.js';

setupTestApp();

async function tokens() {
  const rOtp = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/request',
    payload: { phone: '9000000101', app: 'customer' },
  });
  const rVerify = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/verify',
    payload: { phone: '9000000101', app: 'customer', code: rOtp.json().data.debugCode },
  });
  const pOtp = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/request',
    payload: { phone: '9000000102', app: 'pilot' },
  });
  const pVerify = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/verify',
    payload: { phone: '9000000102', app: 'pilot', code: pOtp.json().data.debugCode },
  });
  return {
    rider: rVerify.json().data.accessToken as string,
    pilot: pVerify.json().data.accessToken as string,
    pilotId: pVerify.json().data.userId as string,
  };
}

describe('ledger settle on complete', () => {
  it('posts commission dues on cash complete and exposes earnings', async () => {
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

    const t = await tokens();
    await Pilot.updateOne(
      { _id: t.pilotId },
      {
        $set: {
          online: true,
          idle: true,
          kycStatus: 'approved',
          vehicleType: 'bike',
          vehicleNumber: 'TS09LED001',
          location: { type: 'Point', coordinates: [79.5941, 17.9689] },
        },
      },
    );
    await app.inject({
      method: 'POST',
      url: '/api/v1/pilot/online',
      headers: { authorization: `Bearer ${t.pilot}` },
      payload: { online: true, lat: 17.9689, lng: 79.5941 },
    });

    const estimate = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/estimate',
      headers: { authorization: `Bearer ${t.rider}` },
      payload: {
        serviceType: 'bike',
        cityId: String(city!._id),
        pickup: { lat: 17.9689, lng: 79.5941, name: 'A' },
        drop: { lat: 17.97, lng: 79.6, name: 'B' },
      },
    });
    expect(estimate.statusCode).toBe(200);
    const quoteId = estimate.json().data.quoteId as string;
    const book = await app.inject({
      method: 'POST',
      url: '/api/v1/rides',
      headers: { authorization: `Bearer ${t.rider}` },
      payload: { quoteId, idempotencyKey: 'idem-ledger-book-1', paymentMethod: 'cash' },
    });
    expect(book.statusCode).toBe(200);
    expect(book.json().data).toBeTruthy();
    const rideId = book.json().data.id as string;

    await app.inject({
      method: 'POST',
      url: `/api/v1/pilot/rides/${rideId}/accept`,
      headers: { authorization: `Bearer ${t.pilot}` },
      payload: { idempotencyKey: 'idem-ledger-accept-1' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/pilot/rides/${rideId}/arrived`,
      headers: { authorization: `Bearer ${t.pilot}` },
    });
    const riderView = await app.inject({
      method: 'GET',
      url: `/api/v1/rides/${rideId}`,
      headers: { authorization: `Bearer ${t.rider}` },
    });
    const otp = riderView.json().data.startOtp as string;
    await app.inject({
      method: 'POST',
      url: `/api/v1/pilot/rides/${rideId}/start`,
      headers: { authorization: `Bearer ${t.pilot}` },
      payload: { otp, idempotencyKey: 'idem-ledger-start-1' },
    });
    const complete = await app.inject({
      method: 'POST',
      url: `/api/v1/pilot/rides/${rideId}/complete`,
      headers: { authorization: `Bearer ${t.pilot}` },
      payload: { idempotencyKey: 'idem-ledger-complete-1', collectedCash: true },
    });
    expect(complete.statusCode).toBe(200);

    const wallet = await PilotWallet.findOne({ pilotId: t.pilotId });
    expect(wallet).toBeTruthy();
    expect(wallet!.lifetimeTrips).toBe(1);
    expect(wallet!.duesPaise).toBeGreaterThan(0); // 15% commission
    expect(wallet!.lifetimeNetPaise).toBeGreaterThan(0);

    const entries = await LedgerEntry.find({ pilotId: t.pilotId });
    expect(entries.length).toBeGreaterThanOrEqual(3);

    const earnings = await app.inject({
      method: 'GET',
      url: '/api/v1/pilot/earnings?range=today',
      headers: { authorization: `Bearer ${t.pilot}` },
    });
    expect(earnings.statusCode).toBe(200);
    expect(earnings.json().data.trips).toBe(1);
    expect(earnings.json().data.netPaise).toBe(wallet!.lifetimeNetPaise);

    const wApi = await app.inject({
      method: 'GET',
      url: '/api/v1/pilot/wallet',
      headers: { authorization: `Bearer ${t.pilot}` },
    });
    expect(wApi.json().data.duesPaise).toBe(wallet!.duesPaise);
  });
});
