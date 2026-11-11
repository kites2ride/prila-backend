import { Types } from 'mongoose';
import { AppError } from '../../lib/errors.js';
import { configCache } from '../../lib/cache.js';
import {
  AdminAuditLog,
  City,
  CommissionRule,
  FareRule,
  ServiceType,
  Zone,
} from '../app/model.js';
import { Pilot, Rider } from '../auth/model.js';
import { Ride } from '../rides/model.js';
import { istDayBounds } from './ist.js';
import type {
  cityUpsertSchema,
  commissionUpsertSchema,
  farePreviewSchema,
  fareUpsertSchema,
  servicePatchSchema,
  zoneUpsertSchema,
} from './schemas.js';
import type { z } from 'zod';

export async function getOverview(fromYmd: string, toYmd: string) {
  let bounds: { from: Date; to: Date };
  try {
    bounds = istDayBounds(fromYmd, toYmd);
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Invalid from/to dates', 400);
  }
  const { from, to } = bounds;
  const created = { createdAt: { $gte: from, $lte: to } };

  const [
    riderSignups,
    pilotSignups,
    ridesRequested,
    ridesCompleted,
    ridesCancelled,
    gmvAgg,
    revenueAgg,
    onlinePilots,
    avgEtaAgg,
  ] = await Promise.all([
    Rider.countDocuments(created),
    Pilot.countDocuments(created),
    Ride.countDocuments(created),
    Ride.countDocuments({ ...created, status: { $in: ['completed', 'paid'] } }),
    Ride.countDocuments({
      ...created,
      status: {
        $in: ['cancelled_by_rider', 'cancelled_by_pilot', 'cancelled_by_system', 'no_pilot_found'],
      },
    }),
    Ride.aggregate<{ total: number }>([
      { $match: { ...created, status: { $in: ['completed', 'paid'] } } },
      { $group: { _id: null, total: { $sum: '$fareTotalPaise' } } },
    ]),
    Ride.aggregate<{ total: number }>([
      { $match: { ...created, status: { $in: ['completed', 'paid'] } } },
      { $group: { _id: null, total: { $sum: '$platformRevenuePaise' } } },
    ]),
    Pilot.countDocuments({ online: true, status: 'active' }),
    Ride.aggregate<{ avg: number }>([
      {
        $match: {
          ...created,
          pickupEtaSec: { $ne: null },
          status: { $in: ['completed', 'paid', 'in_progress', 'pilot_arriving', 'pilot_arrived'] },
        },
      },
      { $group: { _id: null, avg: { $avg: '$pickupEtaSec' } } },
    ]),
  ]);

  return {
    from: fromYmd,
    to: toYmd,
    fromUtc: from.toISOString(),
    toUtc: to.toISOString(),
    signups: { riders: riderSignups, pilots: pilotSignups },
    logins: { riders: 0, pilots: 0 }, // dedicated login events in later analytics phase
    rides: {
      requested: ridesRequested,
      completed: ridesCompleted,
      cancelled: ridesCancelled,
    },
    gmvPaise: gmvAgg[0]?.total ?? 0,
    platformRevenuePaise: revenueAgg[0]?.total ?? 0,
    onlinePilotsNow: onlinePilots,
    averagePickupEtaSec: avgEtaAgg[0]?.avg ?? null,
    screenTimeSec: 0,
    ...(await (async () => {
      try {
        const { overviewAnalytics } = await import('../analytics/service.js');
        const a = await overviewAnalytics(fromYmd, toYmd);
        return {
          logins: { riders: a.logins, pilots: 0 },
          screenTimeSec: a.screenTimeSec,
          dau: { riders: a.dauCustomer, pilots: a.dauPilot },
        };
      } catch {
        return {};
      }
    })()),
  };
}

export async function listAudit(page: number, limit: number) {
  const filter = {};
  const [items, total] = await Promise.all([
    AdminAuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    AdminAuditLog.countDocuments(filter),
  ]);
  return {
    items: items.map((a) => ({
      id: String(a._id),
      actor: a.actor,
      action: a.action,
      key: a.key,
      before: a.before,
      after: a.after,
      meta: a.meta,
      at: a.createdAt,
    })),
    page,
    limit,
    total,
  };
}

export async function listCities() {
  const cities = await City.find().sort({ name: 1 }).lean();
  return cities.map((c) => {
    const coords = c.center?.coordinates ?? [0, 0];
    return {
      id: String(c._id),
      name: c.name,
      slug: c.slug,
      enabled: c.enabled,
      timezone: c.timezone,
      center: { lng: coords[0] ?? 0, lat: coords[1] ?? 0 },
      services: c.services,
    };
  });
}

export async function upsertCity(actor: string, body: z.infer<typeof cityUpsertSchema>, id?: string) {
  const payload = {
    name: body.name,
    slug: body.slug,
    enabled: body.enabled,
    timezone: body.timezone,
    center: { type: 'Point' as const, coordinates: [body.center.lng, body.center.lat] },
    services: body.services,
  };
  const before = id ? await City.findById(id).lean() : null;
  const doc = id
    ? await City.findByIdAndUpdate(id, payload, { returnDocument: 'after' })
    : await City.create(payload);
  if (!doc) throw new AppError('NOT_FOUND', 'City not found', 404);
  configCache.invalidatePrefix('bootstrap:');
  await AdminAuditLog.create({
    actor,
    action: id ? 'city.update' : 'city.create',
    key: 'city',
    before,
    after: doc.toObject(),
  });
  return { id: String(doc._id), slug: doc.slug };
}

export async function listZones(cityId?: string) {
  const filter = cityId ? { cityId } : {};
  const zones = await Zone.find(filter).sort({ name: 1 }).lean();
  return zones.map((z) => ({
    id: String(z._id),
    cityId: String(z.cityId),
    name: z.name,
    enabled: z.enabled,
    coordinates: z.polygon?.coordinates ?? [],
  }));
}

export async function upsertZone(actor: string, body: z.infer<typeof zoneUpsertSchema>, id?: string) {
  if (!Types.ObjectId.isValid(body.cityId)) throw new AppError('VALIDATION_ERROR', 'Invalid cityId', 400);
  const payload = {
    cityId: body.cityId,
    name: body.name,
    enabled: body.enabled,
    polygon: { type: 'Polygon' as const, coordinates: body.coordinates },
  };
  const before = id ? await Zone.findById(id).lean() : null;
  const doc = id
    ? await Zone.findByIdAndUpdate(id, payload, { returnDocument: 'after' })
    : await Zone.create(payload);
  if (!doc) throw new AppError('NOT_FOUND', 'Zone not found', 404);
  configCache.invalidatePrefix('bootstrap:');
  await AdminAuditLog.create({
    actor,
    action: id ? 'zone.update' : 'zone.create',
    key: 'zone',
    before,
    after: doc.toObject(),
  });
  return { id: String(doc._id) };
}

export async function listServices() {
  const services = await ServiceType.find().sort({ order: 1 }).lean();
  return services.map((s) => ({
    id: String(s._id),
    type: s.type,
    name: s.name,
    iconUrl: s.iconUrl,
    order: s.order,
    enabled: s.enabled,
    capacity: s.capacity,
    maxWeightKg: s.maxWeightKg,
    minWeightKg: s.minWeightKg,
  }));
}

export async function patchService(
  actor: string,
  type: string,
  body: z.infer<typeof servicePatchSchema>,
) {
  const serviceType = type as 'bike' | 'auto' | 'parcel' | 'logistics';
  if (!['bike', 'auto', 'parcel', 'logistics'].includes(serviceType)) {
    throw new AppError('VALIDATION_ERROR', 'Invalid service type', 400);
  }
  const before = await ServiceType.findOne({ type: serviceType }).lean();
  if (!before) throw new AppError('NOT_FOUND', 'Service not found', 404);
  const doc = await ServiceType.findOneAndUpdate({ type: serviceType }, body, {
    returnDocument: 'after',
  });
  configCache.invalidatePrefix('bootstrap:');
  await AdminAuditLog.create({
    actor,
    action: 'service.patch',
    key: `service:${serviceType}`,
    before,
    after: doc?.toObject(),
  });
  return doc;
}

export async function listFareRules(cityId?: string) {
  const filter = cityId ? { cityId } : {};
  const rules = await FareRule.find(filter).lean();
  return rules.map((r) => ({
    id: String(r._id),
    cityId: String(r.cityId),
    serviceType: r.serviceType,
    version: r.version,
    baseFarePaise: r.baseFarePaise,
    perKmPaise: r.perKmPaise,
    perMinutePaise: r.perMinutePaise,
    minimumFarePaise: r.minimumFarePaise,
    nightMultiplier: r.nightMultiplier,
    surgeMultiplier: r.surgeMultiplier,
    waitingPerMinutePaise: r.waitingPerMinutePaise,
    cancellationFeePaise: r.cancellationFeePaise,
    platformFeePaise: r.platformFeePaise,
  }));
}

export async function upsertFareRule(actor: string, body: z.infer<typeof fareUpsertSchema>) {
  const before = await FareRule.findOne({
    cityId: body.cityId,
    serviceType: body.serviceType,
  }).lean();
  const version = (before?.version ?? 0) + 1;
  const doc = await FareRule.findOneAndUpdate(
    { cityId: body.cityId, serviceType: body.serviceType },
    { ...body, version },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );
  await AdminAuditLog.create({
    actor,
    action: 'fare.upsert',
    key: `fare:${body.serviceType}`,
    before,
    after: doc?.toObject(),
  });
  return doc;
}

export async function previewFare(body: z.infer<typeof farePreviewSchema>) {
  const rule = await FareRule.findOne({
    cityId: body.cityId,
    serviceType: body.serviceType,
  }).lean();
  if (!rule) throw new AppError('NOT_FOUND', 'Fare rule not found', 404);

  const distanceKm = body.distanceM / 1000;
  const durationMin = body.durationSec / 60;
  const waitingMin = body.waitingSec / 60;
  let subtotal =
    rule.baseFarePaise +
    Math.round(rule.perKmPaise * distanceKm) +
    Math.round(rule.perMinutePaise * durationMin) +
    Math.round(rule.waitingPerMinutePaise * waitingMin);
  if (body.isNight) subtotal = Math.round(subtotal * rule.nightMultiplier);
  if (body.applySurge) subtotal = Math.round(subtotal * rule.surgeMultiplier);
  const fareBeforeMin = subtotal;
  const total = Math.max(subtotal, rule.minimumFarePaise) + rule.platformFeePaise;

  return {
    currency: 'INR',
    breakdown: {
      baseFarePaise: rule.baseFarePaise,
      distancePaise: Math.round(rule.perKmPaise * distanceKm),
      timePaise: Math.round(rule.perMinutePaise * durationMin),
      waitingPaise: Math.round(rule.waitingPerMinutePaise * waitingMin),
      nightApplied: body.isNight,
      surgeApplied: body.applySurge,
      nightMultiplier: rule.nightMultiplier,
      surgeMultiplier: rule.surgeMultiplier,
      beforeMinimumPaise: fareBeforeMin,
      minimumFarePaise: rule.minimumFarePaise,
      platformFeePaise: rule.platformFeePaise,
      totalPaise: total,
    },
    configVersion: rule.version,
  };
}

export async function listCommission(cityId?: string) {
  const filter = cityId ? { cityId } : {};
  const rules = await CommissionRule.find(filter).lean();
  return rules.map((r) => ({
    id: String(r._id),
    cityId: String(r.cityId),
    serviceType: r.serviceType,
    mode: r.mode,
    value: r.value,
    subscriptionPeriod: r.subscriptionPeriod,
    enabled: r.enabled,
    version: r.version,
  }));
}

export async function upsertCommission(actor: string, body: z.infer<typeof commissionUpsertSchema>) {
  const before = await CommissionRule.findOne({
    cityId: body.cityId,
    serviceType: body.serviceType,
    mode: body.mode,
  }).lean();
  const version = (before?.version ?? 0) + 1;
  const doc = await CommissionRule.findOneAndUpdate(
    { cityId: body.cityId, serviceType: body.serviceType, mode: body.mode },
    { ...body, version },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );
  await AdminAuditLog.create({
    actor,
    action: 'commission.upsert',
    key: `commission:${body.mode}`,
    before,
    after: doc?.toObject(),
  });
  return doc;
}
