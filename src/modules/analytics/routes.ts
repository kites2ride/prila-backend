import type { FastifyInstance } from 'fastify';
import { ok } from '../../lib/envelope.js';
import { authenticateAdmin, authenticateAppUser } from '../../plugins/auth.js';
import { analyticsQuerySchema, trackEventSchema } from './schemas.js';
import * as analytics from './service.js';

export async function analyticsRoutes(app: FastifyInstance) {
  app.post('/analytics/events', { preHandler: authenticateAppUser }, async (req, reply) => {
    const body = trackEventSchema.parse(req.body);
    const appKind = req.user.typ === 'pilot' ? 'pilot' : 'customer';
    const data = await analytics.trackEvent({
      name: body.name,
      app: appKind,
      userId: req.user.sub,
      sessionId: body.sessionId,
      props: body.props as Record<string, unknown> | undefined,
      platform: body.platform,
      build: body.build,
      durationSec: body.durationSec,
    });
    return reply.send(ok(data));
  });

  app.get('/admin/analytics/events', { preHandler: authenticateAdmin }, async (req, reply) => {
    const q = analyticsQuerySchema.parse(req.query);
    const data = await analytics.listEvents(q);
    return reply.send(ok(data));
  });
}
