import {
  keywordCoverage,
  lengthAppropriateness,
  rougeL,
} from '../utils/metrics.js';
import { selectStridedSample } from '../utils/sampling.js';
import { classifyIntent } from './classifier.service.js';
import { isProviderConfigured } from './llm.client.js';
import { decideEscalation } from './escalation.service.js';
import { scoreDraftsWithRubric } from './judge.service.js';
import { draftGroundedReply } from './responder.service.js';
import { retrieveSimilarThreads } from './retrieval.service.js';

/**
 * Per-row half of the harness, split from `eval.service.js` (MAIN.md §3.1):
 * run-level code owns batching and metrics, this owns everything that can fail
 * for one row without taking the run down with it.
 */

/**
 * Evaluate a single golden row: every variant classifies it, but only the
 * production variant gets retrieval/drafting — baselines never spend responder
 * quota, so variant comparison stays a pure classification comparison.
 *
 * @param {object} row - Golden example with `threadId`, `customerMessage`, `trueIntent`,
 *   `expectedEscalation`, `idealReplyKeywords`, `notes`.
 * @param {object} context - Shared run context.
 * @param {ReadonlyArray<string>} context.variants - Classifier variants to compare.
 * @param {Array<{ customerMessage: string, trueIntent: string }>} context.examples - Few-shot examples.
 * @param {string} context.productionVariant - The variant whose reply gets drafted.
 * @param {boolean} context.generateReplies - `false` (e.g. `--no-replies`) skips drafting, leaving `reply: null`.
 * @param {boolean} context.useRetrieval - When `false`, drafting runs with no RAG evidence.
 * @param {string} context.runId - Correlation id for logs.
 * @param {string[]} context.errors - Mutated in place: per-variant failures accumulate here
 *   instead of throwing, so one dead variant cannot abort a 45-row run.
 * @returns {Promise<{ threadId: string, expectedIntent: string, expectedEscalation: boolean, notes: string, predictions: Record<string, { intent: string|null, confidence: number, degraded: boolean, error: string|null }>, escalation: object, reply: object|null }>} Row result; `reply` is `null` when `generateReplies` is off.
 */
export async function evaluateRow(row, { variants, examples, productionVariant, generateReplies, useRetrieval, runId, errors }) {
  /** @type {Record<string, object>} */
  const predictions = {};

  for (const variant of variants) {
    try {
      const classification = await classifyIntent(row.customerMessage, { variant, examples, requestId: runId });
      predictions[variant] = {
        intent: classification.intent,
        confidence: classification.confidence,
        degraded: Boolean(classification.degraded),
        error: null,
      };
    } catch (error) {
      predictions[variant] = { intent: null, confidence: 0, degraded: false, error: error.message };
      errors.push(`${row.threadId}:${variant}: ${error.message}`);
    }
  }

  const chosen = predictions[productionVariant] ?? { intent: null, confidence: 0 };

  const escalation = await decideEscalation({
    message: row.customerMessage,
    intent: chosen.intent ?? 'GENERAL_INQUIRY',
    classifierConfidence: chosen.confidence,
    skipLlmReview: !isProviderConfigured(),
    requestId: runId,
  });

  const reply = generateReplies
    ? await buildReplyMetrics(row, chosen, { useRetrieval, runId })
    : null;

  return {
    threadId: row.threadId,
    expectedIntent: row.trueIntent,
    expectedEscalation: row.expectedEscalation,
    notes: row.notes,
    predictions,
    escalation: {
      decision: escalation.decision,
      reason: escalation.reason,
      triggeredBy: escalation.triggeredBy,
      expected: row.expectedEscalation,
      predicted: escalation.decision === 'escalate',
    },
    reply,
  };
}

/**
 * Draft one reply and derive its automated quality signals.
 *
 * Keyword coverage and ROUGE-L are measured against the golden row's
 * `ideal_reply_keywords`, so a row with an empty keyword column silently scores
 * 0 — only feed this rows that were fully labelled.
 *
 * @param {object} row - Golden example (needs `customerMessage`, `threadId`, `idealReplyKeywords`).
 * @param {{ intent: string|null, confidence: number }} chosen - Production classification; a failed
 *   classification degrades to `GENERAL_INQUIRY` rather than skipping the row.
 * @param {{ useRetrieval: boolean, runId: string }} options - `useRetrieval` `false` drafts intent-only.
 * @returns {Promise<{ draft: string, degraded: boolean, sourcedFrom: string[], rougeL: number, coverage: number, missing: string[], appropriate: boolean, wordCount: number }>} Reply plus signals.
 */
async function buildReplyMetrics(row, chosen, { useRetrieval, runId }) {
  const retrieval = useRetrieval
    ? await retrieveSimilarThreads(row.customerMessage, { excludeThreadId: row.threadId, requestId: runId })
    : { results: [] };

  const drafted = await draftGroundedReply({
    intent: chosen.intent ?? 'GENERAL_INQUIRY',
    customerMessage: row.customerMessage,
    retrievedThreads: retrieval.results,
    requestId: runId,
  });

  const coverage = keywordCoverage(drafted.draft, row.idealReplyKeywords);
  const length = lengthAppropriateness(drafted.draft);

  return {
    draft: drafted.draft,
    degraded: Boolean(drafted.degraded),
    sourcedFrom: drafted.sourcedFrom,
    rougeL: rougeL(drafted.draft, row.idealReplyKeywords),
    coverage: coverage.coverage,
    missing: coverage.missing,
    appropriate: length.appropriate,
    wordCount: length.wordCount,
  };
}

/**
 * Judge a deterministic subsample of the drafted replies.
 *
 * The sample must be stride-based, not random: κ is only meaningful when the
 * same 30 rows can be re-judged across runs. Evidence is deliberately passed as
 * `[]` — the judge scores the reply text only, since a human scorer would have
 * no access to the responder's retrieved threads either.
 *
 * @param {Array<object>} rowResults - Row results; rows without a draft are skipped
 *   (they were either `--no-replies` or failed drafting).
 * @param {number} size - Sample size (0 disables the judge entirely).
 * @param {object} context - Judge context.
 * @param {Map<string, object>} context.rowByThreadId - Golden rows by thread id (message + human score).
 * @param {string} context.runId - Correlation id.
 * @param {(done: number, total: number) => void} [context.onProgress] - Progress reporter.
 * @returns {Promise<Array<object>>} Per-row judge results; empty when disabled or nothing drafted.
 */
export async function judgeSampledRows(rowResults, size, { rowByThreadId, runId, onProgress }) {
  const candidates = rowResults.filter((row) => row.reply?.draft);
  if (size <= 0 || candidates.length === 0) return [];

  const judgeRows = selectStridedSample(candidates, size).map((result) => {
    const golden = rowByThreadId.get(result.threadId);
    return {
      threadId: result.threadId,
      customerMessage: golden?.customerMessage ?? '',
      intent: result.expectedIntent,
      draftReply: result.reply.draft,
      retrievedThreads: [],
      humanScore: golden?.humanScore ?? null,
    };
  });

  const { results } = await scoreDraftsWithRubric(judgeRows, { requestId: runId, onProgress });
  return results;
}

