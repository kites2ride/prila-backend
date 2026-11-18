import { describe, expect, it } from 'vitest';
import {
  appUpdateValueSchema,
  dispatchValueSchema,
  maintenanceValueSchema,
  supportValueSchema,
  zonesValueSchema,
  mapsValueSchema,
  pilotQualityValueSchema,
  surgeValueSchema,
} from '../src/modules/app/schemas.js';
import { CATALOG_BASES, catalogMismatches, TYPED_CONFIG_FIELDS } from '../src/modules/app/settingsCatalog.js';

const schemas = {
  dispatch: dispatchValueSchema,
  surge: surgeValueSchema,
  maps: mapsValueSchema,
  pilot_quality: pilotQualityValueSchema,
  support: supportValueSchema,
  maintenance: maintenanceValueSchema,
  zones: zonesValueSchema,
} as const;

describe('settings catalogs stay in sync with Zod schemas', () => {
  for (const key of Object.keys(schemas) as (keyof typeof schemas)[]) {
    it(key, () => {
      expect(catalogMismatches(TYPED_CONFIG_FIELDS[key], (v) => schemas[key].safeParse(v), CATALOG_BASES[key])).toEqual([]);
    });
  }

  it('surge table rules', () => {
    const ok = (table: unknown) => surgeValueSchema.safeParse({ table }).success;
    expect(ok([{ minRatio: 1, multiplier: 1 }])).toBe(false); // must start at 0
    expect(ok([{ minRatio: 0, multiplier: 1 }, { minRatio: 2, multiplier: 1.2 }, { minRatio: 1, multiplier: 1.3 }])).toBe(false);
    expect(ok([{ minRatio: 0, multiplier: 1 }, { minRatio: 2, multiplier: 1.9 }])).toBe(false); // above maxMultiplier 1.5
    expect(ok([{ minRatio: 0, multiplier: 1 }, { minRatio: 2, multiplier: 1.2 }])).toBe(true);
  });

  it('dispatch offer timeout must be shorter than max search', () => {
    expect(dispatchValueSchema.safeParse({ offerTimeoutSec: 60, maxSearchSec: 30 }).success).toBe(false);
  });

  it('support: rejects bad phones, SOS numbers and unsafe links', () => {
    const ok = (v: unknown) => supportValueSchema.safeParse(v).success;
    expect(ok({ phone: '+919876543210', whatsapp: '', sosNumbers: ['112'], termsUrl: 'https://prila.in/t' })).toBe(true);
    expect(ok({ phone: 'call me' })).toBe(false);
    expect(ok({ sosNumbers: ['11', '112'] })).toBe(false);
    expect(ok({ sosNumbers: ['112', '112'] })).toBe(false);
    expect(ok({ termsUrl: 'javascript:alert(1)' })).toBe(false);
    expect(ok({ privacyUrl: 'http://prila.in/p' })).toBe(false);
  });

  it('maintenance: needs a message while enabled', () => {
    expect(maintenanceValueSchema.safeParse({ enabled: true }).success).toBe(false);
    expect(maintenanceValueSchema.safeParse({ enabled: true, message: 'Back at 6 AM' }).success).toBe(true);
    expect(maintenanceValueSchema.safeParse({ enabled: false }).success).toBe(true);
  });

  it('app_update: guards against lock-outs and fake store links', () => {
    const plat = (o: Record<string, unknown>) => ({ minBuild: 0, latestBuild: 1, storeUrl: '', ...o });
    const full = (o: Record<string, unknown>) => {
      const p = plat(o);
      return { customer: { android: p, ios: p }, pilot: { android: p, ios: p } };
    };
    const ok = (o: Record<string, unknown>) => appUpdateValueSchema.safeParse(full(o)).success;
    const play = 'https://play.google.com/store/apps/details?id=in.prila.customer';
    expect(ok({})).toBe(true);
    expect(ok({ minBuild: 5, latestBuild: 7, storeUrl: play })).toBe(true);
    expect(ok({ minBuild: 5, latestBuild: 7 })).toBe(false); // forced update without a store link
    expect(ok({ minBuild: 8, latestBuild: 7, storeUrl: play })).toBe(false); // latest < min
    expect(ok({ minBuild: 5, latestBuild: 7, storeUrl: 'https://evil.example.com/app' })).toBe(false);
    expect(ok({ minBuild: 5, latestBuild: 7, storeUrl: 'http://play.google.com/x' })).toBe(false);
    expect(ok({ minBuild: -1 })).toBe(false);
    expect(ok({ minBuild: 1.5 })).toBe(false);
  });
});
