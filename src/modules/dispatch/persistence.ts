import { Pilot } from '../auth/model.js';
import { getDispatchConfig } from './config.js';
import { locationStore } from './locationStore.js';

let sweepTimer: NodeJS.Timeout | undefined;
let persistTimer: NodeJS.Timeout | undefined;
const dirty = new Set<string>();

export function markDirty(pilotId: string) {
  dirty.add(pilotId);
}

export function startDispatchWorkers() {
  stopDispatchWorkers();
  void tickSweep();
  void tickPersist();
  void getDispatchConfig().then((cfg) => {
    sweepTimer = setInterval(() => void tickSweep(), cfg.sweepIntervalSec * 1000);
    persistTimer = setInterval(() => void tickPersist(), cfg.persistIntervalSec * 1000);
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
    if (typeof persistTimer.unref === 'function') persistTimer.unref();
  });
}

export function stopDispatchWorkers() {
  if (sweepTimer) clearInterval(sweepTimer);
  if (persistTimer) clearInterval(persistTimer);
  sweepTimer = undefined;
  persistTimer = undefined;
}

async function tickSweep() {
  const cfg = await getDispatchConfig();
  locationStore.sweepStale(cfg.locationTtlSec * 1000);
}

async function tickPersist() {
  if (!dirty.size) return;
  const ids = [...dirty];
  dirty.clear();
  const ops = [];
  for (const id of ids) {
    const p = locationStore.get(id);
    if (!p) continue;
    ops.push(
      Pilot.updateOne(
        { _id: id },
        {
          $set: {
            location: { type: 'Point', coordinates: [p.lng, p.lat] },
            lastLocationAt: new Date(p.updatedAt),
            h3Cell: p.cell,
          },
        },
      ),
    );
  }
  if (ops.length) await Promise.all(ops);
}
