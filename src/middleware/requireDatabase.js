import { isDatabaseConnected } from '../config/db.js';
import { AppError } from '../utils/AppError.js';

/**
 * Reject API requests early when MongoDB is not connected.
 *
 * Without this, a mongoose query on a disconnected connection buffers for 10
 * seconds and then surfaces as a generic 500 — a slow, misleading response for
 * what is really a dependency outage. This turns it into an immediate, honest 503.
 *
 * @param {import('express').Request} _req - Unused request.
 * @param {import('express').Response} _res - Unused response.
 * @param {import('express').NextFunction} next - Next handler.
 * @returns {void}
 */
export function requireDatabase(_req, _res, next) {
  if (isDatabaseConnected()) {
    next();
    return;
  }
  next(
    AppError.unavailable(
      'The database is not connected, so this endpoint cannot be served. ' +
        'Start MongoDB (or fix MONGODB_URI) and retry.',
    ),
  );
}
