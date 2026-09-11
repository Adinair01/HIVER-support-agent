import { logger } from '../config/logger.js';
import { buildResponderPrompt } from '../prompts/responder.prompt.js';
import { safeParseModelJson } from '../utils/json.js';
import { sanitizeTweetText, truncate } from '../utils/text.js';
import { complete, isProviderConfigured } from './llm.client.js';

/** Twitter-length replies only; a 600-char support reply reads as a wall of text anyway. */
const MAX_DRAFT_CHARS = 600;

/**
 * Deterministic, evidence-free reply templates used when no API key is present.
 *
 * They keep the whole pipeline (and the evaluation harness) runnable offline and
 * are always flagged with `degraded: true` so they can never be mistaken for
 * model output in the report.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const FALLBACK_TEMPLATES = Object.freeze({
  ORDER_STATUS:
    'Thanks for reaching out — I can check where your order is. Could you send the order number so I can pull up the latest tracking update?',
  RETURN_REFUND:
    'Sorry for the trouble. I can help with the return and refund. Send the order number and we will start the return right away.',
  ACCOUNT_ACCESS:
    'Let us get you back into your account. Please confirm the email on the account and we will send a fresh password reset link.',
  PRODUCT_COMPLAINT:
    'I am sorry the item did not arrive as expected. Send the order number and a photo of what you received so we can arrange a replacement or refund.',
  DELIVERY_ISSUE:
    'I am sorry this shipment did not reach you. Send the order number and we will check the delivery scan and arrange a reshipment or refund.',
  BILLING_DISPUTE:
    'I am sorry about the charge. Please send the order number and the last four digits of the payment method so we can review and correct it.',
  GENERAL_INQUIRY:
    'Thanks for reaching out. Could you share a few more details so we can point you to the right fix?',
  ABUSE_SPAM: 'This account is not able to help with that request. A member of our team will review.',
});

/**
 * Draft a reply grounded in how Amazon resolved similar past cases
 * (MAIN.md §4.5).
 *
 * Unparseable model output falls back to the template rather than throwing —
 * a canned answer is recoverable; a 500 on the support endpoint is not.
 * `sourcedFrom` is filtered against the ids actually retrieved, so the model
 * cannot claim provenance from threads it never saw (hallucinated citations
 * would otherwise look identical to real grounding in the report).
 *
 * @param {object} params - Draft parameters.
 * @param {string} params.intent - Classified intent.
 * @param {string} params.customerMessage - Raw customer message.
 * @param {Array<{ threadId: string, similarityScore: number, resolutionSummary: string }>} [params.retrievedThreads] - Retrieval evidence; empty = draft from intent alone.
 * @param {string} [params.requestId] - Correlation id for logs.
 * @returns {Promise<{ draft: string, confidence: number, sourcedFrom: string[], degraded: boolean, model?: string, degradedReason?: string }>} Drafted reply;
 *   `degraded: true` means template output — never report it as model output.
 */
export async function draftGroundedReply({ intent, customerMessage, retrievedThreads = [], requestId }) {
  const log = requestId ? logger.child({ requestId }) : logger;

  if (!isProviderConfigured()) {
    log.warn({ intent }, 'GROQ_API_KEY missing — returning the deterministic fallback draft');
    return {
      ...buildFallbackDraft({ intent }),
      degradedReason: 'responder requires GROQ_API_KEY; template reply used instead',
    };
  }

  const prompt = buildResponderPrompt({ intent, customerMessage, retrievedThreads });
  const response = await complete({ ...prompt, label: 'responder', requestId });
  const parsed = safeParseModelJson(response.text);

  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
    log.warn({ error: parsed.ok ? 'not an object' : parsed.error }, 'responder output unparseable');
    return {
      ...buildFallbackDraft({ intent }),
      degraded: true,
      degradedReason: `responder output was not valid JSON (${parsed.ok ? 'not an object' : parsed.error})`,
      model: response.model,
    };
  }

  const record = /** @type {Record<string, unknown>} */ (parsed.value);
  const allowedIds = new Set(retrievedThreads.map((thread) => thread.threadId));
  const sourcedFrom = (Array.isArray(record.sourcedFrom) ? record.sourcedFrom : [])
    .map((id) => String(id))
    .filter((id) => allowedIds.has(id));

  return {
    draft: truncate(sanitizeTweetText(String(record.draft ?? '')), MAX_DRAFT_CHARS),
    confidence: clampConfidence(record.confidence),
    sourcedFrom,
    degraded: false,
    model: response.model,
  };
}

/**
 * Build the offline template reply for an intent.
 *
 * @param {object} params - Fallback parameters.
 * @param {string} params.intent - Intent label; unknown labels get the GENERAL_INQUIRY template
 *   rather than an error, because a missing template must never fail a request.
 * @returns {{ draft: string, confidence: number, sourcedFrom: string[], degraded: true }} Template reply.
 */
export function buildFallbackDraft({ intent }) {
  return {
    draft: FALLBACK_TEMPLATES[intent] ?? FALLBACK_TEMPLATES.GENERAL_INQUIRY,
    confidence: 0.3,
    sourcedFrom: [],
    degraded: true,
  };
}

/**
 * Clamp a model-reported confidence into `[0, 1]`.
 *
 * Unparseable maps to 0.5 (not 0 or 1): the model answered, so it showed some
 * signal — but claiming high confidence in an unparseable field would be a lie.
 *
 * @param {unknown} value - Raw confidence; may be a string, `null`, or absent.
 * @returns {number} Clamped confidence, `0.5` when unparseable.
 */
function clampConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0.5;
  return Number(Math.min(1, Math.max(0, numeric)).toFixed(2));
}
