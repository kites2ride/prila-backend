import { Schema, model, Types } from 'mongoose';

const analyticsEventSchema = new Schema(
  {
    name: { type: String, required: true, index: true },
    app: { type: String, enum: ['customer', 'pilot', 'admin'], required: true, index: true },
    userId: { type: Types.ObjectId, index: true },
    sessionId: { type: String, index: true },
    props: { type: Schema.Types.Mixed },
    platform: { type: String },
    build: { type: Number },
    at: { type: Date, default: () => new Date(), index: true },
  },
  { timestamps: false },
);

analyticsEventSchema.index({ at: -1, name: 1 });

export const AnalyticsEvent = model('AnalyticsEvent', analyticsEventSchema);
