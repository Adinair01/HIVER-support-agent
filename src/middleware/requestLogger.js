import { randomUUID } from 'node:crypto';
import pinoHttp from 'pino-http';
import { logger } from '../config/logger.js';

/**
 * Structured request logging (MAIN.md §3.1: no raw `console.log`).
 *
 * Each request gets a correlation id that is echoed in the `x-request-id`
 * response header, so a pipeline run in the logs can be matched to a stored
 * `pipeline_runs` document.
 */
export const requestLogger = pinoHttp({
  logger,
  quietReqLogger: true,
  genReqId: (req, res) => {
    const header = req.headers['x-request-id'];
    const requestId = typeof header === 'string' && header.trim() ? header.trim() : randomUUID();
    res.setHeader('x-request-id', requestId);
    return requestId;
  },
  autoLogging: {
    ignore: (req) => req.url === '/health',
  },
  customLogLevel: (req, res, error) => {
    if (error || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  serializers: {
    req: (req) => ({ id: req.id, method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
});
