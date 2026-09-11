/**
 * Every error that reaches the client is one of these. `code` is a stable,
 * machine-readable string; `message` is safe to show a user.
 *
 * MAIN.md §3.4: the error handler always emits `{ error: { code, message, details } }`.
 */
export class AppError extends Error {
  /**
   * @param {string} message - Human-readable, client-safe message.
   * @param {object} [options] - Error options.
   * @param {number} [options.statusCode=500] - HTTP status to emit.
   * @param {string} [options.code='INTERNAL_ERROR'] - Stable error code.
   * @param {unknown} [options.details] - Extra structured context.
   * @param {Error} [options.cause] - Wrapped lower-level error.
   */
  constructor(message, { statusCode = 500, code = 'INTERNAL_ERROR', details, cause } = {}) {
    super(message, { cause });
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    /** Always true for AppError — the handler uses this to decide 4xx vs 5xx. */
    this.isOperational = true;
    Error.captureStackTrace?.(this, this.constructor);
  }

  /**
   * 400 — caller sent something structurally invalid.
   * @param {string} message - Client-safe message.
   * @param {unknown} [details] - Validation detail payload.
   * @returns {AppError} New error.
   */
  static badRequest(message, details) {
    return new AppError(message, { statusCode: 400, code: 'BAD_REQUEST', details });
  }

  /**
   * 404 — resource does not exist.
   * @param {string} message - Client-safe message.
   * @returns {AppError} New error.
   */
  static notFound(message) {
    return new AppError(message, { statusCode: 404, code: 'NOT_FOUND' });
  }

  /**
   * 502 — an upstream dependency (the model provider) failed.
   * MAIN.md §3.4: never expose the raw upstream error.
   * @param {string} message - Client-safe message.
   * @param {Error} [cause] - Raw upstream error, logged but not returned.
   * @returns {AppError} New error.
   */
  static badGateway(message, cause) {
    return new AppError(message, { statusCode: 502, code: 'UPSTREAM_ERROR', cause });
  }

  /**
   * 503 — a required dependency is not configured or not reachable.
   * @param {string} message - Client-safe message.
   * @returns {AppError} New error.
   */
  static unavailable(message) {
    return new AppError(message, { statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
  }

  /**
   * 500 — a bug. The handler replaces the message in production.
   * @param {string} message - Developer-facing message.
   * @returns {AppError} New error.
   */
  static internal(message) {
    return new AppError(message, { statusCode: 500, code: 'INTERNAL_ERROR' });
  }
}

/**
 * Type guard for errors thrown by this module.
 *
 * @param {unknown} error - Value to inspect.
 * @returns {boolean} `true` if the value is an AppError.
 */
export function isAppError(error) {
  return error instanceof AppError;
}
