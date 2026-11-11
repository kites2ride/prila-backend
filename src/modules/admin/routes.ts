import type { FastifyInstance } from 'fastify';
import { ok } from '../../lib/envelope.js';
import { authenticateAdmin } from '../../plugins/auth.js';
import {
  cityUpsertSchema,
  commissionUpsertSchema,
  dateRangeSchema,
  farePreviewSchema,
  fareUpsertSchema,
  pageSchema,
  servicePatchSchema,
  zoneUpsertSchema,
} from './schemas.js';
import * as adminService from './service.js';

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticateAdmin);

  app.get('/admin/overview', async (req, reply) => {
    const q = dateRangeSchema.parse(req.query);
    const data = await adminService.getOverview(q.from, q.to);
    return reply.send(ok(data));
  });

  app.get('/admin/audit', async (req, reply) => {
    const q = pageSchema.parse(req.query);
    const data = await adminService.listAudit(q.page, q.limit);
    return reply.send(ok(data));
  });

  app.get('/admin/cities', async (_req, reply) => {
    return reply.send(ok({ items: await adminService.listCities() }));
  });

  app.post('/admin/cities', async (req, reply) => {
    const body = cityUpsertSchema.parse(req.body);
    const data = await adminService.upsertCity(req.user.sub, body);
    return reply.send(ok(data));
  });

  app.patch('/admin/cities/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = cityUpsertSchema.parse(req.body);
    const data = await adminService.upsertCity(req.user.sub, body, id);
    return reply.send(ok(data));
  });

  app.get('/admin/zones', async (req, reply) => {
    const cityId = (req.query as { cityId?: string }).cityId;
    return reply.send(ok({ items: await adminService.listZones(cityId) }));
  });

  app.post('/admin/zones', async (req, reply) => {
    const body = zoneUpsertSchema.parse(req.body);
    const data = await adminService.upsertZone(req.user.sub, body);
    return reply.send(ok(data));
  });

  app.patch('/admin/zones/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = zoneUpsertSchema.parse(req.body);
    const data = await adminService.upsertZone(req.user.sub, body, id);
    return reply.send(ok(data));
  });

  app.get('/admin/services', async (_req, reply) => {
    return reply.send(ok({ items: await adminService.listServices() }));
  });

  app.patch('/admin/services/:type', async (req, reply) => {
    const type = (req.params as { type: string }).type;
    const body = servicePatchSchema.parse(req.body);
    const data = await adminService.patchService(req.user.sub, type, body);
    return reply.send(ok(data));
  });

  app.get('/admin/fares', async (req, reply) => {
    const cityId = (req.query as { cityId?: string }).cityId;
    return reply.send(ok({ items: await adminService.listFareRules(cityId) }));
  });

  app.put('/admin/fares', async (req, reply) => {
    const body = fareUpsertSchema.parse(req.body);
    const data = await adminService.upsertFareRule(req.user.sub, body);
    return reply.send(ok(data));
  });

  app.post('/admin/fares/preview', async (req, reply) => {
    const body = farePreviewSchema.parse(req.body);
    const data = await adminService.previewFare(body);
    return reply.send(ok(data));
  });

  app.get('/admin/commission', async (req, reply) => {
    const cityId = (req.query as { cityId?: string }).cityId;
    return reply.send(ok({ items: await adminService.listCommission(cityId) }));
  });

  app.put('/admin/commission', async (req, reply) => {
    const body = commissionUpsertSchema.parse(req.body);
    const data = await adminService.upsertCommission(req.user.sub, body);
    return reply.send(ok(data));
  });
}
