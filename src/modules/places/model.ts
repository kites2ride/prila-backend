import { Schema, model } from 'mongoose';

/**
 * Ops-curated landmarks (bus stand, railway station, hospitals, colleges…).
 * Our own data — searched before Google (free) and safe to store indefinitely.
 */
const landmarkSchema = new Schema(
  {
    cityId: { type: Schema.Types.ObjectId, ref: 'City', index: true },
    name: { type: String, required: true },
    aliases: { type: [String], default: [] },
    address: { type: String, default: '' },
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true }, // [lng, lat]
    },
    enabled: { type: Boolean, default: true, index: true },
    priority: { type: Number, default: 0 },
  },
  { timestamps: true },
);

landmarkSchema.index({ location: '2dsphere' });

export const Landmark = model('Landmark', landmarkSchema);
