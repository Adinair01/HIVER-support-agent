import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { env } from './config/env.js';
import { isDatabaseConnected } from './config/db.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/requestLogger.js';
import { requireDatabase } from './middleware/requireDatabase.js';
import { apiRouter } from './routes/index.js';

/**
 * Build the Express application. MAIN.md §3.1: app setup only — no business
 * logic, no DB calls, no port binding.
 *
 * @returns {import('express').Express} Configured app.
 */
export function createApp() {
  const app = express();

  // Security headers.
  app.use(helmet());

  // Structured request logging with a correlation id.
  app.use(requestLogger);

  // Small body limit: this API takes support messages, not uploads.
  app.use(express.json({ limit: '10kb' }));

  // Global limiter for every external-facing route.
  app.use(
    '/api',
    rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      limit: env.RATE_LIMIT_MAX,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: {
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests. Please slow down and retry shortly.',
          details: null,
        },
      },
    }),
  );

  // Liveness/readiness probe.
  app.get('/health', (req, res) => {
    res.status(200).json({
      data: {
        status: 'ok',
        env: env.NODE_ENV,
        database: isDatabaseConnected() ? 'connected' : 'disconnected',
        model: env.GROQ_MODEL,
        uptimeSeconds: Math.round(process.uptime()),
      },
    });
  });

  // Every API route reads or writes MongoDB, so fail fast when it is down.
  app.use('/api', requireDatabase, apiRouter);

  // Terminal handlers — order matters.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/** @type {import('express').Express} Shared app instance for the server and tests. */
export const app = createApp();
