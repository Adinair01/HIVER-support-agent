import { logger } from '../config/logger.js';
import { MAX_RUBRIC_SCORE, RUBRIC_DIMENSIONS, buildJudgePrompt } from '../prompts/judge.prompt.js';
import { safeParseModelJson } from '../utils/json.js';
import { complete, isProviderConfigured } from './llm.client.js';
import { mean, normalizeJudgeScores } from '../utils/metrics.js';

/**
 * LLM-as-judge: score one drafted reply against the 4×0–3 rubric (MAIN.md §5.3).
 *
 * A failed or unparseable judgement returns `valid: false` rather than throwing,
 * so a single bad row cannot abort a 200-row evaluation run.
 *
 * @param {object} params - Judging inputs.
 * @param {string} params.customerMessage - Customer message the reply answers.
 * @param {string} params.intent - Intent of that message.
 * @param {string} params.draftReply - Reply to score.
 * @param {Array<{ threadId: string, resolutionSummary: string }>} [params.retrievedThreads] - Evidence the responder saw.
 * @param {string} [params.requestId] - Correlation id for logs.
 * @returns {Promise<{ scores: Record<string, number>, total: number, maxTotal: number, valid: boolean, notes: string, problem: string | null, degraded: boolean }>} Judgement.
 */
export async function scoreDraftWithRubric({
  customerMessage,
  intent,
  draftReply,
  retrievedThreads = [],
  requestId,
}) {
  const log = requestId ? logger.child({ requestId }) : logger;

  if (!isProviderConfigured()) {
    return {
      scores: {},
      total: 0,
      maxTotal: MAX_RUBRIC_SCORE,
      valid: false,
      notes: '',
      problem: 'GROQ_API_KEY not configured — judge disabled',
      degraded: true,
    };
  }

  const prompt = buildJudgePrompt({ customerMessage, intent, draftReply, retrievedThreads });

  try {
    const response = await complete({ ...prompt, label: 'judge', maxTokens: 512, requestId });
    const parsed = safeParseModelJson(response.text);
    const normalised = normalizeJudgeScores(parsed.ok ? parsed.value : null, RUBRIC_DIMENSIONS);

    if (!normalised.valid) {
      log.warn({ problem: normalised.problem }, 'judge output incomplete');
    }
    return { ...normalised, degraded: false };
  } catch (error) {
    log.warn({ err: error.message }, 'judge call failed');
    return {
      scores: {},
      total: 0,
      maxTotal: MAX_RUBRIC_SCORE,
      valid: false,
      notes: '',
      problem: error.message,
      degraded: false,
    };
  }
}

/**
 * Judge a batch of rows sequentially and summarise the scores.
 *
 * Sequential is a rate-limit constraint, not caution: parallel judge calls on a
 * free tier just 429 themselves into serial-with-extra-steps. Aggregates use only
 * `valid` results — averaging invalid rows as 0 would understate the judge.
 *
 * @param {Array<{ customerMessage: string, intent: string, draftReply: string, retrievedThreads?: Array<object>, humanScore?: number|null, threadId?: string }>} rows - Rows to judge; each judged independently.
 * @param {object} [options] - Batch options.
 * @param {string} [options.requestId] - Correlation id.
 * @param {(done: number, total: number) => void} [options.onProgress] - Progress callback.
 * @returns {Promise<{ results: Array<object>, summary: object }>} Per-row judgements and aggregate summary;
 *   `summary.meanTotal` is `0` (not NaN) when no row judged valid.
 */
export async function scoreDraftsWithRubric(rows, { requestId, onProgress } = {}) {
  /** @type {Array<object>} */
  const results = [];

  for (const [index, row] of rows.entries()) {
    const judgement = await scoreDraftWithRubric({ ...row, requestId });
    results.push({ threadId: row.threadId ?? null, humanScore: row.humanScore ?? null, ...judgement });
    onProgress?.(index + 1, rows.length);
  }

  const valid = results.filter((result) => result.valid);
  return {
    results,
    summary: {
      judged: results.length,
      valid: valid.length,
      invalid: results.length - valid.length,
      meanTotal: round(mean(valid.map((result) => result.total))),
      maxTotal: MAX_RUBRIC_SCORE,
      normalizedMean: round(mean(valid.map((result) => result.total / MAX_RUBRIC_SCORE))),
      meanByDimension: Object.fromEntries(
        RUBRIC_DIMENSIONS.map((dimension) => [
          dimension.key,
          round(mean(valid.map((result) => result.scores[dimension.key] ?? 0))),
        ]),
      ),
    },
  };
}

/**
 * Round to four decimals for stable JSON output.
 *
 * @param {number} value - Raw number.
 * @returns {number} Rounded number.
 */
function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : 0;
}
