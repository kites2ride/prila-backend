import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok } from '../../lib/envelope.js';
import { AppError } from '../../lib/errors.js';
import { authenticateAdmin, authenticateAppUser } from '../../plugins/auth.js';
import { Report } from './model.js';

const createSchema = z.object({
  category: z.string().min(2).max(64),
  message: z.string().min(3).max(1000),
  rideId: z.string().optional(),
});

const pageSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(20),
  status: z.enum(['open', 'resolved', 'dismissed']).optional(),
});

export async function reportRoutes(app: FastifyInstance) {
  app.post('/reports', { preHandler: authenticateAppUser }, async (req, reply) => {
    const body = createSchema.parse(req.body);
    const doc = await Report.create({
      reporterId: req.user.sub,
      reporterTyp: req.user.typ === 'pilot' ? 'pilot' : 'rider',
      category: body.category,
      message: body.message,
      rideId: body.rideId,
    } as never);
    return reply.send(ok({ id: String(doc._id), status: doc.status }));
  });

  app.get('/admin/reports', { preHandler: authenticateAdmin }, async (req, reply) => {
    const q = pageSchema.parse(req.query);
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    const [items, total] = await Promise.all([
      Report.find(filter as never)
        .sort({ createdAt: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit)
        .lean(),
      Report.countDocuments(filter as never),
    ]);
    return reply.send(
      ok({
        items: items.map((r) => ({
          id: String(r._id),
          reporterId: String(r.reporterId),
          reporterTyp: r.reporterTyp,
          rideId: r.rideId ? String(r.rideId) : null,
          category: r.category,
          message: r.message,
          status: r.status,
          createdAt: r.createdAt,
        })),
        page: q.page,
        limit: q.limit,
        total,
      }),
    );
  });

  app.post('/admin/reports/:id/resolve', { preHandler: authenticateAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = z
      .object({
        status: z.enum(['resolved', 'dismissed']).default('resolved'),
        adminNote: z.string().max(500).optional(),
      })
      .parse(req.body ?? {});
    const doc = await Report.findByIdAndUpdate(
      id,
      {
        $set: {
          status: body.status,
          adminNote: body.adminNote,
          resolvedAt: new Date(),
          resolvedBy: req.user.sub,
        },
      },
      { new: true },
    );
    if (!doc) throw new AppError('NOT_FOUND', 'Report not found', 404);
    return reply.send(ok({ id: String(doc._id), status: doc.status }));
  });
}
