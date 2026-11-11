import { env } from '../../config/env.js';
import type { FastifyBaseLogger } from 'fastify';

/** SMS adapter stub — real DLT provider wired later via env. */
export async function sendOtpSms(
  phone: string,
  code: string,
  log: FastifyBaseLogger,
): Promise<{ sent: boolean; provider: string }> {
  const e = env();
  if (!e.SMS_PROVIDER || !e.SMS_API_KEY) {
    log.info({ phone: '[REDACTED]', provider: 'noop' }, 'SMS provider not configured; OTP not sent');
    return { sent: false, provider: 'noop' };
  }

  // Placeholder for future DLT HTTP call using SMS_* env vars.
  log.info({ provider: e.SMS_PROVIDER }, 'SMS OTP dispatch stub — provider configured but not implemented');
  void code;
  void phone;
  return { sent: false, provider: e.SMS_PROVIDER };
}
