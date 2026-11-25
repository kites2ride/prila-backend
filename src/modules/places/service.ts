import { Types } from 'mongoose';
import { AppError } from '../../lib/errors.js';
import { AdminAuditLog } from '../app/model.js';
import { Rider } from '../auth/model.js';
import { Ride } from '../rides/model.js';
import { Landmark } from './model.js';

type Label = 'home' | 'work';
type PointDoc = { coordinates?: number[] } | null | undefined;

const RECENT_RIDES = 30;
const RECENT_MAX = 6;

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function latLngOf(p: PointDoc): { lat: number; lng: number } | null {
  const c = p?.coordinates;
  if (!c || c.length !== 2) return null;
  const [lng, lat] = c;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function serializeSaved(saved: Array<{ label?: string; name?: string; address?: string; location?: PointDoc }>) {
  const out: Array<{ label: Label; name: string; address: string; lat: number; lng: number }> = [];
  for (const s of saved ?? []) {
    const ll = latLngOf(s.location);
    if (!ll || (s.label !== 'home' && s.label !== 'work')) continue;
    out.push({ label: s.label, name: s.name ?? '', address: s.address ?? '', ...ll });
  }
  // stable order: home, work
  return out.sort((a, b) => (a.label === b.label ? 0 : a.label === 'home' ? -1 : 1));
}

/** Names the app used to send when it had no real address. Never a useful recent. */
const PLACEHOLDER_NAMES = new Set(['', 'current location', 'pinned location']);
const SAME_PLACE_M = 50;

export const isRealPlaceName = (name: string | null | undefined) => !PLACEHOLDER_NAMES.has((name ?? '').trim().toLowerCase());

function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/**
 * Most-recently-used destinations: drops only, newest ride first, max 6. Skips 0/0 coordinates;
 * drops within 50 m of a newer one are collapsed (the newest stays on top). Placeholder or empty
 * names are returned as-is so the app can label them (demo fallback until reverse-geocoding is
 * enabled); a real title repeated at another spot also keeps only its newest entry.
 */
export async function myPlaces(riderId: string) {
  const [rider, rides] = await Promise.all([
    Rider.findById(riderId).select({ savedPlaces: 1 }).lean(),
    Ride.find({ riderId: new Types.ObjectId(riderId) })
      .sort({ createdAt: -1 })
      .limit(RECENT_RIDES)
      .select({ drop: 1, createdAt: 1 })
      .lean(),
  ]);
  const saved = serializeSaved((rider?.savedPlaces ?? []) as never);
  const recents: Array<{ name: string; address: string; lat: number; lng: number; lastUsedAt: Date | null }> = [];
  for (const ride of rides) {
    if (recents.length >= RECENT_MAX) break;
    const p = ride.drop as { name?: string; address?: string; location?: PointDoc } | undefined;
    const ll = latLngOf(p?.location);
    if (!ll || ll.lat === 0 || ll.lng === 0) continue;
    const name = p?.name?.trim() ?? '';
    const title = name.toLowerCase();
    const sameTitle = (r: { name: string }) => isRealPlaceName(name) && r.name.toLowerCase() === title;
    if (recents.some((r) => sameTitle(r) || metersBetween(r, ll) <= SAME_PLACE_M)) continue;
    recents.push({ name, address: p?.address ?? '', ...ll, lastUsedAt: (ride as { createdAt?: Date }).createdAt ?? null });
  }
  return { saved, recents };
}

export async function setSaved(
  riderId: string,
  label: Label,
  body: { name: string; address: string; lat: number; lng: number },
) {
  const current = await Rider.findById(riderId).select({ savedPlaces: 1 }).lean();
  if (!current) throw new AppError('NOT_FOUND', 'Rider not found', 404);
  const next = [
    ...(current.savedPlaces ?? []).filter((s) => s.label !== label),
    { label, name: body.name, address: body.address, location: { type: 'Point', coordinates: [body.lng, body.lat] } },
  ];
  const rider = await Rider.findByIdAndUpdate(riderId, { $set: { savedPlaces: next } }, { returnDocument: 'after' }).lean();
  return { saved: serializeSaved((rider?.savedPlaces ?? []) as never) };
}

export async function deleteSaved(riderId: string, label: Label) {
  const rider = await Rider.findByIdAndUpdate(
    riderId,
    { $pull: { savedPlaces: { label } } },
    { returnDocument: 'after' },
  ).lean();
  if (!rider) throw new AppError('NOT_FOUND', 'Rider not found', 404);
  return { saved: serializeSaved((rider.savedPlaces ?? []) as never) };
}

// ---------------------------------------------------------------- landmarks

export type LandmarkHit = { name: string; address: string; lat: number; lng: number };

/** Word-start, case-insensitive match on name or aliases. Free: no Google call. */
export async function searchLandmarks(q: string, limit = 5): Promise<LandmarkHit[]> {
  const term = q.trim();
  if (!term) return [];
  const re = new RegExp(`(^|[\\s\\-/(,.])${escapeRegex(term)}`, 'i');
  const docs = await Landmark.find({ enabled: true, $or: [{ name: re }, { aliases: re }] })
    .sort({ priority: -1, name: 1 })
    .limit(limit)
    .lean();
  const out: LandmarkHit[] = [];
  for (const d of docs) {
    const ll = latLngOf(d.location as PointDoc);
    if (ll) out.push({ name: d.name, address: d.address ?? '', ...ll });
  }
  return out;
}

function serializeLandmark(d: Record<string, unknown> & { _id: unknown; location?: PointDoc }) {
  const ll = latLngOf(d.location);
  return {
    id: String(d._id),
    cityId: d.cityId ? String(d.cityId) : null,
    name: d.name as string,
    aliases: (d.aliases as string[]) ?? [],
    address: (d.address as string) ?? '',
    lat: ll?.lat ?? null,
    lng: ll?.lng ?? null,
    enabled: d.enabled !== false,
    priority: (d.priority as number) ?? 0,
    updatedAt: (d.updatedAt as Date) ?? null,
  };
}

export async function listLandmarks(input: { cityId?: string; q?: string; page: number; limit: number }) {
  const filter: Record<string, unknown> = {};
  if (input.cityId) {
    if (!Types.ObjectId.isValid(input.cityId)) throw new AppError('VALIDATION_ERROR', 'Invalid cityId', 400);
    filter.cityId = new Types.ObjectId(input.cityId);
  }
  if (input.q?.trim()) {
    const re = new RegExp(escapeRegex(input.q.trim()), 'i');
    filter.$or = [{ name: re }, { aliases: re }];
  }
  const [items, total] = await Promise.all([
    Landmark.find(filter)
      .sort({ priority: -1, name: 1 })
      .skip((input.page - 1) * input.limit)
      .limit(input.limit)
      .lean(),
    Landmark.countDocuments(filter),
  ]);
  return { items: items.map((d) => serializeLandmark(d as never)), page: input.page, limit: input.limit, total };
}

export type LandmarkInput = {
  cityId?: string | null;
  name: string;
  aliases: string[];
  address: string;
  lat: number;
  lng: number;
  enabled: boolean;
  priority: number;
};

function landmarkPayload(body: LandmarkInput) {
  if (body.cityId && !Types.ObjectId.isValid(body.cityId)) throw new AppError('VALIDATION_ERROR', 'Invalid cityId', 400);
  return {
    cityId: body.cityId ? new Types.ObjectId(body.cityId) : null,
    name: body.name,
    aliases: body.aliases,
    address: body.address,
    location: { type: 'Point' as const, coordinates: [body.lng, body.lat] },
    enabled: body.enabled,
    priority: body.priority,
  };
}

export async function upsertLandmark(actor: string, body: LandmarkInput, id?: string) {
  if (id && !Types.ObjectId.isValid(id)) throw new AppError('NOT_FOUND', 'Landmark not found', 404);
  const payload = landmarkPayload(body);
  const before = id ? await Landmark.findById(id).lean() : null;
  if (id && !before) throw new AppError('NOT_FOUND', 'Landmark not found', 404);
  const doc = id
    ? await Landmark.findByIdAndUpdate(id, { $set: payload }, { returnDocument: 'after' })
    : await Landmark.create(payload);
  if (!doc) throw new AppError('NOT_FOUND', 'Landmark not found', 404);
  await AdminAuditLog.create({
    actor,
    action: id ? 'landmark.update' : 'landmark.create',
    key: 'landmark',
    before,
    after: doc.toObject(),
  });
  return { id: String(doc._id) };
}
