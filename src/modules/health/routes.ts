import type { FastifyInstance } from 'fastify';
import mongoose from 'mongoose';
import { ok } from '../../lib/envelope.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (_req, reply) => {
    const db = mongoose.connection.readyState === 1 ? 'up' : 'down';
    return reply.send(
      ok({
        status: db === 'up' ? 'ok' : 'degraded',
        db,
        uptimeSec: Math.floor(process.uptime()),
      }),
    );
  });
}
