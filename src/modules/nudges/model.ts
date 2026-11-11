import { Schema, model, Types } from 'mongoose';

const nudgeRuleSchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    audience: { type: String, enum: ['rider', 'pilot', 'both'], default: 'rider' },
    trigger: {
      type: String,
      enum: ['idle_pilot_online', 'rider_inactive_days', 'manual'],
      default: 'manual',
    },
    threshold: { type: Number, default: 3 },
    enabled: { type: Boolean, default: false },
    deepLink: { type: String },
    cityId: { type: Types.ObjectId, ref: 'City' },
    lastRunAt: { type: Date },
  },
  { timestamps: true },
);

export const NudgeRule = model('NudgeRule', nudgeRuleSchema);
