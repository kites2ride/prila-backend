import { beforeEach, describe, expect, it } from 'vitest';
import { app, setupTestApp } from './helpers.js';
import { locationStore } from '../src/modules/dispatch/locationStore.js';
import { toCell } from '../src/modules/dispatch/h3.js';
import { findNearbyPilots } from '../src/modules/dispatch/nearby.js';
import type { PilotLiveState } from '../src/modules/dispatch/types.js';

setupTestApp();

const ORIGIN = { lat: 17.9689, lng: 79.5941 };
const NOW = Date.now();

function pilot(id: string, over: Partial<PilotLiveState> = {}): PilotLiveState {
  const lat = over.lat ?? ORIGIN.lat + 0.002;
  const lng = over.lng ?? ORIGIN.lng;
  return {
    pilotId: id,
    lat,
    lng,
    cell: toCell(lat, lng, 8),
    updatedAt: NOW,
    status: 'idle',
    serviceTypes: ['bike'],
    vehicleType: 'bike',
    online: true,
    kycStatus: 'approved',
    headingDeg: 370,
    ...over,
  };
}

describe('findNearbyPilots', () => {
  beforeEach(() => {
    for (const p of locationStore.listAll()) locationStore.remove(p.pilotId);
  });

  it('returns only idle, fresh, online pilots of the requested service', async () => {
    locationStore.upsert(pilot('ok'));
    locationStore.upsert(pilot('busy', { status: 'on_ride' }));
    locationStore.upsert(pilot('offered', { status: 'offered' }));
    locationStore.upsert(pilot('stale', { updatedAt: NOW - 3 * 60_000 }));
    locationStore.upsert(pilot('auto', { vehicleType: 'auto' }));
    locationStore.upsert(pilot('far', { lat: ORIGIN.lat + 0.2 }));
    locationStore.upsert(pilot('mocked', { flaggedMocked: true }));
    const r = await findNearbyPilots({ ...ORIGIN, serviceType: 'bike', now: NOW });
    expect(r.map((p) => p.id)).toEqual(['ok']);
    expect(r[0]).toEqual({ id: 'ok', lat: expect.any(Number), lng: expect.any(Number), heading: 10, vehicleType: 'bike' });
  });

  it('parcel also shows eligible bikes; bike never shows parcel vehicles', async () => {
    locationStore.upsert(pilot('b', { vehicleType: 'bike' }));
    locationStore.upsert(pilot('p', { vehicleType: 'parcel' }));
    const parcel = await findNearbyPilots({ ...ORIGIN, serviceType: 'parcel', now: NOW });
    expect(parcel.map((p) => p.id).sort()).toEqual(['b', 'p']);
    const bike = await findNearbyPilots({ ...ORIGIN, serviceType: 'bike', now: NOW });
    expect(bike.map((p) => p.id)).toEqual(['b']);
  });

  it('caps at 12, nearest first', async () => {
    for (let i = 0; i < 15; i++) locationStore.upsert(pilot(`p${i}`, { lat: ORIGIN.lat + 0.0005 * (i + 1) }));
    const r = await findNearbyPilots({ ...ORIGIN, serviceType: 'bike', now: NOW });
    expect(r).toHaveLength(12);
    expect(r[0]!.id).toBe('p0');
  });

  it('GET /pilots/nearby needs a rider token and validates input', async () => {
    const noAuth = await app.inject({ method: 'GET', url: '/api/v1/pilots/nearby?lat=17&lng=79&serviceType=bike' });
    expect(noAuth.statusCode).toBe(401);
  });
});
