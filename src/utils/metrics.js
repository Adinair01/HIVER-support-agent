import { RUBRIC_DIMENSIONS } from '../prompts/judge.prompt.js';
import { INTENTS } from './intents.js';
import { normalizeForComparison, tokenize } from './text.js';

/**
 * Every function here is pure and imports no config or DB module, so the eval
 * metrics and the judge rubric can be unit-tested with zero infrastructure
 * (MAIN.md decision 8).
 */

/**
 * Fraction of predictions equal to the expectation.
 *
 * @param {Array<{ expected: string, predicted: string|null }>} pairs - Comparisons.
 * @returns {number} Accuracy in `[0, 1]`, or `0` for an empty input.
 */
export function accuracy(pairs) {
  const scorable = pairs.filter((pair) => pair.predicted !== null);
  if (scorable.length === 0) return 0;
  const correct = scorable.filter((pair) => pair.predicted === pair.expected).length;
  return round(correct / scorable.length);
}

/**
 * Confusion matrix `actual → predicted → count`.
 *
 * @param {Array<{ expected: string, predicted: string|null }>} pairs - Comparisons.
 * @param {ReadonlyArray<string>} labels - Row/column order.
 * @returns {Record<string, Record<string, number>>} Matrix with every label present.
 */
export function confusionMatrix(pairs, labels) {
  /** @type {Record<string, Record<string, number>>} */
  const matrix = {};
  for (const actual of labels) {
    matrix[actual] = {};
    for (const predicted of labels) matrix[actual][predicted] = 0;
    matrix[actual].__unparsed = 0;
  }

  for (const pair of pairs) {
    const row = matrix[pair.expected];
    if (!row) continue;
    if (pair.predicted === null) row.__unparsed += 1;
    else if (row[pair.predicted] !== undefined) row[pair.predicted] += 1;
    else row.__unparsed += 1;
  }

  return matrix;
}

/**
 * Per-intent precision, recall, F1 and support (macro-averaged separately).
 *
 * @param {Array<{ expected: string, predicted: string|null }>} pairs - Comparisons.
 * @param {ReadonlyArray<string>} labels - Intent labels.
 * @returns {{ perIntent: Record<string, { precision: number, recall: number, f1: number, support: number }>, macro: { precision: number, recall: number, f1: number } }} Metrics.
 */
export function classificationReport(pairs, labels) {
  /** @type {Record<string, { precision: number, recall: number, f1: number, support: number }>} */
  const perIntent = {};

  for (const label of labels) {
    const truePositives = pairs.filter((p) => p.expected === label && p.predicted === label).length;
    const predictedPositives = pairs.filter((p) => p.predicted === label).length;
    const actualPositives = pairs.filter((p) => p.expected === label).length;

    const precision = predictedPositives === 0 ? 0 : truePositives / predictedPositives;
    const recall = actualPositives === 0 ? 0 : truePositives / actualPositives;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

    perIntent[label] = {
      precision: round(precision),
      recall: round(recall),
      f1: round(f1),
      support: actualPositives,
    };
  }

  const scored = labels.filter((label) => perIntent[label].support > 0);
  return {
    perIntent,
    macro: {
      precision: round(mean(scored.map((label) => perIntent[label].precision))),
      recall: round(mean(scored.map((label) => perIntent[label].recall))),
      f1: round(mean(scored.map((label) => perIntent[label].f1))),
    },
  };
}

/**
 * Precision/recall for the binary escalation decision.
 *
 * @param {Array<{ expected: boolean, predicted: boolean }>} pairs - Comparisons.
 * @returns {{ precision: number, recall: number, f1: number, accuracy: number, tp: number, fp: number, fn: number, tn: number }} Metrics.
 */
export function escalationReport(pairs) {
  const tp = pairs.filter((p) => p.expected && p.predicted).length;
  const fp = pairs.filter((p) => !p.expected && p.predicted).length;
  const fn = pairs.filter((p) => p.expected && !p.predicted).length;
  const tn = pairs.filter((p) => !p.expected && !p.predicted).length;

  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    precision: round(precision),
    recall: round(recall),
    f1: round(f1),
    accuracy: round(pairs.length === 0 ? 0 : (tp + tn) / pairs.length),
    tp,
    fp,
    fn,
    tn,
  };
}

/**
 * ROUGE-L (F-measure) between a generated reply and a reference, using
 * token-level longest common subsequence.
 *
 * @param {string} candidate - Generated reply.
 * @param {string} reference - Reference text (the ideal keywords, joined).
 * @returns {number} F-measure in `[0, 1]`.
 */
export function rougeL(candidate, reference) {
  const candidateTokens = tokenize(candidate);
  const referenceTokens = tokenize(reference);
  if (candidateTokens.length === 0 || referenceTokens.length === 0) return 0;

  const lcs = longestCommonSubsequenceLength(candidateTokens, referenceTokens);
  const precision = lcs / candidateTokens.length;
  const recall = lcs / referenceTokens.length;
  return round(precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall));
}

/**
 * Fraction of required keywords present in a reply (substring, case-insensitive).
 *
 * @param {string} reply - Generated reply.
 * @param {string} keywords - `|`-separated keywords.
 * @returns {{ coverage: number, matched: string[], missing: string[] }} Coverage details.
 */
export function keywordCoverage(reply, keywords) {
  const required = String(keywords ?? '')
    .split('|')
    .map((keyword) => normalizeForComparison(keyword))
    .filter(Boolean);
  if (required.length === 0) return { coverage: 0, matched: [], missing: [] };

  const haystack = normalizeForComparison(reply);
  const matched = required.filter((keyword) => haystack.includes(keyword));
  return {
    coverage: round(matched.length / required.length),
    matched,
    missing: required.filter((keyword) => !matched.includes(keyword)),
  };
}

/**
 * Is the reply a sensible length for a support tweet?
 *
 * @param {string} reply - Generated reply.
 * @param {object} [bounds] - Acceptable word count.
 * @param {number} [bounds.min=8] - Minimum words.
 * @param {number} [bounds.max=80] - Maximum words.
 * @returns {{ wordCount: number, appropriate: boolean }} Length assessment.
 */
export function lengthAppropriateness(reply, { min = 8, max = 80 } = {}) {
  const wordCount = String(reply ?? '').trim().split(/\s+/).filter(Boolean).length;
  return { wordCount, appropriate: wordCount >= min && wordCount <= max };
}

/**
 * Validate and total a judge's rubric output.
 *
 * @param {unknown} value - Parsed judge JSON.
 * @param {ReadonlyArray<{ key: string }>} [dimensions=RUBRIC_DIMENSIONS] - Expected dimensions.
 * @returns {{ scores: Record<string, number>, total: number, maxTotal: number, valid: boolean, notes: string, problem: string | null }} Normalised scores.
 */
export function normalizeJudgeScores(value, dimensions = RUBRIC_DIMENSIONS) {
  const maxTotal = dimensions.length * 3;
  const record = value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : null;

  if (!record) {
    return { scores: {}, total: 0, maxTotal, valid: false, notes: '', problem: 'judge output was not an object' };
  }

  /** @type {Record<string, number>} */
  const scores = {};
  const missing = [];
  for (const dimension of dimensions) {
    const raw = Number(record[dimension.key]);
    if (Number.isFinite(raw)) scores[dimension.key] = Math.min(3, Math.max(0, Math.round(raw)));
    else missing.push(dimension.key);
  }

  return {
    scores,
    total: Object.values(scores).reduce((sum, score) => sum + score, 0),
    maxTotal,
    valid: missing.length === 0,
    notes: typeof record.notes === 'string' ? record.notes.slice(0, 300) : '',
    problem: missing.length > 0 ? `missing dimensions: ${missing.join(', ')}` : null,
  };
}

/**
 * Cohen's κ for two raters over categorical labels.
 *
 * @param {Array<{ a: string|number|null, b: string|number|null }>} pairs - Rater pairs.
 * @returns {{ kappa: number, observedAgreement: number, expectedAgreement: number, n: number }} κ statistics.
 */
export function cohenKappa(pairs) {
  const usable = pairs.filter((pair) => pair.a !== null && pair.b !== null && pair.a !== undefined && pair.b !== undefined);
  if (usable.length === 0) return { kappa: 0, observedAgreement: 0, expectedAgreement: 0, n: 0 };

  const categories = [...new Set(usable.flatMap((pair) => [String(pair.a), String(pair.b)]))];
  const total = usable.length;

  const observed = usable.filter((pair) => String(pair.a) === String(pair.b)).length / total;
  const expected = categories.reduce((sum, category) => {
    const aCount = usable.filter((pair) => String(pair.a) === category).length / total;
    const bCount = usable.filter((pair) => String(pair.b) === category).length / total;
    return sum + aCount * bCount;
  }, 0);

  const kappa = expected === 1 ? (observed === 1 ? 1 : 0) : (observed - expected) / (1 - expected);
  return {
    kappa: round(kappa),
    observedAgreement: round(observed),
    expectedAgreement: round(expected),
    n: total,
  };
}

/**
 * Aggregate the per-reply quality signals into report-ready numbers.
 *
 * @param {Array<{ rougeL: number, coverage: number, appropriate: boolean, wordCount: number, missing?: string[] }>} samples - Reply assessments.
 * @returns {{ evaluated: number, meanRougeL: number, meanKeywordCoverage: number, lengthAppropriateRate: number, meanWordCount: number, topMissingKeywords: Array<{ keyword: string, count: number }> }} Summary.
 */
export function summarizeReplyQuality(samples) {
  if (samples.length === 0) {
    return {
      evaluated: 0,
      meanRougeL: 0,
      meanKeywordCoverage: 0,
      lengthAppropriateRate: 0,
      meanWordCount: 0,
      topMissingKeywords: [],
    };
  }

  /** @type {Map<string, number>} */
  const missingCounts = new Map();
  for (const sample of samples) {
    for (const keyword of sample.missing ?? []) {
      missingCounts.set(keyword, (missingCounts.get(keyword) ?? 0) + 1);
    }
  }

  return {
    evaluated: samples.length,
    meanRougeL: round(mean(samples.map((sample) => sample.rougeL))),
    meanKeywordCoverage: round(mean(samples.map((sample) => sample.coverage))),
    lengthAppropriateRate: round(
      samples.filter((sample) => sample.appropriate).length / samples.length,
    ),
    meanWordCount: round(mean(samples.map((sample) => sample.wordCount))),
    topMissingKeywords: [...missingCounts.entries()]
      .map(([keyword, count]) => ({ keyword, count }))
      .sort((a, b) => b.count - a.count || a.keyword.localeCompare(b.keyword))
      .slice(0, 10),
  };
}

/**
 * Bucket a 0–12 rubric score into three ordinal categories for Cohen's κ.
 *
 * @param {number} score - Rubric score.
 * @returns {'high'|'medium'|'low'} Bucket label.
 */
export function scoreBucket(score) {
  if (!Number.isFinite(score)) return 'low';
  if (score >= 9) return 'high';
  if (score >= 6) return 'medium';
  return 'low';
}

/**
 * Mean of a numeric list, `0` for an empty list.
 *
 * @param {number[]} values - Numbers.
 * @returns {number} Mean.
 */
export function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Length of the longest common subsequence of two token arrays.
 *
 * @param {string[]} a - First sequence.
 * @param {string[]} b - Second sequence.
 * @returns {number} LCS length.
 */
function longestCommonSubsequenceLength(a, b) {
  /** @type {number[]} */
  let previous = new Array(b.length + 1).fill(0);
  /** @type {number[]} */
  let current = new Array(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    [previous, current] = [current, previous.fill(0)];
  }

  return previous[b.length];
}

/**
 * Assemble the complete metrics payload for one evaluation run.
 *
 * Kept pure (no DB, no API) so the harness can be tested and so the numbers in
 * the report can be reproduced from a saved JSON file.
 *
 * @param {object} params - Aggregation inputs.
 * @param {Array<object>} params.rowResults - Per-row results (`{ predictions, reply, escalation }`).
 * @param {ReadonlyArray<string>} params.variants - Classifier variants that were run.
 * @param {string} params.productionVariant - Variant used for the reply/escalation metrics.
 * @param {Array<{ total: number, valid: boolean, scores: Record<string, number>, humanScore: number|null }>} [params.judgeResults=[]] - Judge outputs.
 * @returns {{ classification: object, escalation: object, replyQuality: object, judge: object }} Metrics payload.
 */
export function assembleEvaluationMetrics({ rowResults, variants, productionVariant, judgeResults = [] }) {
  /** @type {Record<string, object>} */
  const classification = {};

  for (const variant of variants) {
    const pairs = rowResults.map((row) => ({
      expected: row.expectedIntent,
      predicted: row.predictions[variant]?.intent ?? null,
    }));

    classification[variant] = {
      accuracy: accuracy(pairs),
      ...classificationReport(pairs, INTENTS),
      confusionMatrix: confusionMatrix(pairs, INTENTS),
      unparsedOrFailed: pairs.filter((pair) => pair.predicted === null).length,
    };
  }

  const escalationPairs = rowResults.map((row) => ({
    expected: Boolean(row.expectedEscalation),
    predicted: row.escalation?.decision === 'escalate',
  }));

  const replySamples = rowResults
    .map((row) => row.reply)
    .filter((reply) => reply && typeof reply.rougeL === 'number');

  const kappaPairs = judgeResults
    .filter((result) => result.valid && typeof result.humanScore === 'number')
    .map((result) => ({ a: scoreBucket(result.humanScore), b: scoreBucket(result.total) }));

  return {
    classification,
    escalation: {
      ...escalationReport(escalationPairs),
      productionVariant,
      byTrigger: countBy(rowResults.map((row) => row.escalation?.triggeredBy ?? 'none')),
      decidedByRules: rowResults.filter((row) => row.escalation?.triggeredBy === 'rule').length,
    },
    replyQuality: {
      ...summarizeReplyQuality(replySamples),
      degradedRate: round(
        replySamples.length === 0
          ? 0
          : rowResults.filter((row) => row.reply?.degraded).length / replySamples.length,
      ),
    },
    judge: {
      summary: summarizeJudge(judgeResults),
      agreement: {
        ...cohenKappa(kappaPairs),
        humanScoredRows: kappaPairs.length,
        bucketRule: 'rubric total 0-5 = low, 6-8 = medium, 9-12 = high',
      },
    },
  };
}

/**
 * Aggregate raw judge results into the summary reported in the report.
 *
 * @param {Array<{ total: number, valid: boolean, scores: Record<string, number> }>} judgeResults - Judge outputs.
 * @returns {{ judged: number, valid: number, invalid: number, meanTotal: number, maxTotal: number, normalizedMean: number, meanByDimension: Record<string, number> }} Summary.
 */
export function summarizeJudge(judgeResults) {
  const valid = judgeResults.filter((result) => result.valid);
  return {
    judged: judgeResults.length,
    valid: valid.length,
    invalid: judgeResults.length - valid.length,
    meanTotal: round(mean(valid.map((result) => result.total))),
    maxTotal: RUBRIC_DIMENSIONS.length * 3,
    normalizedMean: round(mean(valid.map((result) => result.total / (RUBRIC_DIMENSIONS.length * 3)))),
    meanByDimension: Object.fromEntries(
      RUBRIC_DIMENSIONS.map((dimension) => [
        dimension.key,
        round(mean(valid.map((result) => result.scores[dimension.key] ?? 0))),
      ]),
    ),
  };
}

/**
 * Count occurrences of each value.
 *
 * @param {Array<string|number|null>} values - Values to count.
 * @returns {Record<string, number>} Value → count.
 */
function countBy(values) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const value of values) {
    const key = String(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Round to four decimals for stable, diff-friendly JSON output.
 *
 * @param {number} value - Raw number.
 * @returns {number} Rounded number.
 */
function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : 0;
}
