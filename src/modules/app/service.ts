import { configCache } from '../../lib/cache.js';
import { AppError } from '../../lib/errors.js';
import {
  AdminAuditLog,
  City,
  ConfigSingleton,
  ServiceType,
  Zone,
  type ConfigSingletonDoc,
} from './model.js';
import {
  configKeySchema,
  validateConfigValue,
  type bootstrapQuerySchema,
} from './schemas.js';
import type { z } from 'zod';
import { serviceAreaFor } from '../zones/service.js';

type ConfigKey = z.infer<typeof configKeySchema>;
type BootstrapQuery = z.infer<typeof bootstrapQuerySchema>;

async function getSingleton(key: ConfigKey): Promise<ConfigSingletonDoc | null> {
  const cacheKey = `cfg:${key}`;
  const cached = configCache.get<ConfigSingletonDoc>(cacheKey);
  if (cached) return cached;
  const doc = await ConfigSingleton.findOne({ key });
  if (doc) configCache.set(cacheKey, doc);
  return doc;
}

/** Raw stored value for a config key (cached, invalidated on patch). undefined when never set. */
export async function getConfigValue(key: ConfigKey): Promise<unknown> {
  const doc = await getSingleton(key);
  return doc?.value;
}

export async function getConfig(key: ConfigKey) {
  const doc = await getSingleton(key);
  if (!doc) throw new AppError('NOT_FOUND', `Config ${key} not found`, 404);
  return { key: doc.key, version: doc.version, value: doc.value };
}

export async function patchConfig(actor: string, key: ConfigKey, rawValue: unknown) {
  const value = validateConfigValue(key, rawValue);
  const existing = await ConfigSingleton.findOne({ key });
  const before = existing ? { version: existing.version, value: existing.value } : null;
  const version = (existing?.version ?? 0) + 1;

  const doc = await ConfigSingleton.findOneAndUpdate(
    { key },
    { key, version, value },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );

  configCache.invalidate(`cfg:${key}`);
  configCache.invalidatePrefix('bootstrap:');

  await AdminAuditLog.create({
    actor,
    action: 'config.patch',
    key,
    before,
    after: { version: doc!.version, value: doc!.value },
  });

  return { key: doc!.key, version: doc!.version, value: doc!.value };
}

function updateMode(minBuild: number, latestBuild: number, build: number) {
  if (minBuild > 0 && build < minBuild) return 'required' as const;
  if (latestBuild > 0 && build < latestBuild) return 'optional' as const;
  return 'none' as const;
}

export async function getUpdatePolicy(app: 'customer' | 'pilot', platform: 'android' | 'ios' | 'web', build: number) {
  const cacheKey = `update:${app}:${platform}`;
  const cached = configCache.get<{ minBuild: number; latestBuild: number; storeUrl: string }>(cacheKey);
  let policy = cached;
  if (!policy) {
    const doc = await getSingleton('app_update');
    const value = (doc?.value ?? {}) as Record<string, Record<string, { minBuild: number; latestBuild: number; storeUrl: string }>>;
    const plat = platform === 'web' ? 'android' : platform;
    policy = value[app]?.[plat] ?? { minBuild: 0, latestBuild: 0, storeUrl: '' };
    configCache.set(cacheKey, policy);
  }
  return {
    ...policy,
    mode: updateMode(policy.minBuild, policy.latestBuild, build),
  };
}

async function resolveCity(lat?: number, lng?: number) {
  if (lat === undefined || lng === undefined) {
    const first = await City.findOne({ enabled: true }).lean();
    return first;
  }

  const zone = await Zone.findOne({
    enabled: true,
    polygon: {
      $geoIntersects: {
        $geometry: { type: 'Point', coordinates: [lng, lat] },
      },
    },
  }).lean();

  if (zone) {
    return City.findById(zone.cityId).lean();
  }

  return City.findOne({
    enabled: true,
    center: {
      $near: {
        $geometry: { type: 'Point', coordinates: [lng, lat] },
        $maxDistance: 50_000,
      },
    },
  }).lean();
}

export async function bootstrap(query: BootstrapQuery) {
  const cacheKey = `bootstrap:${query.app}:${query.platform}:${query.build}:${query.lat ?? ''}:${query.lng ?? ''}`;
  const cached = configCache.get<unknown>(cacheKey);
  if (cached) return cached;

  const [customerCfg, pilotCfg, matching, support, maintenance, promo] = await Promise.all([
    getSingleton('app_config_customer'),
    getSingleton('app_config_pilot'),
    getSingleton('matching'),
    getSingleton('support'),
    getSingleton('maintenance'),
    getSingleton('home_promo'),
  ]);

  const appCfg = query.app === 'customer' ? customerCfg : pilotCfg;
  const update = await getUpdatePolicy(query.app, query.platform, query.build);
  const city = await resolveCity(query.lat, query.lng);

  type ServiceKind = 'bike' | 'auto' | 'parcel' | 'logistics';
  const cityServiceTypes = (city?.services ?? []).filter((s): s is ServiceKind =>
    ['bike', 'auto', 'parcel', 'logistics'].includes(s),
  );
  const serviceFilter =
    cityServiceTypes.length > 0
      ? { enabled: true as const, type: { $in: cityServiceTypes } }
      : { enabled: true as const };

  const services = await ServiceType.find(serviceFilter).sort({ order: 1 }).lean();

  const appValue = (appCfg?.value ?? {}) as Record<string, unknown>;
  const matchingValue = (matching?.value ?? {}) as Record<string, unknown>;
  const supportValue = (support?.value ?? {}) as Record<string, unknown>;
  const maintenanceValue = (maintenance?.value ?? { enabled: false }) as {
    enabled: boolean;
    message?: string;
  };
  const promoValue = (promo?.value ?? {}) as Record<string, unknown>;

  const payload = {
    version: appCfg?.version ?? 1,
    maintenance: {
      enabled: Boolean(maintenanceValue.enabled),
      message: maintenanceValue.message,
    },
    update,
    flags: (appValue.flags as Record<string, boolean>) ?? {},
    city: city
      ? {
          id: String(city._id),
          slug: city.slug,
          name: city.name,
          services: services.map((s) => ({
            type: s.type,
            name: s.name,
            iconUrl: s.iconUrl,
            order: s.order,
            capacity: s.capacity,
            maxWeightKg: s.maxWeightKg,
            minWeightKg: s.minWeightKg,
          })),
        }
      : null,
    /** Display hint only — server enforces on estimate / book / go-online. null when no location sent. */
    serviceArea:
      query.lat !== undefined && query.lng !== undefined
        ? await serviceAreaFor(query.app, { lat: query.lat, lng: query.lng })
        : null,
    home: query.app === 'customer' ? appValue.home : undefined,
    matchingHints: {
      acceptTimeoutSec: matchingValue.acceptTimeoutSec ?? 15,
      searchRadiusM: matchingValue.searchRadiusM ?? 3000,
      maxSearchTimeSec: matchingValue.maxSearchTimeSec ?? 120,
    },
    support: supportValue,
    languages: (appValue.languages as string[]) ?? ['en', 'te'],
    topics: {
      city: city ? `city_${city.slug}_${query.app}` : undefined,
      segments: [] as string[],
    },
    kycDocuments:
      query.app === 'pilot'
        ? ((appValue.kycDocumentsByVehicle as Record<string, unknown>) ?? {})
        : undefined,
    promo: (promoValue as Record<string, unknown>)[query.app] ?? { enabled: false },
    location:
      query.app === 'pilot'
        ? {
            updateIntervalSec: (appValue.locationUpdateIntervalSec as number) ?? 5,
            distanceFilterM: (appValue.locationDistanceFilterM as number) ?? 25,
          }
        : undefined,
  };

  configCache.set(cacheKey, payload);
  return payload;
}

export async function writeAudit(actor: string, action: string, meta?: unknown) {
  await AdminAuditLog.create({ actor, action, meta });
}
