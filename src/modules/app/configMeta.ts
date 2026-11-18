/**
 * Single source of truth for what the admin may edit inside app configs.
 * Used by the Zod schemas (validation) AND served to the admin panel via
 * GET /admin/config/:key/meta so the UI never hardcodes flags, limits or options.
 */
export const SERVICE_TYPES = ['bike', 'auto', 'parcel', 'logistics'] as const;
export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'te', label: 'Telugu' },
] as const;
export const LANGUAGE_CODES = LANGUAGES.map((l) => l.code) as [string, ...string[]];

export const FLAG_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

export type Risk = 'money' | 'matching' | 'cost' | 'pilots' | 'users';

export type FlagMeta = {
  key: string;
  label: string;
  description: string;
  default: boolean;
  /** Shown as a warning in the confirm dialog when changed. */
  risk?: Risk;
};

export const CUSTOMER_FLAGS: FlagMeta[] = [
  { key: 'wallet', label: 'Wallet', description: 'Wallet screens.', default: false, risk: 'money' },
  { key: 'parcel', label: 'Parcel service', description: 'Parcel tile on home (city must also enable it).', default: true },
  { key: 'logistics', label: 'Logistics service', description: 'Logistics tile on home (city must also enable it).', default: true },
  { key: 'online_payments', label: 'Online payments', description: 'UPI / online payment at checkout. Cash is always available.', default: false, risk: 'money' },
  { key: 'upi', label: 'UPI path', description: 'Alias flag for the UPI payment path.', default: false, risk: 'money' },
  { key: 'coupons', label: 'Coupons', description: 'Coupon code entry at estimate.', default: false, risk: 'money' },
  { key: 'student_coupon', label: 'Student coupon', description: 'Student coupon; requires a verified student.', default: false, risk: 'money' },
  { key: 'prila_shakti', label: 'Prila Shakti', description: 'Female riders can request female-only matching.', default: false, risk: 'matching' },
  { key: 'prila_shakti_strict', label: 'Shakti strict matching', description: 'Hard-filter to female pilots only (when Shakti is on).', default: true, risk: 'matching' },
  { key: 'collect_cancel_dues_on_next_ride', label: 'Collect cancel dues', description: 'Collect unpaid cancellation fees on the next ride.', default: false, risk: 'money' },
  { key: 'referrals', label: 'Referrals', description: 'Referral programme.', default: false },
  { key: 'scheduled_rides', label: 'Scheduled rides', description: 'Book a ride for later.', default: false },
  { key: 'chat', label: 'In-ride chat', description: 'Chat between rider and pilot.', default: false },
];

export const PILOT_FLAGS: FlagMeta[] = [
  { key: 'wallet', label: 'Wallet', description: 'Pilot wallet and earnings screens.', default: true, risk: 'money' },
  { key: 'chat', label: 'In-ride chat', description: 'Chat between pilot and rider.', default: false },
];

export const APP_CONFIG_LIMITS = {
  tilesOrder: { min: 1, max: SERVICE_TYPES.length },
  languages: { min: 1, max: LANGUAGES.length },
  locationUpdateIntervalSec: { min: 1, max: 60 },
  locationDistanceFilterM: { min: 0, max: 500 },
  kyc: { maxDocsPerVehicle: 12, idPattern: '^[a-z][a-z0-9_]{0,29}$', labelMax: 40 },
} as const;

export const KYC_DOC_ID_RE = new RegExp(APP_CONFIG_LIMITS.kyc.idPattern);

export function appConfigMeta(key: 'app_config_customer' | 'app_config_pilot') {
  return {
    flags: key === 'app_config_customer' ? CUSTOMER_FLAGS : PILOT_FLAGS,
    languages: LANGUAGES,
    serviceTypes: SERVICE_TYPES,
    limits: APP_CONFIG_LIMITS,
  };
}
