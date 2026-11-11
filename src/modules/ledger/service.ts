import { Types } from 'mongoose';
import { AppError } from '../../lib/errors.js';
import { ConfigSingleton } from '../app/model.js';
import { Pilot } from '../auth/model.js';
import { Ride } from '../rides/model.js';
import { istDayBounds } from '../admin/ist.js';
import { resolveCommission } from './commission.js';
import { IncentiveRule, LedgerEntry, PilotWallet, PayoutRequest } from './model.js';

async function ensureWallet(pilotId: string) {
  let w = await PilotWallet.findOne({ pilotId });
  if (!w) {
    w = await PilotWallet.create({ pilotId });
  }
  return w;
}

async function appendLedger(input: {
  type: string;
  party: 'pilot' | 'platform' | 'rider';
  amountPaise: number;
  pilotId?: string;
  riderId?: string;
  rideId?: string;
  payoutId?: string;
  idempotencyKey: string;
  meta?: Record<string, unknown>;
  note?: string;
  balanceAfterPaise?: number;
  duesAfterPaise?: number;
}) {
  try {
    return await LedgerEntry.create(input as never);
  } catch (e: unknown) {
    // Idempotent retry
    if (e && typeof e === 'object' && 'code' in e && (e as { code?: number }).code === 11000) {
      return LedgerEntry.findOne({ idempotencyKey: input.idempotencyKey });
    }
    throw e;
  }
}

/** Post ride money: append-only ledger + wallet dues/earnings. Cash → pilot owes commission. */
export async function settleRideCompletion(rideId: string) {
  const ride = await Ride.findById(rideId);
  if (!ride?.pilotId) return null;
  const key = `settle:${rideId}`;
  const existing = await LedgerEntry.findOne({ idempotencyKey: key });
  if (existing) return existing;

  const grossPaise = ride.fareTotalPaise ?? ride.fare?.totalPaise ?? 0;
  const cityId = String(ride.cityId);
  const commission = await resolveCommission({
    cityId,
    serviceType: ride.serviceType ?? 'bike',
    grossPaise,
  });
  const platformFeePaise = ride.fare?.platformFeePaise ?? 0;
  const totalPlatform = commission.commissionPaise + platformFeePaise;
  const netPaise = Math.max(0, grossPaise - totalPlatform);

  const wallet = await ensureWallet(String(ride.pilotId));
  wallet.lifetimeGrossPaise += grossPaise;
  wallet.lifetimeNetPaise += netPaise;
  wallet.lifetimeCommissionPaise += totalPlatform;
  wallet.lifetimeTrips += 1;

  if (ride.paymentMethod === 'cash') {
    // Pilot holds cash; owes platform cut
    wallet.duesPaise += totalPlatform;
  } else {
    // Online: net lands in withdrawable balance
    wallet.balancePaise += netPaise;
  }
  await wallet.save();

  await appendLedger({
    type: 'ride_gross',
    party: 'pilot',
    amountPaise: grossPaise,
    pilotId: String(ride.pilotId),
    riderId: String(ride.riderId),
    rideId,
    idempotencyKey: `${key}:gross`,
    meta: { paymentMethod: ride.paymentMethod },
  });
  await appendLedger({
    type: 'platform_commission',
    party: 'platform',
    amountPaise: totalPlatform,
    pilotId: String(ride.pilotId),
    rideId,
    idempotencyKey: `${key}:commission`,
    meta: { mode: commission.mode, value: commission.value, platformFeePaise },
  });
  await appendLedger({
    type: 'pilot_net',
    party: 'pilot',
    amountPaise: netPaise,
    pilotId: String(ride.pilotId),
    rideId,
    idempotencyKey: key,
    balanceAfterPaise: wallet.balancePaise,
    duesAfterPaise: wallet.duesPaise,
    meta: { cash: ride.paymentMethod === 'cash' },
    note: ride.paymentMethod === 'cash' ? 'Cash collected by pilot; commission added to dues' : 'Net credited to wallet',
  });

  await Ride.updateOne(
    { _id: rideId },
    {
      $set: {
        platformRevenuePaise: (ride.platformRevenuePaise ?? 0) + totalPlatform,
        pilotNetPaise: netPaise,
        commissionPaise: totalPlatform,
        commissionMode: commission.mode,
      },
    },
  );

  void checkIncentives(String(ride.pilotId), cityId);
  return { grossPaise, netPaise, commissionPaise: totalPlatform };
}

async function checkIncentives(pilotId: string, cityId: string) {
  const rules = await IncentiveRule.find({ enabled: true }).lean();
  if (!rules.length) return;

  const today = new Date();
  const ymd = today.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const { from, to } = istDayBounds(ymd, ymd);
  const tripsToday = await Ride.countDocuments({
    pilotId,
    status: { $in: ['completed', 'paid'] },
    updatedAt: { $gte: from, $lte: to },
  });

  for (const rule of rules) {
    if (rule.cityId && String(rule.cityId) !== cityId) continue;
    if (rule.trigger !== 'trips_per_day') continue;
    if (tripsToday < (rule.threshold ?? 10)) continue;
    const idem = `incentive:${rule.code}:${pilotId}:${ymd}`;
    const exists = await LedgerEntry.findOne({ idempotencyKey: idem });
    if (exists) continue;
    await creditIncentive(pilotId, rule.amountPaise, idem, rule.code, rule.title);
  }
}

export async function creditIncentive(
  pilotId: string,
  amountPaise: number,
  idempotencyKey: string,
  code: string,
  title?: string,
) {
  const wallet = await ensureWallet(pilotId);
  wallet.balancePaise += amountPaise;
  await wallet.save();
  await appendLedger({
    type: 'incentive',
    party: 'pilot',
    amountPaise,
    pilotId,
    idempotencyKey,
    balanceAfterPaise: wallet.balancePaise,
    meta: { code, title },
    note: title ?? code,
  });
}

export async function getWallet(pilotId: string) {
  const wallet = await ensureWallet(pilotId);
  return {
    balancePaise: wallet.balancePaise,
    duesPaise: wallet.duesPaise,
    lifetimeGrossPaise: wallet.lifetimeGrossPaise,
    lifetimeNetPaise: wallet.lifetimeNetPaise,
    lifetimeCommissionPaise: wallet.lifetimeCommissionPaise,
    lifetimeTrips: wallet.lifetimeTrips,
  };
}

export async function getEarnings(pilotId: string, range: 'today' | 'week' | 'month') {
  const now = new Date();
  const istYmd = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  let fromYmd = istYmd;
  let toYmd = istYmd;

  if (range === 'week') {
    const d = new Date(`${istYmd}T12:00:00+05:30`);
    d.setDate(d.getDate() - 6);
    fromYmd = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  } else if (range === 'month') {
    const d = new Date(`${istYmd}T12:00:00+05:30`);
    d.setDate(d.getDate() - 29);
    fromYmd = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  }

  const { from, to } = istDayBounds(fromYmd, toYmd);
  const entries = await LedgerEntry.find({
    pilotId,
    type: 'pilot_net',
    createdAt: { $gte: from, $lte: to },
  })
    .sort({ createdAt: 1 })
    .lean();

  const trips = entries.length;
  const netPaise = entries.reduce((s, e) => s + (e.amountPaise ?? 0), 0);
  const commissions = await LedgerEntry.find({
    pilotId,
    type: 'platform_commission',
    createdAt: { $gte: from, $lte: to },
  }).lean();
  const commissionPaise = commissions.reduce((s, e) => s + (e.amountPaise ?? 0), 0);
  const grossPaise = netPaise + commissionPaise;

  // Chart buckets by IST day
  const chartMap = new Map<string, number>();
  for (const e of entries) {
    const day = new Date(e.createdAt!).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    chartMap.set(day, (chartMap.get(day) ?? 0) + (e.amountPaise ?? 0));
  }
  const chart = [...chartMap.entries()].map(([day, amountPaise]) => ({ day, amountPaise }));

  const transactions = await LedgerEntry.find({
    pilotId,
    createdAt: { $gte: from, $lte: to },
  })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  return {
    range,
    from: fromYmd,
    to: toYmd,
    trips,
    grossPaise,
    commissionPaise,
    netPaise,
    chart,
    transactions: transactions.map((t) => ({
      id: String(t._id),
      type: t.type,
      amountPaise: t.amountPaise,
      note: t.note,
      rideId: t.rideId ? String(t.rideId) : null,
      at: t.createdAt,
      meta: t.meta,
    })),
  };
}

export async function getLedgerPage(pilotId: string, page: number, limit: number) {
  const [items, total] = await Promise.all([
    LedgerEntry.find({ pilotId })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    LedgerEntry.countDocuments({ pilotId }),
  ]);
  return {
    items: items.map((t) => ({
      id: String(t._id),
      type: t.type,
      amountPaise: t.amountPaise,
      note: t.note,
      rideId: t.rideId ? String(t.rideId) : null,
      at: t.createdAt,
    })),
    page,
    limit,
    total,
  };
}

export async function requestPayout(
  pilotId: string,
  amountPaise: number,
  method: 'upi' | 'bank' | 'manual',
  upiId?: string,
) {
  if (amountPaise <= 0) throw new AppError('VALIDATION_ERROR', 'Invalid amount', 400);
  const wallet = await ensureWallet(pilotId);
  if (amountPaise > wallet.balancePaise) {
    throw new AppError('INSUFFICIENT_BALANCE', 'Not enough wallet balance', 400);
  }
  const pending = await PayoutRequest.findOne({
    pilotId,
    status: { $in: ['requested', 'approved'] },
  });
  if (pending) throw new AppError('PAYOUT_PENDING', 'You already have a pending payout', 409);

  const payout = await PayoutRequest.create({
    pilotId,
    amountPaise,
    method,
    upiId,
    status: 'requested',
  });
  return serializePayout(payout);
}

export async function listPilotPayouts(pilotId: string, page: number, limit: number) {
  const [items, total] = await Promise.all([
    PayoutRequest.find({ pilotId })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    PayoutRequest.countDocuments({ pilotId }),
  ]);
  return { items: items.map(serializePayout), page, limit, total };
}

export async function listAdminPayouts(status: string | undefined, page: number, limit: number) {
  const filter = (
    status ? { status: status as 'requested' | 'approved' | 'paid' | 'rejected' } : {}
  ) as Record<string, unknown>;
  const [items, total] = await Promise.all([
    PayoutRequest.find(filter as never)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    PayoutRequest.countDocuments(filter as never),
  ]);
  return { items: items.map((p) => serializePayout(p as InstanceType<typeof PayoutRequest>)), page, limit, total };
}

export async function processPayout(
  actor: string,
  payoutId: string,
  action: 'approve' | 'pay' | 'reject',
  adminNote?: string,
) {
  const payout = await PayoutRequest.findById(payoutId);
  if (!payout) throw new AppError('NOT_FOUND', 'Payout not found', 404);

  if (action === 'approve') {
    if (payout.status !== 'requested') throw new AppError('INVALID_STATE', 'Not requested', 409);
    payout.status = 'approved';
    payout.adminNote = adminNote;
    payout.processedBy = actor;
    await payout.save();
    return serializePayout(payout);
  }

  if (action === 'reject') {
    if (!['requested', 'approved'].includes(payout.status)) {
      throw new AppError('INVALID_STATE', 'Cannot reject', 409);
    }
    payout.status = 'rejected';
    payout.adminNote = adminNote;
    payout.processedBy = actor;
    payout.processedAt = new Date();
    await payout.save();
    return serializePayout(payout);
  }

  // pay — debit wallet
  if (!['requested', 'approved'].includes(payout.status)) {
    throw new AppError('INVALID_STATE', 'Cannot pay', 409);
  }
  const wallet = await ensureWallet(String(payout.pilotId));
  if (payout.amountPaise > wallet.balancePaise) {
    throw new AppError('INSUFFICIENT_BALANCE', 'Pilot balance too low', 400);
  }
  wallet.balancePaise -= payout.amountPaise;
  await wallet.save();
  await appendLedger({
    type: 'payout',
    party: 'pilot',
    amountPaise: -payout.amountPaise,
    pilotId: String(payout.pilotId),
    payoutId: String(payout._id),
    idempotencyKey: `payout:${payout._id}`,
    balanceAfterPaise: wallet.balancePaise,
    note: 'Payout paid',
  });
  payout.status = 'paid';
  payout.adminNote = adminNote;
  payout.processedBy = actor;
  payout.processedAt = new Date();
  await payout.save();
  return serializePayout(payout);
}

export async function settleDues(actor: string, pilotId: string, amountPaise: number, note?: string) {
  const wallet = await ensureWallet(pilotId);
  const amt = Math.min(amountPaise, wallet.duesPaise);
  if (amt <= 0) throw new AppError('VALIDATION_ERROR', 'Nothing to settle', 400);
  wallet.duesPaise -= amt;
  await wallet.save();
  await appendLedger({
    type: 'dues_settlement',
    party: 'platform',
    amountPaise: amt,
    pilotId,
    idempotencyKey: `dues:${pilotId}:${Date.now()}`,
    duesAfterPaise: wallet.duesPaise,
    note: note ?? `Settled by ${actor}`,
    meta: { actor },
  });
  return getWallet(pilotId);
}

export async function getPilotReviews(pilotId: string, page: number, limit: number) {
  const filter = {
    pilotId: new Types.ObjectId(pilotId),
    pilotRating: { $gte: 1 },
    status: { $in: ['completed', 'paid'] as const },
  };
  const [items, total, agg] = await Promise.all([
    Ride.find(filter as never)
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select('pilotRating pilotRatingTags serviceType updatedAt pickup.name drop.name')
      .lean(),
    Ride.countDocuments(filter as never),
    Ride.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          avg: { $avg: '$pilotRating' },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  return {
    average: agg[0]?.avg ? Math.round(agg[0].avg * 10) / 10 : null,
    count: agg[0]?.count ?? 0,
    items: (items as Array<Record<string, unknown>>).map((r) => ({
      rideId: String(r._id),
      rating: r.pilotRating,
      tags: (r.pilotRatingTags as string[]) ?? [],
      serviceType: r.serviceType,
      at: r.updatedAt,
      pickup: (r.pickup as { name?: string } | undefined)?.name,
      drop: (r.drop as { name?: string } | undefined)?.name,
    })),
    page,
    limit,
    total,
  };
}

export async function refreshPilotRating(pilotId: string) {
  const agg = await Ride.aggregate([
    {
      $match: {
        pilotId: new Types.ObjectId(pilotId),
        pilotRating: { $gte: 1 },
      },
    },
    { $group: { _id: null, avg: { $avg: '$pilotRating' }, count: { $sum: 1 } } },
  ]);
  const ratingAvg = agg[0]?.avg ? Math.round(agg[0].avg * 100) / 100 : undefined;
  const ratingCount = agg[0]?.count ?? 0;
  await Pilot.updateOne({ _id: pilotId }, { $set: { ratingAvg, ratingCount } });
  return { ratingAvg, ratingCount };
}

export async function getQualityConfig() {
  const doc = await ConfigSingleton.findOne({ key: 'pilot_quality' }).lean();
  const v = (doc?.value ?? {}) as Record<string, unknown>;
  return {
    minRatingToGoOnline: (v.minRatingToGoOnline as number) ?? 3.0,
    maxCancelRate7d: (v.maxCancelRate7d as number) ?? 0.5,
    minTripsForCancelRate: (v.minTripsForCancelRate as number) ?? 5,
    autoSuspendEnabled: v.autoSuspendEnabled === true,
  };
}

export async function assertPilotCanGoOnline(pilotId: string) {
  const pilot = await Pilot.findById(pilotId).lean();
  if (!pilot) throw new AppError('NOT_FOUND', 'Pilot not found', 404);
  if (pilot.status === 'suspended') {
    throw new AppError('ACCOUNT_SUSPENDED', pilot.suspendReason ?? 'Account suspended', 403);
  }
  const cfg = await getQualityConfig();
  if (pilot.ratingCount && pilot.ratingCount >= 5 && pilot.ratingAvg != null) {
    if (pilot.ratingAvg < cfg.minRatingToGoOnline) {
      throw new AppError(
        'QUALITY_GATE',
        `Rating too low (${pilot.ratingAvg}). Minimum ${cfg.minRatingToGoOnline}`,
        403,
      );
    }
  }
  return true;
}

export async function computeCancelRate7d(pilotId: string) {
  const toYmd = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const fromD = new Date(`${toYmd}T12:00:00+05:30`);
  fromD.setDate(fromD.getDate() - 6);
  const fromYmd = fromD.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const { from, to } = istDayBounds(fromYmd, toYmd);
  const assigned = await Ride.countDocuments({
    pilotId,
    createdAt: { $gte: from, $lte: to },
    status: {
      $in: [
        'pilot_assigned',
        'pilot_arriving',
        'pilot_arrived',
        'in_progress',
        'completed',
        'paid',
        'cancelled_by_pilot',
        'cancelled_by_rider',
        'cancelled_by_system',
      ],
    },
  });
  const cancelledByPilot = await Ride.countDocuments({
    pilotId,
    status: 'cancelled_by_pilot',
    createdAt: { $gte: from, $lte: to },
  });
  const rate = assigned === 0 ? 0 : cancelledByPilot / assigned;
  return { assigned, cancelledByPilot, rate };
}

export async function listPilots(status: string | undefined, page: number, limit: number) {
  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;
  const [items, total] = await Promise.all([
    Pilot.find(filter as never)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select(
        'phone name vehicleType vehicleNumber kycStatus online status suspendReason ratingAvg ratingCount createdAt',
      )
      .lean(),
    Pilot.countDocuments(filter as never),
  ]);
  const ids = items.map((p) => p._id);
  const wallets = await PilotWallet.find({ pilotId: { $in: ids } }).lean();
  const walletByPilot = new Map(wallets.map((w) => [String(w.pilotId), w]));
  return {
    items: items.map((p) => {
      const w = walletByPilot.get(String(p._id));
      return {
        id: String(p._id),
        phone: p.phone,
        name: p.name,
        vehicleType: p.vehicleType,
        vehicleNumber: p.vehicleNumber,
        kycStatus: p.kycStatus,
        online: p.online,
        status: p.status,
        suspendReason: p.suspendReason,
        ratingAvg: p.ratingAvg,
        ratingCount: p.ratingCount ?? 0,
        duesPaise: w?.duesPaise ?? 0,
        balancePaise: w?.balancePaise ?? 0,
        lifetimeTrips: w?.lifetimeTrips ?? 0,
        createdAt: (p as { createdAt?: Date }).createdAt,
      };
    }),
    page,
    limit,
    total,
  };
}

export async function suspendPilot(actor: string, pilotId: string, reason: string) {
  await Pilot.updateOne(
    { _id: pilotId },
    {
      $set: {
        status: 'suspended',
        suspendReason: reason,
        suspendedAt: new Date(),
        online: false,
        idle: true,
      },
    },
  );
  const { markPilotOffline } = await import('../dispatch/index.js');
  markPilotOffline(pilotId);
  return { id: pilotId, status: 'suspended', reason, by: actor };
}

export async function unsuspendPilot(actor: string, pilotId: string) {
  await Pilot.updateOne(
    { _id: pilotId },
    { $set: { status: 'active' }, $unset: { suspendReason: 1, suspendedAt: 1 } },
  );
  return { id: pilotId, status: 'active', by: actor };
}

function serializePayout(p: { toObject: () => Record<string, unknown> }) {
  const o = p.toObject();
  return {
    id: String(o._id),
    pilotId: String(o.pilotId),
    amountPaise: o.amountPaise as number,
    status: o.status as string,
    method: o.method as string | undefined,
    upiId: o.upiId as string | undefined,
    note: o.note as string | undefined,
    adminNote: o.adminNote as string | undefined,
    processedAt: o.processedAt,
    createdAt: o.createdAt,
  };
}
