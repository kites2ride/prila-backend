import { Schema, model, Types } from 'mongoose';

export const RIDE_STATUSES = [
  'requested',
  'searching',
  'pilot_assigned',
  'pilot_arriving',
  'pilot_arrived',
  'in_progress',
  'completed',
  'paid',
  'cancelled_by_rider',
  'cancelled_by_pilot',
  'cancelled_by_system',
  'no_pilot_found',
] as const;

export type RideStatus = (typeof RIDE_STATUSES)[number];

const pointSchema = new Schema(
  {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], required: true }, // [lng, lat]
  },
  { _id: false },
);

const timelineSchema = new Schema(
  {
    at: { type: Date, required: true },
    from: { type: String },
    to: { type: String, required: true },
    actor: { type: String, enum: ['rider', 'pilot', 'system', 'admin'], required: true },
    actorId: { type: String },
    location: pointSchema,
    note: { type: String },
  },
  { _id: false },
);

const fareBreakdownSchema = new Schema(
  {
    baseFarePaise: Number,
    distancePaise: Number,
    timePaise: Number,
    waitingPaise: Number,
    nightMultiplier: Number,
    surgeMultiplier: Number,
    minimumFarePaise: Number,
    platformFeePaise: Number,
    cancellationFeePaise: Number,
    discountPaise: { type: Number, default: 0 },
    couponCode: String,
    totalPaise: Number,
    configVersion: Number,
  },
  { _id: false },
);

const rideSchema = new Schema(
  {
    status: { type: String, enum: RIDE_STATUSES, required: true, index: true },
    riderId: { type: Schema.Types.ObjectId, ref: 'Rider', required: true, index: true },
    pilotId: { type: Schema.Types.ObjectId, ref: 'Pilot', index: true },
    cityId: { type: Schema.Types.ObjectId, ref: 'City', index: true },
    serviceType: {
      type: String,
      enum: ['bike', 'auto', 'parcel', 'logistics'],
      required: true,
    },
    quoteId: { type: String, required: true, index: true },
    pickup: {
      name: String,
      address: String,
      location: { type: pointSchema, required: true },
    },
    drop: {
      name: String,
      address: String,
      location: { type: pointSchema, required: true },
    },
    distanceM: { type: Number, required: true },
    durationSec: { type: Number, required: true },
    /** Google encoded polyline from the estimate; null when straight-line fallback. */
    routePolyline: { type: String, default: null },
    routeSource: { type: String, enum: ['google', 'haversine'], default: 'haversine' },
    fare: fareBreakdownSchema,
    fareTotalPaise: { type: Number, default: 0 },
    platformRevenuePaise: { type: Number, default: 0 },
    pilotNetPaise: { type: Number },
    commissionPaise: { type: Number },
    commissionMode: { type: String },
    paymentMethod: { type: String, enum: ['cash', 'upi'], default: 'cash' },
    paymentStatus: { type: String, enum: ['unpaid', 'paid', 'waived'], default: 'unpaid' },
    startOtpHash: { type: String },
    startOtpHint: { type: String }, // never return full OTP after assign except to rider once
    offeredPilotIds: [{ type: Schema.Types.ObjectId, ref: 'Pilot' }],
    skippedPilotIds: [{ type: Schema.Types.ObjectId, ref: 'Pilot' }],
    matchingAttempt: { type: Number, default: 0 },
    searchExpiresAt: { type: Date },
    acceptDeadlineAt: { type: Date },
    pickupEtaSec: { type: Number },
    shakti: { type: Boolean, default: false },
    idempotencyKey: { type: String, index: true },
    cancelReasonCode: { type: String },
    cancelReasonText: { type: String },
    riderRating: { type: Number, min: 1, max: 5 },
    pilotRating: { type: Number, min: 1, max: 5 },
    riderRatingTags: [String],
    pilotRatingTags: [String],
    timeline: { type: [timelineSchema], default: [] },
    dispatchLog: {
      type: [
        {
          at: String,
          event: String,
          cells: [String],
          candidateCount: Number,
          pilotIds: [String],
          note: String,
          ms: Number,
        },
      ],
      default: [],
    },
    lastPilotLocation: pointSchema,
    lastPilotLocationAt: { type: Date },
  },
  { timestamps: true },
);

rideSchema.index({ 'pickup.location': '2dsphere' });
rideSchema.index({ status: 1, updatedAt: -1 });
rideSchema.index({ riderId: 1, status: 1 });
rideSchema.index({ pilotId: 1, status: 1 });

const quoteSchema = new Schema(
  {
    quoteId: { type: String, required: true, unique: true },
    riderId: { type: Schema.Types.ObjectId, ref: 'Rider', required: true },
    cityId: { type: Schema.Types.ObjectId, ref: 'City', required: true },
    serviceType: { type: String, required: true },
    pickup: { name: String, address: String, location: pointSchema },
    drop: { name: String, address: String, location: pointSchema },
    distanceM: Number,
    durationSec: Number,
    routePolyline: { type: String, default: null },
    routeSource: { type: String, enum: ['google', 'haversine'], default: 'haversine' },
    fare: fareBreakdownSchema,
    expiresAt: { type: Date, required: true, index: true },
    usedAt: { type: Date },
    couponCode: String,
    shakti: { type: Boolean, default: false },
    signature: { type: String, required: true },
  },
  { timestamps: true },
);

export const Ride = model('Ride', rideSchema);
export const RideQuote = model('RideQuote', quoteSchema);

export type RideId = Types.ObjectId;
