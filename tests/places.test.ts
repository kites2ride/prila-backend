import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { env } from '../src/config/env.js';
import { configCache } from '../src/lib/cache.js';
import { AdminAuditLog, City, ConfigSingleton } from '../src/modules/app/model.js';
import { Rider } from '../src/modules/auth/model.js';
import { Landmark } from '../src/modules/places/model.js';
import { Ride } from '../src/modules/rides/model.js';
import { app, setupTestApp } from './helpers.js';

setupTestApp();

const KEY = 'test-server-key-never-real';
const SESSION = '3f2b8c1e-6a7d-4e2f-9b10-0c1d2e3f4a5b';

type Handler = (url: URL) => { status?: number; json: unknown };
let handler: Handler;
let fetchSpy: ReturnType<typeof vi.spyOn>;
let fetchCalls = 0;

beforeAll(() => {
  env().GOOGLE_MAPS_SERVER_KEY = KEY;
});
afterAll(() => {
  env().GOOGLE_MAPS_SERVER_KEY = '';
});
beforeEach(() => {
  fetchCalls = 0;
  handler = () => ({ status: 500, json: {} });
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    fetchCalls += 1;
    const r = handler(new URL(String(input)));
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  });
});
afterEach(() => fetchSpy.mockRestore());

let seq = 0;
async function rider() {
  const r = await Rider.create({ phone: `94${String(10_000_000 + seq++).slice(1)}` });
  return { id: String(r._id), token: app.jwt.sign({ sub: String(r._id), typ: 'access' }) };
}
async function adminToken() {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/admin/login', payload: { email: 'ops@prila.local', password: 'adminpass' },
  });
  return res.json().data.accessToken as string;
}
function req(method: 'GET' | 'PUT' | 'DELETE' | 'POST' | 'PATCH', url: string, token: string, payload?: Record<string, unknown>) {
  return app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, payload });
}

const pt = (lng: number, lat: number) => ({ type: 'Point' as const, coordinates: [lng, lat] });

async function addRide(riderId: string, at: Date, pickup: [string, number, number], drop: [string, number, number]) {
  const city = await City.findOne();
  await Ride.collection.insertOne({
    status: 'completed',
    riderId: new Types.ObjectId(riderId),
    cityId: city!._id,
    serviceType: 'bike',
    pickup: { name: pickup[0], address: `${pickup[0]} addr`, location: pt(pickup[2], pickup[1]) },
    drop: { name: drop[0], address: `${drop[0]} addr`, location: pt(drop[2], drop[1]) },
    distanceM: 1000,
    durationSec: 300,
    createdAt: at,
    updatedAt: at,
  });
}

async function setMaps(value: Record<string, unknown>) {
  await ConfigSingleton.findOneAndUpdate({ key: 'maps' }, { key: 'maps', version: 1, value }, { upsert: true });
  configCache.clear();
}

async function landmarks(names: Array<[string, string[]?, number?]>) {
  for (const [name, aliases, priority] of names) {
    await Landmark.create({
      name, aliases: aliases ?? [], address: `${name}, Warangal`, priority: priority ?? 0,
      location: pt(79.55 + Math.random() / 100, 17.98),
    });
  }
}

const googleOk: Handler = () => ({
  json: {
    suggestions: [
      { placePrediction: { placeId: 'ChIJkazipetJn0001', structuredFormat: { mainText: { text: 'Kazipet Junction' }, secondaryText: { text: 'Kazipet, Telangana' } } } },
      { placePrediction: { placeId: 'ChIJkazipetMkt002', structuredFormat: { mainText: { text: 'Kazipet Market' }, secondaryText: { text: 'Kazipet' } } } },
    ],
  },
});

describe('places: saved + recents', () => {
  it('saves, replaces and deletes home/work with validation', async () => {
    const r = await rider();
    const put = await req('PUT', '/places/saved/home', r.token, { name: '  Home  ', address: 'Nayeem Nagar', lat: 18.0, lng: 79.56 });
    expect(put.statusCode).toBe(200);
    expect(put.json().data.saved).toEqual([{ label: 'home', name: 'Home', address: 'Nayeem Nagar', lat: 18.0, lng: 79.56 }]);
    await req('PUT', '/places/saved/work', r.token, { name: 'Office', lat: 17.97, lng: 79.6 });
    const replaced = await req('PUT', '/places/saved/home', r.token, { name: 'New home', lat: 18.01, lng: 79.55 });
    expect(replaced.json().data.saved.map((s: { label: string; name: string }) => `${s.label}:${s.name}`)).toEqual(['home:New home', 'work:Office']);

    expect((await req('PUT', '/places/saved/gym', r.token, { name: 'x', lat: 1, lng: 1 })).statusCode).toBe(400);
    expect((await req('PUT', '/places/saved/home', r.token, { name: '', lat: 1, lng: 1 })).statusCode).toBe(400);
    expect((await req('PUT', '/places/saved/home', r.token, { name: 'x', lat: 91, lng: 1 })).statusCode).toBe(400);

    const del = await req('DELETE', '/places/saved/work', r.token);
    expect(del.json().data.saved).toHaveLength(1);
    expect((await req('GET', '/places/mine', 'bad')).statusCode).toBe(401);
  });

  it('recents: newest first, deduped, max 6, excludes saved places', async () => {
    const r = await rider();
    await req('PUT', '/places/saved/home', r.token, { name: 'Home', lat: 18.0, lng: 79.56 });
    const t0 = Date.now();
    // oldest → newest
    await addRide(r.id, new Date(t0 - 9000), ['Home', 18.0, 79.56], ['Bus Stand', 17.97, 79.6]);
    await addRide(r.id, new Date(t0 - 8000), ['Bus Stand', 17.97000004, 79.60000004], ['College', 18.02, 79.53]);
    await addRide(r.id, new Date(t0 - 7000), ['A', 17.9, 79.5], ['B', 17.91, 79.51]);
    await addRide(r.id, new Date(t0 - 6000), ['C', 17.92, 79.52], ['D', 17.93, 79.53]);
    await addRide(r.id, new Date(t0 - 5000), ['E', 17.94, 79.54], ['F', 17.95, 79.55]);
    const other = await rider();
    await addRide(other.id, new Date(t0), ['Not mine', 17.5, 79.1], ['Not mine 2', 17.6, 79.2]);

    const res = await req('GET', '/places/mine', r.token);
    const names = res.json().data.recents.map((p: { name: string }) => p.name);
    expect(names).toEqual(['F', 'E', 'D', 'C', 'B', 'A']);
    expect(names).not.toContain('Home');
    expect(res.json().data.recents[0]).toMatchObject({ address: 'F addr', lat: 17.95, lng: 79.55 });
    expect(res.json().data.saved[0].label).toBe('home');
  });

  it('recents dedupe repeated places across rides', async () => {
    const r = await rider();
    const t0 = Date.now();
    await addRide(r.id, new Date(t0 - 2000), ['Bus Stand', 17.97, 79.6], ['College', 18.02, 79.53]);
    await addRide(r.id, new Date(t0 - 1000), ['College', 18.02, 79.53], ['Bus Stand', 17.97, 79.6]);
    const names = (await req('GET', '/places/mine', r.token)).json().data.recents.map((p: { name: string }) => p.name);
    expect(names).toEqual(['Bus Stand', 'College']);
  });
});

describe('places: landmarks in autocomplete', () => {
  it('word-start match, regex-safe, free (no Google) when enough local hits', async () => {
    await landmarks([['Kazipet Junction', ['KZJ railway station']], ['Kazipet Bus Stop'], ['Kazipet Fort', [], 5], ['Hanamkonda Chowrasta']]);
    const r = await rider();
    const res = await req('GET', `/maps/autocomplete?q=kaz&sessionToken=${SESSION}`, r.token);
    expect(res.statusCode).toBe(200);
    const items = res.json().data.suggestions;
    expect(items.map((s: { mainText: string }) => s.mainText)).toEqual(['Kazipet Fort', 'Kazipet Bus Stop', 'Kazipet Junction']);
    expect(items[0]).toMatchObject({ source: 'landmark', placeId: null, secondaryText: 'Kazipet Fort, Warangal', lat: 17.98 });
    expect(fetchCalls).toBe(0);

    // alias word-start
    const alias = await req('GET', `/maps/autocomplete?q=railway&sessionToken=${SESSION}`, r.token);
    expect(alias.json().data.suggestions[0].mainText).toBe('Kazipet Junction');
    expect(fetchCalls).toBe(1); // 1 local hit < threshold 3 → Google was asked too (failed → local still returned)
    fetchCalls = 0;

    // mid-word does not match locally; regex characters are literal
    await setMaps({ localMinHitsToSkipGoogle: 1, enabled: false });
    expect((await req('GET', `/maps/autocomplete?q=unction&sessionToken=${SESSION}`, r.token)).statusCode).toBe(503);
    expect((await req('GET', `/maps/autocomplete?q=${encodeURIComponent('.*(')}&sessionToken=${SESSION}`, r.token)).statusCode).toBe(503);
    expect(fetchCalls).toBe(0);
  });

  it('few local hits → landmarks first, then Google, duplicates dropped', async () => {
    await landmarks([['Kazipet Junction']]);
    handler = googleOk;
    const r = await rider();
    const res = await req('GET', `/maps/autocomplete?q=kazipet&sessionToken=${SESSION}`, r.token);
    const items = res.json().data.suggestions;
    expect(items.map((s: { source: string; mainText: string }) => `${s.source}:${s.mainText}`)).toEqual([
      'landmark:Kazipet Junction',
      'google:Kazipet Market',
    ]);
    expect(items[1]).toEqual({ source: 'google', placeId: 'ChIJkazipetMkt002', mainText: 'Kazipet Market', secondaryText: 'Kazipet' });
    expect(fetchCalls).toBe(1);
  });

  it('Google failing or disabled still returns landmarks (200)', async () => {
    await landmarks([['Kazipet Junction']]);
    handler = () => ({ status: 503, json: { error: { status: 'UNAVAILABLE' } } });
    const r = await rider();
    const res = await req('GET', `/maps/autocomplete?q=kazipet&sessionToken=${SESSION}`, r.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.suggestions).toHaveLength(1);

    await setMaps({ enabled: false });
    const off = await req('GET', `/maps/autocomplete?q=kazipet&sessionToken=${SESSION}`, r.token);
    expect(off.statusCode).toBe(200);
    expect(off.json().data.suggestions[0].source).toBe('landmark');
  });

  it('disabled landmarks are not suggested', async () => {
    await Landmark.create({ name: 'Kazipet Old Gate', enabled: false, location: pt(79.5, 17.98) });
    await setMaps({ enabled: false });
    const r = await rider();
    expect((await req('GET', `/maps/autocomplete?q=kazipet&sessionToken=${SESSION}`, r.token)).statusCode).toBe(503);
  });
});

describe('places: admin landmarks', () => {
  it('creates, searches, patches and audits; validates input', async () => {
    const admin = await adminToken();
    const city = await City.findOne();
    const created = await req('POST', '/admin/landmarks', admin, {
      cityId: String(city!._id), name: ' Kazipet Junction ', aliases: ['KZJ', 'KZJ', 'Railway station'],
      address: 'Kazipet', lat: 17.976, lng: 79.502, priority: 3,
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().data.id as string;

    const list = await req('GET', `/admin/landmarks?cityId=${city!._id}&q=${encodeURIComponent('kzj')}`, admin);
    expect(list.json().data.total).toBe(1);
    expect(list.json().data.items[0]).toMatchObject({
      id, name: 'Kazipet Junction', aliases: ['KZJ', 'Railway station'], lat: 17.976, lng: 79.502, enabled: true, priority: 3,
    });
    expect((await req('GET', `/admin/landmarks?q=${encodeURIComponent('(')}`, admin)).statusCode).toBe(200);

    const patched = await req('PATCH', `/admin/landmarks/${id}`, admin, { name: 'Kazipet Jn', lat: 17.976, lng: 79.502, enabled: false });
    expect(patched.statusCode).toBe(200);
    expect((await Landmark.findById(id).lean())?.enabled).toBe(false);
    expect(await AdminAuditLog.countDocuments({ key: 'landmark' })).toBe(2);
    expect(await AdminAuditLog.countDocuments({ action: 'landmark.update' })).toBe(1);

    expect((await req('POST', '/admin/landmarks', admin, { name: '', lat: 1, lng: 1 })).statusCode).toBe(400);
    expect((await req('POST', '/admin/landmarks', admin, { name: 'x', lat: 100, lng: 1 })).statusCode).toBe(400);
    expect((await req('POST', '/admin/landmarks', admin, { name: 'x', lat: 1, lng: 1, aliases: Array(11).fill('a') })).statusCode).toBe(400);
    expect((await req('PATCH', `/admin/landmarks/${new Types.ObjectId()}`, admin, { name: 'x', lat: 1, lng: 1 })).statusCode).toBe(404);
    const rt = (await rider()).token;
    expect((await req('GET', '/admin/landmarks', rt)).statusCode).toBe(403);
  });
});

describe('bootstrap maps hints', () => {
  it('exposes min chars + debounce from maps config', async () => {
    await setMaps({ autocompleteMinChars: 2, autocompleteDebounceMs: 350 });
    const res = await app.inject({ method: 'GET', url: '/api/v1/app/bootstrap?app=customer' });
    expect(res.json().data.maps).toEqual({ autocompleteMinChars: 2, autocompleteDebounceMs: 350 });
  });
});
