import { isDatabaseConnected } from '../config/db.js';
import { logger } from '../config/logger.js';
import { GoldenExample } from '../models/GoldenExample.model.js';
import { classifyByKeywords } from './classifier.keyword.js';
import { assertLlmVariantAvailable, classifyFewShot, classifyZeroShot } from './classifier.llm.js';
import { isProviderConfigured } from './llm.client.js';
import { DEFAULT_GOLDEN_SET_PATH, parseGoldenSetCsv } from './goldenSet.loader.js';

/** @type {number} MAIN.md §4.3: 3 labelled examples per intent. More just burns prompt tokens for marginal F1. */
const EXAMPLES_PER_INTENT = 3;
/** @type {number} Cache TTL — long enough to cover one eval run, short enough that re-labelling shows up. */
const EXAMPLE_CACHE_TTL_MS = 5 * 60 * 1000;

/** @type {{ loadedAt: number, examples: Array<{ customerMessage: string, trueIntent: string }> }} */
let exampleCache = { loadedAt: 0, examples: [] };

/**
 * Load few-shot examples from the golden set: up to 3 per intent, first by
 * threadId within each intent. Sorted (not random) selection keeps a given
 * golden-set file producing identical prompts — and therefore identical eval
 * numbers — across runs. CSV fallback keeps this working before `npm run seed -- --golden`.
 *
 * @param {object} [options] - Loader options.
 * @param {boolean} [options.force=false] - Bypass the cache (scripts call this after re-labelling).
 * @returns {Promise<Array<{ customerMessage: string, trueIntent: string }>>} Labelled examples;
 *   empty (with a warning, not a throw) when no golden set exists anywhere.
 */
export async function loadFewShotExamples({ force = false } = {}) {
  const fresh = Date.now() - exampleCache.loadedAt < EXAMPLE_CACHE_TTL_MS;
  if (!force && fresh && exampleCache.examples.length > 0) return exampleCache.examples;

  let rows = [];
  if (isDatabaseConnected()) {
    rows = await GoldenExample.find({})
      .select('customerMessage trueIntent')
      .sort({ trueIntent: 1, threadId: 1 })
      .lean();
  } else {
    try {
      rows = parseGoldenSetCsv(DEFAULT_GOLDEN_SET_PATH).rows;
    } catch {
      rows = [];
    }
  }

  /** @type {Map<string, Array<{ customerMessage: string, trueIntent: string }>>} */
  const byIntent = new Map();
  for (const row of rows) {
    const bucket = byIntent.get(row.trueIntent) ?? [];
    if (bucket.length < EXAMPLES_PER_INTENT) {
      bucket.push({ customerMessage: row.customerMessage, trueIntent: row.trueIntent });
      byIntent.set(row.trueIntent, bucket);
    }
  }

  const examples = [...byIntent.values()].flat();
  if (examples.length === 0) {
    logger.warn('golden set is empty — few-shot classification will run without examples');
  }

  exampleCache = { loadedAt: Date.now(), examples };
  return examples;
}

/**
 * Drop the cached examples (used by scripts after re-labelling).
 *
 * @returns {void}
 */
export function clearExampleCache() {
  exampleCache = { loadedAt: 0, examples: [] };
}

/**
 * Classify one customer message with a selectable variant (MAIN.md §4.3).
 *
 * All three variants return the same shape so the evaluation harness can
 * compare them without special-casing — that is the point of decision 9.
 * Unconfigured-key degradation is loud (`degraded: true`, logged) rather than
 * silent, because a keyword result scored as if it were the LLM's would poison
 * every metric downstream.
 *
 * @param {string} customerMessage - Raw customer message.
 * @param {object} [options] - Classification options.
 * @param {'keyword'|'zero-shot'|'few-shot'} [options.variant='few-shot'] - Variant to run.
 * @param {string} [options.requestId] - Correlation id for logs.
 * @param {Array<{ customerMessage: string, trueIntent: string }>} [options.examples] - Override few-shot examples;
 *   the eval harness passes these once per run so all rows see identical prompts.
 * @returns {Promise<{ intent: string, confidence: number, rationale: string, variant: string, matchedRules: string[], degraded: boolean, parseError: string | null }>} Classification result;
 *   `degraded: true` marks an LLM variant that fell back to keywords.
 * @throws {AppError} 503 for LLM variants when no API key is configured and the caller
 *   opted out of degradation (direct `classifyIntent` with an explicit variant).
 */
export async function classifyIntent(customerMessage, { variant = 'few-shot', requestId, examples } = {}) {
  const log = requestId ? logger.child({ requestId }) : logger;
  const configured = isProviderConfigured();

  if (variant === 'keyword') {
    return { ...classifyByKeywords(customerMessage), variant: 'keyword', degraded: false, parseError: null };
  }

  if (!configured) {
    // Loud, explicit degradation — never a silent fallback (MAIN.md §3.1).
    log.warn({ variant }, 'GROQ_API_KEY missing — degrading to the keyword classifier');
    return {
      ...classifyByKeywords(customerMessage),
      variant: 'keyword',
      degraded: true,
      degradedReason: `variant "${variant}" requires GROQ_API_KEY; keyword baseline used instead`,
      parseError: null,
    };
  }

  assertLlmVariantAvailable(configured, variant);

  if (variant === 'zero-shot') {
    const result = await classifyZeroShot(customerMessage, { requestId });
    return { ...result, degraded: false };
  }

  const fewShotExamples = examples ?? (await loadFewShotExamples());
  const result = await classifyFewShot(customerMessage, { examples: fewShotExamples, requestId });
  return { ...result, degraded: false };
}

/**
 * Run every variant for one message — used by the eval harness.
 *
 * Failures are captured per variant rather than thrown, so one provider outage
 * cannot invalidate a whole evaluation run.
 *
 * @param {string} customerMessage - Raw customer message.
 * @param {object} [options] - Options.
 * @param {ReadonlyArray<string>} [options.variants] - Variants to run; unknown names are silently
 *   skipped by the harness earlier, so no validation here.
 * @param {Array<{ customerMessage: string, trueIntent: string }>} [options.examples] - Few-shot examples.
 * @param {string} [options.requestId] - Correlation id.
 * @returns {Promise<Record<string, object>>} Variant name → result, or
 *   `{ intent: null, confidence: 0, error }` for a failed variant.
 */
export async function classifyWithAllVariants(
  customerMessage,
  { variants = ['keyword', 'zero-shot', 'few-shot'], examples, requestId } = {},
) {
  /** @type {Record<string, object>} */
  const results = {};

  for (const variant of variants) {
    try {
      results[variant] = await classifyIntent(customerMessage, { variant, examples, requestId });
    } catch (error) {
      results[variant] = { intent: null, confidence: 0, variant, error: error.message };
    }
  }

  return results;
}
