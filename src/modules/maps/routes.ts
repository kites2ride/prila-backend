import type { FastifyInstance } from 'fastify';
import { ok } from '../../lib/envelope.js';
import { authenticateAdmin, authenticateAppUser } from '../../plugins/auth.js';
import { FIELD_MASKS } from './google.js';
import { autocompleteQuerySchema, placeQuerySchema, reverseQuerySchema } from './schemas.js';
import * as maps from './service.js';
import { usage } from './usage.js';

/**
 * Maps proxy: apps never hold the server key. `logLevel: 'warn'` keeps search
 * text and user coordinates (query string) out of the request access logs.
 */
export async function mapsRoutes(app: FastifyInstance) {
  const appOpts = { preHandler: authenticateAppUser, logLevel: 'warn' as const };

  app.get('/maps/autocomplete', appOpts, async (req, reply) => {
    const q = autocompleteQuerySchema.parse(req.query);
    return reply.send(ok(await maps.autocomplete(req.user.sub, q)));
  });

  app.get('/maps/place', appOpts, async (req, reply) => {
    const q = placeQuerySchema.parse(req.query);
    return reply.send(ok(await maps.place(req.user.sub, q)));
  });

  app.get('/maps/reverse', appOpts, async (req, reply) => {
    const q = reverseQuerySchema.parse(req.query);
    return reply.send(ok(await maps.reverse(req.user.sub, q)));
  });

  /** Cost monitoring: billable Google calls vs cache hits since start/reset (this instance). */
  app.get('/admin/maps/usage', { preHandler: authenticateAdmin }, async (_req, reply) => {
    return reply.send(ok({ ...usage.snapshot(), fieldMasks: FIELD_MASKS }));
  });

  app.post('/admin/maps/usage/reset', { preHandler: authenticateAdmin }, async (_req, reply) => {
    usage.reset();
    return reply.send(ok(usage.snapshot()));
  });
}
