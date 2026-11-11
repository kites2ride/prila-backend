import { describe, expect, it } from 'vitest';
import { app, setupTestApp } from './helpers.js';

setupTestApp();

describe('auth', () => {
  it('requests and verifies rider OTP', async () => {
    const reqRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
      payload: { phone: '9876543210', app: 'customer' },
    });
    expect(reqRes.statusCode).toBe(200);
    const reqBody = reqRes.json();
    expect(reqBody.ok).toBe(true);
    expect(reqBody.data.debugCode).toMatch(/^\d{4}$/);

    const verifyRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      payload: {
        phone: '9876543210',
        app: 'customer',
        code: reqBody.data.debugCode,
      },
    });
    expect(verifyRes.statusCode).toBe(200);
    const verifyBody = verifyRes.json();
    expect(verifyBody.ok).toBe(true);
    expect(verifyBody.data.typ).toBe('access');
    expect(verifyBody.data.accessToken).toBeTruthy();
    expect(verifyBody.data.refreshToken).toBeTruthy();
  });

  it('issues pilot typ on pilot OTP verify', async () => {
    const reqRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
      payload: { phone: '9888777666', app: 'pilot' },
    });
    expect(reqRes.statusCode).toBe(200);
    const code = reqRes.json().data.debugCode as string;
    expect(code).toMatch(/^\d{4}$/);
    const verifyRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      payload: { phone: '9888777666', app: 'pilot', code },
    });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.json().data.typ).toBe('pilot');
  });

  it('logs in admin and rejects wrong typ on admin config', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/login',
      payload: { email: 'ops@prila.local', password: 'adminpass' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().data.typ).toBe('admin');
    const adminToken = login.json().data.accessToken as string;

    const okGet = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/config/matching',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(okGet.statusCode).toBe(200);
    expect(okGet.json().data.key).toBe('matching');

    const otp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
      payload: { phone: '9111111111', app: 'customer' },
    });
    const rider = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      payload: {
        phone: '9111111111',
        app: 'customer',
        code: otp.json().data.debugCode,
      },
    });
    const riderToken = rider.json().data.accessToken as string;

    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/config/matching',
      headers: { authorization: `Bearer ${riderToken}` },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().ok).toBe(false);
    expect(forbidden.json().error.code).toBe('FORBIDDEN');
  });

  it('refreshes rider tokens', async () => {
    const otp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
      payload: { phone: '9222222222', app: 'customer' },
    });
    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      payload: {
        phone: '9222222222',
        app: 'customer',
        code: otp.json().data.debugCode,
      },
    });
    const refreshToken = verified.json().data.refreshToken as string;
    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().data.accessToken).toBeTruthy();
  });
});
