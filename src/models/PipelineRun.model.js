import mongoose from 'mongoose';

/**
 * One end-to-end pipeline execution (MAIN.md §4.7): the classification,
 * retrieval evidence, drafted reply and escalation decision for a single
 * customer message, stored together as one document.
 */
const pipelineRunSchema = new mongoose.Schema(
  {
    requestId: { type: String, required: true, unique: true, index: true },
    threadId: { type: String, default: null },
    customerMessage: { type: String, required: true },
    classification: { type: mongoose.Schema.Types.Mixed, default: {} },
    retrieval: { type: mongoose.Schema.Types.Mixed, default: {} },
    response: { type: mongoose.Schema.Types.Mixed, default: {} },
    escalation: { type: mongoose.Schema.Types.Mixed, default: {} },
    timings: { type: mongoose.Schema.Types.Mixed, default: {} },
    /** Names of any components that ran in degraded (non-LLM) mode. */
    degraded: { type: [String], default: [] },
  },
  { timestamps: true, collection: 'pipeline_runs' },
);

pipelineRunSchema.index({ createdAt: -1 }, { name: 'pipeline_recent' });

/**
 * Persist one pipeline execution.
 *
 * @param {object} run - Run payload.
 * @returns {Promise<object>} Created document (lean).
 */
pipelineRunSchema.statics.saveRun = function saveRun(run) {
  return this.create(run);
};

/**
 * Fetch a stored run by its correlation id.
 *
 * @param {string} requestId - Correlation id.
 * @returns {Promise<object | null>} Lean document.
 */
pipelineRunSchema.statics.findByRequestId = function findByRequestId(requestId) {
  return this.findOne({ requestId: String(requestId) }).lean();
};

/**
 * List the most recent runs, for debugging and demos.
 *
 * @param {number} [limit=20] - Maximum number of runs.
 * @returns {Promise<Array<object>>} Lean documents without the full message text.
 */
pipelineRunSchema.statics.listRecent = function listRecent(limit = 20) {
  return this.find({})
    .select('requestId threadId classification.intent escalation.decision createdAt timings')
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(1, limit), 100))
    .lean();
};

/** @type {import('mongoose').Model} */
export const PipelineRun =
  mongoose.models.PipelineRun ?? mongoose.model('PipelineRun', pipelineRunSchema);
