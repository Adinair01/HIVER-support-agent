import { Router } from 'express';
import { agentRouter } from './agent.routes.js';
import { evalRouter } from './eval.routes.js';

/** @type {Router} Aggregate router mounted at `/api`. */
export const apiRouter = Router();

apiRouter.use('/agent', agentRouter);
apiRouter.use('/eval', evalRouter);
