import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { OtpChallenge, Pilot, RefreshToken, Rider } from './model.js';
import { sendOtpSms } from './sms.js';

function hashOtp(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (phone.startsWith('+')) return phone;
  return `+${digits}`;
}

export async function requestOtp(
  app: FastifyInstance,
  input: { phone: string; app: 'customer' | 'pilot' },
) {
  const phone = normalizePhone(input.phone);
  const code = String(randomInt(1000, 9999));
  const expiresAt = new Date(Date.now() + 5 * 60_000);

  await OtpChallenge.deleteMany({ phone, app: input.app });
  await OtpChallenge.create({
    phone,
    app: input.app,
    codeHash: hashOtp(code),
    expiresAt,
  });

  await sendOtpSms(phone, code, app.log);

  const payload: { expiresInSec: number; debugCode?: string } = { expiresInSec: 300 };
  if (env().ALLOW_OTP_DEBUG) {
    payload.debugCode = code;
  }
  return payload;
}

export async function verifyOtp(
  app: FastifyInstance,
  input: { phone: string; app: 'customer' | 'pilot'; code: string },
) {
  const phone = normalizePhone(input.phone);
  const challenge = await OtpChallenge.findOne({ phone, app: input.app }).sort({ createdAt: -1 });
  if (!challenge || challenge.expiresAt.getTime() < Date.now()) {
    throw new AppError('OTP_EXPIRED', 'OTP expired or not found', 400);
  }
  if (challenge.attempts >= 5) {
    throw new AppError('OTP_LOCKED', 'Too many attempts', 429);
  }

  const ok = challenge.codeHash === hashOtp(input.code);
  if (!ok) {
    challenge.attempts += 1;
    await challenge.save();
    throw new AppError('OTP_INVALID', 'Invalid OTP', 400);
  }

  await OtpChallenge.deleteMany({ phone, app: input.app });

  if (input.app === 'customer') {
    let rider = await Rider.findOne({ phone });
    if (!rider) rider = await Rider.create({ phone });
    if (rider.status !== 'active') throw new AppError('ACCOUNT_SUSPENDED', 'Account suspended', 403);
    return issueUserTokens(app, { userId: rider._id.toString(), typ: 'access' });
  }

  let pilot = await Pilot.findOne({ phone });
  if (!pilot) pilot = await Pilot.create({ phone });
  if (pilot.status !== 'active') throw new AppError('ACCOUNT_SUSPENDED', 'Account suspended', 403);
  return issueUserTokens(app, { userId: pilot._id.toString(), typ: 'pilot' });
}

async function issueUserTokens(
  app: FastifyInstance,
  claims: { userId: string; typ: 'access' | 'pilot' },
) {
  const e = env();
  const jti = randomUUID();
  const accessToken = await app.jwt.sign(
    { sub: claims.userId, typ: claims.typ },
    { expiresIn: e.JWT_ACCESS_TTL },
  );
  const refreshToken = await app.jwt.sign(
    { sub: claims.userId, typ: claims.typ, jti },
    { expiresIn: e.JWT_REFRESH_TTL },
  );

  const refreshMs = parseDurationMs(e.JWT_REFRESH_TTL);
  await RefreshToken.create({
    jti,
    userId: claims.userId,
    typ: claims.typ,
    expiresAt: new Date(Date.now() + refreshMs),
  });

  return {
    accessToken,
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: parseDurationMs(e.JWT_ACCESS_TTL) / 1000,
    typ: claims.typ,
    userId: claims.userId,
  };
}

export async function refreshTokens(app: FastifyInstance, refreshToken: string) {
  let decoded: { sub: string; typ: string; jti?: string };
  try {
    decoded = await app.jwt.verify<{ sub: string; typ: string; jti?: string }>(refreshToken);
  } catch {
    throw new AppError('UNAUTHORIZED', 'Invalid refresh token', 401);
  }

  if ((decoded.typ !== 'access' && decoded.typ !== 'pilot') || !decoded.jti) {
    throw new AppError('UNAUTHORIZED', 'Invalid refresh token type', 401);
  }

  const stored = await RefreshToken.findOne({ jti: decoded.jti });
  if (!stored || stored.revokedAt || stored.expiresAt.getTime() < Date.now()) {
    throw new AppError('UNAUTHORIZED', 'Refresh token revoked or expired', 401);
  }

  stored.revokedAt = new Date();
  await stored.save();

  return issueUserTokens(app, {
    userId: decoded.sub,
    typ: decoded.typ as 'access' | 'pilot',
  });
}

export async function adminLogin(app: FastifyInstance, email: string, password: string) {
  const logins = env().ADMIN_LOGINS;
  const expected = logins[email.toLowerCase()] ?? logins[email];
  if (!expected || expected !== password) {
    throw new AppError('UNAUTHORIZED', 'Invalid credentials', 401);
  }

  const accessToken = await app.jwt.sign(
    { sub: email.toLowerCase(), typ: 'admin' },
    { expiresIn: env().JWT_ADMIN_TTL },
  );

  return {
    accessToken,
    tokenType: 'Bearer',
    expiresIn: parseDurationMs(env().JWT_ADMIN_TTL) / 1000,
    typ: 'admin' as const,
    email: email.toLowerCase(),
  };
}

/** Supports 15m, 8h, 30d style strings used by @fastify/jwt */
export function parseDurationMs(ttl: string): number {
  const m = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!m) return 15 * 60_000;
  const n = Number(m[1]);
  const unit = m[2];
  switch (unit) {
    case 's':
      return n * 1000;
    case 'm':
      return n * 60_000;
    case 'h':
      return n * 3_600_000;
    case 'd':
      return n * 86_400_000;
    default:
      return 15 * 60_000;
  }
}
