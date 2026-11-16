import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok } from '../../lib/envelope.js';
import { authenticateAdmin, authenticatePilot } from '../../plugins/auth.js';
import * as kyc from './service.js';

const submitSchema = z.object({
  name: z.string().trim().min(2).max(80),
  vehicleType: z.enum(['bike', 'auto', 'parcel', 'logistics']),
  vehicleNumber: z.string().min(4).max(20),
  /** docId → storage key returned by /uploads/presign (folder "kyc") */
  documents: z.record(z.string().min(1).max(32), z.string().min(5).max(200)),
});

const listSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).default('pending'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const rejectSchema = z.object({
  /** Mandatory — shown to the pilot word for word. */
  reason: z.string().trim().min(5, 'Write a reason the pilot can act on (at least 5 letters)').max(500),
  docIds: z.array(z.string().max(32)).max(20).default([]),
});

export async function kycRoutes(app: FastifyInstance) {
  app.post('/pilot/kyc', { preHandler: authenticatePilot }, async (req, reply) => {
    const body = submitSchema.parse(req.body);
    return reply.send(ok(await kyc.submit(req.user.sub, body)));
  });

  app.get('/pilot/kyc', { preHandler: authenticatePilot }, async (req, reply) => {
    return reply.send(ok(await kyc.status(req.user.sub)));
  });

  app.get('/admin/kyc/count', { preHandler: authenticateAdmin, logLevel: 'warn' }, async (_req, reply) => {
    return reply.send(ok(await kyc.pendingCount()));
  });

  app.get('/admin/kyc', { preHandler: authenticateAdmin }, async (req, reply) => {
    const q = listSchema.parse(req.query);
    return reply.send(ok(await kyc.list(q.status, q.page, q.limit)));
  });

  app.get('/admin/kyc/:pilotId', { preHandler: authenticateAdmin }, async (req, reply) => {
    const { pilotId } = req.params as { pilotId: string };
    return reply.send(ok(await kyc.detail(pilotId)));
  });

  app.post('/admin/kyc/:pilotId/approve', { preHandler: authenticateAdmin }, async (req, reply) => {
    const { pilotId } = req.params as { pilotId: string };
    return reply.send(ok(await kyc.approve(req.user.sub, pilotId)));
  });

  app.post('/admin/kyc/:pilotId/reject', { preHandler: authenticateAdmin }, async (req, reply) => {
    const { pilotId } = req.params as { pilotId: string };
    const body = rejectSchema.parse(req.body);
    return reply.send(ok(await kyc.reject(req.user.sub, pilotId, body.reason, body.docIds)));
  });
}
