import mongoose from 'mongoose';
import { INTENTS } from '../utils/intents.js';

/**
 * One row of `eval/golden_set.csv` (MAIN.md §5.1).
 *
 * `human_score` is filled in only for the 30-row subsample that also gets
 * LLM-as-judge scoring, which is what Cohen's κ is computed against.
 */
const goldenExampleSchema = new mongoose.Schema(
  {
    threadId: { type: String, required: true, index: true },
    customerMessage: { type: String, required: true },
    trueIntent: { type: String, required: true, enum: INTENTS, index: true },
    expectedEscalation: { type: Boolean, required: true },
    /** `|`-separated keywords an ideal reply must contain. */
    idealReplyKeywords: { type: String, default: '' },
    notes: { type: String, default: '' },
    /** Human rubric score out of 12, or `null` when not human-scored. */
    humanScore: { type: Number, default: null, min: 0, max: 12 },
    source: { type: String, default: 'kaggle:twcs' },
  },
  { timestamps: true, collection: 'golden_examples' },
);

goldenExampleSchema.index({ trueIntent: 1, threadId: 1 }, { name: 'intent_thread' });

/**
 * Replace the whole golden set in one call so re-labelling is idempotent.
 *
 * @param {Array<object>} rows - Parsed CSV rows.
 * @returns {Promise<{ inserted: number, deleted: number }>} Counts for logging.
 */
goldenExampleSchema.statics.replaceAll = async function replaceAll(rows) {
  const deleted = await this.deleteMany({});
  if (rows.length === 0) return { inserted: 0, deleted: deleted.deletedCount ?? 0 };
  const inserted = await this.insertMany(rows, { ordered: false });
  return { inserted: inserted.length, deleted: deleted.deletedCount ?? 0 };
};

/**
 * Stratified, deterministic subsample for the LLM judge.
 *
 * A fixed stride (rather than `Math.random`) keeps κ comparable across runs.
 *
 * @param {number} size - Desired sample size.
 * @returns {Promise<Array<object>>} Lean, intent-balanced examples.
 */
goldenExampleSchema.statics.getJudgeSample = async function getJudgeSample(size) {
  const all = await this.find({}).sort({ trueIntent: 1, threadId: 1 }).lean();
  if (all.length === 0 || size <= 0) return [];
  if (size >= all.length) return all;

  const stride = all.length / size;
  const sample = [];
  for (let i = 0; i < size; i += 1) {
    sample.push(all[Math.floor(i * stride)]);
  }
  return sample;
};

/**
 * Count examples per intent, for stratified sampling and label balance checks.
 *
 * @returns {Promise<Array<{ _id: string, count: number }>>} Aggregated counts.
 */
goldenExampleSchema.statics.countByIntent = function countByIntent() {
  return this.aggregate([{ $group: { _id: '$trueIntent', count: { $sum: 1 } } }, { $sort: { _id: 1 } }]);
};

/**
 * Fetch every example in a stable order (used by the eval harness).
 *
 * @returns {Promise<Array<object>>} Lean examples.
 */
goldenExampleSchema.statics.findAllSorted = function findAllSorted() {
  return this.find({}).sort({ trueIntent: 1, threadId: 1 }).lean();
};

/** @type {import('mongoose').Model} */
export const GoldenExample =
  mongoose.models.GoldenExample ?? mongoose.model('GoldenExample', goldenExampleSchema);
