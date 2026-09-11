import { app } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';

/**
 * Store entrypoint. MAIN.md §3.1: port binding only — all logic lives in
 * services, and the DB is connected before the first request is served.
 */
async function startServer() {
  await connectDatabase();

  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, model: env.GROQ_MODEL },
      'server listening',
    );
  });

  /**
   * Stop accepting connections, drain, then exit. Registered for both SIGINT
   * (Ctrl-C) and SIGTERM (container stop).
   *
   * @param {string} signal - Received signal name.
   * @returns {Promise<void>} Resolves once shutdown completes.
   */
  async function shutdown(signal) {
    logger.info({ signal }, 'shutting down');
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
    // Do not hang forever on a stuck keep-alive connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      shutdown(signal).catch((error) => {
        logger.error({ err: error.message }, 'shutdown failed');
        process.exit(1);
      });
    });
  }

  return server;
}

startServer().catch((error) => {
  logger.error({ err: error.message }, 'failed to start server');
  process.exit(1);
});
