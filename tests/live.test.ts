import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { City } from '../src/modules/app/model.js';
import { Pilot, Rider } from '../src/modules/auth/model.js';
import { locationStore } from '../src/modules/dispatch/locationStore.js';
import { Ride, type RideStatus } from '../src/modules/rides/model.js';
import { OutOfAreaDemand } from '../src/modules/zones/model.js';
import { latLngToCell } from 'h3-js';
import { app, setupTestApp } from './helpers.js';

setupTestApp();

let seq = 0;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

async function adminToken() {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/admin/login', payload: { email: 'ops@prila.local', password: 'adminpass' },
  });
  return res.json().data.accessToken as string;
}

async function warangal() {
  return (await City.findOne({ slug: 'warangal' }).lean())!;
}

async function karimnagar() {
  return City.create({
    name: 'Karimnagar', slug: 'karimnagar', enabled: true,
    center: { type: 'Point', coordinates: [79.13, 18.43] }, services: ['bike'],
  });
}

async function onlinePilot(cityId: string, at: { lat: number; lng: number }, extra: Record<string, unknown> = {}) {
  const p = await Pilot.create({
    phone: `94${String(10_000_000 + seq++).slice(1)}`,
    name: `Pilot ${seq}`, vehicleType: 'bike', vehicleNumber: `TS03AB${1000 + seq}`,
    kycStatus: 'approved', status: 'active', cityId,
  });
  locationStore.upsert({
    pilotId: String(p._id), lat: at.lat, lng: at.lng, cell: 'x', updatedAt: Date.now(),
    status: 'idle', serviceTypes: ['bike'], vehicleType: 'bike', cityId, online: true, ...extra,
  });
  return String(p._id);
}

async function ride(cityId: Types.ObjectId | string, status: RideStatus, pilotId?: string) {
  const r = await Rider.create({ phone: `95${String(10_000_000 + seq++).slice(1)}`, name: 'Secret Rider' });
  return Ride.create({
    status, riderId: r._id, pilotId, cityId, serviceType: 'bike', quoteId: `q${seq}`,
    pickup: { name: 'Kazipet Junction', location: { type: 'Point', coordinates: [79.5133, 17.9757] } },
    drop: { name: 'MGM Hospital', location: { type: 'Point', coordinates: [79.59, 17.97] } },
    distanceM: 9000, durationSec: 1500,
  });
}

function live(token: string, cityId?: string) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/admin/dispatch/live${cityId ? `?cityId=${cityId}` : ''}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('admin live map', () => {
  it('needs an admin and a real city', async () => {
    const admin = await adminToken();
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/dispatch/live' })).statusCode).toBe(401);
    expect((await live(admin)).statusCode).toBe(400);
    expect((await live(admin, 'not-an-id')).statusCode).toBe(400);
    expect((await live(admin, String(new Types.ObjectId()))).statusCode).toBe(404);
  });

  it('shows only the chosen city: pilots with name + vehicle, live rides, counts', async () => {
    const admin = await adminToken();
    const w = await warangal();
    const k = await karimnagar();
    const idle = await onlinePilot(String(w._id), { lat: 17.98, lng: 79.55 });
    const busy = await onlinePilot(String(w._id), { lat: 17.99, lng: 79.56 }, { status: 'on_ride' });
    await onlinePilot(String(k._id), { lat: 18.43, lng: 79.13 }); // other city — hidden

    await ride(w._id, 'searching');
    await ride(w._id, 'in_progress', busy);
    await ride(w._id, 'completed', idle); // finished — hidden
    await ride(k._id, 'searching'); // other city — hidden

    const res = await live(admin, String(w._id));
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.pilots.map((p: { id: string }) => p.id).sort()).toEqual([idle, busy].sort());
    expect(d.pilots.find((p: { id: string }) => p.id === idle)).toMatchObject({
      status: 'idle', stale: false, vehicleType: 'bike', vehicleNumber: expect.stringMatching(/^TS03AB/),
      name: expect.stringMatching(/^Pilot /), lat: 17.98, lng: 79.55,
    });
    expect(d.rides).toHaveLength(2);
    const onTrip = d.rides.find((r: { status: string }) => r.status === 'in_progress');
    expect(onTrip).toMatchObject({
      searching: false, pilotId: busy, pilotName: expect.stringMatching(/^Pilot /),
      pickup: { name: 'Kazipet Junction', lat: 17.9757, lng: 79.5133 },
      drop: { name: 'MGM Hospital', lat: 17.97, lng: 79.59 },
    });
    expect(d.counts).toEqual({ idle: 1, offered: 0, onRide: 1, stale: 0, searching: 1, activeRides: 1 });
    expect(d.staleAfterSec).toBeGreaterThan(0);
    // Rider identity never reaches the live map.
    expect(res.body).not.toContain('Secret Rider');
    expect(res.body).not.toContain('riderId');
  });

  it('marks pilots without fresh GPS as stale and keeps them out of the status counts', async () => {
    const admin = await adminToken();
    const w = await warangal();
    const id = await onlinePilot(String(w._id), { lat: 17.98, lng: 79.55 }, { updatedAt: Date.now() - 10 * 60_000 });
    const d = (await live(admin, String(w._id))).json().data;
    expect(d.pilots[0]).toMatchObject({ id, stale: true });
    expect(d.pilots[0].lastSeenSec).toBeGreaterThanOrEqual(600);
    expect(d.counts).toMatchObject({ idle: 0, stale: 1 });
  });

  it('heatmap supply counts only this city\'s free pilots', async () => {
    const admin = await adminToken();
    const w = await warangal();
    const k = await karimnagar();
    await onlinePilot(String(w._id), { lat: 17.98, lng: 79.55 });
    await onlinePilot(String(k._id), { lat: 18.43, lng: 79.13 });
    const res = await app.inject({
      method: 'GET', url: `/api/v1/admin/dispatch/heatmap?cityId=${w._id}`, headers: { authorization: `Bearer ${admin}` },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().data.items as Array<{ supply: number; boundary: unknown[] }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.supply).toBe(1);
    expect(items[0]!.boundary.length).toBeGreaterThanOrEqual(6);
  });

  it('turned-away demand can be limited to one city', async () => {
    const admin = await adminToken();
    const w = await warangal();
    const NEAR = latLngToCell(18.05, 79.45, 8);
    const FAR = latLngToCell(17.38, 78.48, 8);
    const base = { day: today, kind: 'pickup' as const, reason: 'pickup_outside', count: 3, lastAt: new Date() };
    await OutOfAreaDemand.create([
      { ...base, cell: NEAR, lat: 18.05, lng: 79.45 }, // Hasanparthy side, ~20 km
      { ...base, cell: FAR, lat: 17.38, lng: 78.48 }, // Hyderabad, ~140 km
    ]);
    const get = (q: string) =>
      app.inject({ method: 'GET', url: `/api/v1/admin/zones/demand-outside?${q}`, headers: { authorization: `Bearer ${admin}` } });
    expect((await get('days=7')).json().data.items).toHaveLength(2);
    const near = (await get(`days=7&cityId=${w._id}`)).json().data.items;
    expect(near.map((i: { cell: string }) => i.cell)).toEqual([NEAR]);
    // Hexagon outline as [lng, lat] around the cell, so the admin map needs no H3 library.
    const ring = near[0].boundary as Array<[number, number]>;
    expect(ring).toHaveLength(6);
    for (const [lng, lat] of ring) {
      expect(Math.abs(lng - 79.45)).toBeLessThan(0.01);
      expect(Math.abs(lat - 18.05)).toBeLessThan(0.01);
    }
    expect((await get(`days=7&cityId=${new Types.ObjectId()}`)).statusCode).toBe(404);
  });
});
