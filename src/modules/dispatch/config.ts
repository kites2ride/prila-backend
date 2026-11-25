import { ConfigSingleton } from '../app/model.js';

export type DispatchConfig = {
  enabled: boolean;
  h3Resolution: number;
  maxRingK: number;
  minCandidates: number;
  maxPickupDistanceM: number;
  offerTimeoutSec: number;
  batchSize: number;
  researchDelaySec: number;
  maxSearchSec: number;
  etaRefineTopN: number;
  locationTtlSec: number;
  sweepIntervalSec: number;
  persistIntervalSec: number;
  maxAccuracyM: number;
  maxSpeedMps: number;
  /** Rider can raise the fare in steps of this (paise) while no pilot accepts. */
  boostStepPaise: number;
  /** Most a rider can add in total (paise). 0 = feature off. */
  boostMaxPaise: number;
};

export type SurgeConfig = {
  enabled: boolean;
  h3Resolution: number;
  windowMin: number;
  maxMultiplier: number;
  table: Array<{ minRatio: number; multiplier: number }>;
};

const dispatchDefaults: DispatchConfig = {
  enabled: true,
  h3Resolution: 8,
  maxRingK: 3,
  minCandidates: 5,
  maxPickupDistanceM: 3000,
  offerTimeoutSec: 15,
  batchSize: 5,
  researchDelaySec: 5,
  maxSearchSec: 120,
  etaRefineTopN: 0,
  locationTtlSec: 30,
  sweepIntervalSec: 10,
  persistIntervalSec: 30,
  maxAccuracyM: 50,
  maxSpeedMps: 55, // ~200 km/h hard gate for spoof / teleport
  boostStepPaise: 1000, // ₹10
  boostMaxPaise: 5000, // ₹50
};

const surgeDefaults: SurgeConfig = {
  enabled: false,
  h3Resolution: 7,
  windowMin: 10,
  maxMultiplier: 1.5,
  table: [
    { minRatio: 0, multiplier: 1 },
    { minRatio: 1.5, multiplier: 1.2 },
    { minRatio: 2.5, multiplier: 1.4 },
    { minRatio: 4, multiplier: 1.5 },
  ],
};

export async function getDispatchConfig(): Promise<DispatchConfig> {
  const doc = await ConfigSingleton.findOne({ key: 'dispatch' }).lean();
  const v = (doc?.value ?? {}) as Partial<DispatchConfig>;
  return { ...dispatchDefaults, ...v };
}

export async function getSurgeConfig(): Promise<SurgeConfig> {
  const doc = await ConfigSingleton.findOne({ key: 'surge' }).lean();
  const v = (doc?.value ?? {}) as Partial<SurgeConfig>;
  return {
    ...surgeDefaults,
    ...v,
    table: v.table?.length ? v.table : surgeDefaults.table,
  };
}

export { dispatchDefaults, surgeDefaults };
