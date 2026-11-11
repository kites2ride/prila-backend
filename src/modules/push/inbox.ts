import { Schema, model, Types } from 'mongoose';

const notificationSchema = new Schema(
  {
    userId: { type: Types.ObjectId, required: true, index: true },
    typ: { type: String, enum: ['rider', 'pilot'], required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    data: { type: Schema.Types.Mixed },
    readAt: { type: Date },
  },
  { timestamps: true },
);

export const AppNotification = model('AppNotification', notificationSchema);

export async function createInboxNotification(input: {
  userId: string;
  typ: 'rider' | 'pilot';
  title: string;
  body: string;
  data?: Record<string, string>;
}) {
  return AppNotification.create({
    userId: new Types.ObjectId(input.userId),
    typ: input.typ,
    title: input.title,
    body: input.body,
    data: input.data,
  } as never);
}

export async function listInbox(userId: string, page: number, limit: number) {
  const filter = { userId: new Types.ObjectId(userId) };
  const [items, total] = await Promise.all([
    AppNotification.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    AppNotification.countDocuments(filter),
  ]);
  return {
    items: items.map((n) => ({
      id: String(n._id),
      title: n.title,
      body: n.body,
      data: n.data,
      readAt: n.readAt,
      createdAt: n.createdAt,
    })),
    page,
    limit,
    total,
  };
}

export async function markRead(userId: string, id: string) {
  await AppNotification.updateOne(
    { _id: id, userId: new Types.ObjectId(userId) },
    { $set: { readAt: new Date() } },
  );
  return { ok: true };
}
