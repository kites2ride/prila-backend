import { Schema, model } from 'mongoose';

/**
 * Demand we turned away because it was outside the service area. Daily counters
 * per H3 cell (res 8 ≈ 0.7 km²) so ops can see where to expand. Auto-expires.
 */
const outOfAreaDemandSchema = new Schema(
  {
    day: { type: String, required: true }, // YYYY-MM-DD (IST)
    cell: { type: String, required: true },
    kind: { type: String, enum: ['pickup', 'drop'], required: true },
    reason: { type: String, required: true }, // pickup_outside | pickup_blocked | drop_outside | drop_other_city
    lat: { type: Number, required: true }, // cell centre
    lng: { type: Number, required: true },
    count: { type: Number, default: 0 },
    lastAt: { type: Date, required: true },
  },
  { timestamps: false },
);

outOfAreaDemandSchema.index({ day: 1, cell: 1, kind: 1, reason: 1 }, { unique: true });
outOfAreaDemandSchema.index({ lastAt: 1 }, { expireAfterSeconds: 90 * 86_400 });

export const OutOfAreaDemand = model('OutOfAreaDemand', outOfAreaDemandSchema);
