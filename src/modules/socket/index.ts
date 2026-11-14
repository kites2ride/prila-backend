import type { FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import { env } from '../../config/env.js';
import * as rideService from '../rides/service.js';

export type PrilaSocketServer = Server;

export function attachSocket(app: FastifyInstance): Server {
  const io = new Server(app.server, {
    cors: { origin: env().CORS_ORIGINS, credentials: true },
    path: '/socket.io',
  });

  const authenticate = async (token: string | undefined) => {
    if (!token) throw new Error('missing token');
    const bare = token.startsWith('Bearer ') ? token.slice(7) : token;
    return app.jwt.verify<{ sub: string; typ: string }>(bare);
  };

  for (const nspName of ['/rider', '/pilot'] as const) {
    const nsp = io.of(nspName);
    nsp.use(async (socket, next) => {
      try {
        const token =
          (socket.handshake.auth?.token as string | undefined) ??
          (socket.handshake.headers.authorization as string | undefined);
        const user = await authenticate(token);
        const expected = nspName === '/rider' ? 'access' : 'pilot';
        if (user.typ !== expected && user.typ !== 'admin') {
          return next(new Error('forbidden'));
        }
        socket.data.user = user;
        next();
      } catch {
        next(new Error('unauthorized'));
      }
    });

    nsp.on('connection', (socket) => {
      const user = socket.data.user as { sub: string; typ: string };
      app.log.info({ nsp: nspName, sub: user.sub }, 'socket connected');

      if (nspName === '/rider') {
        void socket.join(`rider:${user.sub}`);
      }

      socket.on('join_ride', (rideId: string) => {
        if (typeof rideId === 'string' && rideId.length > 0) {
          void socket.join(`ride:${rideId}`);
        }
      });

      if (nspName === '/pilot') {
        void socket.join(`pilot:${user.sub}`);
        const onLocation = (payload: unknown) => {
          void rideService.updatePilotLocation(app, user.sub, payload as {
            lat: number;
            lng: number;
            accuracyM?: number;
            headingDeg?: number;
            speedMps?: number;
            recordedAt?: string | number;
            isMocked?: boolean;
          }).then((res) => {
            socket.emit('location:ack', { ok: res.ok, reason: res.reason, at: Date.now() });
          });
        };
        socket.on('pilot:location', onLocation);
        socket.on('location', onLocation); // legacy alias

        socket.on('disconnect', () => {
          app.log.info({ nsp: nspName, sub: user.sub }, 'socket disconnected');
        });
      } else {
        socket.on('disconnect', () => {
          app.log.info({ nsp: nspName, sub: user.sub }, 'socket disconnected');
        });
      }
    });
  }

  // Fastify 5 forbids decorate after ready/listen; assign for Socket.io after server exists.
  Object.assign(app, { io });
  return io;
}

declare module 'fastify' {
  interface FastifyInstance {
    io: Server;
  }
}
