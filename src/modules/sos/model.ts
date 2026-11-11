import { Schema, model, Types } from 'mongoose';

const sosSchema = new Schema(
  {
    riderId: { type: Types.ObjectId, required: true, index: true },
    rideId: { type: Types.ObjectId, ref: 'Ride', index: true },
    lat: { type: Number },
    lng: { type: Number },
    note: { type: String },
    status: { type: String, enum: ['open', 'ack', 'closed'], default: 'open', index: true },
    ackBy: { type: String },
    ackAt: { type: Date },
  },
  { timestamps: true },
);

export const SosAlert = model('SosAlert', sosSchema);
