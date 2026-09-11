import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { EvalResult } from '../models/EvalResult.model.js';
import { GoldenExample } from '../models/GoldenExample.model.js';
import { AppError } from '../utils/AppError.js';
import { assembleEvaluationMetrics } from '../utils/metrics.js';
import { loadFewShotExamples } from './classifier.service.js';
import { evaluateRow, judgeSampledRows } from './eval.row.js';
import { DEFAULT_GOLDEN_SET_PATH, parseGoldenSetCsv } from './goldenSet.loader.js';

/** @type {ReadonlyArray<string>} Variants the harness can compare. */
export const EVAL_VARIANTS = Object.freeze(['keyword', 'zero-shot', 'few-shot']);

/**
 * Run the full evaluation harness over the golden set (MAIN.md §5).
 *
 * One pass produces everything the report needs — variant classification, escalation
 * P/R, reply quality, judge scores — because the alternative (separate scripts per
 * metric) re-spends provider quota per metric and lets runs drift apart.
 *
 * Sequential on purpose: concurrency just converts free-tier 429s into failures.
 *
 * @param {object} [options] - Harness options.
 * @param {ReadonlyArray<'keyword'|'zero-shot'|'few-shot'>} [options.variants] - Variants to compare.
 * @param {number} [options.judgeSampleSize=env.EVAL_JUDGE_SAMPLE_SIZE] - Rows sent to the judge (0 disables).
 * @param {number} [options.limit] - Only evaluate the first N golden rows.
 * @param {boolean} [options.generateReplies=true] - Draft a reply per row.
 * @param {boolean} [options.useRetrieval=true] - Ground replies in retrieved threads.
 * @param {'mongo'|'csv'} [options.source='mongo'] - Read the golden set from MongoDB or straight from `eval/golden_set.csv`.
 * @param {string} [options.goldenSetPath] - CSV path when `source` is `csv`.
 * @param {boolean} [options.storeResult=true] - Persist the run in `eval_results` (ignored for `source: 'csv'`).
 * @param {(done: number, total: number) => void} [options.onProgress] - Progress reporter.
 * @param {string} [options.requestId] - Correlation id for logs.
 * @returns {Promise<{ runId: string, config: object, metrics: object, rows: Array<object>, judgeResults: Array<object> }>} Run id, metrics, per-row detail (drafts included) and judge scores.
 *   `rows`/`judgeResults` are returned raw so `export-judge-sample` can work from a
 *   completed artifact instead of re-spending quota.
 * @throws {AppError} 503 when the golden set is empty.
 */
export async function runEvaluation({
  variants = ['keyword', 'few-shot'],
  judgeSampleSize = env.EVAL_JUDGE_SAMPLE_SIZE,
  limit,
  generateReplies = true,
  useRetrieval = true,
  storeResult = true,
  source = 'mongo',
  goldenSetPath = DEFAULT_GOLDEN_SET_PATH,
  onProgress,
  requestId,
} = {}) {
  const runId = `eval-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const log = logger.child({ requestId: requestId ?? runId, runId });

  // The CSV source exists so the harness can be reproduced (and reviewed)
  // without a running MongoDB; it never writes results back to the database.
  const fromCsv = source === 'csv';
  const allRows = fromCsv ? parseGoldenSetCsv(goldenSetPath).rows : await GoldenExample.findAllSorted();
  const persist = storeResult && !fromCsv;

  if (allRows.length === 0) {
    throw new AppError(
      'The golden set is empty. Run "npm run build:golden" (or seed eval/golden_set.csv) before evaluating.',
      { statusCode: 503, code: 'GOLDEN_SET_EMPTY' },
    );
  }
  const rows = limit ? allRows.slice(0, limit) : allRows;
  const productionVariant = variants.includes('few-shot')
    ? 'few-shot'
    : variants.includes('zero-shot')
      ? 'zero-shot'
      : 'keyword';

  /** @type {Map<string, object>} Source rows by thread id, for the judge pass. */
  const rowByThreadId = new Map(rows.map((row) => [row.threadId, row]));

  const config = {
    model: env.GROQ_MODEL,
    goldenSetSize: rows.length,
    judgeSampleSize,
    variants: [...variants],
    source,
    seededThreads: !fromCsv,
  };

  if (persist) await EvalResult.startRun({ runId, config });

  const examples = variants.includes('few-shot') ? await loadFewShotExamples() : [];
  /** @type {string[]} */
  const errors = [];
  /** @type {Array<object>} */
  const rowResults = [];

  // A failed run must still be observable as `failed` in eval_results, or the
  // runs list shows a phantom `running` entry forever.
  try {
    for (const [index, row] of rows.entries()) {
      const result = await evaluateRow(row, {
        variants,
        examples,
        productionVariant,
        generateReplies,
        useRetrieval,
        runId,
        errors,
      });
      rowResults.push(result);
      onProgress?.(index + 1, rows.length);
    }
  } catch (error) {
    if (persist) await EvalResult.failRun(runId, error.message);
    throw error;
  }

  const judgeResults = await judgeSampledRows(rowResults, judgeSampleSize, { rowByThreadId, runId, onProgress });
  const metrics = assembleEvaluationMetrics({
    rowResults,
    variants,
    productionVariant,
    judgeResults,
  });
  const storedPayload = { ...metrics, runErrors: errors.slice(0, 25) };

  if (persist) await EvalResult.completeRun(runId, storedPayload);
  log.info({ runId, rows: rows.length, errors: errors.length }, 'evaluation complete');

  // `judgeResults` is returned (and persisted in the run artifact) so the judge
  // sample can be exported for human scoring without re-spending quota.
  return { runId, config, metrics, rows: rowResults, judgeResults };
}

/**
 * List stored evaluation runs.
 *
 * @param {number} [limit=25] - Maximum number of runs; metric payloads are excluded upstream,
 *   so this stays cheap even with multi-MB runs stored.
 * @returns {Promise<Array<object>>} Run summaries, newest first.
 */
export function listEvaluationRuns(limit = 25) {
  return EvalResult.listRecent(limit);
}

/**
 * Fetch one stored evaluation run.
 *
 * @param {string} runId - Run id as written in the run artifact's `runId` field.
 * @returns {Promise<object>} Stored run, metrics included.
 * @throws {AppError} 404 when the run does not exist — callers surface this to API clients.
 */
export async function getEvaluationRun(runId) {
  const run = await EvalResult.findByRunId(runId);
  if (!run) throw AppError.notFound(`No evaluation run found for id "${runId}".`);
  return run;
}

