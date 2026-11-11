import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok } from '../../lib/envelope.js';
import { AppError } from '../../lib/errors.js';
import { authenticateAdmin, authenticateRider } from '../../plugins/auth.js';
import { sendPush } from '../push/service.js';
import { SosAlert } from './model.js';

const createSchema = z.object({
  rideId: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  note: z.string().max(500).optional(),
});

export async function sosRoutes(app: FastifyInstance) {
  app.post('/sos', { preHandler: authenticateRider }, async (req, reply) => {
    const body = createSchema.parse(req.body ?? {});
    const doc = await SosAlert.create({
      riderId: req.user.sub,
      rideId: body.rideId,
      lat: body.lat,
      lng: body.lng,
      note: body.note,
    } as never);
    void sendPush({
      topic: 'ops_sos',
      title: 'SOS alert',
      body: `Rider SOS${body.rideId ? ` ride ${body.rideId}` : ''}`,
      data: { sosId: String(doc._id), rideId: body.rideId ?? '' },
    });
    return reply.send(ok({ id: String(doc._id), status: doc.status }));
  });

  app.get('/admin/sos', { preHandler: authenticateAdmin }, async (req, reply) => {
    const q = z
      .object({
        page: z.coerce.number().int().positive().default(1),
        limit: z.coerce.number().int().positive().max(50).default(20),
        status: z.enum(['open', 'ack', 'closed']).optional(),
      })
      .parse(req.query);
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    const [items, total] = await Promise.all([
      SosAlert.find(filter as never)
        .sort({ createdAt: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit)
        .lean(),
      SosAlert.countDocuments(filter as never),
    ]);
    return reply.send(
      ok({
        items: items.map((s) => ({
          id: String(s._id),
          riderId: String(s.riderId),
          rideId: s.rideId ? String(s.rideId) : null,
          lat: s.lat,
          lng: s.lng,
          note: s.note,
          status: s.status,
          createdAt: s.createdAt,
        })),
        page: q.page,
        limit: q.limit,
        total,
      }),
    );
  });

  app.post('/admin/sos/:id/ack', { preHandler: authenticateAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const doc = await SosAlert.findByIdAndUpdate(
      id,
      { $set: { status: 'ack', ackBy: req.user.sub, ackAt: new Date() } },
      { new: true },
    );
    if (!doc) throw new AppError('NOT_FOUND', 'SOS not found', 404);
    return reply.send(ok({ id: String(doc._id), status: doc.status }));
  });
}
