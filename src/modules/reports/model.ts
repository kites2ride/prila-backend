import { Schema, model, Types } from 'mongoose';

const reportSchema = new Schema(
  {
    reporterId: { type: Types.ObjectId, required: true, index: true },
    reporterTyp: { type: String, enum: ['rider', 'pilot'], required: true },
    rideId: { type: Types.ObjectId, ref: 'Ride' },
    category: { type: String, required: true },
    message: { type: String, required: true },
    status: { type: String, enum: ['open', 'resolved', 'dismissed'], default: 'open', index: true },
    adminNote: { type: String },
    resolvedAt: { type: Date },
    resolvedBy: { type: String },
  },
  { timestamps: true },
);

export const Report = model('Report', reportSchema);
