import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { loadEnv, resetEnvCache } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/lib/db.js';
import { configCache } from '../src/lib/cache.js';
import { buildApp, type AppInstance } from '../src/app.js';
import {
  City,
  CommissionRule,
  ConfigSingleton,
  FareRule,
  ServiceType,
} from '../src/modules/app/model.js';
import {
  defaultAppUpdate,
  defaultCustomerConfig,
  defaultDispatch,
  defaultHomePromo,
  defaultMaintenance,
  defaultMatching,
  defaultPilotConfig,
  defaultSupport,
  defaultSurge,
  defaultPilotQuality,
} from '../src/seeds/defaults.js';
import { OtpChallenge, Pilot, RefreshToken, Rider } from '../src/modules/auth/model.js';
import { AdminAuditLog } from '../src/modules/app/model.js';

let mongo: MongoMemoryServer;
export let app: AppInstance;

export async function seedMinimal() {
  await City.create({
    name: 'Warangal',
    slug: 'warangal',
    enabled: true,
    center: { type: 'Point', coordinates: [79.5941, 17.9689] },
    services: ['bike', 'auto', 'parcel', 'logistics'],
  });
  await ServiceType.create([
    { type: 'bike', name: 'Bike Ride', order: 1, enabled: true, capacity: 1 },
    { type: 'auto', name: 'Auto Ride', order: 2, enabled: true, capacity: 3 },
    { type: 'parcel', name: 'Parcel', order: 3, enabled: true, capacity: 1, maxWeightKg: 5 },
    { type: 'logistics', name: 'Logistics', order: 4, enabled: true, capacity: 1, minWeightKg: 5.001 },
  ]);
  const configs = [
    { key: 'app_config_customer' as const, value: defaultCustomerConfig },
    { key: 'app_config_pilot' as const, value: defaultPilotConfig },
    { key: 'app_update' as const, value: defaultAppUpdate },
    { key: 'home_promo' as const, value: defaultHomePromo },
    { key: 'matching' as const, value: defaultMatching },
    { key: 'dispatch' as const, value: defaultDispatch },
    { key: 'surge' as const, value: defaultSurge },
    { key: 'pilot_quality' as const, value: defaultPilotQuality },
    { key: 'support' as const, value: defaultSupport },
    { key: 'maintenance' as const, value: defaultMaintenance },
  ];
  for (const c of configs) {
    await ConfigSingleton.create({ key: c.key, version: 1, value: c.value });
  }
  const city = await City.findOne({ slug: 'warangal' });
  if (city) {
    await CommissionRule.create({
      cityId: city._id,
      serviceType: 'all',
      mode: 'percentage',
      value: 1500, // 15% (basis points)
      enabled: true,
      version: 1,
    });
  }
}

export function setupTestApp() {
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    resetEnvCache();
    loadEnv({
      NODE_ENV: 'test',
      MONGODB_URI: mongo.getUri(),
      JWT_SECRET: 'test-jwt-secret-key-32chars!!',
      ADMIN_LOGINS: JSON.stringify({ 'ops@prila.local': 'adminpass' }),
      ALLOW_OTP_DEBUG: 'true',
      CORS_ORIGINS: 'http://localhost:5173',
      LOG_LEVEL: 'silent',
    });
    await connectDb();
    app = await buildApp({ logger: false });
    await app.ready();
  });

  beforeEach(async () => {
    configCache.clear();
    const { locationStore } = await import('../src/modules/dispatch/locationStore.js');
    locationStore.clear();
    const { Ride, RideQuote } = await import('../src/modules/rides/model.js');
    const { LedgerEntry, PilotWallet, PayoutRequest } = await import('../src/modules/ledger/model.js');
    await Promise.all([
      Rider.deleteMany({}),
      Pilot.deleteMany({}),
      OtpChallenge.deleteMany({}),
      RefreshToken.deleteMany({}),
      ConfigSingleton.deleteMany({}),
      City.deleteMany({}),
      ServiceType.deleteMany({}),
      AdminAuditLog.deleteMany({}),
      Ride.deleteMany({}),
      RideQuote.deleteMany({}),
      LedgerEntry.deleteMany({}),
      PilotWallet.deleteMany({}),
      PayoutRequest.deleteMany({}),
      CommissionRule.deleteMany({}),
      FareRule.deleteMany({}),
      (async () => {
        const { AnalyticsEvent } = await import('../src/modules/analytics/model.js');
        const { Report } = await import('../src/modules/reports/model.js');
        const { SosAlert } = await import('../src/modules/sos/model.js');
        const { AppNotification } = await import('../src/modules/push/inbox.js');
        const { NudgeRule } = await import('../src/modules/nudges/model.js');
        await Promise.all([
          AnalyticsEvent.deleteMany({}),
          Report.deleteMany({}),
          SosAlert.deleteMany({}),
          AppNotification.deleteMany({}),
          NudgeRule.deleteMany({}),
        ]);
      })(),
    ]);
    await seedMinimal();
  });

  afterAll(async () => {
    await app.close();
    await disconnectDb();
    await mongo.stop();
    resetEnvCache();
  });
}
