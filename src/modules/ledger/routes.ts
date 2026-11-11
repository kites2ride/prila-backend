import type { FastifyInstance } from 'fastify';
import { ok } from '../../lib/envelope.js';
import { authenticateAdmin, authenticatePilot } from '../../plugins/auth.js';
import {
  duesSettleSchema,
  earningsQuerySchema,
  pageSchema,
  payoutProcessSchema,
  payoutRequestSchema,
  suspendSchema,
} from './schemas.js';
import * as ledger from './service.js';

export async function ledgerRoutes(app: FastifyInstance) {
  // —— Pilot ——
  app.get('/pilot/wallet', { preHandler: authenticatePilot }, async (req, reply) => {
    const data = await ledger.getWallet(req.user.sub);
    return reply.send(ok(data));
  });

  app.get('/pilot/earnings', { preHandler: authenticatePilot }, async (req, reply) => {
    const q = earningsQuerySchema.parse(req.query);
    const data = await ledger.getEarnings(req.user.sub, q.range);
    return reply.send(ok(data));
  });

  app.get('/pilot/ledger', { preHandler: authenticatePilot }, async (req, reply) => {
    const q = pageSchema.parse(req.query);
    const data = await ledger.getLedgerPage(req.user.sub, q.page, q.limit);
    return reply.send(ok(data));
  });

  app.get('/pilot/reviews', { preHandler: authenticatePilot }, async (req, reply) => {
    const q = pageSchema.parse(req.query);
    const data = await ledger.getPilotReviews(req.user.sub, q.page, q.limit);
    return reply.send(ok(data));
  });

  app.get('/pilot/payouts', { preHandler: authenticatePilot }, async (req, reply) => {
    const q = pageSchema.parse(req.query);
    const data = await ledger.listPilotPayouts(req.user.sub, q.page, q.limit);
    return reply.send(ok(data));
  });

  app.post('/pilot/payouts', { preHandler: authenticatePilot }, async (req, reply) => {
    const body = payoutRequestSchema.parse(req.body);
    const data = await ledger.requestPayout(req.user.sub, body.amountPaise, body.method, body.upiId);
    return reply.send(ok(data));
  });

  app.get('/pilot/quality', { preHandler: authenticatePilot }, async (req, reply) => {
    const cancel = await ledger.computeCancelRate7d(req.user.sub);
    const cfg = await ledger.getQualityConfig();
    return reply.send(ok({ ...cancel, config: cfg }));
  });

  // —— Admin ——
  app.get('/admin/pilots', { preHandler: authenticateAdmin }, async (req, reply) => {
    const q = pageSchema.parse(req.query);
    const status = (req.query as { status?: string }).status;
    const data = await ledger.listPilots(status, q.page, q.limit);
    return reply.send(ok(data));
  });

  app.get('/admin/payouts', { preHandler: authenticateAdmin }, async (req, reply) => {
    const q = pageSchema.parse(req.query);
    const status = (req.query as { status?: string }).status;
    const data = await ledger.listAdminPayouts(status, q.page, q.limit);
    return reply.send(ok(data));
  });

  app.post('/admin/payouts/:id/process', { preHandler: authenticateAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = payoutProcessSchema.parse(req.body);
    const data = await ledger.processPayout(req.user.sub, id, body.action, body.adminNote);
    return reply.send(ok(data));
  });

  app.get('/admin/pilots/:id/wallet', { preHandler: authenticateAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const data = await ledger.getWallet(id);
    return reply.send(ok(data));
  });

  app.post('/admin/pilots/:id/dues/settle', { preHandler: authenticateAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = duesSettleSchema.parse(req.body);
    const data = await ledger.settleDues(req.user.sub, id, body.amountPaise, body.note);
    return reply.send(ok(data));
  });

  app.post('/admin/pilots/:id/suspend', { preHandler: authenticateAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = suspendSchema.parse(req.body);
    const data = await ledger.suspendPilot(req.user.sub, id, body.reason);
    return reply.send(ok(data));
  });

  app.post('/admin/pilots/:id/unsuspend', { preHandler: authenticateAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const data = await ledger.unsuspendPilot(req.user.sub, id);
    return reply.send(ok(data));
  });

  app.get('/admin/pilots/:id/reviews', { preHandler: authenticateAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const q = pageSchema.parse(req.query);
    const data = await ledger.getPilotReviews(id, q.page, q.limit);
    return reply.send(ok(data));
  });
}
