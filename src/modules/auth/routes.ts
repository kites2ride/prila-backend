import type { FastifyInstance } from 'fastify';
import { ok } from '../../lib/envelope.js';
import { authenticateRider } from '../../plugins/auth.js';
import { AppError } from '../../lib/errors.js';
import { Rider } from './model.js';
import { adminLoginSchema, otpRequestSchema, otpVerifySchema, refreshSchema } from './schemas.js';
import * as authService from './service.js';

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/otp/request', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const body = otpRequestSchema.parse(req.body);
      const data = await authService.requestOtp(app, body);
      return reply.send(ok(data));
    },
  });

  app.post('/auth/otp/verify', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const body = otpVerifySchema.parse(req.body);
      const data = await authService.verifyOtp(app, body);
      return reply.send(ok(data));
    },
  });

  /** The signed-in rider's own account facts. `createdAt` = when the account was created (profile "Member since"). */
  app.get('/rider/me', { preHandler: authenticateRider }, async (req, reply) => {
    const rider = await Rider.findById(req.user.sub).select('createdAt').lean();
    if (!rider) throw new AppError('NOT_FOUND', 'Rider not found', 404);
    return reply.send(ok({ id: String(rider._id), createdAt: rider.createdAt }));
  });

  app.post('/auth/refresh', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const body = refreshSchema.parse(req.body);
      const data = await authService.refreshTokens(app, body.refreshToken);
      return reply.send(ok(data));
    },
  });

  app.post('/admin/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const body = adminLoginSchema.parse(req.body);
      const data = await authService.adminLogin(app, body.email, body.password);
      return reply.send(ok(data));
    },
  });
}
