import { AppError } from '../utils/AppError.js';
import { safeParseModelJson } from '../utils/json.js';
import { normalizeIntentLabel } from '../utils/intents.js';
import {
  buildFewShotClassifierPrompt,
  buildZeroShotClassifierPrompt,
} from '../prompts/classifier.prompt.js';
import { complete } from './llm.client.js';

/** 0.3, not 0: a mid-confidence unparseable result escalates naturally via the
 *  low-confidence rule instead of pinning to either escalation extreme. */
const UNPARSEABLE_CONFIDENCE = 0.3;

/**
 * Baseline 2 (MAIN.md §4.3): zero-shot classification, no examples.
 *
 * @param {string} customerMessage - Raw customer message.
 * @param {object} [options] - Call options.
 * @param {string} [options.requestId] - Correlation id for logs.
 * @returns {Promise<object>} Normalised classification result.
 * @throws {AppError} 502 when the model provider fails.
 */
export async function classifyZeroShot(customerMessage, { requestId } = {}) {
  const prompt = buildZeroShotClassifierPrompt({ customerMessage });
  const response = await complete({ ...prompt, label: 'classifier:zero-shot', requestId });
  const parsed = parseClassifierResponse(response.text);
  return { ...parsed, variant: 'zero-shot', model: response.model };
}

/**
 * Production variant (MAIN.md §4.3): few-shot classification using labelled
 * golden-set examples.
 *
 * @param {string} customerMessage - Raw customer message.
 * @param {object} options - Call options.
 * @param {Array<{ customerMessage: string, trueIntent: string }>} options.examples - Labelled examples.
 * @param {string} [options.requestId] - Correlation id for logs.
 * @returns {Promise<object>} Normalised classification result.
 * @throws {AppError} 502 when the model provider fails.
 */
export async function classifyFewShot(customerMessage, { examples = [], requestId } = {}) {
  const prompt = buildFewShotClassifierPrompt({ customerMessage, examples });
  const response = await complete({ ...prompt, label: 'classifier:few-shot', requestId });
  const parsed = parseClassifierResponse(response.text);
  return { ...parsed, variant: 'few-shot', model: response.model, exampleCount: examples.length };
}

/**
 * Turn raw model text into the shared classification shape.
 *
 * Deliberately never throws: a malformed answer degrades to `GENERAL_INQUIRY`
 * with low confidence so the pipeline still returns an auditable result. An
 * out-of-taxonomy label keeps `parseError` set but still returns the normalised
 * best-guess intent — silently dropping the label would make model drift
 * invisible in the confusion matrix.
 *
 * @param {string} text - Raw model output; expected to be a JSON object with
 *   `intent`, `confidence`, `rationale`, but all three are optional in practice.
 * @returns {{ intent: string, confidence: number, rationale: string, matchedRules: string[], parseError: string | null }} Classification result;
 *   `matchedRules` is always empty here — it exists so keyword and LLM results share one shape.
 */
export function parseClassifierResponse(text) {
  const parsed = safeParseModelJson(text);

  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
    return {
      intent: 'GENERAL_INQUIRY',
      confidence: UNPARSEABLE_CONFIDENCE,
      rationale: `Could not parse model output: ${parsed.ok ? 'not an object' : parsed.error}`,
      matchedRules: [],
      parseError: parsed.ok ? 'not an object' : parsed.error,
    };
  }

  const record = /** @type {Record<string, unknown>} */ (parsed.value);
  const { intent, matched } = normalizeIntentLabel(record.intent);
  const rawConfidence = Number(record.confidence);

  return {
    intent,
    confidence: Number.isFinite(rawConfidence)
      ? Math.min(1, Math.max(0, rawConfidence))
      : matched
        ? 0.7
        : UNPARSEABLE_CONFIDENCE,
    rationale: typeof record.rationale === 'string' ? record.rationale.slice(0, 300) : '',
    matchedRules: [],
    parseError: matched ? null : `Label "${String(record.intent)}" was not in the taxonomy`,
  };
}

/**
 * Shared guard so callers get one consistent 503 shape.
 *
 * @param {boolean} configured - Result of `isProviderConfigured()`.
 * @param {string} variant - Variant name, echoed in the error so the fix is obvious
 *   (`"few-shot" requires GROQ_API_KEY`, not a bare 503).
 * @returns {void}
 * @throws {AppError} 503 when not configured.
 */
export function assertLlmVariantAvailable(configured, variant) {
  if (!configured) {
    throw AppError.unavailable(
      `The "${variant}" classifier variant needs GROQ_API_KEY. Use variant "keyword" for offline runs.`,
    );
  }
}
