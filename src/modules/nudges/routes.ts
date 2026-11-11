import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok } from '../../lib/envelope.js';
import { AppError } from '../../lib/errors.js';
import { authenticateAdmin } from '../../plugins/auth.js';
import * as nudges from './service.js';

export async function nudgeRoutes(app: FastifyInstance) {
  app.get('/admin/nudges', { preHandler: authenticateAdmin }, async (_req, reply) => {
    const data = await nudges.listNudges();
    return reply.send(ok(data));
  });

  app.patch('/admin/nudges/:id', { preHandler: authenticateAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = z.object({ enabled: z.boolean() }).parse(req.body);
    const data = await nudges.setNudgeEnabled(id, body.enabled);
    if (!data) throw new AppError('NOT_FOUND', 'Nudge not found', 404);
    return reply.send(ok(data));
  });
}
