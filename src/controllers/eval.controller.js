import { getEvaluationRun, listEvaluationRuns, runEvaluation } from '../services/eval.service.js';
import { catchAsync } from '../utils/catchAsync.js';

/**
 * `POST /api/eval/run` — run the harness over the golden set (MAIN.md §6).
 *
 * @param {import('express').Request} req - Validated request.
 * @param {import('express').Response} res - Response.
 * @returns {Promise<void>} Resolves once the response is sent.
 */
export const startEvaluation = catchAsync(async (req, res) => {
  const { variants, judgeSampleSize, limit, generateReplies, storeResult } = req.body;

  const { runId, config, metrics } = await runEvaluation({
    variants,
    judgeSampleSize,
    limit,
    generateReplies,
    storeResult,
    requestId: req.id,
  });

  res.status(201).json({ data: { runId, config, metrics } });
});

/**
 * `GET /api/eval/results` — list stored runs.
 *
 * @param {import('express').Request} req - Request with validated query.
 * @param {import('express').Response} res - Response.
 * @returns {Promise<void>} Resolves once the response is sent.
 */
export const listRuns = catchAsync(async (req, res) => {
  const runs = await listEvaluationRuns(req.validatedQuery.limit);
  res.status(200).json({ data: runs, count: runs.length });
});

/**
 * `GET /api/eval/results/:runId` — full metrics for one run.
 *
 * @param {import('express').Request} req - Request with validated params.
 * @param {import('express').Response} res - Response.
 * @returns {Promise<void>} Resolves once the response is sent.
 */
export const getRun = catchAsync(async (req, res) => {
  const run = await getEvaluationRun(req.validatedParams.runId);
  res.status(200).json({ data: run });
});
