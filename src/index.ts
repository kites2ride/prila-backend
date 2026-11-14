import { loadEnv } from './config/env.js';
import { connectDb } from './lib/db.js';
import { buildApp } from './app.js';
import { attachSocket } from './modules/socket/index.js';
import { startDispatch } from './modules/dispatch/index.js';
import { startNudgeCron } from './modules/nudges/service.js';

async function main() {
  const e = loadEnv();
  await connectDb();
  const app = await buildApp();
  await app.ready();
  attachSocket(app);
  await startDispatch(app);
  startNudgeCron(app.log);
  await app.listen({ port: e.PORT, host: e.HOST });
  app.log.info(`Prila API listening on ${e.HOST}:${e.PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
