import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env.js';
import { City, FareRule } from '../src/modules/app/model.js';
import { Pilot, Rider } from '../src/modules/auth/model.js';
import { app, setupTestApp } from './helpers.js';

/**
 * Step 7 — "how many Google calls does one ride cost?"
 * Walks a whole ride the way the apps do it (search → pick → estimate → switch service →
 * book → pilot trip → tracking → admin live map) with Google faked, and counts every
 * request that would have left our server for Google.
 */
setupTestApp();

const KEY = 'test-server-key-never-real';
const SESSION = '7c1e2d3f-4a5b-4c6d-8e7f-901a2b3c4d5e';
const calls: string[] = [];
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  env().GOOGLE_MAPS_SERVER_KEY = KEY;
});
afterAll(() => {
  env().GOOGLE_MAPS_SERVER_KEY = '';
});
beforeEach(() => {
  calls.length = 0;
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input));
    let json: unknown = {};
    if (url.pathname === '/v1/places:autocomplete') {
      calls.push('autocomplete');
      json = {
        suggestions: [
          {
            placePrediction: {
              placeId: 'ChIJmgmHospital00001',
              structuredFormat: { mainText: { text: 'MGM Hospital' }, secondaryText: { text: 'Warangal' } },
            },
          },
        ],
      };
    } else if (url.pathname.startsWith('/v1/places/')) {
      calls.push('placeDetails');
      json = { location: { latitude: 17.9702, longitude: 79.6003 }, formattedAddress: 'MGM Hospital, Warangal' };
    } else if (url.pathname.includes('/geocode/')) {
      calls.push('reverseGeocode');
      json = { status: 'OK', results: [{ formatted_address: 'Kazipet, Hanamkonda', types: ['sublocality'] }] };
    } else if (url.host === 'routes.googleapis.com') {
      calls.push('computeRoutes');
      json = { routes: [{ distanceMeters: 9100, duration: '1500s', polyline: { encodedPolyline: '_route_' } }] };
    } else {
      calls.push(`other:${url.host}`);
    }
    return new Response(JSON.stringify(json), { status: 200 });
  });
});
afterEach(() => fetchSpy.mockRestore());

const PICKUP = { lat: 17.9757, lng: 79.5133, name: 'Kazipet' };
const DROP = { lat: 17.9702, lng: 79.6003, name: 'MGM Hospital' };

async function fareRules() {
  const city = await City.findOne();
  for (const serviceType of ['bike', 'auto'] as const) {
    await FareRule.findOneAndUpdate(
      { cityId: city!._id, serviceType },
      {
        cityId: city!._id, serviceType, version: 1, baseFarePaise: 2000, perKmPaise: 800, perMinutePaise: 100,
        minimumFarePaise: 3000, nightMultiplier: 1, surgeMultiplier: 1, waitingPerMinutePaise: 0,
        cancellationFeePaise: 2000, platformFeePaise: 500,
      },
      { upsert: true },
    );
  }
  return city!;
}

describe('Google calls per ride (Step 7)', () => {
  it('one full ride = 1 reverse geocode + typing + 1 place details + 1 route per vehicle type; trip itself = 0', async () => {
    const city = await fareRules();
    const rider = await Rider.create({ phone: '9876500001' });
    const riderT = app.jwt.sign({ sub: String(rider._id), typ: 'access' });
    const pilot = await Pilot.create({
      phone: '9876500002', name: 'Cost Pilot', vehicleType: 'bike', vehicleNumber: 'TS03CO0001',
      kycStatus: 'approved', status: 'active', cityId: city._id,
    });
    const pilotT = app.jwt.sign({ sub: String(pilot._id), typ: 'pilot' });
    const admin = (
      await app.inject({ method: 'POST', url: '/api/v1/admin/login', payload: { email: 'ops@prila.local', password: 'adminpass' } })
    ).json().data.accessToken as string;

    const asRider = (method: 'GET' | 'POST', url: string, payload?: object) =>
      app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${riderT}` }, payload });
    const asPilot = (url: string, payload: object = {}) =>
      app.inject({ method: 'POST', url: `/api/v1${url}`, headers: { authorization: `Bearer ${pilotT}` }, payload });
    const step = (name: string) => ({ name, before: calls.length });
    const spent: Record<string, number> = {};
    const done = (s: { name: string; before: number }) => (spent[s.name] = calls.length - s.before);

    // 1. Pickup = "current location" → one address lookup.
    let s = step('pickup address (current location)');
    expect((await asRider('GET', `/maps/reverse?lat=${PICKUP.lat}&lng=${PICKUP.lng}`)).statusCode).toBe(200);
    done(s);

    // 2. Typing the drop: 1-2 chars never reach Google; debounced pauses do (app sends ~2 per search).
    s = step('typing drop (2 pauses)');
    await asRider('GET', `/maps/autocomplete?q=mg&sessionToken=${SESSION}`);
    await asRider('GET', `/maps/autocomplete?q=mgm&sessionToken=${SESSION}`);
    await asRider('GET', `/maps/autocomplete?q=mgm hosp&sessionToken=${SESSION}`);
    done(s);

    // 3. Tap the Google suggestion → one Place Details (ends the session).
    s = step('pick suggestion');
    expect((await asRider('GET', `/maps/place?placeId=ChIJmgmHospital00001&sessionToken=${SESSION}`)).statusCode).toBe(200);
    done(s);

    // 4. Fare screen: bike, switch to auto, back to bike, quote refresh.
    s = step('fare screen (bike → auto → bike → refresh)');
    const est = (serviceType: string) =>
      asRider('POST', '/rides/estimate', { serviceType, pickup: PICKUP, drop: DROP, cityId: String(city._id) });
    expect((await est('bike')).statusCode).toBe(200);
    expect((await est('auto')).statusCode).toBe(200);
    expect((await est('bike')).statusCode).toBe(200);
    const quote = await est('bike');
    done(s);

    // 5. Book + whole pilot trip + rider tracking + admin live map.
    s = step('book + trip + tracking + admin live map');
    await asPilot('/pilot/online', { online: true, lat: PICKUP.lat, lng: PICKUP.lng });
    const book = await asRider('POST', '/rides', {
      quoteId: quote.json().data.quoteId, idempotencyKey: 'cost-book-1', paymentMethod: 'cash',
    });
    expect(book.statusCode).toBe(200);
    const rideId = book.json().data.id as string;
    expect((await asPilot(`/pilot/rides/${rideId}/accept`, { idempotencyKey: 'cost-accept-1' })).statusCode).toBe(200);
    for (let i = 0; i < 5; i++) {
      await asPilot('/pilot/location', { lat: PICKUP.lat + i * 0.001, lng: PICKUP.lng }); // pilot GPS
      await asRider('GET', `/rides/${rideId}`); // rider tracking poll
    }
    await asPilot(`/pilot/rides/${rideId}/arrived`);
    const otp = (await asRider('GET', `/rides/${rideId}`)).json().data.startOtp as string;
    expect((await asPilot(`/pilot/rides/${rideId}/start`, { otp, idempotencyKey: 'cost-start-1' })).statusCode).toBe(200);
    await app.inject({
      method: 'GET', url: `/api/v1/admin/dispatch/live?cityId=${city._id}`, headers: { authorization: `Bearer ${admin}` },
    });
    const complete = await asPilot(`/pilot/rides/${rideId}/complete`, { idempotencyKey: 'cost-complete-1', collectedCash: true });
    expect(complete.statusCode).toBe(200);
    // Final fare = the quoted fare (locked at booking, never recalculated).
    expect(complete.json().data.fareTotalPaise).toBe(quote.json().data.fare.totalPaise);
    done(s);

    expect(spent).toEqual({
      'pickup address (current location)': 1,
      'typing drop (2 pauses)': 2, // "mg" is below the 3-character minimum
      'pick suggestion': 1,
      'fare screen (bike → auto → bike → refresh)': 2, // one route per vehicle type, rest cached
      'book + trip + tracking + admin live map': 0,
    });
    expect(calls).toEqual(['reverseGeocode', 'autocomplete', 'autocomplete', 'placeDetails', 'computeRoutes', 'computeRoutes']);
    expect(calls.some((c) => c.startsWith('other:'))).toBe(false);

    // The same numbers are visible to ops at /admin/maps/usage.
    const usage = (
      await app.inject({ method: 'GET', url: '/api/v1/admin/maps/usage', headers: { authorization: `Bearer ${admin}` } })
    ).json().data;
    expect(usage.googleCalls).toEqual({ autocomplete: 2, placeDetails: 1, reverseGeocode: 1, computeRoutes: 2 });
  });

  it('a repeat rider who picks a recent / saved place and books a bike = 1 Google call', async () => {
    const city = await fareRules();
    const rider = await Rider.create({ phone: '9876500003' });
    const t = app.jwt.sign({ sub: String(rider._id), typ: 'access' });
    // Recents / saved places / landmarks carry coordinates → no search or details calls.
    const res = await app.inject({
      method: 'POST', url: '/api/v1/rides/estimate', headers: { authorization: `Bearer ${t}` },
      payload: { serviceType: 'bike', pickup: PICKUP, drop: DROP, cityId: String(city._id) },
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['computeRoutes']);
  });
});
