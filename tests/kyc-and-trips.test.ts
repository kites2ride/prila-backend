import { describe, expect, it } from 'vitest';
import { AdminAuditLog, City, FareRule } from '../src/modules/app/model.js';
import { Pilot, Rider } from '../src/modules/auth/model.js';
import { PilotWallet } from '../src/modules/ledger/model.js';
import { Ride } from '../src/modules/rides/model.js';
import { app, setupTestApp } from './helpers.js';

setupTestApp();

let seq = 0;
const PICKUP = { lat: 17.9689, lng: 79.5941, name: 'Hanamkonda Chowrasta' };
const DROP = { lat: 17.97, lng: 79.6, name: 'Warangal Fort' };
const KYC_DOCS = ['dl', 'rc', 'id', 'selfie', 'bank'];

async function adminToken() {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/admin/login', payload: { email: 'ops@prila.local', password: 'adminpass' },
  });
  return res.json().data.accessToken as string;
}

function call(token: string, method: 'GET' | 'POST', url: string, payload?: object) {
  return app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, payload });
}

async function newPilot(extra: Record<string, unknown> = {}) {
  const p = await Pilot.create({ phone: `96${String(10_000_000 + seq++).slice(1)}`, status: 'active', ...extra });
  return { id: String(p._id), token: app.jwt.sign({ sub: String(p._id), typ: 'pilot' }) };
}

function docsFor(pilotId: string, ids = KYC_DOCS) {
  return Object.fromEntries(ids.map((d) => [d, `kyc/${pilotId}/${d}-${seq++}.jpg`]));
}

async function fares() {
  const city = await City.findOne();
  for (const serviceType of ['bike', 'parcel'] as const) {
    await FareRule.findOneAndUpdate(
      { cityId: city!._id, serviceType },
      {
        cityId: city!._id, serviceType, version: 1, baseFarePaise: 5000, perKmPaise: 0, perMinutePaise: 0,
        minimumFarePaise: 5000, nightMultiplier: 1, surgeMultiplier: 1, waitingPerMinutePaise: 0,
        cancellationFeePaise: 2000, platformFeePaise: 0,
      },
      { upsert: true },
    );
  }
  return city!;
}

async function onlinePilot(name: string, vehicleNumber: string) {
  const city = await City.findOne();
  const p = await newPilot({
    name, vehicleType: 'bike', vehicleNumber, kycStatus: 'approved', cityId: city!._id, photoKey: `kyc/x/selfie.jpg`,
  });
  const res = await call(p.token, 'POST', '/pilot/online', { online: true, lat: PICKUP.lat, lng: PICKUP.lng });
  expect(res.statusCode).toBe(200);
  return p;
}

async function bookRide(serviceType: 'bike' | 'parcel', payAt?: 'pickup' | 'drop') {
  const city = await fares();
  const r = await Rider.create({ phone: `97${String(10_000_000 + seq++).slice(1)}`, name: 'Sita Sender' });
  const t = app.jwt.sign({ sub: String(r._id), typ: 'access' });
  const est = await call(t, 'POST', '/rides/estimate', { serviceType, pickup: PICKUP, drop: DROP, cityId: String(city._id) });
  expect(est.statusCode).toBe(200);
  const book = await call(t, 'POST', '/rides', {
    quoteId: est.json().data.quoteId, idempotencyKey: `book-${seq++}-xyz`, paymentMethod: 'cash', ...(payAt ? { payAt } : {}),
  });
  expect(book.statusCode).toBe(200);
  return { rider: t, riderPhone: r.phone, rideId: book.json().data.id as string, otp: book.json().data.startOtp as string };
}

/* ───────────────────────────────── KYC ───────────────────────────────── */

describe('KYC: pilot submits, admin approves / rejects with a reason', () => {
  it('validates documents, vehicle number and that files belong to this pilot', async () => {
    const p = await newPilot();
    const other = await newPilot();
    const base = { name: 'Ravi Kumar', vehicleType: 'bike', vehicleNumber: 'TS 03 AB 1234' };

    const missing = await call(p.token, 'POST', '/pilot/kyc', { ...base, documents: docsFor(p.id, ['dl', 'rc']) });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('KYC_DOCS_MISSING');
    expect(missing.json().error.message).toContain('Selfie');

    const stolen = await call(p.token, 'POST', '/pilot/kyc', { ...base, documents: docsFor(other.id) });
    expect(stolen.statusCode).toBe(400);

    const badNo = await call(p.token, 'POST', '/pilot/kyc', { ...base, vehicleNumber: 'HELLO', documents: docsFor(p.id) });
    expect(badNo.statusCode).toBe(400);

    // KYC uploads: pilots only, photos / PDF only (checked before storage is touched).
    const r = await Rider.create({ phone: '9555500001' });
    const riderT = app.jwt.sign({ sub: String(r._id), typ: 'access' });
    expect((await call(riderT, 'POST', '/uploads/presign', { folder: 'kyc', contentType: 'image/jpeg' })).statusCode).toBe(403);
    expect((await call(p.token, 'POST', '/uploads/presign', { folder: 'kyc', contentType: 'text/html' })).statusCode).toBe(400);
  });

  it('pending → admin badge → reject needs a reason → pilot sees it, re-applies → approve', async () => {
    const admin = await adminToken();
    const p = await newPilot();
    const submit = await call(p.token, 'POST', '/pilot/kyc', {
      name: 'Ravi Kumar', vehicleType: 'bike', vehicleNumber: 'ts-03-ab-1234', documents: docsFor(p.id),
    });
    expect(submit.statusCode).toBe(200);
    expect(submit.json().data).toMatchObject({ status: 'pending', vehicleNumber: 'TS03AB1234' });
    expect((await call(p.token, 'POST', '/pilot/kyc', { name: 'Ravi Kumar', vehicleType: 'bike', vehicleNumber: 'TS03AB1234', documents: docsFor(p.id) })).json().error.code).toBe('KYC_PENDING');

    // Not approved yet → cannot go online.
    expect((await call(p.token, 'POST', '/pilot/online', { online: true, lat: PICKUP.lat, lng: PICKUP.lng })).statusCode).not.toBe(200);

    const count = (await call(admin, 'GET', '/admin/kyc/count')).json().data;
    expect(count).toMatchObject({ pending: 1, newest: { id: p.id, name: 'Ravi Kumar', vehicleType: 'bike' } });
    const list = (await call(admin, 'GET', '/admin/kyc?status=pending')).json().data;
    expect(list.items[0]).toMatchObject({ id: p.id, vehicleNumber: 'TS03AB1234' });
    const detail = (await call(admin, 'GET', `/admin/kyc/${p.id}`)).json().data;
    expect(detail.documents.map((d: { label: string }) => d.label)).toEqual(['Driving Licence', 'RC', 'Government ID', 'Selfie', 'Bank / UPI']);
    expect(JSON.stringify(detail)).not.toContain(`kyc/${p.id}/`); // raw storage keys never leave the server

    // Reason is mandatory.
    expect((await call(admin, 'POST', `/admin/kyc/${p.id}/reject`, {})).statusCode).toBe(400);
    expect((await call(admin, 'POST', `/admin/kyc/${p.id}/reject`, { reason: ' ' })).statusCode).toBe(400);
    const rej = await call(admin, 'POST', `/admin/kyc/${p.id}/reject`, { reason: 'RC photo is blurred', docIds: ['rc', 'nope'] });
    expect(rej.statusCode).toBe(200);
    expect((await call(admin, 'POST', `/admin/kyc/${p.id}/approve`)).json().error.code).toBe('KYC_NOT_PENDING');

    const seen = (await call(p.token, 'GET', '/pilot/kyc')).json().data;
    expect(seen).toMatchObject({ status: 'rejected', rejectReason: 'RC photo is blurred', rejectedDocs: ['rc'] });

    // Re-apply from the app (e.g. after a reinstall): only the wrong document is uploaded again.
    const before = (await Pilot.findById(p.id).lean())!.kycDocs!;
    const base = { name: 'Ravi Kumar', vehicleType: 'bike', vehicleNumber: 'TS03AB1234' };
    const none = await call(p.token, 'POST', '/pilot/kyc', { ...base, documents: {} });
    expect(none.json().error.code).toBe('KYC_DOCS_MISSING'); // the wrong RC is not kept
    const newRc = docsFor(p.id, ['rc']);
    const again = await call(p.token, 'POST', '/pilot/kyc', { ...base, documents: newRc });
    expect(again.json().data).toMatchObject({ status: 'pending', rejectReason: null, rejectedDocs: [] });
    expect([...again.json().data.uploadedDocs].sort()).toEqual([...KYC_DOCS].sort());
    const after = (await Pilot.findById(p.id).lean())!.kycDocs!;
    expect(after.find((d) => d.docId === 'rc')?.key).toBe(newRc.rc);
    expect(after.find((d) => d.docId === 'dl')?.key).toBe(before.find((d) => d.docId === 'dl')?.key);
    expect((await call(admin, 'POST', `/admin/kyc/${p.id}/approve`)).statusCode).toBe(200);
    const approved = await Pilot.findById(p.id).lean();
    expect(approved).toMatchObject({ kycStatus: 'approved', kycReviewedBy: 'ops@prila.local' });
    expect(approved?.photoKey).toMatch(new RegExp(`^kyc/${p.id}/selfie`));
    expect((await call(admin, 'GET', '/admin/kyc/count')).json().data.pending).toBe(0);
    expect(await AdminAuditLog.countDocuments({ action: { $in: ['kyc.approve', 'kyc.reject'] }, 'meta.pilotId': p.id })).toBe(2);

    // Pilots / riders cannot use admin KYC endpoints.
    expect((await call(p.token, 'GET', '/admin/kyc/count')).statusCode).toBe(403);
  });
});

/* ───────────────────────── pilot cancel → new pilot ───────────────────────── */

describe('pilot cancels → rider automatically gets another pilot', () => {
  it('re-searches without the cancelling pilot, no fee, and the rider sees the new pilot card', async () => {
    const first = await onlinePilot('Ravi', 'TS03AB0001');
    const { rider, rideId } = await bookRide('bike');
    expect((await call(first.token, 'POST', `/pilot/rides/${rideId}/accept`, { idempotencyKey: 'acc-1-xyz' })).statusCode).toBe(200);

    // Rider sees who is coming (never the pilot's phone).
    const view = (await call(rider, 'GET', `/rides/${rideId}`)).json().data;
    expect(view.pilot).toMatchObject({ name: 'Ravi', vehicleNumber: 'TS03AB0001', vehicleType: 'bike' });
    expect(JSON.stringify(view.pilot)).not.toMatch(/96\d{8}/);

    // Second pilot comes online, first cancels.
    const second = await onlinePilot('Kiran', 'TS03AB0002');
    expect((await call(first.token, 'POST', `/pilot/rides/${rideId}/cancel`, { reasonCode: 'other' })).statusCode).toBe(400); // "other" needs text
    const cancel = await call(first.token, 'POST', `/pilot/rides/${rideId}/cancel`, { reasonCode: 'vehicle_problem' });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().data.status).toBe('searching');

    const after = (await call(rider, 'GET', `/rides/${rideId}`)).json().data;
    expect(after).toMatchObject({ status: 'searching', reassigned: true, pilotId: null, pilot: null });
    const doc = await Ride.findById(rideId).lean();
    expect(doc?.platformRevenuePaise).toBe(0); // no cancellation fee for the rider
    expect((await Pilot.findById(first.id).lean())?.cancelCount).toBe(1);

    // The cancelling pilot is not offered the ride again; the second pilot is.
    expect((await call(first.token, 'GET', '/pilot/rides/offers')).json().data.items).toHaveLength(0);
    expect((await call(second.token, 'GET', '/pilot/rides/offers')).json().data.items.map((r: { id: string }) => r.id)).toContain(rideId);
    expect((await call(first.token, 'POST', `/pilot/rides/${rideId}/accept`, { idempotencyKey: 'acc-2-xyz' })).statusCode).not.toBe(200);
    expect((await call(second.token, 'POST', `/pilot/rides/${rideId}/accept`, { idempotencyKey: 'acc-3-xyz' })).statusCode).toBe(200);
    expect((await call(rider, 'GET', `/rides/${rideId}`)).json().data.pilot).toMatchObject({ name: 'Kiran' });
  });

  it('cannot cancel once the trip has started (support only)', async () => {
    const p = await onlinePilot('Ravi', 'TS03AB0003');
    const { rideId, otp } = await bookRide('bike');
    await call(p.token, 'POST', `/pilot/rides/${rideId}/accept`, { idempotencyKey: 'acc-4-xyz' });
    await call(p.token, 'POST', `/pilot/rides/${rideId}/arrived`);
    expect((await call(p.token, 'POST', `/pilot/rides/${rideId}/start`, { otp, idempotencyKey: 'start-4-xyz' })).statusCode).toBe(200);
    const res = await call(p.token, 'POST', `/pilot/rides/${rideId}/cancel`, { reasonCode: 'vehicle_problem' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('RIDE_IN_PROGRESS');
  });
});

/* ───────────────────────── parcels: pay at pickup / drop ───────────────────────── */

describe('parcels: pay at pickup or pay at drop', () => {
  it('pay at pickup: pilot must confirm cash before starting; "sender refused" ends the request', async () => {
    const p = await onlinePilot('Ravi', 'TS03AB0004');
    const { rideId, otp } = await bookRide('parcel', 'pickup');
    expect((await Ride.findById(rideId).lean())?.payAt).toBe('pickup');
    await call(p.token, 'POST', `/pilot/rides/${rideId}/accept`, { idempotencyKey: 'acc-5-xyz' });
    await call(p.token, 'POST', `/pilot/rides/${rideId}/arrived`);
    const noCash = await call(p.token, 'POST', `/pilot/rides/${rideId}/start`, { otp, idempotencyKey: 'start-5-xyz' });
    expect(noCash.json().error.code).toBe('CASH_FIRST');
    const ok = await call(p.token, 'POST', `/pilot/rides/${rideId}/start`, { otp, idempotencyKey: 'start-6-xyz', cashCollected: true });
    expect(ok.json().data.paymentStatus).toBe('paid');
    const done = await call(p.token, 'POST', `/pilot/rides/${rideId}/complete`, { idempotencyKey: 'done-5-xyz', collectedCash: false });
    expect(done.json().data).toMatchObject({ status: 'paid', paymentStatus: 'paid', paymentIssue: null });

    // Another parcel: sender refuses at pickup → request ends (no re-search).
    const p2 = await onlinePilot('Kiran', 'TS03AB0005');
    const second = await bookRide('parcel', 'pickup');
    const who = (await call(p.token, 'GET', '/pilot/rides/offers')).json().data.items.length ? p : p2;
    await call(who.token, 'POST', `/pilot/rides/${second.rideId}/accept`, { idempotencyKey: 'acc-6-xyz' });
    const refused = await call(who.token, 'POST', `/pilot/rides/${second.rideId}/cancel`, { reasonCode: 'sender_refused_payment' });
    expect(refused.json().data.status).toBe('cancelled_by_pilot');
  });

  it('pay at drop: "receiver didn\'t pay" completes the ride, flags it for ops, pilot owes no dues; pilot can call the sender', async () => {
    const admin = await adminToken();
    const p = await onlinePilot('Ravi', 'TS03AB0006');
    const { rideId, otp, riderPhone } = await bookRide('parcel', 'drop');
    await call(p.token, 'POST', `/pilot/rides/${rideId}/accept`, { idempotencyKey: 'acc-7-xyz' });
    await call(p.token, 'POST', `/pilot/rides/${rideId}/arrived`);
    expect((await call(p.token, 'POST', `/pilot/rides/${rideId}/start`, { otp, idempotencyKey: 'start-7-xyz' })).statusCode).toBe(200);

    const contact = await call(p.token, 'GET', `/pilot/rides/${rideId}/sender-contact`);
    expect(contact.json().data).toEqual({ name: 'Sita Sender', phone: riderPhone });

    const done = await call(p.token, 'POST', `/pilot/rides/${rideId}/complete`, {
      idempotencyKey: 'done-7-xyz', collectedCash: false, notCollectedReason: 'receiver_refused',
    });
    expect(done.json().data).toMatchObject({ status: 'completed', paymentStatus: 'unpaid', paymentIssue: { code: 'receiver_refused' } });
    expect((await PilotWallet.findOne({ pilotId: p.id }).lean())?.duesPaise ?? 0).toBe(0);
    expect((await call(p.token, 'GET', `/pilot/rides/${rideId}/sender-contact`)).statusCode).toBe(409); // only while active

    const open = (await call(admin, 'GET', '/admin/rides/payment-issues')).json().data;
    expect(open.items.map((r: { id: string }) => r.id)).toEqual([rideId]);
    expect((await call(admin, 'POST', `/admin/rides/${rideId}/payment-issue/resolve`, { note: 'Sender paid by UPI' })).statusCode).toBe(200);
    expect((await call(admin, 'GET', '/admin/rides/payment-issues')).json().data.items).toHaveLength(0);
  });

  it('sender contact is parcel-only and only for the assigned pilot', async () => {
    const p = await onlinePilot('Ravi', 'TS03AB0007');
    const stranger = await onlinePilot('Kiran', 'TS03AB0008');
    const { rideId } = await bookRide('bike');
    const who = (await call(p.token, 'GET', '/pilot/rides/offers')).json().data.items.length ? p : stranger;
    const notWho = who === p ? stranger : p;
    await call(who.token, 'POST', `/pilot/rides/${rideId}/accept`, { idempotencyKey: 'acc-8-xyz' });
    expect((await call(who.token, 'GET', `/pilot/rides/${rideId}/sender-contact`)).statusCode).toBe(403);
    expect((await call(notWho.token, 'GET', `/pilot/rides/${rideId}/sender-contact`)).statusCode).toBe(404);
  });
});
