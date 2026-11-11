import pino from 'pino';
import { env } from '../config/env.js';

export function createLogger() {
  const e = env();
  return pino({
    level: e.LOG_LEVEL,
    redact: {
      paths: [
        'req.headers.authorization',
        'password',
        'otp',
        'code',
        'token',
        'refreshToken',
        'accessToken',
        'phone',
        'documentUrl',
        'location.coordinates',
      ],
      censor: '[REDACTED]',
    },
    transport:
      e.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
        : undefined,
  });
}
