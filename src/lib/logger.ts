import pino from 'pino';
import { env } from '../config/env.js';

export function createLogger() {
  const e = env();
  const opts: pino.LoggerOptions = {
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
  };
  if (e.NODE_ENV === 'development') {
    opts.transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard' },
    };
  }
  return pino(opts);
}
