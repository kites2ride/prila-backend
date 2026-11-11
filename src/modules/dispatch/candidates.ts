import { haversineM } from '../rides/geo.js';
import { getDispatchConfig } from './config.js';
import { cellsAtRing, toCell } from './h3.js';
import { locationStore } from './locationStore.js';
import type { Candidate, DispatchLogEntry } from './types.js';

export async function findCandidates(input: {
  pickupLat: number;
  pickupLng: number;
  serviceType: string;
  excludePilotIds: string[];
  shaktiStrict?: boolean;
  now?: number;
}): Promise<{ candidates: Candidate[]; log: DispatchLogEntry }> {
  const started = Date.now();
  const cfg = await getDispatchConfig();
  const now = input.now ?? Date.now();
  const ttlMs = cfg.locationTtlSec * 1000;
  const origin = toCell(input.pickupLat, input.pickupLng, cfg.h3Resolution);
  const exclude = new Set(input.excludePilotIds);
  const found: Candidate[] = [];
  const cellsSearched: string[] = [];

  for (let k = 0; k <= cfg.maxRingK; k++) {
    const ring = cellsAtRing(origin, k);
    cellsSearched.push(...ring);
    const pilots = locationStore.listByCells(ring);

    for (const p of pilots) {
      if (exclude.has(p.pilotId)) continue;
      if (p.status !== 'idle') continue; // never offer to offered / on_ride
      if (!p.online) continue;
      if (p.flaggedMocked) continue;
      if (now - p.updatedAt > ttlMs) continue;
      if (p.kycStatus && p.kycStatus !== 'approved') continue;
      if (input.shaktiStrict) {
        if (p.gender !== 'female' || !p.shaktiOptIn) continue;
      }
      if (!vehicleMatches(p.vehicleType, input.serviceType)) continue;

      const distanceM = haversineM(
        { lat: input.pickupLat, lng: input.pickupLng },
        { lat: p.lat, lng: p.lng },
      );
      if (distanceM > cfg.maxPickupDistanceM) continue;

      found.push({
        pilotId: p.pilotId,
        lat: p.lat,
        lng: p.lng,
        cell: p.cell,
        distanceM,
        vehicleType: p.vehicleType,
      });
    }

    if (found.length >= cfg.minCandidates) break;
  }

  found.sort((a, b) => a.distanceM - b.distanceM);
  const limited = found.slice(0, Math.max(cfg.batchSize, cfg.minCandidates));

  return {
    candidates: limited.slice(0, cfg.batchSize),
    log: {
      at: new Date().toISOString(),
      event: 'candidate_search',
      cells: cellsSearched,
      candidateCount: limited.length,
      pilotIds: limited.slice(0, cfg.batchSize).map((c) => c.pilotId),
      ms: Date.now() - started,
    },
  };
}

function vehicleMatches(vehicleType: string | undefined, serviceType: string): boolean {
  if (!vehicleType) return false;
  if (serviceType === 'parcel' || serviceType === 'logistics') {
    return vehicleType === serviceType || vehicleType === 'bike' || vehicleType === 'auto';
  }
  return vehicleType === serviceType;
}
