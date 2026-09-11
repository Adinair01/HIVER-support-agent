import mongoose from 'mongoose';

/**
 * One stored evaluation run (MAIN.md §4.3: all three classifier variants'
 * results land here; §5.2/§5.3 define the metric payloads).
 */
const evalResultSchema = new mongoose.Schema(
  {
    runId: { type: String, required: true, unique: true, index: true },
    status: { type: String, required: true, enum: ['running', 'completed', 'failed'], default: 'running' },
    startedAt: { type: Date, required: true, default: Date.now },
    finishedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },
    /** Which variant produced which classification metrics. */
    classification: { type: mongoose.Schema.Types.Mixed, default: {} },
    escalation: { type: mongoose.Schema.Types.Mixed, default: {} },
    replyQuality: { type: mongoose.Schema.Types.Mixed, default: {} },
    judge: { type: mongoose.Schema.Types.Mixed, default: {} },
    /** Per-row failures (`threadId:variant: message`). Named `runErrors` because
     * `errors` is a reserved Mongoose schema path. */
    runErrors: { type: [String], default: [] },
    config: {
      model: { type: String, default: '' },
      goldenSetSize: { type: Number, default: 0 },
      judgeSampleSize: { type: Number, default: 0 },
      variants: { type: [String], default: [] },
      seededThreads: { type: Boolean, default: false },
    },
    error: { type: String, default: null },
  },
  { timestamps: true, collection: 'eval_results' },
);

/**
 * Open a run so long evaluations are observable while they execute.
 *
 * @param {object} params - Run metadata.
 * @param {string} params.runId - Correlation id.
 * @param {object} [params.config] - Config snapshot.
 * @returns {Promise<object>} Created document.
 */
evalResultSchema.statics.startRun = function startRun({ runId, config = {} }) {
  return this.create({ runId, status: 'running', startedAt: new Date(), config });
};

/**
 * Persist the final metrics for a run.
 *
 * @param {string} runId - Correlation id.
 * @param {object} metrics - `{ classification, escalation, replyQuality, judge, errors }`.
 * @returns {Promise<object | null>} Updated document.
 */
evalResultSchema.statics.completeRun = function completeRun(runId, metrics) {
  return this.findOneAndUpdate(
    { runId },
    {
      $set: {
        ...metrics,
        status: 'completed',
        finishedAt: new Date(),
      },
    },
    { new: true },
  );
};

/**
 * Mark a run as failed with a safe error message.
 *
 * @param {string} runId - Correlation id.
 * @param {string} message - Error summary.
 * @returns {Promise<object | null>} Updated document.
 */
evalResultSchema.statics.failRun = function failRun(runId, message) {
  return this.findOneAndUpdate(
    { runId },
    { $set: { status: 'failed', error: message, finishedAt: new Date() } },
    { new: true },
  );
};

/**
 * List runs, newest first, without the heavy metric payloads.
 *
 * @param {number} [limit=25] - Maximum number of runs.
 * @returns {Promise<Array<object>>} Lean summaries.
 */
evalResultSchema.statics.listRecent = function listRecent(limit = 25) {
  return this.find({})
    .select('runId status startedAt finishedAt durationMs config runErrors')
    .sort({ startedAt: -1 })
    .limit(limit)
    .lean();
};

/**
 * Fetch one run by its public id.
 *
 * @param {string} runId - Correlation id.
 * @returns {Promise<object | null>} Lean document.
 */
evalResultSchema.statics.findByRunId = function findByRunId(runId) {
  return this.findOne({ runId: String(runId) }).lean();
};

/** @type {import('mongoose').Model} */
export const EvalResult = mongoose.models.EvalResult ?? mongoose.model('EvalResult', evalResultSchema);
