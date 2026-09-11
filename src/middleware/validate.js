import { AppError } from '../utils/AppError.js';

/**
 * Convert a zod error into the project's error shape (MAIN.md §3.4).
 *
 * @param {import('zod').ZodError} error - Zod validation error.
 * @returns {AppError} 400 error with per-field details.
 */
function toValidationError(error) {
  const details = error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
  return AppError.badRequest('Request validation failed.', details);
}

/**
 * Validate and replace request data with the parsed, coerced result.
 *
 * Parsed `params`/`query` land on `req.validatedParams` / `req.validatedQuery`
 * because Express 5 exposes `req.query` as a getter.
 *
 * @param {object} schemas - Schemas to apply.
 * @param {import('zod').ZodTypeAny} [schemas.body] - Body schema.
 * @param {import('zod').ZodTypeAny} [schemas.params] - Path-param schema.
 * @param {import('zod').ZodTypeAny} [schemas.query] - Query-string schema.
 * @returns {import('express').RequestHandler} Middleware.
 */
export function validate({ body, params, query } = {}) {
  return function validateRequest(req, res, next) {
    try {
      if (body) req.body = body.parse(req.body ?? {});
      if (params) req.validatedParams = params.parse(req.params ?? {});
      if (query) req.validatedQuery = query.parse(req.query ?? {});
      return next();
    } catch (error) {
      return next(error?.issues ? toValidationError(error) : error);
    }
  };
}

/**
 * Validate only the request body.
 *
 * @param {import('zod').ZodTypeAny} schema - Body schema.
 * @returns {import('express').RequestHandler} Middleware.
 */
export function validateBody(schema) {
  return validate({ body: schema });
}

/**
 * Validate only the path params.
 *
 * @param {import('zod').ZodTypeAny} schema - Params schema.
 * @returns {import('express').RequestHandler} Middleware.
 */
export function validateParams(schema) {
  return validate({ params: schema });
}

/**
 * Validate only the query string.
 *
 * @param {import('zod').ZodTypeAny} schema - Query schema.
 * @returns {import('express').RequestHandler} Middleware.
 */
export function validateQuery(schema) {
  return validate({ query: schema });
}
