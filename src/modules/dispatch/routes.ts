import type { FastifyInstance } from 'fastify';
import { ok } from '../../lib/envelope.js';
import { AppError } from '../../lib/errors.js';
import { authenticateAdmin } from '../../plugins/auth.js';
import { Ride } from '../rides/model.js';
import { getDispatchConfig, getSurgeConfig } from './config.js';
import { cellBoundary } from './h3.js';
import { locationStore } from './locationStore.js';
import { getHeatmap } from './surge.js';

export async function dispatchRoutes(app: FastifyInstance) {
  app.get('/admin/dispatch/live', { preHandler: authenticateAdmin }, async (req, reply) => {
    const cityId = (req.query as { cityId?: string }).cityId;
    let pilots = locationStore.listAll().filter((p) => p.online);
    if (cityId) pilots = pilots.filter((p) => !p.cityId || p.cityId === cityId);
    return reply.send(
      ok({
        items: pilots.map((p) => ({
          id: p.pilotId,
          status: p.status,
          lat: p.lat,
          lng: p.lng,
          cell: p.cell,
          updatedAt: new Date(p.updatedAt).toISOString(),
          vehicleType: p.vehicleType,
          offerRideId: p.offerRideId,
        })),
        at: new Date().toISOString(),
      }),
    );
  });

  app.get('/admin/dispatch/heatmap', { preHandler: authenticateAdmin }, async (req, reply) => {
    const cityId = (req.query as { cityId?: string }).cityId;
    if (!cityId) throw new AppError('VALIDATION_ERROR', 'cityId required', 400);
    const cfg = await getSurgeConfig();
    const cells = await getHeatmap(cityId);
    return reply.send(
      ok({
        enabled: cfg.enabled,
        resolution: cfg.h3Resolution,
        items: cells.map((c) => ({
          ...c,
          boundary: cellBoundary(c.cell),
        })),
      }),
    );
  });

  app.get('/admin/dispatch/config', { preHandler: authenticateAdmin }, async (_req, reply) => {
    const [dispatch, surge] = await Promise.all([getDispatchConfig(), getSurgeConfig()]);
    return reply.send(ok({ dispatch, surge }));
  });

  app.get('/admin/rides/:id/dispatch-log', { preHandler: authenticateAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ride = await Ride.findById(id).lean();
    if (!ride) throw new AppError('NOT_FOUND', 'Ride not found', 404);
    return reply.send(
      ok({
        rideId: id,
        status: ride.status,
        dispatchLog: (ride as { dispatchLog?: unknown[] }).dispatchLog ?? [],
      }),
    );
  });

  app.get('/admin/dispatch/metrics', { preHandler: authenticateAdmin }, async (_req, reply) => {
    const online = locationStore.listAll().filter((p) => p.online);
    const searching = await Ride.countDocuments({ status: 'searching' });
    const noPilot = await Ride.countDocuments({ status: 'no_pilot_found' });
    const completed = await Ride.countDocuments({ status: { $in: ['completed', 'paid'] } });
    return reply.send(
      ok({
        onlinePilots: online.length,
        idlePilots: online.filter((p) => p.status === 'idle').length,
        offeredPilots: online.filter((p) => p.status === 'offered').length,
        onRidePilots: online.filter((p) => p.status === 'on_ride').length,
        searchingRides: searching,
        noPilotFound: noPilot,
        completedRides: completed,
      }),
    );
  });
}
