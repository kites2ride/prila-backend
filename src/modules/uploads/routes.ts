import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ok } from '../../lib/envelope.js';
import { AppError } from '../../lib/errors.js';
import { presignSchema } from './schemas.js';
import * as uploadService from './service.js';

async function authenticateAnyUser(req: FastifyRequest, _reply: FastifyReply) {
  try {
    await req.jwtVerify();
  } catch {
    throw new AppError('UNAUTHORIZED', 'Invalid or missing token', 401);
  }
  const typ = req.user.typ;
  if (typ !== 'access' && typ !== 'pilot' && typ !== 'admin') {
    throw new AppError('FORBIDDEN', 'Forbidden', 403);
  }
}

export async function uploadRoutes(app: FastifyInstance) {
  app.post('/uploads/presign', { preHandler: authenticateAnyUser }, async (req, reply) => {
    const body = presignSchema.parse(req.body);
    const data = await uploadService.createPresignedUpload(body);
    return reply.send(ok(data));
  });
}
