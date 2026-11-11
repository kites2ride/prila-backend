import { cellToBoundary, gridDisk, latLngToCell } from 'h3-js';

export function toCell(lat: number, lng: number, resolution: number): string {
  return latLngToCell(lat, lng, resolution);
}

/** Rings 0..k inclusive (origin + neighbours). */
export function cellsInDisk(origin: string, k: number): string[] {
  return gridDisk(origin, k);
}

/** Only the new ring at distance k (k=0 → origin alone). */
export function cellsAtRing(origin: string, k: number): string[] {
  if (k === 0) return [origin];
  const outer = new Set(gridDisk(origin, k));
  const inner = new Set(gridDisk(origin, k - 1));
  return [...outer].filter((c) => !inner.has(c));
}

export function cellBoundary(cell: string): Array<[number, number]> {
  // h3 returns [lat, lng][]; map polygons often want [lng, lat]
  return cellToBoundary(cell).map(([lat, lng]) => [lng, lat]);
}
