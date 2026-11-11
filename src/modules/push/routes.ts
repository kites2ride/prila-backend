import type { FastifyInstance } from 'fastify';
import { ok } from '../../lib/envelope.js';
import { authenticateAdmin, authenticateAppUser } from '../../plugins/auth.js';
import { z } from 'zod';
import { adminPushSchema, permissionsSchema, pushTokenSchema } from './schemas.js';
import * as devices from './devices.js';
import * as inbox from './inbox.js';
import { sendPush } from './service.js';

const pageSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(20),
});

export async function pushRoutes(app: FastifyInstance) {
  app.post('/devices/push-token', { preHandler: authenticateAppUser }, async (req, reply) => {
    const body = pushTokenSchema.parse(req.body);
    const typ = req.user.typ === 'pilot' ? 'pilot' : 'access';
    const data = await devices.registerPushToken(typ, req.user.sub, body.pushToken, body.platform);
    return reply.send(ok(data));
  });

  app.delete('/devices/push-token', { preHandler: authenticateAppUser }, async (req, reply) => {
    const body = pushTokenSchema.pick({ pushToken: true }).parse(req.body);
    const typ = req.user.typ === 'pilot' ? 'pilot' : 'access';
    const data = await devices.unregisterPushToken(typ, req.user.sub, body.pushToken);
    return reply.send(ok(data));
  });

  app.post('/devices/permissions', { preHandler: authenticateAppUser }, async (req, reply) => {
    const body = permissionsSchema.parse(req.body);
    const typ = req.user.typ === 'pilot' ? 'pilot' : 'access';
    const data = await devices.updatePermissions(typ, req.user.sub, body);
    return reply.send(ok(data));
  });

  app.get('/notifications', { preHandler: authenticateAppUser }, async (req, reply) => {
    const q = pageSchema.parse(req.query);
    const data = await inbox.listInbox(req.user.sub, q.page, q.limit);
    return reply.send(ok(data));
  });

  app.post('/notifications/:id/read', { preHandler: authenticateAppUser }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const data = await inbox.markRead(req.user.sub, id);
    return reply.send(ok(data));
  });

  app.post('/admin/push/send', { preHandler: authenticateAdmin }, async (req, reply) => {
    const body = adminPushSchema.parse(req.body);
    const dataPayload = {
      ...(body.data ?? {}),
      ...(body.deepLink ? { deepLink: body.deepLink } : {}),
    };
    if (body.topic) {
      const r = await sendPush({
        topic: body.topic,
        title: body.title,
        body: body.body,
        data: dataPayload,
      });
      return reply.send(ok(r));
    }
    if (body.userId) {
      const typ = body.userTyp ?? 'rider';
      const r = await devices.pushToUser(typ, body.userId, body.title, body.body, dataPayload);
      await inbox.createInboxNotification({
        userId: body.userId,
        typ,
        title: body.title,
        body: body.body,
        data: dataPayload,
      });
      return reply.send(ok(r));
    }
    return reply.status(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'topic or userId required' } });
  });

  app.get('/admin/permissions/stats', { preHandler: authenticateAdmin }, async (_req, reply) => {
    const data = await devices.permissionStats();
    return reply.send(ok(data));
  });
}
