import { logger } from '../config/logger.js';
import { PipelineRun } from '../models/PipelineRun.model.js';
import { randomUUID } from 'node:crypto';
import { classifyIntent } from './classifier.service.js';
import { decideEscalation } from './escalation.service.js';
import { draftGroundedReply } from './responder.service.js';
import { retrieveSimilarThreads } from './retrieval.service.js';

/** @type {number} Evidence summaries returned to the caller (matches retrieval's DEFAULT_TOP_K). */
const MAX_EVIDENCE = 3;

/**
 * Run one customer message through classify → retrieve → respond → escalate and
 * store the whole execution as one pipeline run (MAIN.md §4.7).
 *
 * Lives in a service rather than the controller so §3.1 ("zero DB calls in
 * controllers") and §4.7 ("outputs stored together") are both satisfied.
 *
 * @param {object} params - Pipeline input.
 * @param {string} params.customerMessage - Raw customer message.
 * @param {'keyword'|'zero-shot'|'few-shot'} [params.variant='few-shot'] - Classifier variant for the intent step.
 * @param {boolean} [params.useRetrieval=true] - Skip RAG and draft from the intent alone.
 * @param {boolean} [params.skipLlmEscalation=false] - Rules-only escalation decision.
 * @param {string} [params.threadId] - Thread the message belongs to, when known.
 * @param {string} [params.requestId] - Caller-supplied correlation id.
 * @returns {Promise<object>} Unified pipeline response.
 * @throws {AppError} 502/503 when a required upstream dependency fails.
 */
export async function runSupportPipeline({
  customerMessage,
  variant = 'few-shot',
  useRetrieval = true,
  skipLlmEscalation = false,
  threadId,
  requestId,
}) {
  const runId = requestId ?? randomUUID();
  const log = logger.child({ requestId: runId });
  const timings = {};
  /** @type {string[]} */
  const degraded = [];

  const classification = await timed('classification', timings, () =>
    classifyIntent(customerMessage, { variant, requestId: runId }),
  );
  if (classification.degraded) degraded.push('classification');

  const retrieval = useRetrieval
    ? await timed('retrieval', timings, () =>
        retrieveSimilarThreads(customerMessage, { limit: MAX_EVIDENCE, excludeThreadId: threadId, requestId: runId }),
      )
    : { searchQuery: '', results: [] };

  const response = await timed('response', timings, () =>
    draftGroundedReply({
      intent: classification.intent,
      customerMessage,
      retrievedThreads: retrieval.results,
      requestId: runId,
    }),
  );
  if (response.degraded) degraded.push('response');

  const escalation = await timed('escalation', timings, () =>
    decideEscalation({
      message: customerMessage,
      intent: classification.intent,
      classifierConfidence: classification.confidence,
      skipLlmReview: skipLlmEscalation,
      requestId: runId,
    }),
  );

  const payload = {
    requestId: runId,
    threadId: threadId ?? null,
    customerMessage,
    classification,
    retrieval: { searchQuery: retrieval.searchQuery, evidence: retrieval.results.map(toEvidenceSummary) },
    response,
    escalation,
    timings,
    degraded,
  };

  // Storage failure must never lose the answer we already computed.
  try {
    await PipelineRun.saveRun(payload);
  } catch (error) {
    log.error({ err: error.message }, 'failed to persist pipeline run');
  }

  log.info(
    {
      intent: classification.intent,
      decision: escalation.decision,
      evidenceCount: retrieval.results.length,
      durationMs: totalDuration(timings),
    },
    'pipeline complete',
  );

  return payload;
}

/**
 * Trim a retrieved thread down to what the caller (and the report) needs.
 *
 * @param {object} result - Retrieval result entry.
 * @returns {object} Evidence summary.
 */
function toEvidenceSummary({ threadId, similarityScore, resolutionSummary, messageCount, resolvedAt }) {
  return {
    threadId,
    similarityScore,
    resolutionSummary,
    messageCount,
    resolvedAt,
  };
}

/**
 * Time one pipeline step.
 *
 * `finally` (not around the await) so a thrown step still records its duration —
 * the slow step in a failure report is usually the one that failed.
 *
 * @param {string} label - Step name.
 * @param {Record<string, number>} timings - Accumulator, mutated in place.
 * @param {() => Promise<T>} task - Step to run.
 * @returns {Promise<T>} The step's result.
 * @template T
 */
async function timed(label, timings, task) {
  const startedAt = Date.now();
  try {
    return await task();
  } finally {
    timings[label] = Date.now() - startedAt;
  }
}

/**
 * Sum the per-step timings.
 *
 * @param {Record<string, number>} timings - Per-step durations.
 * @returns {number} Total duration in milliseconds.
 */
function totalDuration(timings) {
  return Object.values(timings).reduce((sum, value) => sum + value, 0);
}
