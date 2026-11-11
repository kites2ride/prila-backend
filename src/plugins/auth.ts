import fjwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';

export type JwtTyp = 'access' | 'pilot' | 'admin';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; typ: JwtTyp; jti?: string };
    user: { sub: string; typ: JwtTyp; jti?: string };
  }
}

export async function registerJwt(app: FastifyInstance): Promise<void> {
  await app.register(fjwt, {
    secret: env().JWT_SECRET,
  });
}

function requireTyp(typ: JwtTyp) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      throw new AppError('UNAUTHORIZED', 'Invalid or missing token', 401);
    }
    if (req.user.typ !== typ) {
      throw new AppError('FORBIDDEN', `Requires ${typ} token`, 403);
    }
  };
}

export const authenticateRider = requireTyp('access');
export const authenticatePilot = requireTyp('pilot');
export const authenticateAdmin = requireTyp('admin');

/** Rider or pilot access token. */
export async function authenticateAppUser(req: FastifyRequest, _reply: FastifyReply) {
  try {
    await req.jwtVerify();
  } catch {
    throw new AppError('UNAUTHORIZED', 'Invalid or missing token', 401);
  }
  if (req.user.typ !== 'access' && req.user.typ !== 'pilot') {
    throw new AppError('FORBIDDEN', 'Requires rider or pilot token', 403);
  }
}
