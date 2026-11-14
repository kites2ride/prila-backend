import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env.js';
import { City, ConfigSingleton, FareRule } from '../src/modules/app/model.js';
import { Ride } from '../src/modules/rides/model.js';
import { Rider } from '../src/modules/auth/model.js';
import { app, setupTestApp } from './helpers.js';

setupTestApp();

const KEY = 'test-server-key-never-real';
const SESSION = '3f2b8c1e-6a7d-4e2f-9b10-0c1d2e3f4a5b';

type Handler = (url: URL, init: RequestInit) => { status?: number; json: unknown } | Promise<never>;
let handler: Handler;
let fetchSpy: ReturnType<typeof vi.spyOn>;
const calls: Array<{ url: URL; init: RequestInit }> = [];

function google(handlerFn: Handler) {
  handler = handlerFn;
}

beforeAll(() => {
  env().GOOGLE_MAPS_SERVER_KEY = KEY;
});
afterAll(() => {
  env().GOOGLE_MAPS_SERVER_KEY = '';
});

beforeEach(() => {
  calls.length = 0;
  handler = () => ({ status: 500, json: {} });
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    const r = await handler(url, init ?? {});
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  });
});
afterEach(() => {
  fetchSpy.mockRestore();
});

/** Real Rider doc + signed access token (skips OTP, which is IP rate-limited to 10/min). */
let phoneSeq = 0;
async function riderToken() {
  const rider = await Rider.create({ phone: `9100${String(100000 + phoneSeq++).slice(1)}0` });
  return app.jwt.sign({ sub: String(rider._id), typ: 'access' });
}

async function adminToken() {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/login',
    payload: { email: 'ops@prila.local', password: 'adminpass' },
  });
  return res.json().data.accessToken as string;
}

function get(url: string, token: string) {
  return app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });
}

async function setMaps(value: Record<string, unknown>) {
  await ConfigSingleton.findOneAndUpdate({ key: 'maps' }, { key: 'maps', version: 1, value }, { upsert: true });
  const { configCache } = await import('../src/lib/cache.js');
  configCache.clear();
}

const autocompleteOk: Handler = () => ({
  json: {
    suggestions: [
      {
        placePrediction: {
          placeId: 'ChIJhanamkonda0001',
          structuredFormat: { mainText: { text: 'Hanamkonda Chowrasta' }, secondaryText: { text: 'Hanamkonda, Telangana' } },
        },
      },
      { queryPrediction: { text: { text: 'hanamkonda bus stand' } } },
    ],
  },
});

describe('maps: auth + validation', () => {
  it('requires an app token', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/maps/autocomplete?q=hana&sessionToken=${SESSION}` });
    expect(res.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('rejects bad session tokens, place ids and lone lat', async () => {
    const t = await riderToken();
    expect((await get(`/maps/autocomplete?q=hana&sessionToken=x`, t)).statusCode).toBe(400);
    expect((await get(`/maps/place?placeId=../../evil&sessionToken=${SESSION}`, t)).statusCode).toBe(400);
    expect((await get(`/maps/autocomplete?q=hana&sessionToken=${SESSION}&lat=17.9`, t)).statusCode).toBe(400);
    expect((await get(`/maps/reverse?lat=91&lng=79`, t)).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe('maps: autocomplete', () => {
  it('answers locally below min chars (no Google call)', async () => {
    const t = await riderToken();
    const res = await get(`/maps/autocomplete?q=ha&sessionToken=${SESSION}`, t);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, data: { suggestions: [] } });
    expect(calls).toHaveLength(0);
  });

  it('calls Places (New) with field mask, header key, India + city bias', async () => {
    google(autocompleteOk);
    const t = await riderToken();
    const res = await get(`/maps/autocomplete?q=${encodeURIComponent('  hanamkonda ')}&sessionToken=${SESSION}`, t);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.suggestions).toEqual([
      { placeId: 'ChIJhanamkonda0001', mainText: 'Hanamkonda Chowrasta', secondaryText: 'Hanamkonda, Telangana' },
    ]);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    const h = init.headers as Record<string, string>;
    expect(url.href).toBe('https://places.googleapis.com/v1/places:autocomplete');
    expect(url.search).not.toContain(KEY);
    expect(h['X-Goog-Api-Key']).toBe(KEY);
    expect(h['X-Goog-FieldMask']).toContain('suggestions.placePrediction.placeId');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      input: 'hanamkonda',
      sessionToken: SESSION,
      languageCode: 'en',
      includedRegionCodes: ['in'],
      locationBias: { circle: { center: { latitude: 17.9689, longitude: 79.5941 }, radius: 20000 } },
    });
  });

  it('biases around the user location when given', async () => {
    google(autocompleteOk);
    const t = await riderToken();
    await get(`/maps/autocomplete?q=kazipet&sessionToken=${SESSION}&lat=18.0145&lng=79.4876`, t);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.locationBias.circle.center).toEqual({ latitude: 18.0145, longitude: 79.4876 });
  });

  it('rate limits per user from config', async () => {
    google(autocompleteOk);
    await setMaps({ autocompleteRateLimitPerMin: 2 });
    const t = await riderToken();
    const codes = [];
    for (let i = 0; i < 3; i++) {
      codes.push((await get(`/maps/autocomplete?q=hanam${i}&sessionToken=${SESSION}`, t)).statusCode);
    }
    expect(codes).toEqual([200, 200, 429]);
    expect(calls).toHaveLength(2);
  });

  it('maps Google denial / timeout to MAPS_UNAVAILABLE without leaking details', async () => {
    const t = await riderToken();
    google(() => ({ status: 403, json: { error: { status: 'PERMISSION_DENIED', message: `bad key ${KEY}` } } }));
    const denied = await get(`/maps/autocomplete?q=hanamkonda&sessionToken=${SESSION}`, t);
    expect(denied.statusCode).toBe(503);
    expect(denied.json().error.code).toBe('MAPS_UNAVAILABLE');
    expect(denied.body).not.toContain(KEY);
    expect(denied.body).not.toContain('googleapis');

    google(() => Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' })));
    const timeout = await get(`/maps/autocomplete?q=hanamkonda&sessionToken=${SESSION}`, t);
    expect(timeout.statusCode).toBe(503);
    expect(timeout.json().error.code).toBe('MAPS_UNAVAILABLE');
  });

  it('kill switch: maps.enabled=false makes no Google calls', async () => {
    await setMaps({ enabled: false });
    const t = await riderToken();
    const res = await get(`/maps/autocomplete?q=hanamkonda&sessionToken=${SESSION}`, t);
    expect(res.statusCode).toBe(503);
    expect(calls).toHaveLength(0);
  });
});

describe('maps: place details', () => {
  it('uses Essentials field mask, ends the session, caches by placeId', async () => {
    google(() => ({ json: { location: { latitude: 18.0072, longitude: 79.5584 }, formattedAddress: 'Chowrasta, Hanamkonda' } }));
    const t = await riderToken();
    const res = await get(`/maps/place?placeId=ChIJhanamkonda0001&sessionToken=${SESSION}`, t);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ placeId: 'ChIJhanamkonda0001', lat: 18.0072, lng: 79.5584, address: 'Chowrasta, Hanamkonda' });
    const { url, init } = calls[0]!;
    expect(url.pathname).toBe('/v1/places/ChIJhanamkonda0001');
    expect(url.searchParams.get('sessionToken')).toBe(SESSION);
    expect((init.headers as Record<string, string>)['X-Goog-FieldMask']).toBe('location,formattedAddress');

    const again = await get(`/maps/place?placeId=ChIJhanamkonda0001&sessionToken=${SESSION}`, t);
    expect(again.json().data.lat).toBe(18.0072);
    expect(calls).toHaveLength(1);
  });

  it('unknown place → 404 PLACE_NOT_FOUND (not an outage)', async () => {
    google(() => ({ status: 404, json: { error: { status: 'NOT_FOUND' } } }));
    const t = await riderToken();
    const res = await get(`/maps/place?placeId=ChIJdoesnotexist01`, t);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('PLACE_NOT_FOUND');
  });
});

describe('maps: reverse geocode', () => {
  it('rounds to ~11 m, skips plus codes, caches nearby points', async () => {
    google(() => ({
      json: {
        status: 'OK',
        results: [
          { formatted_address: 'XQ9+2V Hanamkonda', types: ['plus_code'] },
          { formatted_address: 'Nayeem Nagar, Hanamkonda', types: ['sublocality'] },
        ],
      },
    }));
    const t = await riderToken();
    const res = await get(`/maps/reverse?lat=18.007212&lng=79.558431`, t);
    expect(res.json().data.address).toBe('Nayeem Nagar, Hanamkonda');
    expect(calls[0]!.url.searchParams.get('latlng')).toBe('18.0072,79.5584');
    // Same ~11 m cell → cache
    await get(`/maps/reverse?lat=18.007198&lng=79.558402`, t);
    expect(calls).toHaveLength(1);
  });

  it('ZERO_RESULTS → null address; REQUEST_DENIED → 503', async () => {
    const t = await riderToken();
    google(() => ({ json: { status: 'ZERO_RESULTS', results: [] } }));
    const zero = await get(`/maps/reverse?lat=17.5&lng=80.1`, t);
    expect(zero.statusCode).toBe(200);
    expect(zero.json().data.address).toBeNull();

    google(() => ({ json: { status: 'REQUEST_DENIED', error_message: `key ${KEY}` } }));
    const denied = await get(`/maps/reverse?lat=17.6&lng=80.2`, t);
    expect(denied.statusCode).toBe(503);
    expect(denied.body).not.toContain(KEY);
  });
});

describe('maps: route inside /rides/estimate', () => {
  const pickup = { lat: 17.9689, lng: 79.5941 };
  const drop = { lat: 18.0072, lng: 79.5584 };

  async function fareRule(serviceType: 'bike' | 'auto') {
    const city = await City.findOne();
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

  function estimate(t: string, serviceType: 'bike' | 'auto') {
    return app.inject({
      method: 'POST',
      url: '/api/v1/rides/estimate',
      headers: { authorization: `Bearer ${t}` },
      payload: { serviceType, pickup, drop },
    });
  }

  it('uses Compute Routes once (cached), right mode, polyline flows to the ride', async () => {
    await fareRule('bike');
    await fareRule('auto');
    google(() => ({ json: { routes: [{ distanceMeters: 6800, duration: '1260s', polyline: { encodedPolyline: 'abc_poly' } }] } }));
    const t = await riderToken();

    const first = await estimate(t, 'bike');
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toMatchObject({ distanceM: 6800, durationSec: 1260, route: { polyline: 'abc_poly', source: 'google' } });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ travelMode: 'TWO_WHEELER', routingPreference: 'TRAFFIC_UNAWARE', computeAlternativeRoutes: false });
    expect((calls[0]!.init.headers as Record<string, string>)['X-Goog-FieldMask']).toBe(
      'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
    );

    await estimate(t, 'bike'); // refresh → cache
    expect(calls).toHaveLength(1);
    await estimate(t, 'auto'); // different travel mode → one more call
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[1]!.init.body)).travelMode).toBe('DRIVE');

    const book = await app.inject({
      method: 'POST',
      url: '/api/v1/rides',
      headers: { authorization: `Bearer ${t}` },
      payload: { quoteId: first.json().data.quoteId, idempotencyKey: 'maps-test-0001' },
    });
    expect(book.statusCode).toBe(200);
    expect(book.json().data.routePolyline).toBe('abc_poly');
    const ride = await Ride.findById(book.json().data.id).lean();
    expect(ride?.routeSource).toBe('google');
    expect(calls).toHaveLength(2); // booking never calls Google
  });

  it('falls back to straight-line distance when Google fails (estimate still works)', async () => {
    await fareRule('bike');
    google(() => ({ status: 503, json: { error: { status: 'UNAVAILABLE' } } }));
    const t = await riderToken();
    const res = await estimate(t, 'bike');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.route).toEqual({ polyline: null, source: 'haversine' });
    expect(res.json().data.distanceM).toBeGreaterThan(4000);
  });

  it('admin usage shows billable calls vs cache hits', async () => {
    await fareRule('bike');
    google(() => ({ json: { routes: [{ distanceMeters: 6800, duration: '1260s', polyline: { encodedPolyline: 'p' } }] } }));
    const t = await riderToken();
    await estimate(t, 'bike');
    await estimate(t, 'bike');
    const admin = await adminToken();
    const res = await get('/admin/maps/usage', admin);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.googleCalls.computeRoutes).toBe(1);
    expect(res.json().data.cacheHits.computeRoutes).toBe(1);
    expect((await get('/admin/maps/usage', t)).statusCode).toBe(403);
  });
});
