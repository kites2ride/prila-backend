import type { FastifyInstance } from 'fastify';
import { ok } from '../../lib/envelope.js';
import { authenticateAdmin, authenticatePilot, authenticateRider } from '../../plugins/auth.js';
import {
  acceptSchema,
  bookSchema,
  cancelSchema,
  completeSchema,
  estimateSchema,
  locationSchema,
  pilotOnlineSchema,
  placesSuggestSchema,
  rateSchema,
  skipSchema,
  startSchema,
  pilotCancelSchema,
  resolvePaymentIssueSchema,
} from './schemas.js';
import * as rideService from './service.js';
import { pageSchema } from '../admin/schemas.js';

export async function rideRoutes(app: FastifyInstance) {
  app.get('/places/suggest', { preHandler: authenticateRider }, async (req, reply) => {
    const q = placesSuggestSchema.parse(req.query);
    // Server-side stub — swap for Google/Ola Places proxy later (key stays server-side).
    const items = [
      {
        id: 'stub-1',
        name: q.q,
        address: `${q.q}, Warangal`,
        lat: 17.9689,
        lng: 79.5941,
      },
      {
        id: 'stub-2',
        name: `${q.q} Cross Roads`,
        address: `${q.q} Cross Roads, Warangal`,
        lat: 17.975,
        lng: 79.6,
      },
    ];
    return reply.send(ok({ items }));
  });

  app.post('/rides/estimate', { preHandler: authenticateRider }, async (req, reply) => {
    const body = estimateSchema.parse(req.body);
    const data = await rideService.estimate(req.user.sub, body);
    return reply.send(ok(data));
  });

  app.post('/rides', { preHandler: authenticateRider }, async (req, reply) => {
    const body = bookSchema.parse(req.body);
    const data = await rideService.book(app, req.user.sub, body);
    return reply.send(ok(data));
  });

  app.get('/rides/active', { preHandler: authenticateRider }, async (req, reply) => {
    const list = await rideService.listRides(
      { riderId: req.user.sub, status: { $in: ['requested', 'searching', 'pilot_assigned', 'pilot_arriving', 'pilot_arrived', 'in_progress'] } },
      1,
      1,
    );
    const ride = list.items[0] ?? null;
    return reply.send(ok({ ride: ride ? { ...ride, pilot: await rideService.pilotCardFor(ride) } : null }));
  });

  app.get('/rides', { preHandler: authenticateRider }, async (req, reply) => {
    const q = pageSchema.parse(req.query);
    const data = await rideService.listRides({ riderId: req.user.sub }, q.page, q.limit);
    return reply.send(ok(data));
  });

  app.get('/rides/:id', { preHandler: authenticateRider }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const data = await rideService.riderRideView(id, req.user.sub);
    return reply.send(ok(data));
  });

  app.post('/rides/:id/cancel', { preHandler: authenticateRider }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = cancelSchema.parse(req.body);
    const data = await rideService.cancel(
      app,
      { id: req.user.sub, role: 'rider' },
      id,
      body.reasonCode,
      body.reasonText,
    );
    return reply.send(ok(data));
  });

  app.post('/rides/:id/rate', { preHandler: authenticateRider }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = rateSchema.parse(req.body);
    const data = await rideService.rate({ id: req.user.sub, role: 'rider' }, id, body.rating, body.tags);
    return reply.send(ok(data));
  });

  // Pilot
  app.post('/pilot/online', { preHandler: authenticatePilot }, async (req, reply) => {
    const body = pilotOnlineSchema.parse(req.body);
    const data = await rideService.setPilotOnline(req.user.sub, body.online, {
      lat: body.lat,
      lng: body.lng,
    });
    return reply.send(ok(data));
  });

  app.post('/pilot/location', { preHandler: authenticatePilot }, async (req, reply) => {
    const body = locationSchema.parse(req.body);
    const data = await rideService.updatePilotLocation(app, req.user.sub, body);
    return reply.send(ok(data));
  });

  app.get('/pilot/rides/offers', { preHandler: authenticatePilot }, async (req, reply) => {
    const data = await rideService.listPilotOffers(req.user.sub);
    return reply.send(ok(data));
  });

  app.get('/pilot/rides/active', { preHandler: authenticatePilot }, async (req, reply) => {
    const list = await rideService.listRides(
      {
        pilotId: req.user.sub,
        status: { $in: ['pilot_assigned', 'pilot_arriving', 'pilot_arrived', 'in_progress'] },
      },
      1,
      1,
    );
    return reply.send(ok({ ride: list.items[0] ?? null }));
  });

  app.get('/pilot/rides', { preHandler: authenticatePilot }, async (req, reply) => {
    const q = pageSchema.parse(req.query);
    const data = await rideService.listRides({ pilotId: req.user.sub }, q.page, q.limit);
    return reply.send(ok(data));
  });

  app.get('/pilot/rides/:id', { preHandler: authenticatePilot }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const data = await rideService.getRide(id, { id: req.user.sub, role: 'pilot' });
    return reply.send(ok(data));
  });

  app.post('/pilot/rides/:id/accept', { preHandler: authenticatePilot }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = acceptSchema.parse(req.body);
    const data = await rideService.accept(app, req.user.sub, id, body.idempotencyKey);
    return reply.send(ok(data));
  });

  app.post('/pilot/rides/:id/skip', { preHandler: authenticatePilot }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    skipSchema.parse(req.body ?? {});
    const data = await rideService.skip(app, req.user.sub, id);
    return reply.send(ok(data));
  });

  app.post('/pilot/rides/:id/arrived', { preHandler: authenticatePilot }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const data = await rideService.arrived(app, req.user.sub, id);
    return reply.send(ok(data));
  });

  app.post('/pilot/rides/:id/start', { preHandler: authenticatePilot }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = startSchema.parse(req.body);
    const data = await rideService.start(app, req.user.sub, id, body.otp, body.cashCollected);
    return reply.send(ok(data));
  });

  app.post('/pilot/rides/:id/complete', { preHandler: authenticatePilot }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = completeSchema.parse(req.body);
    const data = await rideService.complete(app, req.user.sub, id, body.collectedCash, body.notCollectedReason);
    return reply.send(ok(data));
  });

  /** Pilot cancels after accepting → the rider gets another pilot automatically. */
  app.post('/pilot/rides/:id/cancel', { preHandler: authenticatePilot }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = pilotCancelSchema.parse(req.body);
    const data = await rideService.pilotCancel(app, req.user.sub, id, body.reasonCode, body.reasonText);
    return reply.send(ok(data));
  });

  /** Parcel: the sender's number so the pilot can call (e.g. receiver refuses to pay). */
  app.get('/pilot/rides/:id/sender-contact', { preHandler: authenticatePilot }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    return reply.send(ok(await rideService.senderContact(req.user.sub, id)));
  });

  app.post('/pilot/rides/:id/rate', { preHandler: authenticatePilot }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = rateSchema.parse(req.body);
    const data = await rideService.rate({ id: req.user.sub, role: 'pilot' }, id, body.rating, body.tags);
    return reply.send(ok(data));
  });

  // Admin
  app.get('/admin/rides', { preHandler: authenticateAdmin }, async (req, reply) => {
    const q = pageSchema.parse(req.query);
    const status = (req.query as { status?: string }).status;
    const filter = status ? { status } : {};
    const data = await rideService.listRides(filter, q.page, q.limit);
    return reply.send(ok(data));
  });

  /** Cash not collected (e.g. parcel receiver refused) — ops follow up with the sender. */
  app.get('/admin/rides/payment-issues', { preHandler: authenticateAdmin }, async (req, reply) => {
    const q = pageSchema.parse(req.query);
    const open = (req.query as { state?: string }).state !== 'resolved';
    return reply.send(ok(await rideService.listPaymentIssues(open, q.page, q.limit)));
  });

  app.post('/admin/rides/:id/payment-issue/resolve', { preHandler: authenticateAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = resolvePaymentIssueSchema.parse(req.body);
    return reply.send(ok(await rideService.resolvePaymentIssue(req.user.sub, id, body.note)));
  });

  app.get('/admin/rides/:id', { preHandler: authenticateAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const data = await rideService.getRide(id, { id: req.user.sub, role: 'admin' });
    return reply.send(ok(data));
  });

  app.post('/admin/rides/:id/cancel', { preHandler: authenticateAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = cancelSchema.parse(req.body);
    const data = await rideService.cancel(
      app,
      { id: req.user.sub, role: 'admin' },
      id,
      body.reasonCode,
      body.reasonText,
    );
    return reply.send(ok(data));
  });
}
