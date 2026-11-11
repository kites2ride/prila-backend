import type { z } from 'zod';
import {
  appConfigCustomerValueSchema,
  appConfigPilotValueSchema,
  appUpdateValueSchema,
  dispatchValueSchema,
  homePromoValueSchema,
  matchingValueSchema,
  maintenanceValueSchema,
  supportValueSchema,
  surgeValueSchema,
  pilotQualityValueSchema,
} from '../modules/app/schemas.js';

export const defaultCustomerConfig: z.infer<typeof appConfigCustomerValueSchema> =
  appConfigCustomerValueSchema.parse({
    flags: {
      wallet: false,
      parcel: true,
      logistics: true,
      online_payments: false,
      upi: false,
      coupons: false,
      student_coupon: false,
      prila_shakti: false,
      prila_shakti_strict: true,
      referrals: false,
      scheduled_rides: false,
      chat: false,
    },
    languages: ['en', 'te'],
    home: {
      tilesOrder: ['bike', 'auto', 'parcel', 'logistics'],
      recentPlacesEnabled: true,
      promoSectionEnabled: true,
    },
  });

export const defaultPilotConfig: z.infer<typeof appConfigPilotValueSchema> = appConfigPilotValueSchema.parse({
  flags: { wallet: true, chat: false },
  languages: ['en', 'te'],
  locationUpdateIntervalSec: 5,
  locationDistanceFilterM: 25,
  kycDocumentsByVehicle: {
    bike: [
      { id: 'dl', label: 'Driving Licence', required: true },
      { id: 'rc', label: 'RC', required: true },
      { id: 'id', label: 'Government ID', required: true },
      { id: 'selfie', label: 'Selfie', required: true },
      { id: 'bank', label: 'Bank / UPI', required: true },
    ],
    auto: [
      { id: 'dl', label: 'Driving Licence', required: true },
      { id: 'rc', label: 'RC', required: true },
      { id: 'id', label: 'Government ID', required: true },
      { id: 'selfie', label: 'Selfie', required: true },
      { id: 'bank', label: 'Bank / UPI', required: true },
    ],
    parcel: [
      { id: 'dl', label: 'Driving Licence', required: true },
      { id: 'rc', label: 'RC', required: true },
      { id: 'id', label: 'Government ID', required: true },
      { id: 'selfie', label: 'Selfie', required: true },
      { id: 'bank', label: 'Bank / UPI', required: true },
    ],
    logistics: [
      { id: 'dl', label: 'Driving Licence', required: true },
      { id: 'rc', label: 'RC', required: true },
      { id: 'id', label: 'Government ID', required: true },
      { id: 'selfie', label: 'Selfie', required: true },
      { id: 'bank', label: 'Bank / UPI', required: true },
    ],
  },
});

export const defaultMatching = matchingValueSchema.parse({});
export const defaultDispatch = dispatchValueSchema.parse({});
export const defaultSurge = surgeValueSchema.parse({});
export const defaultPilotQuality = pilotQualityValueSchema.parse({});
export const defaultSupport = supportValueSchema.parse({
  phone: '',
  whatsapp: '',
  sosNumbers: ['112'],
  termsUrl: '',
  privacyUrl: '',
});
export const defaultMaintenance = maintenanceValueSchema.parse({ enabled: false });
export const defaultHomePromo = homePromoValueSchema.parse({});
export const defaultAppUpdate = appUpdateValueSchema.parse({
  customer: {
    android: { minBuild: 0, latestBuild: 1, storeUrl: '' },
    ios: { minBuild: 0, latestBuild: 1, storeUrl: '' },
  },
  pilot: {
    android: { minBuild: 0, latestBuild: 1, storeUrl: '' },
    ios: { minBuild: 0, latestBuild: 1, storeUrl: '' },
  },
});
