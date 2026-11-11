import { Schema, model, Types } from 'mongoose';

/** Append-only money movements. Amounts in paise. Positive = credit to `party`. */
const ledgerEntrySchema = new Schema(
  {
    type: {
      type: String,
      enum: [
        'ride_gross',
        'platform_commission',
        'platform_fee',
        'pilot_net',
        'cash_collected',
        'incentive',
        'payout',
        'dues_settlement',
        'adjustment',
        'cancellation_fee',
      ],
      required: true,
      index: true,
    },
    party: { type: String, enum: ['pilot', 'platform', 'rider'], required: true, index: true },
    pilotId: { type: Schema.Types.ObjectId, ref: 'Pilot', index: true },
    riderId: { type: Schema.Types.ObjectId, ref: 'Rider', index: true },
    rideId: { type: Schema.Types.ObjectId, ref: 'Ride', index: true },
    payoutId: { type: Schema.Types.ObjectId, ref: 'PayoutRequest' },
    amountPaise: { type: Number, required: true },
    balanceAfterPaise: { type: Number },
    duesAfterPaise: { type: Number },
    currency: { type: String, default: 'INR' },
    idempotencyKey: { type: String, required: true, unique: true },
    meta: { type: Schema.Types.Mixed },
    note: { type: String },
  },
  { timestamps: true },
);

ledgerEntrySchema.index({ pilotId: 1, createdAt: -1 });
ledgerEntrySchema.index({ type: 1, createdAt: -1 });

const pilotWalletSchema = new Schema(
  {
    pilotId: { type: Schema.Types.ObjectId, ref: 'Pilot', required: true, unique: true },
    /** Withdrawable / incentive balance (paise). */
    balancePaise: { type: Number, default: 0 },
    /** Commission owed to platform on cash rides (paise). */
    duesPaise: { type: Number, default: 0 },
    lifetimeGrossPaise: { type: Number, default: 0 },
    lifetimeNetPaise: { type: Number, default: 0 },
    lifetimeCommissionPaise: { type: Number, default: 0 },
    lifetimeTrips: { type: Number, default: 0 },
  },
  { timestamps: true },
);

const payoutRequestSchema = new Schema(
  {
    pilotId: { type: Schema.Types.ObjectId, ref: 'Pilot', required: true, index: true },
    amountPaise: { type: Number, required: true },
    status: {
      type: String,
      enum: ['requested', 'approved', 'paid', 'rejected'],
      default: 'requested',
      index: true,
    },
    method: { type: String, enum: ['upi', 'bank', 'manual'], default: 'upi' },
    upiId: { type: String },
    note: { type: String },
    adminNote: { type: String },
    processedAt: { type: Date },
    processedBy: { type: String },
  },
  { timestamps: true },
);

const incentiveRuleSchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    enabled: { type: Boolean, default: false },
    /** Credit pilot wallet this many paise when trigger fires. */
    amountPaise: { type: Number, required: true },
    trigger: {
      type: String,
      enum: ['trips_per_day', 'trips_per_week', 'manual'],
      default: 'trips_per_day',
    },
    threshold: { type: Number, default: 10 },
    cityId: { type: Schema.Types.ObjectId, ref: 'City' },
  },
  { timestamps: true },
);

export const LedgerEntry = model('LedgerEntry', ledgerEntrySchema);
export const PilotWallet = model('PilotWallet', pilotWalletSchema);
export const PayoutRequest = model('PayoutRequest', payoutRequestSchema);
export const IncentiveRule = model('IncentiveRule', incentiveRuleSchema);

export type LedgerId = Types.ObjectId;
