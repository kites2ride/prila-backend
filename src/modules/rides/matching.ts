import { Pilot } from '../auth/model.js';
import { ConfigSingleton } from '../app/model.js';
import type { Types } from 'mongoose';

export async function getMatchingConfig() {
  const doc = await ConfigSingleton.findOne({ key: 'matching' }).lean();
  const v = (doc?.value ?? {}) as Record<string, number>;
  return {
    searchRadiusM: v.searchRadiusM ?? 3000,
    batchSize: v.batchSize ?? 5,
    acceptTimeoutSec: v.acceptTimeoutSec ?? 15,
    retries: v.retries ?? 3,
    maxSearchTimeSec: v.maxSearchTimeSec ?? 120,
    quoteTtlSec: v.quoteTtlSec ?? 120,
  };
}

export async function getCustomerFlags(): Promise<Record<string, boolean>> {
  const doc = await ConfigSingleton.findOne({ key: 'app_config_customer' }).lean();
  return ((doc?.value as { flags?: Record<string, boolean> })?.flags ?? {}) as Record<string, boolean>;
}

/** Find online approved idle pilots near pickup; optional Prila Shakti filter. */
export async function findCandidatePilots(input: {
  lng: number;
  lat: number;
  serviceType: string;
  excludeIds: Types.ObjectId[];
  shaktiStrict: boolean;
  limit: number;
  radiusM: number;
}) {
  const filter: Record<string, unknown> = {
    online: true,
    idle: true,
    status: 'active',
    kycStatus: 'approved',
    vehicleType: input.serviceType === 'parcel' || input.serviceType === 'logistics'
      ? { $in: [input.serviceType, 'bike', 'auto'] }
      : input.serviceType,
    location: { $exists: true },
  };
  if (input.excludeIds.length) {
    filter._id = { $nin: input.excludeIds };
  }
  if (input.shaktiStrict) {
    filter.gender = 'female';
    filter.shaktiOptIn = true;
  }

  const pilots = await Pilot.aggregate([
    {
      $geoNear: {
        near: { type: 'Point', coordinates: [input.lng, input.lat] },
        distanceField: 'distanceM',
        maxDistance: input.radiusM,
        spherical: true,
        query: filter,
      },
    },
    { $limit: input.limit },
    {
      $project: {
        _id: 1,
        name: 1,
        phone: 1,
        vehicleType: 1,
        vehicleNumber: 1,
        distanceM: 1,
        gender: 1,
      },
    },
  ]);

  return pilots as Array<{
    _id: Types.ObjectId;
    name?: string;
    vehicleType?: string;
    vehicleNumber?: string;
    distanceM: number;
  }>;
}
