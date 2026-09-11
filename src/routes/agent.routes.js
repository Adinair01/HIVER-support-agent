import { Router } from 'express';
import { classifyMessage, getThread, processMessage } from '../controllers/agent.controller.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import {
  classifyBodySchema,
  processBodySchema,
  threadParamsSchema,
} from '../validators/agent.validator.js';

/**
 * Agent routes. MAIN.md §3.1: zero logic here — validate the input shape, then
 * delegate to the controller.
 */
export const agentRouter = Router();

agentRouter.post('/process', validateBody(processBodySchema), processMessage);
agentRouter.post('/classify', validateBody(classifyBodySchema), classifyMessage);
agentRouter.get('/thread/:id', validateParams(threadParamsSchema), getThread);
