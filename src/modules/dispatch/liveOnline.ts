import { getDispatchConfig } from './config.js';
import { locationStore } from './locationStore.js';

/**
 * Ids of pilots that are online AND pinging recently. The DB `online` flag alone goes
 * stale when an app is killed or loses network, so admin screens use this instead.
 */
export async function getLiveOnlinePilotIds(now = Date.now()): Promise<Set<string>> {
  const ttlMs = (await getDispatchConfig()).locationTtlSec * 1000;
  return new Set(
    locationStore
      .listAll()
      .filter((p) => p.online && now - p.updatedAt <= ttlMs)
      .map((p) => p.pilotId),
  );
}
