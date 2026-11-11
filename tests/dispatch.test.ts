import { describe, expect, it, beforeEach } from 'vitest';
import { InMemoryLocationStore } from '../src/modules/dispatch/locationStore.js';
import { toCell, cellsAtRing } from '../src/modules/dispatch/h3.js';
import { findCandidates } from '../src/modules/dispatch/candidates.js';
import { locationStore } from '../src/modules/dispatch/locationStore.js';
import { getSurgeMultiplier, recordDemand, _resetSurgeForTests } from '../src/modules/dispatch/surge.js';
import { ConfigSingleton } from '../src/modules/app/model.js';
import { setupTestApp } from './helpers.js';

setupTestApp();

describe('dispatch LocationStore', () => {
  it('indexes a pilot in exactly one cell and moves on cell change', () => {
    const store = new InMemoryLocationStore();
    const cellA = toCell(17.9689, 79.5941, 8);
    const cellB = toCell(17.99, 79.62, 8);
    expect(cellA).not.toBe(cellB);

    store.upsert({
      pilotId: 'p1',
      lat: 17.9689,
      lng: 79.5941,
      cell: cellA,
      updatedAt: Date.now(),
      status: 'idle',
      serviceTypes: ['bike'],
      vehicleType: 'bike',
      online: true,
      kycStatus: 'approved',
    });
    expect(store.listByCells([cellA]).map((p) => p.pilotId)).toEqual(['p1']);

    store.upsert({
      pilotId: 'p1',
      lat: 17.99,
      lng: 79.62,
      cell: cellB,
      updatedAt: Date.now(),
      status: 'idle',
      serviceTypes: ['bike'],
      vehicleType: 'bike',
      online: true,
      kycStatus: 'approved',
    });
    expect(store.listByCells([cellA])).toHaveLength(0);
    expect(store.listByCells([cellB]).map((p) => p.pilotId)).toEqual(['p1']);
  });

  it('sweepStale removes old pilots', () => {
    const store = new InMemoryLocationStore();
    const cell = toCell(17.9689, 79.5941, 8);
    store.upsert({
      pilotId: 'old',
      lat: 17.9689,
      lng: 79.5941,
      cell,
      updatedAt: Date.now() - 60_000,
      status: 'idle',
      serviceTypes: ['bike'],
      vehicleType: 'bike',
      online: true,
    });
    const removed = store.sweepStale(30_000);
    expect(removed).toContain('old');
    expect(store.get('old')).toBeUndefined();
  });
});

describe('dispatch candidates + surge', () => {
  beforeEach(() => {
    locationStore.clear();
    _resetSurgeForTests();
  });

  it('finds nearest idle pilot via H3 rings and skips on_ride', async () => {
    const cell = toCell(17.9689, 79.5941, 8);
    locationStore.upsert({
      pilotId: 'busy',
      lat: 17.9689,
      lng: 79.5941,
      cell,
      updatedAt: Date.now(),
      status: 'on_ride',
      serviceTypes: ['bike'],
      vehicleType: 'bike',
      online: true,
      kycStatus: 'approved',
    });
    locationStore.upsert({
      pilotId: 'near',
      lat: 17.969,
      lng: 79.5942,
      cell,
      updatedAt: Date.now(),
      status: 'idle',
      serviceTypes: ['bike'],
      vehicleType: 'bike',
      online: true,
      kycStatus: 'approved',
    });
    locationStore.upsert({
      pilotId: 'farther',
      lat: 17.972,
      lng: 79.598,
      cell: cellsAtRing(cell, 1)[0] ?? cell,
      updatedAt: Date.now(),
      status: 'idle',
      serviceTypes: ['bike'],
      vehicleType: 'bike',
      online: true,
      kycStatus: 'approved',
    });

    const { candidates, log } = await findCandidates({
      pickupLat: 17.9689,
      pickupLng: 79.5941,
      serviceType: 'bike',
      excludePilotIds: [],
    });
    expect(candidates.map((c) => c.pilotId)).not.toContain('busy');
    expect(candidates[0]?.pilotId).toBe('near');
    expect(log.event).toBe('candidate_search');
    expect((log.ms ?? 99) < 50).toBe(true);
  });

  it('caps surge multiplier and returns 1 when disabled', async () => {
    await ConfigSingleton.updateOne({ key: 'surge' }, { $set: { 'value.enabled': true } });
    const cityId = 'city1';
    for (let i = 0; i < 20; i++) await recordDemand(cityId, 17.9689, 79.5941);
    const mult = await getSurgeMultiplier(cityId, 17.9689, 79.5941);
    expect(mult).toBeLessThanOrEqual(1.5);
    expect(mult).toBeGreaterThanOrEqual(1);

    await ConfigSingleton.updateOne({ key: 'surge' }, { $set: { 'value.enabled': false } });
    expect(await getSurgeMultiplier(cityId, 17.9689, 79.5941)).toBe(1);
  });
});
