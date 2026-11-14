import { describe, expect, it } from 'vitest';
import type { Types } from 'mongoose';
import { AdminAuditLog, City, ConfigSingleton, FareRule, Zone } from '../src/modules/app/model.js';
import { Pilot, Rider } from '../src/modules/auth/model.js';
import { checkPolygon } from '../src/modules/zones/geo.js';
import { OutOfAreaDemand } from '../src/modules/zones/model.js';
import { invalidateZoneCaches } from '../src/modules/zones/service.js';
import { configCache } from '../src/lib/cache.js';
import { app, setupTestApp } from './helpers.js';

setupTestApp();

type LatLng = { lat: number; lng: number };

/** Axis-aligned box → closed GeoJSON ring [lng, lat]. */
function box(lngMin: number, latMin: number, lngMax: number, latMax: number): number[][][] {
  return [[[lngMin, latMin], [lngMax, latMin], [lngMax, latMax], [lngMin, latMax], [lngMin, latMin]]];
}

// Test geography (approximate, not real boundaries)
const HANAMKONDA = box(79.54, 17.99, 79.6, 18.03);
const WARANGAL = box(79.58, 17.95, 79.62, 17.99);
const KAZIPET_AUTO_ONLY = box(79.47, 17.96, 79.52, 18.0);
const AIRPORT_BLOCKED = box(79.56, 18.0, 79.57, 18.01); // inside Hanamkonda
const KARIMNAGAR = box(79.1, 18.41, 79.16, 18.46);

const H_IN = { lat: 18.02, lng: 79.55 };
const H_IN_2 = { lat: 18.0, lng: 79.59 };
const W_IN = { lat: 17.97, lng: 79.6 };
const K_IN = { lat: 17.98, lng: 79.5 };
const K_IN_2 = { lat: 17.97, lng: 79.49 };
const BLOCKED_PT = { lat: 18.005, lng: 79.565 };
const OUTSIDE = { lat: 17.8, lng: 79.4 };
const KARIM_IN = { lat: 18.43, lng: 79.13 };

let seq = 0;

async function warangalCity() {
  return (await City.findOne({ slug: 'warangal' }))!;
}

async function addZone(
  coordinates: number[][][],
  opts: {
    name?: string;
    type?: 'service' | 'blocked';
    services?: Array<'bike' | 'auto' | 'parcel' | 'logistics'>;
    cityId?: Types.ObjectId;
    enabled?: boolean;
  } = {},
) {
  const city = await warangalCity();
  const z = await Zone.create({
    cityId: opts.cityId ?? city._id,
    name: opts.name ?? `zone-${seq++}`,
    type: opts.type ?? 'service',
    services: opts.services ?? [],
    enabled: opts.enabled ?? true,
    polygon: { type: 'Polygon', coordinates },
  });
  invalidateZoneCaches();
  return z;
}

async function standardZones() {
  await addZone(HANAMKONDA, { name: 'Hanamkonda' });
  await addZone(WARANGAL, { name: 'Warangal' });
  await addZone(KAZIPET_AUTO_ONLY, { name: 'Kazipet', services: ['auto'] });
  await addZone(AIRPORT_BLOCKED, { name: 'Airport', type: 'blocked' });
  const karim = await City.create({
    name: 'Karimnagar', slug: 'karimnagar', enabled: true,
    center: { type: 'Point', coordinates: [79.13, 18.43] }, services: ['bike', 'auto'],
  });
  await addZone(KARIMNAGAR, { name: 'Karimnagar', cityId: karim._id });
}

async function fareRules() {
  const city = await warangalCity();
  for (const serviceType of ['bike', 'auto'] as const) {
    await FareRule.findOneAndUpdate(
      { cityId: city._id, serviceType },
      {
        cityId: city._id, serviceType, version: 1, baseFarePaise: 2000, perKmPaise: 800, perMinutePaise: 100,
        minimumFarePaise: 3000, nightMultiplier: 1, surgeMultiplier: 1, waitingPerMinutePaise: 0,
        cancellationFeePaise: 2000, platformFeePaise: 500,
      },
      { upsert: true },
    );
  }
}

async function setZonesConfig(value: Record<string, unknown>) {
  await ConfigSingleton.findOneAndUpdate({ key: 'zones' }, { key: 'zones', version: 1, value }, { upsert: true });
  configCache.clear();
}

async function riderToken() {
  const r = await Rider.create({ phone: `92${String(10_000_000 + seq++).slice(1)}` });
  return app.jwt.sign({ sub: String(r._id), typ: 'access' });
}

async function pilotToken(vehicleType: 'bike' | 'auto' = 'bike') {
  const p = await Pilot.create({
    phone: `93${String(10_000_000 + seq++).slice(1)}`, vehicleType, kycStatus: 'approved', status: 'active',
  });
  return { token: app.jwt.sign({ sub: String(p._id), typ: 'pilot' }), id: String(p._id) };
}

async function adminToken() {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/admin/login', payload: { email: 'ops@prila.local', password: 'adminpass' },
  });
  return res.json().data.accessToken as string;
}

function estimate(token: string, pickup: LatLng, drop: LatLng, serviceType: 'bike' | 'auto' = 'bike') {
  return app.inject({
    method: 'POST', url: '/api/v1/rides/estimate',
    headers: { authorization: `Bearer ${token}` },
    payload: { serviceType, pickup, drop },
  });
}

function goOnline(token: string, at: LatLng) {
  return app.inject({
    method: 'POST', url: '/api/v1/pilot/online',
    headers: { authorization: `Bearer ${token}` },
    payload: { online: true, ...at },
  });
}

async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 2000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('zones: polygon validation (pure)', () => {
  it('closes open rings, drops duplicate points and orients counter-clockwise', () => {
    const cw = [[[79.54, 17.99], [79.54, 18.03], [79.54, 18.03], [79.6, 18.03], [79.6, 17.99]]]; // clockwise, open
    const r = checkPolygon(cw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ring).toHaveLength(5);
    expect(r.ring[0]).toEqual(r.ring[4]);
    // reversed → CCW: (79.6,17.99) → (79.6,18.03) → (79.54,18.03) → (79.54,17.99)
    expect(r.ring.slice(0, 4)).toEqual([[79.6, 17.99], [79.6, 18.03], [79.54, 18.03], [79.54, 17.99]]);
    expect(r.areaKm2).toBeGreaterThan(20);
  });

  it('rejects self-crossing, too few points, too small, too large, holes', () => {
    const bowtie = [[[79.54, 17.99], [79.6, 18.03], [79.6, 17.99], [79.54, 18.03]]];
    expect(checkPolygon(bowtie)).toMatchObject({ ok: false, message: expect.stringContaining('crosses itself') });
    expect(checkPolygon([[[79.5, 18], [79.6, 18]]])).toMatchObject({ ok: false, message: expect.stringContaining('at least 3') });
    expect(checkPolygon(box(79.5, 18, 79.5001, 18.0001))).toMatchObject({ ok: false, message: expect.stringContaining('too small') });
    expect(checkPolygon(box(70, 10, 80, 20))).toMatchObject({ ok: false, message: expect.stringContaining('too large') });
    expect(checkPolygon([...HANAMKONDA, ...AIRPORT_BLOCKED])).toMatchObject({ ok: false });
  });
});

describe('zones: rider trips', () => {
  it('no zones drawn yet → not enforced (fresh install keeps working)', async () => {
    await fareRules();
    const t = await riderToken();
    expect((await estimate(t, OUTSIDE, W_IN)).statusCode).toBe(200);
  });

  it('allows trips across zones of the same city and books them', async () => {
    await standardZones();
    await fareRules();
    const t = await riderToken();
    const res = await estimate(t, H_IN, W_IN);
    expect(res.statusCode).toBe(200);
    const book = await app.inject({
      method: 'POST', url: '/api/v1/rides', headers: { authorization: `Bearer ${t}` },
      payload: { quoteId: res.json().data.quoteId, idempotencyKey: `zones-book-${seq++}` },
    });
    expect(book.statusCode).toBe(200);
  });

  it('pickup outside → OUT_OF_SERVICE_AREA with config message, demand counted', async () => {
    await standardZones();
    await fareRules();
    const t = await riderToken();
    const res = await estimate(t, OUTSIDE, H_IN);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('OUT_OF_SERVICE_AREA');
    expect(res.json().error.details).toEqual({ reason: 'pickup_outside' });
    expect(res.json().error.message).toContain("We're not in your area yet");
    const row = await waitFor(() => OutOfAreaDemand.findOne({ kind: 'pickup', reason: 'pickup_outside' }).lean());
    expect(row.count).toBe(1);
  });

  it('drop must be inside (configurable) and in the same city', async () => {
    await standardZones();
    await fareRules();
    const t = await riderToken();
    const out = await estimate(t, H_IN, OUTSIDE);
    expect(out.statusCode).toBe(422);
    expect(out.json().error.details.reason).toBe('drop_outside');

    const otherCity = await estimate(t, H_IN, KARIM_IN);
    expect(otherCity.json().error.details.reason).toBe('drop_other_city');

    await setZonesConfig({ requireDropInside: false });
    expect((await estimate(t, H_IN, OUTSIDE)).statusCode).toBe(200);
  });

  it('blocked zone stops pickups (overrides service) but drops there are fine', async () => {
    await standardZones();
    await fareRules();
    const t = await riderToken();
    const res = await estimate(t, BLOCKED_PT, W_IN);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.reason).toBe('pickup_blocked');
    expect(res.json().error.message).toContain("Pickups aren't allowed");
    expect((await estimate(t, W_IN, BLOCKED_PT)).statusCode).toBe(200);
  });

  it('service-specific zones: Kazipet is auto-only', async () => {
    await standardZones();
    await fareRules();
    const t = await riderToken();
    expect((await estimate(t, K_IN, K_IN_2, 'bike')).json().error.details.reason).toBe('pickup_outside');
    expect((await estimate(t, K_IN, K_IN_2, 'auto')).statusCode).toBe(200);
    // auto from Kazipet into Hanamkonda (all-services zone) is fine
    expect((await estimate(t, K_IN, H_IN_2, 'auto')).statusCode).toBe(200);
  });

  it('disabled zone / disabled city close service; enforce=false opens it', async () => {
    await standardZones();
    await fareRules();
    const t = await riderToken();
    await Zone.updateOne({ name: 'Hanamkonda' }, { enabled: false });
    invalidateZoneCaches();
    expect((await estimate(t, H_IN, W_IN)).statusCode).toBe(422);

    await City.updateOne({ slug: 'warangal' }, { enabled: false });
    invalidateZoneCaches();
    expect((await estimate(t, W_IN, W_IN)).statusCode).toBe(422);

    await City.updateOne({ slug: 'warangal' }, { enabled: true }); // fare rules live on this city
    await setZonesConfig({ enforce: false });
    expect((await estimate(t, OUTSIDE, OUTSIDE)).statusCode).toBe(200);
  });

  it('booking re-checks zones (zone changed after the estimate)', async () => {
    await standardZones();
    await fareRules();
    const t = await riderToken();
    const est = await estimate(t, H_IN, W_IN);
    expect(est.statusCode).toBe(200);
    await Zone.updateOne({ name: 'Hanamkonda' }, { enabled: false });
    invalidateZoneCaches();
    const book = await app.inject({
      method: 'POST', url: '/api/v1/rides', headers: { authorization: `Bearer ${t}` },
      payload: { quoteId: est.json().data.quoteId, idempotencyKey: `zones-book-${seq++}` },
    });
    expect(book.statusCode).toBe(422);
    expect(book.json().error.code).toBe('OUT_OF_SERVICE_AREA');
  });
});

describe('zones: pilots', () => {
  it('can go online inside, not outside; respects vehicle type and config', async () => {
    await standardZones();
    const bike = await pilotToken('bike');
    expect((await goOnline(bike.token, H_IN)).statusCode).toBe(200);

    const out = await goOnline(bike.token, OUTSIDE);
    expect(out.statusCode).toBe(422);
    expect(out.json().error.details.reason).toBe('pilot_outside');
    expect(out.json().error.message).toContain('outside the Prila service area');

    // Kazipet is auto-only
    expect((await goOnline(bike.token, K_IN)).statusCode).toBe(422);
    const auto = await pilotToken('auto');
    expect((await goOnline(auto.token, K_IN)).statusCode).toBe(200);

    // waiting inside a blocked spot (inside a service zone) is fine for pilots
    expect((await goOnline(bike.token, BLOCKED_PT)).statusCode).toBe(200);

    await setZonesConfig({ pilotMustBeInside: false });
    expect((await goOnline(bike.token, OUTSIDE)).statusCode).toBe(200);
  });

  it('going offline does not move the pilot', async () => {
    await standardZones();
    const p = await pilotToken('bike');
    await goOnline(p.token, H_IN);
    await app.inject({
      method: 'POST', url: '/api/v1/pilot/online', headers: { authorization: `Bearer ${p.token}` },
      payload: { online: false, ...OUTSIDE },
    });
    const doc = await Pilot.findById(p.id).lean();
    expect(doc?.location?.coordinates).toEqual([H_IN.lng, H_IN.lat]);
  });
});

describe('zones: bootstrap + outlines', () => {
  it('bootstrap reports the service area for the reported location', async () => {
    const get = (q: string) => app.inject({ method: 'GET', url: `/api/v1/app/bootstrap?${q}` });
    const noZones = await get(`app=customer&lat=${OUTSIDE.lat}&lng=${OUTSIDE.lng}`);
    expect(noZones.json().data.serviceArea).toMatchObject({ enforced: false, inService: true });

    await standardZones();
    const inside = await get(`app=customer&lat=${H_IN.lat}&lng=${H_IN.lng}`);
    expect(inside.json().data.serviceArea).toMatchObject({ enforced: true, inService: true, cityName: 'Warangal', message: null });

    const outside = await get(`app=customer&lat=${OUTSIDE.lat}&lng=${OUTSIDE.lng}`);
    expect(outside.json().data.serviceArea).toMatchObject({ inService: false, message: expect.stringContaining('not in your area') });

    const blockedRider = await get(`app=customer&lat=${BLOCKED_PT.lat}&lng=${BLOCKED_PT.lng}`);
    expect(blockedRider.json().data.serviceArea.inService).toBe(false);
    const blockedPilot = await get(`app=pilot&lat=${BLOCKED_PT.lat}&lng=${BLOCKED_PT.lng}`);
    expect(blockedPilot.json().data.serviceArea.inService).toBe(true);

    expect((await get('app=customer')).json().data.serviceArea).toBeNull();
  });

  it('/app/zones is empty unless showOutlineOnMap', async () => {
    await standardZones();
    expect((await app.inject({ method: 'GET', url: '/api/v1/app/zones' })).json().data.zones).toEqual([]);
    await setZonesConfig({ showOutlineOnMap: true });
    const res = await app.inject({ method: 'GET', url: '/api/v1/app/zones' });
    expect(res.json().data.zones.map((z: { name: string }) => z.name).sort()).toEqual(
      ['Airport', 'Hanamkonda', 'Karimnagar', 'Kazipet', 'Warangal'],
    );
  });
});

describe('zones: admin', () => {
  it('validates, normalises, versions and audits zones', async () => {
    const admin = await adminToken();
    const city = await warangalCity();
    const post = (payload: Record<string, unknown>) => app.inject({
      method: 'POST', url: '/api/v1/admin/zones', headers: { authorization: `Bearer ${admin}` }, payload,
    });

    const bowtie = await post({ cityId: String(city._id), name: 'Bad', coordinates: [[[79.54, 17.99], [79.6, 18.03], [79.6, 17.99], [79.54, 18.03]]] });
    expect(bowtie.statusCode).toBe(400);
    expect(JSON.stringify(bowtie.json())).toContain('crosses itself');

    // open, clockwise ring → stored closed + CCW, version 1
    const open = [[[79.54, 17.99], [79.54, 18.03], [79.6, 18.03], [79.6, 17.99]]];
    const created = await post({ cityId: String(city._id), name: 'Hanamkonda', district: 'Hanamkonda', services: ['bike'], coordinates: open });
    expect(created.statusCode).toBe(200);
    expect(created.json().data.version).toBe(1);
    const id = created.json().data.id as string;
    const doc = await Zone.findById(id).lean();
    const ring = doc?.polygon?.coordinates[0] as unknown as number[][];
    expect(ring).toHaveLength(5);
    expect(ring.slice(0, 2)).toEqual([[79.6, 17.99], [79.6, 18.03]]); // CCW

    const patch = (payload: Record<string, unknown>) => app.inject({
      method: 'PATCH', url: `/api/v1/admin/zones/${id}`, headers: { authorization: `Bearer ${admin}` }, payload,
    });
    const body = { cityId: String(city._id), name: 'Hanamkonda', type: 'service', coordinates: HANAMKONDA };
    const ok = await patch({ ...body, expectedVersion: 1 });
    expect(ok.json().data.version).toBe(2);
    const stale = await patch({ ...body, expectedVersion: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');

    expect(await AdminAuditLog.countDocuments({ key: 'zone' })).toBe(2);

    const list = await app.inject({ method: 'GET', url: `/api/v1/admin/zones?cityId=${city._id}`, headers: { authorization: `Bearer ${admin}` } });
    expect(list.json().data.enforcement).toEqual({ enforce: true, serviceZonesExist: true, active: true });
    expect(list.json().data.items[0]).toMatchObject({ type: 'service', version: 2, district: '' });
  });

  it('upgrades a legacy (pre-versioning) zone safely', async () => {
    const admin = await adminToken();
    const city = await warangalCity();
    const legacy = await Zone.collection.insertOne({
      cityId: city._id, name: 'Legacy', enabled: true, polygon: { type: 'Polygon', coordinates: HANAMKONDA },
    });
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/admin/zones/${legacy.insertedId}`, headers: { authorization: `Bearer ${admin}` },
      payload: { cityId: String(city._id), name: 'Legacy v2', coordinates: HANAMKONDA },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.version).toBe(2);
  });

  it('"Test a point" matches what the server enforces', async () => {
    await standardZones();
    await fareRules();
    const admin = await adminToken();
    const test = async (payload: Record<string, unknown>) => {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/admin/zones/test-point', headers: { authorization: `Bearer ${admin}` },
        payload,
      });
      return res.json().data;
    };
    const rider = await riderToken();

    for (const [pt, svc] of [[H_IN, 'bike'], [OUTSIDE, 'bike'], [BLOCKED_PT, 'bike'], [K_IN, 'bike'], [K_IN, 'auto']] as const) {
      const verdict = await test({ ...pt, serviceType: svc, role: 'pickup' });
      const est = await estimate(rider, pt, H_IN_2, svc);
      expect(verdict.allowedNow, `${JSON.stringify(pt)} ${svc}`).toBe(est.statusCode === 200);
      if (est.statusCode !== 200) expect(verdict.reason).toBe(est.json().error.details.reason);
    }
    const inside = await test({ ...H_IN, role: 'pickup' });
    expect(inside).toMatchObject({ enforced: true, inService: true, zone: { name: 'Hanamkonda' }, cityName: 'Warangal' });
    const blocked = await test({ ...BLOCKED_PT, role: 'pickup' });
    expect(blocked).toMatchObject({ allowedNow: false, reason: 'pickup_blocked', blockedBy: { name: 'Airport' } });
  });

  it('demand outside the zones is aggregated for ops', async () => {
    await standardZones();
    await fareRules();
    const t = await riderToken();
    await estimate(t, OUTSIDE, H_IN);
    await estimate(t, OUTSIDE, H_IN);
    await waitFor(() => OutOfAreaDemand.findOne({ count: 2 }).lean());
    const admin = await adminToken();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/admin/zones/demand-outside?days=7', headers: { authorization: `Bearer ${admin}` },
    });
    expect(res.json().data.items[0]).toMatchObject({ kind: 'pickup', count: 2, reasons: ['pickup_outside'] });
    expect(res.json().data.items[0].lat).toBeCloseTo(OUTSIDE.lat, 1);
  });
});
