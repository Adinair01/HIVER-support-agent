import { logger } from '../config/logger.js';
import { Thread } from '../models/Thread.model.js';
import { AppError } from '../utils/AppError.js';
import { buildTextSearchQuery, sanitizeTweetText } from '../utils/text.js';

/** Top-3, not more: the responder prompt degrades visibly past ~3 evidence blocks, and tokens cost latency. */
export const DEFAULT_TOP_K = 3;

/**
 * Find historical Amazon threads that were actually resolved and look like the
 * incoming message.
 *
 * MVP is MongoDB `$text` search (MAIN.md decision 4): explainable, dependency-free
 * and fast. Embeddings are only justified if classification/retrieval proves
 * insufficient — see §9 of MAIN.md.
 *
 * @param {string} customerMessage - Raw customer message.
 * @param {object} [options] - Retrieval options.
 * @param {number} [options.limit=DEFAULT_TOP_K] - Number of threads to return.
 * @param {string} [options.excludeThreadId] - Thread id to exclude (self-match guard).
 * @param {string} [options.requestId] - Correlation id for logs.
 * @returns {Promise<{ searchQuery: string, results: Array<{ threadId: string, similarityScore: number, resolutionSummary: string, messageCount: number, resolvedAt: Date|null, firstCustomerMessage: string, thread: object }> }>} Ranked evidence.
 */
export async function retrieveSimilarThreads(
  customerMessage,
  { limit = DEFAULT_TOP_K, excludeThreadId, requestId } = {},
) {
  const log = requestId ? logger.child({ requestId }) : logger;
  const searchQuery = buildTextSearchQuery(customerMessage);
  const safeLimit = Math.min(Math.max(1, Number(limit) || DEFAULT_TOP_K), 10);

  const matches = await Thread.findSimilarResolvedThreads({ searchQuery, limit: safeLimit, excludeThreadId });

  log.debug({ searchQuery, matchCount: matches.length }, 'retrieval complete');

  return {
    searchQuery,
    results: matches.map(({ thread, similarityScore }) => ({
      threadId: thread.threadId,
      similarityScore,
      resolutionSummary: thread.resolutionSummary,
      messageCount: thread.messageCount,
      resolvedAt: thread.resolvedAt,
      firstCustomerMessage: thread.firstCustomerMessage,
      /** Full document, kept for the API response and the judge's context. */
      thread,
    })),
  };
}

/**
 * Fetch one stored thread by business id or Mongo id.
 *
 * @param {string} id - Thread id or ObjectId hex string.
 * @returns {Promise<object>} Lean thread document.
 * @throws {AppError} 404 when the thread does not exist.
 */
export async function getThreadById(id) {
  const thread = await Thread.findByAnyId(String(id).trim());
  if (!thread) throw AppError.notFound(`No thread found for id "${id}".`);
  return thread;
}

/**
 * Count resolved threads available as retrieval evidence.
 *
 * @returns {Promise<number>} Resolved thread count.
 */
export function countRetrievableThreads() {
  return Thread.countResolvedThreads();
}

/**
 * Fetch a small, recent sample of resolved threads — used to build the golden
 * set when the full text search index is not yet populated.
 *
 * @param {number} [limit=25] - Maximum number of threads; clamped to 500 so a typo'd
 *   `--limit=100000` cannot pull the whole collection into memory.
 * @returns {Promise<Array<object>>} Lean threads, newest resolved first.
 */
export async function sampleResolvedThreads(limit = 25) {
  const threads = await Thread.find({ hasAgentReply: true })
    .sort({ resolvedAt: -1 })
    .limit(Math.min(Math.max(1, limit), 500))
    .lean();
  return threads;
}

/**
 * Convenience wrapper used by the pipeline: sanitised query + retrieval in one call.
 *
 * @param {string} customerMessage - Raw customer message.
 * @param {object} [options] - Same options as `retrieveSimilarThreads`.
 * @returns {Promise<object>} Retrieval payload.
 */
export async function retrieveEvidenceFor(customerMessage, options = {}) {
  return retrieveSimilarThreads(sanitizeTweetText(customerMessage), options);
}
