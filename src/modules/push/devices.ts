import { Pilot, Rider } from '../auth/model.js';
import { AppError } from '../../lib/errors.js';
import { sendPush } from './service.js';

type AppTyp = 'access' | 'pilot';

export async function registerPushToken(
  typ: AppTyp,
  userId: string,
  pushToken: string,
  platform: 'android' | 'ios' | 'web',
) {
  if (typ === 'pilot') {
    const user = await Pilot.findById(userId);
    if (!user) throw new AppError('NOT_FOUND', 'User not found', 404);
    const devices = (user.devices ?? []) as Array<{
      platform: string;
      pushToken?: string;
      lastActiveAt?: Date;
    }>;
    const next = devices.filter((d) => d.pushToken !== pushToken);
    next.push({ platform, pushToken, lastActiveAt: new Date() });
    user.devices = next.slice(-5) as never;
    user.notificationPermission = 'granted';
    await user.save();
    return { ok: true, devices: user.devices.length };
  }
  const user = await Rider.findById(userId);
  if (!user) throw new AppError('NOT_FOUND', 'User not found', 404);
  const devices = (user.devices ?? []) as Array<{
    platform: string;
    pushToken?: string;
    lastActiveAt?: Date;
  }>;
  const next = devices.filter((d) => d.pushToken !== pushToken);
  next.push({ platform, pushToken, lastActiveAt: new Date() });
  user.devices = next.slice(-5) as never;
  user.notificationPermission = 'granted';
  await user.save();
  return { ok: true, devices: user.devices.length };
}

export async function unregisterPushToken(typ: AppTyp, userId: string, pushToken: string) {
  if (typ === 'pilot') {
    await Pilot.updateOne({ _id: userId }, { $pull: { devices: { pushToken } } });
  } else {
    await Rider.updateOne({ _id: userId }, { $pull: { devices: { pushToken } } });
  }
  return { ok: true };
}

export async function updatePermissions(
  typ: AppTyp,
  userId: string,
  body: { locationPermission?: string; notificationPermission?: string },
) {
  const $set: Record<string, string> = {};
  if (body.locationPermission) $set.locationPermission = body.locationPermission;
  if (body.notificationPermission) $set.notificationPermission = body.notificationPermission;
  if (!Object.keys($set).length) return { ok: true };
  if (typ === 'pilot') {
    await Pilot.updateOne({ _id: userId }, { $set });
  } else {
    await Rider.updateOne({ _id: userId }, { $set });
  }
  return { ok: true, ...$set };
}

export async function getUserPushTokens(typ: 'rider' | 'pilot', userId: string): Promise<string[]> {
  const user =
    typ === 'pilot'
      ? await Pilot.findById(userId).select('devices').lean()
      : await Rider.findById(userId).select('devices').lean();
  if (!user?.devices) return [];
  return (user.devices as Array<{ pushToken?: string }>)
    .map((d) => d.pushToken)
    .filter((t): t is string => Boolean(t));
}

export async function pushToUser(
  typ: 'rider' | 'pilot',
  userId: string,
  title: string,
  body: string,
  data?: Record<string, string>,
) {
  const tokens = await getUserPushTokens(typ, userId);
  const results = [];
  for (const token of tokens) {
    results.push(await sendPush({ token, title, body, data }));
  }
  return { sent: results.filter((r) => r.ok).length, attempted: results.length, results };
}

export async function permissionStats() {
  const [riders, pilots] = await Promise.all([
    Rider.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          locAlways: { $sum: { $cond: [{ $eq: ['$locationPermission', 'always'] }, 1, 0] } },
          locWhile: { $sum: { $cond: [{ $eq: ['$locationPermission', 'whileInUse'] }, 1, 0] } },
          locDenied: { $sum: { $cond: [{ $eq: ['$locationPermission', 'denied'] }, 1, 0] } },
          notifGranted: { $sum: { $cond: [{ $eq: ['$notificationPermission', 'granted'] }, 1, 0] } },
          notifDenied: { $sum: { $cond: [{ $eq: ['$notificationPermission', 'denied'] }, 1, 0] } },
        },
      },
    ]),
    Pilot.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          locAlways: { $sum: { $cond: [{ $eq: ['$locationPermission', 'always'] }, 1, 0] } },
          locWhile: { $sum: { $cond: [{ $eq: ['$locationPermission', 'whileInUse'] }, 1, 0] } },
          locDenied: { $sum: { $cond: [{ $eq: ['$locationPermission', 'denied'] }, 1, 0] } },
          notifGranted: { $sum: { $cond: [{ $eq: ['$notificationPermission', 'granted'] }, 1, 0] } },
          notifDenied: { $sum: { $cond: [{ $eq: ['$notificationPermission', 'denied'] }, 1, 0] } },
        },
      },
    ]),
  ]);
  return {
    riders: riders[0] ?? { total: 0 },
    pilots: pilots[0] ?? { total: 0 },
  };
}
