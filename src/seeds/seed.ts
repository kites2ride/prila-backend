import { loadEnv } from '../config/env.js';
import { connectDb, disconnectDb } from '../lib/db.js';
import {
  City,
  CommissionRule,
  ConfigSingleton,
  FareRule,
  ServiceType,
  Zone,
} from '../modules/app/model.js';
import { CouponRule } from '../modules/coupons/model.js';
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
} from './defaults.js';
import { IncentiveRule } from '../modules/ledger/model.js';

async function seed() {
  loadEnv();
  await connectDb();

  const city = await City.findOneAndUpdate(
    { slug: 'warangal' },
    {
      name: 'Warangal',
      slug: 'warangal',
      timezone: 'Asia/Kolkata',
      enabled: true,
      center: { type: 'Point', coordinates: [79.5941, 17.9689] },
      services: ['bike', 'auto', 'parcel', 'logistics'],
    },
    { upsert: true, new: true },
  );

  // Rough bounding box around Warangal center for v1 zone
  const lng = 79.5941;
  const lat = 17.9689;
  const d = 0.15;
  await Zone.findOneAndUpdate(
    { cityId: city._id, name: 'Warangal Core' },
    {
      cityId: city._id,
      name: 'Warangal Core',
      enabled: true,
      polygon: {
        type: 'Polygon',
        coordinates: [
          [
            [lng - d, lat - d],
            [lng + d, lat - d],
            [lng + d, lat + d],
            [lng - d, lat + d],
            [lng - d, lat - d],
          ],
        ],
      },
    },
    { upsert: true, new: true },
  );

  const services = [
    { type: 'bike', name: 'Bike Ride', order: 1, capacity: 1 },
    { type: 'auto', name: 'Auto Ride', order: 2, capacity: 3 },
    { type: 'parcel', name: 'Parcel', order: 3, capacity: 1, maxWeightKg: 5, minWeightKg: 0 },
    { type: 'logistics', name: 'Logistics', order: 4, capacity: 1, minWeightKg: 5.001 },
  ] as const;

  for (const s of services) {
    await ServiceType.findOneAndUpdate({ type: s.type }, { ...s, enabled: true, iconUrl: '' }, { upsert: true });
  }

  const fareDefaults: Record<string, { base: number; perKm: number; perMin: number; min: number }> = {
    bike: { base: 2000, perKm: 800, perMin: 100, min: 3000 },
    auto: { base: 3000, perKm: 1200, perMin: 150, min: 5000 },
    parcel: { base: 2500, perKm: 900, perMin: 100, min: 4000 },
    logistics: { base: 5000, perKm: 1500, perMin: 200, min: 8000 },
  };

  for (const type of ['bike', 'auto', 'parcel', 'logistics'] as const) {
    const f = fareDefaults[type]!;
    await FareRule.findOneAndUpdate(
      { cityId: city._id, serviceType: type },
      {
        cityId: city._id,
        serviceType: type,
        version: 1,
        baseFarePaise: f.base,
        perKmPaise: f.perKm,
        perMinutePaise: f.perMin,
        minimumFarePaise: f.min,
        nightMultiplier: 1.2,
        surgeMultiplier: 1,
        waitingPerMinutePaise: 100,
        cancellationFeePaise: 2000,
        platformFeePaise: 500,
      },
      { upsert: true },
    );
  }

  await CommissionRule.findOneAndUpdate(
    { cityId: city._id, serviceType: 'all', mode: 'percentage' },
    {
      cityId: city._id,
      serviceType: 'all',
      mode: 'percentage',
      value: 1500, // 15%
      enabled: true,
      version: 1,
    },
    { upsert: true },
  );

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
    await ConfigSingleton.findOneAndUpdate(
      { key: c.key },
      { key: c.key, version: 1, value: c.value },
      { upsert: true },
    );
  }

  // Growth coupons — disabled until flags on
  const coupons = [
    {
      code: 'FIRST100',
      title: 'First ride ₹100 off',
      kind: 'first_ride' as const,
      enabled: false,
      discountMode: 'fixed' as const,
      discountValue: 10000,
      maxDiscountPaise: 10000,
      minFarePaise: 3000,
      perUserLimit: 1,
    },
    {
      code: 'RIDE5',
      title: '5th ride reward ₹50 off',
      kind: 'ride_milestone' as const,
      enabled: false,
      discountMode: 'fixed' as const,
      discountValue: 5000,
      milestoneRideCount: 5,
      perUserLimit: 1,
    },
    {
      code: 'STUDENT1',
      title: 'Student first ride 50% off',
      kind: 'student_first' as const,
      enabled: false,
      discountMode: 'percentage' as const,
      discountValue: 5000,
      maxDiscountPaise: 15000,
      perUserLimit: 1,
    },
  ];
  for (const c of coupons) {
    await CouponRule.findOneAndUpdate({ code: c.code }, c, { upsert: true });
  }

  await IncentiveRule.findOneAndUpdate(
    { code: 'DAY10' },
    {
      code: 'DAY10',
      title: 'Complete 10 trips today',
      enabled: false,
      amountPaise: 5000,
      trigger: 'trips_per_day',
      threshold: 10,
    },
    { upsert: true },
  );

  const { NudgeRule } = await import('../modules/nudges/model.js');
  await NudgeRule.findOneAndUpdate(
    { code: 'IDLE_PILOT' },
    {
      code: 'IDLE_PILOT',
      title: 'Riders are nearby',
      body: 'Stay online — demand is picking up in your area.',
      audience: 'pilot',
      trigger: 'idle_pilot_online',
      threshold: 30,
      enabled: false,
    },
    { upsert: true },
  );
  await NudgeRule.findOneAndUpdate(
    { code: 'RIDER_COMEBACK' },
    {
      code: 'RIDER_COMEBACK',
      title: 'Miss a ride?',
      body: 'Book a Prila bike or auto in seconds.',
      audience: 'rider',
      trigger: 'rider_inactive_days',
      threshold: 7,
      enabled: false,
      deepLink: 'prila://home',
    },
    { upsert: true },
  );

  console.log('Seed complete: city=warangal, services, configs, coupons, incentives, nudges');
  await disconnectDb();
}

seed().catch(async (err) => {
  console.error(err);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
