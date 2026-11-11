import type { FastifyBaseLogger } from 'fastify';
import cron from 'node-cron';
import { Pilot, Rider } from '../auth/model.js';
import { pushToUser } from '../push/devices.js';
import { createInboxNotification } from '../push/inbox.js';
import { NudgeRule } from './model.js';

let started = false;

export async function listNudges() {
  const items = await NudgeRule.find().sort({ createdAt: -1 }).lean();
  return {
    items: items.map((n) => ({
      id: String(n._id),
      code: n.code,
      title: n.title,
      body: n.body,
      audience: n.audience,
      trigger: n.trigger,
      threshold: n.threshold,
      enabled: n.enabled,
      deepLink: n.deepLink,
      lastRunAt: n.lastRunAt,
    })),
  };
}

export async function setNudgeEnabled(id: string, enabled: boolean) {
  const doc = await NudgeRule.findByIdAndUpdate(id, { $set: { enabled } }, { new: true });
  return doc
    ? { id: String(doc._id), enabled: doc.enabled }
    : null;
}

export function startNudgeCron(log: FastifyBaseLogger) {
  if (started) return;
  started = true;
  // every 15 minutes
  cron.schedule('*/15 * * * *', () => {
    void runNudges(log).catch((err) => log.warn({ err }, 'nudge cron failed'));
  });
  log.info('Nudge cron scheduled');
}

async function runNudges(log: FastifyBaseLogger) {
  const rules = await NudgeRule.find({ enabled: true, trigger: { $ne: 'manual' } }).lean();
  for (const rule of rules) {
    if (rule.trigger === 'idle_pilot_online') {
      const since = new Date(Date.now() - (rule.threshold ?? 30) * 60_000);
      const pilots = await Pilot.find({
        online: true,
        idle: true,
        status: 'active',
        updatedAt: { $lte: since },
      })
        .limit(50)
        .select('_id')
        .lean();
      for (const p of pilots) {
        const id = String(p._id);
        await pushToUser('pilot', id, rule.title, rule.body, rule.deepLink ? { deepLink: rule.deepLink } : undefined);
        await createInboxNotification({
          userId: id,
          typ: 'pilot',
          title: rule.title,
          body: rule.body,
          data: rule.deepLink ? { deepLink: rule.deepLink } : undefined,
        });
      }
      log.info({ code: rule.code, count: pilots.length }, 'idle pilot nudge');
    }
    if (rule.trigger === 'rider_inactive_days') {
      const since = new Date(Date.now() - (rule.threshold ?? 7) * 86_400_000);
      const riders = await Rider.find({
        status: 'active',
        updatedAt: { $lte: since },
      })
        .limit(50)
        .select('_id')
        .lean();
      for (const r of riders) {
        const id = String(r._id);
        await pushToUser('rider', id, rule.title, rule.body, rule.deepLink ? { deepLink: rule.deepLink } : undefined);
        await createInboxNotification({
          userId: id,
          typ: 'rider',
          title: rule.title,
          body: rule.body,
          data: rule.deepLink ? { deepLink: rule.deepLink } : undefined,
        });
      }
    }
    await NudgeRule.updateOne({ _id: rule._id }, { $set: { lastRunAt: new Date() } });
  }
}
