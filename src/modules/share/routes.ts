import type { FastifyInstance } from 'fastify';
import { ok } from '../../lib/envelope.js';
import { authenticateRider } from '../../plugins/auth.js';
import * as share from './service.js';

export async function shareRoutes(app: FastifyInstance) {
  app.post('/rides/:id/share', { preHandler: authenticateRider }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const data = await share.createShareToken(req.user.sub, id);
    return reply.send(ok(data));
  });

  app.get('/share/rides/:token', async (req, reply) => {
    const token = (req.params as { token: string }).token;
    const data = await share.readSharedRide(token);
    return reply.send(ok(data));
  });
}
