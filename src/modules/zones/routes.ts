import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok } from '../../lib/envelope.js';
import { AppError } from '../../lib/errors.js';
import { City } from '../app/model.js';
import { authenticateAdmin } from '../../plugins/auth.js';
import * as zones from './service.js';

const serviceType = z.enum(['bike', 'auto', 'parcel', 'logistics']);

const testPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  serviceType: serviceType.optional(),
  role: z.enum(['pickup', 'drop', 'pilot']).default('pickup'),
});

const demandQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  /** Optional: only requests within radiusKm of this city's centre. */
  cityId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  radiusKm: z.coerce.number().min(1).max(150).default(40),
});

export async function zoneRoutes(app: FastifyInstance) {
  /** Public, display-only outlines (empty unless zones.showOutlineOnMap). */
  app.get('/app/zones', async (req, reply) => {
    const q = z.object({ cityId: z.string().regex(/^[a-f0-9]{24}$/).optional() }).parse(req.query);
    return reply.send(ok(await zones.outlines(q.cityId)));
  });

  app.post('/admin/zones/test-point', { preHandler: authenticateAdmin }, async (req, reply) => {
    const body = testPointSchema.parse(req.body);
    return reply.send(ok(await zones.testPoint(body)));
  });

  app.get('/admin/zones/demand-outside', { preHandler: authenticateAdmin }, async (req, reply) => {
    const q = demandQuerySchema.parse(req.query);
    let near: { lat: number; lng: number; radiusKm: number } | undefined;
    if (q.cityId) {
      const city = await City.findById(q.cityId).select('center').lean();
      const c = city?.center?.coordinates;
      if (!c || c.length < 2) throw new AppError('NOT_FOUND', 'City not found', 404);
      near = { lat: c[1]!, lng: c[0]!, radiusKm: q.radiusKm };
    }
    return reply.send(ok(await zones.demandOutside(q.days, q.limit, near)));
  });
}
