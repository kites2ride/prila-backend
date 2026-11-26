import type { FastifyInstance } from 'fastify';
import { ok } from '../../lib/envelope.js';
import { AppError } from '../../lib/errors.js';
import { authenticateAdmin, authenticateRider } from '../../plugins/auth.js';
import {
  NEARBY_DEFAULT_RADIUS_KM,
  NEARBY_MAX_RADIUS_KM,
  NEARBY_SERVICE_TYPES,
  findNearbyPilots,
} from './nearby.js';
import { Ride } from '../rides/model.js';
import { getDispatchConfig, getSurgeConfig } from './config.js';
import { cellBoundary } from './h3.js';
import { locationStore } from './locationStore.js';
import { getHeatmap } from './surge.js';
import { liveSnapshot } from './live.js';
import { City } from '../app/model.js';
import { z } from 'zod';

const cityQuery = z.object({
  cityId: z.string().refine((v) => /^[a-f\d]{24}$/i.test(v), 'cityId must be a city id'),
});

const nearbyQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  serviceType: z.enum(NEARBY_SERVICE_TYPES),
  radiusKm: z.coerce.number().positive().max(NEARBY_MAX_RADIUS_KM).default(NEARBY_DEFAULT_RADIUS_KM),
});

export async function dispatchRoutes(app: FastifyInstance) {
  /** Rider map: up to 12 idle pilots near a point for one service type. */
  app.get('/pilots/nearby', { preHandler: authenticateRider }, async (req, reply) => {
    const q = nearbyQuery.parse(req.query);
    const pilots = await findNearbyPilots(q);
    return reply.send(ok({ pilots }));
  });

  /** City live map (admin, polled every 5 s): pilots, live rides, counts. */
  app.get('/admin/dispatch/live', { preHandler: authenticateAdmin }, async (req, reply) => {
    const { cityId } = cityQuery.parse(req.query);
    if (!(await City.exists({ _id: cityId }))) throw new AppError('NOT_FOUND', 'City not found', 404);
    return reply.send(ok(await liveSnapshot(cityId)));
  });

  app.get('/admin/dispatch/heatmap', { preHandler: authenticateAdmin }, async (req, reply) => {
    const { cityId } = cityQuery.parse(req.query);
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
