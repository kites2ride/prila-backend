import type { FastifyInstance } from 'fastify';
import { Ride } from '../rides/model.js';
import { runBatchOffer } from './batchOffer.js';
import { getDispatchConfig } from './config.js';
import { startDispatchWorkers } from './persistence.js';

export { locationStore } from './locationStore.js';
export { ingestPilotLocation, markPilotOffline, markPilotOnRide, markPilotIdle } from './intake.js';
export { runBatchOffer, releaseOtherOffers, releaseOfferOnCancel } from './batchOffer.js';
export { findCandidates } from './candidates.js';
export { getDispatchConfig, getSurgeConfig } from './config.js';
export { recordDemand, getSurgeMultiplier, getHeatmap } from './surge.js';
export { dispatchRoutes } from './routes.js';
export { startDispatchWorkers, stopDispatchWorkers, markDirty } from './persistence.js';

/** Boot: start sweepers + resume searching rides if dispatch.enabled. */
export async function startDispatch(app: FastifyInstance) {
  startDispatchWorkers();
  const cfg = await getDispatchConfig();
  if (!cfg.enabled) return;

  const searching = await Ride.find({ status: 'searching' }).limit(100);
  for (const ride of searching) {
    const shaktiStrict = Boolean(ride.shakti);
    void runBatchOffer(app, String(ride._id), { shaktiStrict });
  }
}
