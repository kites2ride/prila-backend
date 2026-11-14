import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { fail } from './lib/envelope.js';
import { AppError, isAppError } from './lib/errors.js';
import { createLogger } from './lib/logger.js';
import { authRoutes } from './modules/auth/routes.js';
import { appRoutes } from './modules/app/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { uploadRoutes } from './modules/uploads/routes.js';
import { adminRoutes } from './modules/admin/routes.js';
import { rideRoutes } from './modules/rides/routes.js';
import { dispatchRoutes } from './modules/dispatch/index.js';
import { ledgerRoutes } from './modules/ledger/routes.js';
import { analyticsRoutes } from './modules/analytics/routes.js';
import { pushRoutes } from './modules/push/routes.js';
import { reportRoutes } from './modules/reports/routes.js';
import { sosRoutes } from './modules/sos/routes.js';
import { shareRoutes } from './modules/share/routes.js';
import { nudgeRoutes } from './modules/nudges/routes.js';
import { initFcm } from './modules/push/service.js';
import { registerJwt } from './plugins/auth.js';

export async function buildApp(opts?: { logger?: boolean }) {
  const e = env();
  const app = Fastify({
    ...(opts?.logger === false
      ? { logger: false }
      : { loggerInstance: createLogger() }),
    trustProxy: true,
  });

  await app.register(helmet, { global: true });
  await app.register(cors, {
    origin: e.CORS_ORIGINS,
    credentials: true,
  });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
  });

  await registerJwt(app);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send(
        fail(
          'VALIDATION_ERROR',
          'Invalid request',
          err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        ),
      );
    }
    if (isAppError(err)) {
      return reply.status(err.statusCode).send(fail(err.code, err.message, err.details));
    }
    req.log.error({ err }, 'unhandled error');
    const message =
      e.NODE_ENV === 'production'
        ? 'Internal server error'
        : err instanceof Error
          ? err.message
          : 'Internal server error';
    return reply.status(500).send(fail('INTERNAL_ERROR', message));
  });

  app.setNotFoundHandler((_req, reply) => {
    return reply.status(404).send(fail('NOT_FOUND', 'Route not found'));
  });

  await app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(authRoutes);
      await api.register(appRoutes);
      await api.register(uploadRoutes);
      await api.register(adminRoutes);
      await api.register(rideRoutes);
      await api.register(dispatchRoutes);
      await api.register(ledgerRoutes);
      await api.register(analyticsRoutes);
      await api.register(pushRoutes);
      await api.register(reportRoutes);
      await api.register(sosRoutes);
      await api.register(shareRoutes);
      await api.register(nudgeRoutes);
    },
    { prefix: '/api/v1' },
  );

  initFcm(app.log);

  return app;
}

export type AppInstance = Awaited<ReturnType<typeof buildApp>>;
