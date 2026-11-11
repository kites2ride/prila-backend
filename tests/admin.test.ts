import { describe, expect, it } from 'vitest';
import { app, setupTestApp } from './helpers.js';
import { istDayBounds } from '../src/modules/admin/ist.js';

setupTestApp();

async function adminToken() {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/login',
    payload: { email: 'ops@prila.local', password: 'adminpass' },
  });
  return login.json().data.accessToken as string;
}

describe('admin ops', () => {
  it('parses IST day bounds', () => {
    const { from, to } = istDayBounds('2026-11-11', '2026-11-11');
    expect(from.toISOString()).toBe('2026-11-10T18:30:00.000Z');
    expect(to.toISOString()).toBe('2026-11-11T18:29:59.999Z');
  });

  it('returns overview KPIs for date range', async () => {
    const token = await adminToken();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/overview?from=2026-11-01&to=2026-11-11',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.signups.riders).toBeTypeOf('number');
    expect(data.rides.requested).toBe(0);
    expect(data.onlinePilotsNow).toBeTypeOf('number');
  });

  it('lists cities and previews fare', async () => {
    const token = await adminToken();
    const cities = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/cities',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(cities.statusCode).toBe(200);
    const cityId = cities.json().data.items[0].id as string;

    // Seed does not run in tests — create a fare rule first
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/fares',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        cityId,
        serviceType: 'bike',
        baseFarePaise: 2000,
        perKmPaise: 800,
        perMinutePaise: 100,
        minimumFarePaise: 3000,
        nightMultiplier: 1.2,
        surgeMultiplier: 1,
        waitingPerMinutePaise: 100,
        cancellationFeePaise: 2000,
        platformFeePaise: 500,
      },
    });
    expect(put.statusCode).toBe(200);

    const preview = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fares/preview',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        cityId,
        serviceType: 'bike',
        distanceM: 8400,
        durationSec: 1200,
        waitingSec: 0,
        isNight: false,
        applySurge: true,
      },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.breakdown.totalPaise).toBeGreaterThan(0);
  });
});
