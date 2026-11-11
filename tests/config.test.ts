import { describe, expect, it } from 'vitest';
import { AdminAuditLog } from '../src/modules/app/model.js';
import { app, setupTestApp } from './helpers.js';

setupTestApp();

async function adminToken() {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/login',
    payload: { email: 'ops@prila.local', password: 'adminpass' },
  });
  return login.json().data.accessToken as string;
}

describe('config + bootstrap', () => {
  it('returns bootstrap for customer with services and flags', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/app/bootstrap?app=customer&platform=android&build=1',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.languages).toEqual(['en', 'te']);
    expect(body.data.flags.online_payments).toBe(false);
    expect(body.data.flags.upi).toBe(false);
    expect(body.data.city.slug).toBe('warangal');
    expect(body.data.city.services.map((s: { type: string }) => s.type)).toEqual([
      'bike',
      'auto',
      'parcel',
      'logistics',
    ]);
    expect(body.data.maintenance.enabled).toBe(false);
    expect(body.data.update.mode).toBe('none');
  });

  it('patches matching config, bumps version, writes audit', async () => {
    const token = await adminToken();
    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/config/matching',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.json().data.version).toBe(1);

    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/config/matching',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        value: {
          searchRadiusM: 4000,
          batchSize: 6,
          acceptTimeoutSec: 20,
          retries: 4,
          maxSearchTimeSec: 150,
          quoteTtlSec: 180,
        },
      },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().data.version).toBe(2);
    expect(patch.json().data.value.searchRadiusM).toBe(4000);

    const audits = await AdminAuditLog.find({ key: 'matching' });
    expect(audits.length).toBe(1);
    expect(audits[0]?.actor).toBe('ops@prila.local');
  });

  it('health returns ok envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().data.db).toBe('up');
  });
});
