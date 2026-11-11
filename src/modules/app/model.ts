import { Schema, model, type InferSchemaType, Types } from 'mongoose';

const configSingletonSchema = new Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      enum: [
        'app_config_customer',
        'app_config_pilot',
        'app_update',
        'home_promo',
        'matching',
        'dispatch',
        'surge',
        'pilot_quality',
        'support',
        'maintenance',
      ],
    },
    version: { type: Number, default: 1 },
    value: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true },
);

const citySchema = new Schema(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    timezone: { type: String, default: 'Asia/Kolkata' },
    enabled: { type: Boolean, default: true },
    center: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true }, // [lng, lat]
    },
    services: [{ type: String }],
  },
  { timestamps: true },
);

citySchema.index({ center: '2dsphere' });

const zoneSchema = new Schema(
  {
    cityId: { type: Schema.Types.ObjectId, ref: 'City', required: true, index: true },
    name: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    polygon: {
      type: { type: String, enum: ['Polygon'], required: true },
      coordinates: { type: [[[Number]]], required: true },
    },
  },
  { timestamps: true },
);

zoneSchema.index({ polygon: '2dsphere' });

const serviceSchema = new Schema(
  {
    type: { type: String, enum: ['bike', 'auto', 'parcel', 'logistics'], required: true, unique: true },
    name: { type: String, required: true },
    iconUrl: { type: String, default: '' },
    order: { type: Number, default: 0 },
    enabled: { type: Boolean, default: true },
    capacity: { type: Number, default: 1 },
    maxWeightKg: { type: Number },
    minWeightKg: { type: Number },
  },
  { timestamps: true },
);

const fareRuleSchema = new Schema(
  {
    cityId: { type: Schema.Types.ObjectId, ref: 'City', required: true },
    serviceType: { type: String, enum: ['bike', 'auto', 'parcel', 'logistics'], required: true },
    version: { type: Number, default: 1 },
    baseFarePaise: { type: Number, required: true },
    perKmPaise: { type: Number, required: true },
    perMinutePaise: { type: Number, required: true },
    minimumFarePaise: { type: Number, required: true },
    nightMultiplier: { type: Number, default: 1 },
    surgeMultiplier: { type: Number, default: 1 },
    waitingPerMinutePaise: { type: Number, default: 0 },
    cancellationFeePaise: { type: Number, default: 0 },
    platformFeePaise: { type: Number, default: 0 },
  },
  { timestamps: true },
);

fareRuleSchema.index({ cityId: 1, serviceType: 1 }, { unique: true });

const commissionRuleSchema = new Schema(
  {
    cityId: { type: Schema.Types.ObjectId, ref: 'City', required: true },
    serviceType: { type: String, enum: ['bike', 'auto', 'parcel', 'logistics', 'all'], default: 'all' },
    mode: { type: String, enum: ['percentage', 'fixed', 'subscription'], required: true },
    /** percentage: basis points (e.g. 1500 = 15%); fixed/subscription: paise */
    value: { type: Number, required: true },
    subscriptionPeriod: { type: String, enum: ['day', 'week', 'month'], required: false },
    enabled: { type: Boolean, default: true },
    version: { type: Number, default: 1 },
  },
  { timestamps: true },
);

commissionRuleSchema.index({ cityId: 1, serviceType: 1, mode: 1 });

const auditSchema = new Schema(
  {
    actor: { type: String, required: true },
    action: { type: String, required: true },
    key: { type: String },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

export type ConfigSingletonDoc = InferSchemaType<typeof configSingletonSchema> & { _id: Types.ObjectId };

export const ConfigSingleton = model('ConfigSingleton', configSingletonSchema);
export const City = model('City', citySchema);
export const Zone = model('Zone', zoneSchema);
export const ServiceType = model('ServiceType', serviceSchema);
export const FareRule = model('FareRule', fareRuleSchema);
export const CommissionRule = model('CommissionRule', commissionRuleSchema);
export const AdminAuditLog = model('AdminAuditLog', auditSchema);
