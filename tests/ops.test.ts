import { describe, expect, it } from 'vitest';
import { app, setupTestApp } from './helpers.js';

setupTestApp();

async function riderToken() {
  const otp = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/request',
    payload: { phone: '9000000201', app: 'customer' },
  });
  const verify = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/verify',
    payload: { phone: '9000000201', app: 'customer', code: otp.json().data.debugCode },
  });
  return verify.json().data.accessToken as string;
}

async function adminToken() {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/login',
    payload: { email: 'ops@prila.local', password: 'adminpass' },
  });
  return login.json().data.accessToken as string;
}

describe('phase 6 ops', () => {
  it('tracks analytics, registers push token (noop FCM), creates report and SOS', async () => {
    const token = await riderToken();
    const admin = await adminToken();

    const ev = await app.inject({
      method: 'POST',
      url: '/api/v1/analytics/events',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'app_open', platform: 'android', sessionId: 'sess-ops-1' },
    });
    expect(ev.statusCode).toBe(200);

    const push = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/push-token',
      headers: { authorization: `Bearer ${token}` },
      payload: { pushToken: 'fake-fcm-token-ops-test-123456', platform: 'android' },
    });
    expect(push.statusCode).toBe(200);

    const perms = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/permissions',
      headers: { authorization: `Bearer ${token}` },
      payload: { locationPermission: 'whileInUse', notificationPermission: 'granted' },
    });
    expect(perms.statusCode).toBe(200);

    const report = await app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: { authorization: `Bearer ${token}` },
      payload: { category: 'safety', message: 'Test report from ops suite' },
    });
    expect(report.statusCode).toBe(200);

    const sos = await app.inject({
      method: 'POST',
      url: '/api/v1/sos',
      headers: { authorization: `Bearer ${token}` },
      payload: { lat: 17.96, lng: 79.59, note: 'test' },
    });
    expect(sos.statusCode).toBe(200);

    const send = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/push/send',
      headers: { authorization: `Bearer ${admin}` },
      payload: { title: 'Hello', body: 'World', topic: 'city_warangal' },
    });
    expect(send.statusCode).toBe(200);
    expect(send.json().data.ok).toBe(false);
    expect(send.json().data.reason).toBe('fcm_disabled');

    const stats = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/permissions/stats',
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(stats.statusCode).toBe(200);
    expect(stats.json().data.riders.total).toBeGreaterThanOrEqual(1);
  });
});
