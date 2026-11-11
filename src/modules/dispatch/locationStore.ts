import type { PilotDispatchStatus, PilotLiveState } from './types.js';

export interface LocationStore {
  upsert(state: PilotLiveState): void;
  get(pilotId: string): PilotLiveState | undefined;
  remove(pilotId: string): void;
  setStatus(pilotId: string, status: PilotDispatchStatus, patch?: Partial<PilotLiveState>): boolean;
  listByCells(cells: string[]): PilotLiveState[];
  listAll(): PilotLiveState[];
  sweepStale(ttlMs: number, now?: number): string[];
}

/** v1 hot path — later swap for RedisLocationStore without changing callers. */
export class InMemoryLocationStore implements LocationStore {
  private pilots = new Map<string, PilotLiveState>();
  private cellIndex = new Map<string, Set<string>>();

  upsert(state: PilotLiveState): void {
    const prev = this.pilots.get(state.pilotId);
    if (prev && prev.cell !== state.cell) {
      this.leaveCell(prev.cell, state.pilotId);
    }
    this.pilots.set(state.pilotId, state);
    this.enterCell(state.cell, state.pilotId);
  }

  get(pilotId: string): PilotLiveState | undefined {
    return this.pilots.get(pilotId);
  }

  remove(pilotId: string): void {
    const prev = this.pilots.get(pilotId);
    if (!prev) return;
    this.leaveCell(prev.cell, pilotId);
    this.pilots.delete(pilotId);
  }

  setStatus(pilotId: string, status: PilotDispatchStatus, patch?: Partial<PilotLiveState>): boolean {
    const cur = this.pilots.get(pilotId);
    if (!cur) return false;
    const next: PilotLiveState = { ...cur, ...patch, status };
    if (status === 'idle') {
      delete next.offerRideId;
      delete next.offerExpiresAt;
    }
    this.pilots.set(pilotId, next);
    return true;
  }

  listByCells(cells: string[]): PilotLiveState[] {
    const out: PilotLiveState[] = [];
    const seen = new Set<string>();
    for (const cell of cells) {
      const set = this.cellIndex.get(cell);
      if (!set) continue;
      for (const id of set) {
        if (seen.has(id)) continue;
        seen.add(id);
        const p = this.pilots.get(id);
        if (p) out.push(p);
      }
    }
    return out;
  }

  listAll(): PilotLiveState[] {
    return [...this.pilots.values()];
  }

  sweepStale(ttlMs: number, now = Date.now()): string[] {
    const removed: string[] = [];
    for (const [id, p] of this.pilots) {
      if (now - p.updatedAt > ttlMs) {
        this.remove(id);
        removed.push(id);
      }
    }
    return removed;
  }

  /** Test helper */
  clear(): void {
    this.pilots.clear();
    this.cellIndex.clear();
  }

  private enterCell(cell: string, pilotId: string) {
    let set = this.cellIndex.get(cell);
    if (!set) {
      set = new Set();
      this.cellIndex.set(cell, set);
    }
    set.add(pilotId);
  }

  private leaveCell(cell: string, pilotId: string) {
    const set = this.cellIndex.get(cell);
    if (!set) return;
    set.delete(pilotId);
    if (set.size === 0) this.cellIndex.delete(cell);
  }
}

export const locationStore = new InMemoryLocationStore();
