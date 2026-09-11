import pino from 'pino';
import { env } from './env.js';

/**
 * Application logger. MAIN.md §3.1 forbids raw `console.log` in production
 * paths, so every module imports this instead.
 *
 * Verbose levels are silenced in production. Secrets are redacted so an API key
 * can never reach a log sink.
 */
export const logger = pino({
  level: env.NODE_ENV === 'production' && env.LOG_LEVEL === 'debug' ? 'info' : env.LOG_LEVEL,
  base: { service: 'hiver-support-agent', env: env.NODE_ENV },
  redact: {
    paths: [
      'GROQ_API_KEY',
      'KAGGLE_KEY',
      'apiKey',
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'res.headers["set-cookie"]',
    ],
    censor: '[redacted]',
  },
});

/**
 * Create a child logger that tags every line with a pipeline/eval correlation id.
 *
 * @param {string} requestId - Correlation id for one request or eval run.
 * @returns {pino.Logger} Child logger.
 */
export function childLogger(requestId) {
  return logger.child({ requestId });
}
