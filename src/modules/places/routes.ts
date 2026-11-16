import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok } from '../../lib/envelope.js';
import { authenticateAdmin, authenticateRider } from '../../plugins/auth.js';
import * as places from './service.js';

const labelSchema = z.object({ label: z.enum(['home', 'work']) });

const savedBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  address: z.string().trim().max(200).default(''),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const landmarkBodySchema = z.object({
  cityId: z.string().regex(/^[a-f0-9]{24}$/).nullable().optional(),
  name: z.string().trim().min(1).max(80),
  aliases: z
    .array(z.string().trim().min(1).max(60))
    .max(10)
    .default([])
    .transform((a) => [...new Set(a)]),
  address: z.string().trim().max(200).default(''),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(-100).max(100).default(0),
});

const landmarkListSchema = z.object({
  cityId: z.string().optional(),
  q: z.string().max(80).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

export async function placesRoutes(app: FastifyInstance) {
  const rider = { preHandler: authenticateRider, logLevel: 'warn' as const };

  app.get('/places/mine', rider, async (req, reply) => {
    return reply.send(ok(await places.myPlaces(req.user.sub)));
  });

  app.put('/places/saved/:label', rider, async (req, reply) => {
    const { label } = labelSchema.parse(req.params);
    const body = savedBodySchema.parse(req.body);
    return reply.send(ok(await places.setSaved(req.user.sub, label, body)));
  });

  app.delete('/places/saved/:label', rider, async (req, reply) => {
    const { label } = labelSchema.parse(req.params);
    return reply.send(ok(await places.deleteSaved(req.user.sub, label)));
  });

  const admin = { preHandler: authenticateAdmin };

  app.get('/admin/landmarks', admin, async (req, reply) => {
    const q = landmarkListSchema.parse(req.query);
    return reply.send(ok(await places.listLandmarks(q)));
  });

  app.post('/admin/landmarks', admin, async (req, reply) => {
    const body = landmarkBodySchema.parse(req.body);
    return reply.send(ok(await places.upsertLandmark(req.user.sub, body)));
  });

  app.patch('/admin/landmarks/:id', admin, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = landmarkBodySchema.parse(req.body);
    return reply.send(ok(await places.upsertLandmark(req.user.sub, body, id)));
  });
}
