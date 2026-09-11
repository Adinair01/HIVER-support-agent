import mongoose from 'mongoose';
import { truncate } from '../utils/text.js';

const MESSAGE_ROLES = ['customer', 'agent'];

/**
 * One reconstructed Twitter conversation between a customer and a brand account
 * (MAIN.md §4.1 step 4).
 *
 * `resolutionSummary` and `hasAgentReply` are denormalised at seed time so the
 * retrieval service can query on them without an aggregation per request.
 */
const threadSchema = new mongoose.Schema(
  {
    threadId: { type: String, required: true, unique: true, index: true },
    brand: { type: String, required: true, default: 'Amazon', index: true },
    messages: {
      type: [
        new mongoose.Schema(
          {
            role: { type: String, required: true, enum: MESSAGE_ROLES },
            text: { type: String, required: true },
            timestamp: { type: Date, required: true },
            tweetId: { type: String },
          },
          { _id: false },
        ),
      ],
      validate: [(messages) => messages.length > 0, 'a thread needs at least one message'],
    },
    /** First customer message — the message we classify and retrieve against. */
    firstCustomerMessage: { type: String, required: true },
    messageCount: { type: Number, required: true, default: 0 },
    /** True when the brand replied — the definition of "successfully resolved" for RAG. */
    hasAgentReply: { type: Boolean, required: true, default: false, index: true },
    /** Condensed view of what the agent actually did, used to ground the responder. */
    resolutionSummary: { type: String, default: '' },
    resolvedAt: { type: Date, default: null },
    lastMessageAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'threads' },
);

// The only index the retrieval service needs: full-text over every message.
threadSchema.index(
  { 'messages.text': 'text' },
  { name: 'messages_text', weights: { 'messages.text': 1 } },
);
threadSchema.index({ hasAgentReply: 1, resolvedAt: -1 }, { name: 'resolved_recent' });

/**
 * Find historical threads that were actually resolved, ranked by text relevance.
 *
 * @param {object} params - Search parameters.
 * @param {string} params.searchQuery - Sanitised `$text` query (see `buildTextSearchQuery`).
 * @param {number} [params.limit=3] - Maximum number of threads to return.
 * @param {string} [params.excludeThreadId] - Thread to omit (self-match guard).
 * @returns {Promise<Array<{ thread: object, similarityScore: number }>>} Ranked matches.
 */
threadSchema.statics.findSimilarResolvedThreads = async function findSimilarResolvedThreads({
  searchQuery,
  limit = 3,
  excludeThreadId,
}) {
  const baseFilter = { hasAgentReply: true };
  if (excludeThreadId) baseFilter.threadId = { $ne: excludeThreadId };

  if (!searchQuery) {
    // No usable terms: degrade to most-recent resolutions instead of failing.
    const recent = await this.find(baseFilter).sort({ resolvedAt: -1 }).limit(limit).lean();
    return recent.map((thread) => ({ thread, similarityScore: 0 }));
  }

  const matches = await this.find(
    { ...baseFilter, $text: { $search: searchQuery } },
    { score: { $meta: 'textScore' } },
  )
    .sort({ score: { $meta: 'textScore' } })
    .limit(limit)
    .lean();

  const topScore = matches[0]?.score ?? 0;
  return matches.map((thread) => ({
    thread,
    // Normalise to 0–1 so the responder/escalation layers can reason about it.
    similarityScore: topScore > 0 ? Number((thread.score / topScore).toFixed(4)) : 0,
  }));
};

/**
 * Look a thread up by business id or Mongo `_id`.
 *
 * @param {string} id - Thread id or ObjectId hex string.
 * @returns {Promise<object | null>} Lean thread document.
 */
threadSchema.statics.findByAnyId = function findByAnyId(id) {
  const query = mongoose.isValidObjectId(id) ? { _id: id } : { threadId: String(id) };
  return this.findOne(query).lean();
};

/**
 * Insert a batch of threads, ignoring duplicates so seeding is resumable.
 *
 * @param {Array<object>} threads - Thread documents.
 * @returns {Promise<number>} Number of newly inserted documents.
 */
threadSchema.statics.bulkInsertThreads = async function bulkInsertThreads(threads) {
  if (threads.length === 0) return 0;
  const result = await this.insertMany(threads, { ordered: false, lean: true });
  return result.length;
};

/**
 * Count of threads the retrieval service can actually search.
 *
 * @returns {Promise<number>} Document count where `hasAgentReply` is true.
 */
threadSchema.statics.countResolvedThreads = function countResolvedThreads() {
  return this.countDocuments({ hasAgentReply: true });
};

/**
 * Build the denormalised summary fields for a thread from its messages.
 *
 * @param {Array<{ role: string, text: string, timestamp: Date|string }>} messages - Ordered messages.
 * @returns {{ firstCustomerMessage: string, messageCount: number, hasAgentReply: boolean, resolutionSummary: string, resolvedAt: Date|null, lastMessageAt: Date }} Derived fields.
 */
threadSchema.statics.deriveThreadFields = function deriveThreadFields(messages) {
  const sorted = [...messages].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  const customerMessages = sorted.filter((message) => message.role === 'customer');
  const agentMessages = sorted.filter((message) => message.role === 'agent');
  const lastMessage = sorted[sorted.length - 1];

  return {
    firstCustomerMessage: customerMessages[0]?.text ?? sorted[0].text,
    messageCount: sorted.length,
    hasAgentReply: agentMessages.length > 0,
    resolutionSummary: truncate(
      agentMessages.map((message) => message.text).join(' ') || 'No brand response recorded.',
      500,
    ),
    resolvedAt: agentMessages.length > 0 ? new Date(lastMessage.timestamp) : null,
    lastMessageAt: new Date(lastMessage.timestamp),
  };
};

/** @type {import('mongoose').Model} */
export const Thread = mongoose.models.Thread ?? mongoose.model('Thread', threadSchema);
