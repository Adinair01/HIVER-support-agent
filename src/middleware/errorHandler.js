import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../utils/AppError.js';

/**
 * 404 handler for unmatched routes.
 *
 * @param {import('express').Request} req - Request.
 * @param {import('express').Response} _res - Unused response.
 * @param {import('express').NextFunction} next - Next handler.
 * @returns {void}
 */
export function notFoundHandler(req, _res, next) {
  next(AppError.notFound(`Route ${req.method} ${req.originalUrl} does not exist.`));
}

/**
 * Translate any thrown value into `{ error: { code, message, details } }`
 * (MAIN.md §3.4).
 *
 * @param {unknown} error - Thrown value.
 * @param {import('express').Request} req - Request.
 * @param {import('express').Response} res - Response.
 * @param {import('express').NextFunction} _next - Unused next handler.
 * @returns {void}
 */
export function errorHandler(error, req, res, _next) {
  const normalised = normaliseError(error);
  const log = req.log ?? logger;

  if (normalised.statusCode >= 500) {
    log.error(
      { err: error instanceof Error ? error.message : String(error), stack: error?.stack, code: normalised.code },
      'request failed',
    );
  } else {
    log.warn({ code: normalised.code, details: normalised.details }, 'request rejected');
  }

  res.status(normalised.statusCode).json({
    error: {
      code: normalised.code,
      message: normalised.message,
      details: normalised.details ?? null,
    },
  });
}

/**
 * Map framework errors (mongoose, body-parser, zod) onto the project shape.
 *
 * @param {unknown} error - Thrown value.
 * @returns {{ statusCode: number, code: string, message: string, details: unknown }} Normalised error.
 */
function normaliseError(error) {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  if (error?.type === 'entity.parse.failed') {
    return { statusCode: 400, code: 'INVALID_JSON', message: 'Request body is not valid JSON.', details: null };
  }

  if (error?.name === 'ValidationError') {
    return {
      statusCode: 400,
      code: 'DB_VALIDATION_ERROR',
      message: 'The supplied data failed validation.',
      details: Object.values(error.errors ?? {}).map((issue) => issue.message),
    };
  }

  if (error?.name === 'CastError') {
    return { statusCode: 400, code: 'INVALID_ID', message: `Malformed value for "${error.path}".`, details: null };
  }

  if (error?.name === 'MongooseServerSelectionError' || error?.name === 'MongoNetworkError') {
    return {
      statusCode: 503,
      code: 'DATABASE_UNAVAILABLE',
      message: 'The database is unavailable. Please retry shortly.',
      details: null,
    };
  }

  // Mongoose buffers queries while disconnected; once the buffer times out the
  // error is a plain MongooseError, which would otherwise be reported as a 500.
  if (error?.name === 'MongooseError' && /buffering timed out|not connected/i.test(error.message ?? '')) {
    return {
      statusCode: 503,
      code: 'DATABASE_UNAVAILABLE',
      message: 'The database is not connected, so this request could not be served.',
      details: null,
    };
  }

  return {
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    // Never leak internal messages (or API errors) to the client in production.
    message: env.isProduction
      ? 'Something went wrong while processing the request.'
      : `Unexpected error: ${error?.message ?? String(error)}`,
    details: null,
  };
}
