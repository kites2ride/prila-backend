import type { FastifyInstance } from 'fastify';
import { ok } from '../../lib/envelope.js';
import { authenticateAdmin } from '../../plugins/auth.js';
import { bootstrapQuerySchema, configKeySchema, patchConfigSchema } from './schemas.js';
import * as appService from './service.js';

export async function appRoutes(app: FastifyInstance) {
  app.get('/app/bootstrap', async (req, reply) => {
    const query = bootstrapQuerySchema.parse(req.query);
    const data = await appService.bootstrap(query);
    return reply.send(ok(data));
  });

  app.get('/app/update-policy', async (req, reply) => {
    const query = bootstrapQuerySchema.pick({ app: true, platform: true, build: true }).parse(req.query);
    const data = await appService.getUpdatePolicy(query.app, query.platform, query.build);
    return reply.send(ok(data));
  });

  app.get(
    '/admin/config/:key',
    { preHandler: authenticateAdmin },
    async (req, reply) => {
      const key = configKeySchema.parse((req.params as { key: string }).key);
      const data = await appService.getConfig(key);
      return reply.send(ok(data));
    },
  );

  app.patch(
    '/admin/config/:key',
    { preHandler: authenticateAdmin },
    async (req, reply) => {
      const key = configKeySchema.parse((req.params as { key: string }).key);
      const body = patchConfigSchema.parse(req.body);
      const actor = req.user.sub;
      const data = await appService.patchConfig(actor, key, body.value);
      return reply.send(ok(data));
    },
  );
}
