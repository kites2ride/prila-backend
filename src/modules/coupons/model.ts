import { Schema, model } from 'mongoose';

const couponRuleSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true },
    title: { type: String, required: true },
    /** first_ride | ride_milestone | student_first | manual */
    kind: {
      type: String,
      enum: ['first_ride', 'ride_milestone', 'student_first', 'manual'],
      required: true,
    },
    enabled: { type: Boolean, default: false },
    /** percentage basis points (1500=15%) or fixed paise */
    discountMode: { type: String, enum: ['percentage', 'fixed'], default: 'fixed' },
    discountValue: { type: Number, required: true },
    maxDiscountPaise: { type: Number },
    minFarePaise: { type: Number, default: 0 },
    milestoneRideCount: { type: Number }, // e.g. 5
    serviceTypes: [{ type: String }],
    cityIds: [{ type: Schema.Types.ObjectId }],
    startsAt: { type: Date },
    endsAt: { type: Date },
    perUserLimit: { type: Number, default: 1 },
  },
  { timestamps: true },
);

const couponRedemptionSchema = new Schema(
  {
    couponCode: { type: String, required: true, index: true },
    riderId: { type: Schema.Types.ObjectId, ref: 'Rider', required: true, index: true },
    rideId: { type: Schema.Types.ObjectId, ref: 'Ride' },
    discountPaise: { type: Number, required: true },
  },
  { timestamps: true },
);

couponRedemptionSchema.index({ couponCode: 1, riderId: 1 });

export const CouponRule = model('CouponRule', couponRuleSchema);
export const CouponRedemption = model('CouponRedemption', couponRedemptionSchema);
