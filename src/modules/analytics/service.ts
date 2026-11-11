import { Types } from 'mongoose';
import { istDayBounds } from '../admin/ist.js';
import { AnalyticsEvent } from './model.js';

export async function trackEvent(input: {
  name: string;
  app: 'customer' | 'pilot' | 'admin';
  userId?: string;
  sessionId?: string;
  props?: Record<string, unknown>;
  platform?: string;
  build?: number;
  durationSec?: number;
}) {
  const props = { ...(input.props ?? {}) };
  if (input.durationSec != null) props.durationSec = input.durationSec;
  await AnalyticsEvent.create({
    name: input.name,
    app: input.app,
    userId: input.userId ? new Types.ObjectId(input.userId) : undefined,
    sessionId: input.sessionId,
    props,
    platform: input.platform,
    build: input.build,
    at: new Date(),
  } as never);
  return { ok: true };
}

export async function listEvents(opts: {
  page: number;
  limit: number;
  name?: string;
  app?: string;
}) {
  const filter: Record<string, unknown> = {};
  if (opts.name) filter.name = opts.name;
  if (opts.app) filter.app = opts.app;
  const [items, total] = await Promise.all([
    AnalyticsEvent.find(filter as never)
      .sort({ at: -1 })
      .skip((opts.page - 1) * opts.limit)
      .limit(opts.limit)
      .lean(),
    AnalyticsEvent.countDocuments(filter as never),
  ]);
  return {
    items: items.map((e) => ({
      id: String(e._id),
      name: e.name,
      app: e.app,
      userId: e.userId ? String(e.userId) : null,
      sessionId: e.sessionId,
      props: e.props,
      platform: e.platform,
      at: e.at,
    })),
    page: opts.page,
    limit: opts.limit,
    total,
  };
}

export async function overviewAnalytics(fromYmd: string, toYmd: string) {
  const { from, to } = istDayBounds(fromYmd, toYmd);
  const match = { at: { $gte: from, $lte: to } };
  const [dauCustomer, dauPilot, logins, screenAgg] = await Promise.all([
    AnalyticsEvent.distinct('userId', { ...match, app: 'customer', userId: { $exists: true } }),
    AnalyticsEvent.distinct('userId', { ...match, app: 'pilot', userId: { $exists: true } }),
    AnalyticsEvent.countDocuments({ ...match, name: { $in: ['app_open', 'login'] } }),
    AnalyticsEvent.aggregate([
      { $match: { ...match, name: 'screen_time', 'props.durationSec': { $exists: true } } },
      { $group: { _id: null, sec: { $sum: '$props.durationSec' } } },
    ]),
  ]);
  return {
    dauCustomer: dauCustomer.filter(Boolean).length,
    dauPilot: dauPilot.filter(Boolean).length,
    logins,
    screenTimeSec: Math.round(screenAgg[0]?.sec ?? 0),
  };
}
