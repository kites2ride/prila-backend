import { readFileSync, existsSync } from 'node:fs';
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../../config/env.js';

type Messaging = {
  send: (msg: unknown) => Promise<string>;
};

let messaging: Messaging | null = null;
let initAttempted = false;

export function initFcm(log: FastifyBaseLogger): void {
  if (initAttempted) return;
  initAttempted = true;
  const path = env().FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!path || !existsSync(path)) {
    log.warn('FCM disabled — FIREBASE_SERVICE_ACCOUNT_PATH missing');
    return;
  }
  void (async () => {
    try {
      // firebase-admin CJS interop — keep loosely typed
      const mod = (await import('firebase-admin')) as unknown as {
        default?: FirebaseAdminLike;
        apps?: unknown[];
        initializeApp?: FirebaseAdminLike['initializeApp'];
        credential?: FirebaseAdminLike['credential'];
        messaging?: FirebaseAdminLike['messaging'];
      };
      const admin: FirebaseAdminLike = mod.default ?? (mod as FirebaseAdminLike);
      const json = JSON.parse(readFileSync(path, 'utf8')) as object;
      if (!admin.apps?.length) {
        admin.initializeApp?.({ credential: admin.credential?.cert(json) });
      }
      messaging = admin.messaging?.() ?? null;
      log.info('FCM initialized');
    } catch (err) {
      log.warn({ err }, 'FCM init failed — continuing with no-op');
      messaging = null;
    }
  })();
}

type FirebaseAdminLike = {
  apps?: unknown[];
  initializeApp?: (opts: { credential: unknown }) => unknown;
  credential?: { cert: (json: object) => unknown };
  messaging?: () => Messaging;
};

export async function sendPush(input: {
  token?: string;
  topic?: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  silent?: boolean;
}): Promise<{ ok: boolean; id?: string; reason?: string }> {
  if (!messaging) return { ok: false, reason: 'fcm_disabled' };
  const message: Record<string, unknown> = {
    data: input.data,
  };
  if (!input.silent) {
    message.notification = { title: input.title, body: input.body };
  }
  if (input.token) message.token = input.token;
  if (input.topic) message.topic = input.topic;
  const id = await messaging.send(message);
  return { ok: true, id };
}
