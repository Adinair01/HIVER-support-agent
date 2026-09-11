import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { getRun, listRuns, startEvaluation } from '../controllers/eval.controller.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import {
  listResultsQuerySchema,
  runEvalBodySchema,
  runIdParamsSchema,
} from '../validators/eval.validator.js';

/**
 * Evaluation routes. A run costs many LLM calls, so this router gets its own,
 * much stricter limiter than the global one (MAIN.md §3.3).
 */
export const evalRouter = Router();

export const evalRunLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Evaluation runs are limited to 5 per minute.',
      details: null,
    },
  },
});

evalRouter.post('/run', evalRunLimiter, validateBody(runEvalBodySchema), startEvaluation);
evalRouter.get('/results', validateQuery(listResultsQuerySchema), listRuns);
evalRouter.get('/results/:runId', validateParams(runIdParamsSchema), getRun);
