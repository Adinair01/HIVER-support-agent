import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from './logger.js';

/** @type {Promise<typeof mongoose> | null} Cached connection promise for reuse. */
let connectionPromise = null;

/**
 * Connect to MongoDB exactly once and reuse the connection.
 *
 * @param {string} [uri=env.MONGODB_URI] - Connection string (injectable for tests).
 * @returns {Promise<typeof mongoose>} Resolved mongoose instance.
 * @throws {Error} If the server is unreachable within the selection timeout.
 */
export async function connectDatabase(uri = env.MONGODB_URI) {
  if (connectionPromise) return connectionPromise;

  mongoose.set('strictQuery', true);

  // NOTE: `sanitizeFilter` is deliberately NOT enabled.
  //
  // It was enabled in session 1 as an anti-injection guard, and it broke retrieval
  // in two ways that only a live database run could reveal:
  //   1. `$text` queries are rejected outright ("$text is not allowed with
  //      sanitizeFilter"), and the per-query override does not bypass the check,
  //      so RAG search could never run;
  //   2. a legitimate `{ field: { $ne: value } }` filter is wrapped into
  //      `{ $eq: { $ne: value } }` and then fails to cast, so the retrieval
  //      self-match guard threw a CastError as well.
  //
  // Injection safety is provided instead by never letting caller input become a
  // query object: every filter here is built from typed schema fields, request
  // bodies are parsed by zod schemas (`src/validators/`), and free text destined
  // for `$text` is tokenised by `buildTextSearchQuery()` before use.

  connectionPromise = mongoose
    .connect(uri, {
      serverSelectionTimeoutMS: 10_000,
      maxPoolSize: 10,
    })
    .then((instance) => {
      logger.info(
        { db: instance.connection.name, host: instance.connection.host },
        'mongo connected',
      );
      return instance;
    })
    .catch((error) => {
      connectionPromise = null;
      throw new Error(
        `Could not connect to MongoDB at ${describeTarget(uri)}: ${error.message}. ` +
          'Is mongod running, or is MONGODB_URI in .env correct?',
      );
    });

  return connectionPromise;
}

/**
 * Close the connection. Used by scripts and graceful shutdown.
 *
 * @returns {Promise<void>} Resolves once disconnected.
 */
export async function disconnectDatabase() {
  if (!connectionPromise) return;
  await mongoose.disconnect();
  connectionPromise = null;
  logger.info('mongo disconnected');
}

/**
 * Report whether the connection is currently healthy.
 *
 * @returns {boolean} `true` when readyState is `connected`.
 */
export function isDatabaseConnected() {
  return mongoose.connection.readyState === 1;
}

/**
 * Redact credentials before a URI is placed in an error message or log line.
 *
 * @param {string} uri - Raw connection string.
 * @returns {string} Host-only description.
 */
function describeTarget(uri) {
  return uri.replace(/\/\/[^@]*@/, '//<credentials>@');
}
