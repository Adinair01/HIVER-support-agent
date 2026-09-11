import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import { RUBRIC_DIMENSIONS } from '../prompts/judge.prompt.js';
import { AppError } from '../utils/AppError.js';
import { cohenKappa, mean, scoreBucket } from '../utils/metrics.js';

/**
 * Human-vs-judge agreement (MAIN.md §5.3).
 *
 * The judge only earns trust if a human, scoring the same replies on the same
 * rubric, agrees with it. This module owns the CSV contract for that comparison
 * so the exporter and the reporter cannot drift apart.
 */

/**
 * Rubric key → column suffix used in `eval/judge_sample_30.csv`.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const RUBRIC_COLUMN_SLUGS = Object.freeze({
  groundedness: 'groundedness',
  toneMatch: 'tone_match',
  resolutionLikelihood: 'resolution_likelihood',
  conciseness: 'conciseness',
});

/** @type {ReadonlyArray<string>} Columns a human must fill in. */
export const HUMAN_SCORE_COLUMNS = Object.freeze(
  RUBRIC_DIMENSIONS.map((dimension) => `human_score_${RUBRIC_COLUMN_SLUGS[dimension.key]}`),
);

/** @type {ReadonlyArray<string>} Columns the judge fills in. */
export const LLM_SCORE_COLUMNS = Object.freeze(
  RUBRIC_DIMENSIONS.map((dimension) => `llm_score_${RUBRIC_COLUMN_SLUGS[dimension.key]}`),
);

/**
 * Read a judge-sample CSV.
 *
 * @param {string} csvPath - Path to the sample file.
 * @returns {Array<Record<string, string>>} Raw records.
 * @throws {AppError} 503 when the file is missing.
 */
export function readJudgeSampleCsv(csvPath) {
  try {
    return parse(readFileSync(csvPath, 'utf8'), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new AppError(
        `Judge sample not found at ${csvPath}. Create it with "npm run export-judge-sample" ` +
          'after a run that included the judge (--judge=30).',
        { statusCode: 503, code: 'JUDGE_SAMPLE_MISSING' },
      );
    }
    throw error;
  }
}

/**
 * Compute agreement between human and judge scores.
 *
 * κ is computed per rubric dimension on raw 0–3 values, and on the overall total
 * only after bucketing into low/medium/high. Raw totals are not used directly for
 * κ: a 10 vs 11 disagreement is noise, a high-vs-medium disagreement is a real
 * judgement gap, and bucketing is what keeps the number from being dominated by
 * ±1 jitter.
 *
 * @param {Array<Record<string, string>>} records - Sample rows as parsed from the CSV.
 * @returns {{ ready: boolean, reason: string | null, n: number, dimensions: Record<string, object>, total: object, compared: number }} Agreement report;
 *   `ready: false` carries the reason (no rows / no complete pairs) instead of throwing,
 *   because an unfinished worksheet is a normal state, not an error.
 */
export function computeAgreement(records) {
  const rows = records.map(readScores);
  const complete = rows.filter((row) => row.humanTotal !== null && row.llmTotal !== null);

  if (records.length === 0) {
    return { ready: false, reason: 'the sample file has no rows', n: 0, dimensions: {}, total: {}, compared: 0 };
  }
  if (complete.length === 0) {
    return {
      ready: false,
      reason: 'no row has both human_score_* and llm_score_* values yet — fill the human columns first',
      n: records.length,
      dimensions: {},
      total: {},
      compared: 0,
    };
  }

  /** @type {Record<string, object>} */
  const dimensions = {};
  for (const dimension of RUBRIC_DIMENSIONS) {
    const pairs = complete
      .map((row) => ({ a: row.humanScores[dimension.key], b: row.llmScores[dimension.key] }))
      .filter((pair) => pair.a !== null && pair.b !== null);

    const differences = pairs.map((pair) => pair.b - pair.a);
    dimensions[dimension.key] = {
      ...cohenKappa(pairs),
      meanHuman: round(mean(pairs.map((pair) => pair.a))),
      meanJudge: round(mean(pairs.map((pair) => pair.b))),
      // Positive means the judge is more generous than the human.
      meanBias: round(mean(differences)),
      exactAgreement: round(
        pairs.length === 0 ? 0 : pairs.filter((pair) => pair.a === pair.b).length / pairs.length,
      ),
    };
  }

  const totalPairs = complete.map((row) => ({
    a: scoreBucket(row.humanTotal),
    b: scoreBucket(row.llmTotal),
  }));

  return {
    ready: true,
    reason: null,
    n: records.length,
    compared: complete.length,
    dimensions,
    total: {
      ...cohenKappa(totalPairs),
      bucketRule: 'rubric total 0-5 = low, 6-8 = medium, 9-12 = high',
      meanHumanTotal: round(mean(complete.map((row) => row.humanTotal))),
      meanJudgeTotal: round(mean(complete.map((row) => row.llmTotal))),
    },
  };
}

/**
 * Extract the human and judge scores (plus totals) from one CSV record.
 *
 * @param {Record<string, string>} record - CSV record.
 * @returns {{ threadId: string, humanScores: Record<string, number|null>, llmScores: Record<string, number|null>, humanTotal: number|null, llmTotal: number|null }} Parsed scores.
 */
function readScores(record) {
  /** @type {Record<string, number|null>} */
  const humanScores = {};
  /** @type {Record<string, number|null>} */
  const llmScores = {};

  for (const dimension of RUBRIC_DIMENSIONS) {
    const slug = RUBRIC_COLUMN_SLUGS[dimension.key];
    humanScores[dimension.key] = toScore(record[`human_score_${slug}`]);
    llmScores[dimension.key] = toScore(record[`llm_score_${slug}`]);
  }

  return {
    threadId: String(record.thread_id ?? ''),
    humanScores,
    llmScores,
    humanTotal: totalOf(humanScores),
    llmTotal: totalOf(llmScores),
  };
}

/**
 * Parse a rubric cell into `0..3`, or `null` when it is blank or out of range.
 *
 * Out-of-range maps to `null` rather than clamping: a stray typo ("13", "o") must
 * shrink the compared set loudly, not silently distort κ.
 *
 * @param {unknown} value - Raw cell.
 * @returns {number|null} Score.
 */
function toScore(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const numeric = Number(text);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 3) return null;
  return numeric;
}

/**
 * Sum a score map, or `null` when any dimension is missing.
 *
 * @param {Record<string, number|null>} scores - Per-dimension scores.
 * @returns {number|null} Total out of 12.
 */
function totalOf(scores) {
  const values = Object.values(scores);
  if (values.some((value) => value === null)) return null;
  return values.reduce((sum, value) => sum + /** @type {number} */ (value), 0);
}

/**
 * Round to four decimals.
 *
 * @param {number} value - Raw number.
 * @returns {number} Rounded number.
 */
function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : 0;
}
