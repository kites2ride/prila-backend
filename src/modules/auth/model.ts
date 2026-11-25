import { Schema, model, type InferSchemaType, Types } from 'mongoose';

const deviceSchema = new Schema(
  {
    platform: { type: String, enum: ['android', 'ios', 'web'], required: true },
    pushToken: { type: String },
    lastActiveAt: { type: Date },
  },
  { _id: false },
);

const savedPlaceSchema = new Schema(
  {
    label: { type: String, enum: ['home', 'work'], required: true },
    name: { type: String, required: true },
    address: { type: String, default: '' },
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true }, // [lng, lat]
    },
  },
  { _id: false },
);

const riderSchema = new Schema(
  {
    phone: { type: String, required: true, unique: true, index: true },
    savedPlaces: { type: [savedPlaceSchema], default: [] },
    name: { type: String },
    language: { type: String, default: 'en' },
    /** Explicit self-ID — never infer from name (Uber-style heuristics avoided). */
    gender: { type: String, enum: ['female', 'male', 'other', 'unspecified'], default: 'unspecified' },
    studentVerified: { type: Boolean, default: false },
    cityId: { type: Schema.Types.ObjectId, ref: 'City' },
    citySlug: { type: String },
    locationPermission: { type: String, enum: ['denied', 'whileInUse', 'always', 'unknown'], default: 'unknown' },
    notificationPermission: { type: String, enum: ['granted', 'denied', 'unknown'], default: 'unknown' },
    devices: [deviceSchema],
    status: { type: String, enum: ['active', 'suspended', 'deleted'], default: 'active' },
  },
  { timestamps: true },
);

const pilotSchema = new Schema(
  {
    phone: { type: String, required: true, unique: true, index: true },
    name: { type: String },
    language: { type: String, default: 'en' },
    /** From KYC / self-ID — required for Prila Shakti matching. */
    gender: { type: String, enum: ['female', 'male', 'other', 'unspecified'], default: 'unspecified' },
    cityId: { type: Schema.Types.ObjectId, ref: 'City' },
    citySlug: { type: String },
    vehicleType: { type: String, enum: ['bike', 'auto', 'parcel', 'logistics'] },
    vehicleNumber: { type: String },
    kycStatus: {
      type: String,
      enum: ['not_started', 'pending', 'approved', 'rejected'],
      default: 'not_started',
    },
    kycRejectReason: { type: String },
    /** Doc ids the admin marked as wrong on the last rejection (pilot re-uploads these). */
    kycRejectedDocs: [{ type: String }],
    /** Private storage keys (kyc/<pilotId>/...). Never public URLs. */
    kycDocs: [
      {
        _id: false,
        docId: { type: String, required: true },
        key: { type: String, required: true },
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
    kycSubmittedAt: { type: Date, index: true },
    kycReviewedAt: { type: Date },
    kycReviewedBy: { type: String },
    /** Approved KYC selfie, shown to riders on the pilot card. */
    photoKey: { type: String },
    /** Count of rides this pilot cancelled after accepting (no penalty yet; visible to ops). */
    cancelCount: { type: Number, default: 0 },
    /** Times riders cancelled because of this pilot (asked to cancel, extra money, unreachable, ...). Ops review. */
    cancellationFlags: { type: Number, default: 0 },
    online: { type: Boolean, default: false },
    idle: { type: Boolean, default: true },
    shaktiOptIn: { type: Boolean, default: false },
    location: {
      type: { type: String, enum: ['Point'] },
      coordinates: { type: [Number] },
    },
    lastLocationAt: { type: Date },
    h3Cell: { type: String },
    locationMockFlagged: { type: Boolean, default: false },
    locationPermission: { type: String, enum: ['denied', 'whileInUse', 'always', 'unknown'], default: 'unknown' },
    notificationPermission: { type: String, enum: ['granted', 'denied', 'unknown'], default: 'unknown' },
    devices: [deviceSchema],
    status: { type: String, enum: ['active', 'suspended', 'deleted'], default: 'active' },
    suspendReason: { type: String },
    suspendedAt: { type: Date },
    ratingAvg: { type: Number },
    ratingCount: { type: Number, default: 0 },
    upiId: { type: String },
  },
  { timestamps: true },
);

pilotSchema.index({ location: '2dsphere' });

const otpChallengeSchema = new Schema(
  {
    phone: { type: String, required: true, index: true },
    app: { type: String, enum: ['customer', 'pilot'], required: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: true },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true },
);

otpChallengeSchema.index({ phone: 1, app: 1 });

const refreshTokenSchema = new Schema(
  {
    jti: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    typ: { type: String, enum: ['access', 'pilot'], required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
  },
  { timestamps: true },
);

refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type RiderDoc = InferSchemaType<typeof riderSchema> & { _id: Types.ObjectId };
export type PilotDoc = InferSchemaType<typeof pilotSchema> & { _id: Types.ObjectId };

export const Rider = model('Rider', riderSchema);
export const Pilot = model('Pilot', pilotSchema);
export const OtpChallenge = model('OtpChallenge', otpChallengeSchema);
export const RefreshToken = model('RefreshToken', refreshTokenSchema);
