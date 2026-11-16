import { getSurgeConfig } from './config.js';
import { toCell } from './h3.js';
import { locationStore } from './locationStore.js';

type Bucket = { demand: number; supplyHint: number };

const windows = new Map<string, Array<{ at: number; who: string }>>();

const uniqueDemand = (arr: Array<{ who: string }>) => new Set(arr.map((e) => e.who)).size;

function key(cityId: string, cell: string) {
  return `${cityId}:${cell}`;
}

/**
 * Record a fare estimate as demand in the surge cell. Demand = different riders asking in the
 * window, so one rider refreshing the fare screen never pushes their own price up.
 */
export async function recordDemand(cityId: string, lat: number, lng: number, riderId?: string) {
  const cfg = await getSurgeConfig();
  if (!cfg.enabled) return;
  const cell = toCell(lat, lng, cfg.h3Resolution);
  const k = key(cityId, cell);
  const arr = windows.get(k) ?? [];
  arr.push({ at: Date.now(), who: riderId ?? `anon:${Math.random()}` });
  windows.set(k, arr);
}

export async function getSurgeMultiplier(cityId: string, lat: number, lng: number): Promise<number> {
  const cfg = await getSurgeConfig();
  if (!cfg.enabled) return 1;

  const cell = toCell(lat, lng, cfg.h3Resolution);
  const cutoff = Date.now() - cfg.windowMin * 60_000;
  const k = key(cityId, cell);
  const arr = (windows.get(k) ?? []).filter((e) => e.at >= cutoff);
  windows.set(k, arr);
  const demand = uniqueDemand(arr);

  const supply = locationStore
    .listAll()
    .filter(
      (p) =>
        p.status === 'idle' &&
        p.online &&
        Date.now() - p.updatedAt < 60_000 &&
        toCell(p.lat, p.lng, cfg.h3Resolution) === cell,
    ).length;

  const ratio = demand / Math.max(supply, 1);
  let mult = 1;
  for (const row of [...cfg.table].sort((a, b) => a.minRatio - b.minRatio)) {
    if (ratio >= row.minRatio) mult = row.multiplier;
  }
  return Math.min(mult, cfg.maxMultiplier);
}

export async function getHeatmap(cityId: string): Promise<
  Array<{ cell: string; demand: number; supply: number; multiplier: number }>
> {
  const cfg = await getSurgeConfig();
  const cutoff = Date.now() - cfg.windowMin * 60_000;
  const cells = new Set<string>();

  for (const [k, arr] of windows) {
    if (!k.startsWith(`${cityId}:`)) continue;
    const cell = k.slice(cityId.length + 1);
    cells.add(cell);
    windows.set(
      k,
      arr.filter((e) => e.at >= cutoff),
    );
  }
  for (const p of locationStore.listAll()) {
    if (p.cityId !== cityId) continue; // only this city's pilots
    cells.add(toCell(p.lat, p.lng, cfg.h3Resolution));
  }

  const out: Array<{ cell: string; demand: number; supply: number; multiplier: number }> = [];
  for (const cell of cells) {
    const k = key(cityId, cell);
    const demand = uniqueDemand(windows.get(k) ?? []);
    const supply = locationStore
      .listAll()
      .filter(
        (p) =>
          p.status === 'idle' &&
          p.online &&
          p.cityId === cityId &&
          Date.now() - p.updatedAt < 60_000 &&
          toCell(p.lat, p.lng, cfg.h3Resolution) === cell,
      ).length;
    const ratio = demand / Math.max(supply, 1);
    let multiplier = 1;
    for (const row of [...cfg.table].sort((a, b) => a.minRatio - b.minRatio)) {
      if (ratio >= row.minRatio) multiplier = row.multiplier;
    }
    multiplier = Math.min(multiplier, cfg.maxMultiplier);
    out.push({ cell, demand, supply, multiplier });
  }
  return out;
}

/** Test helper */
export function _resetSurgeForTests() {
  windows.clear();
}

void (0 as unknown as Bucket);
