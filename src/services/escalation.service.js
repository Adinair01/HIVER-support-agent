import { logger } from '../config/logger.js';
import { buildEscalationPrompt } from '../prompts/escalation.prompt.js';
import { parseYesNoVerdict } from '../utils/json.js';
import { complete, isProviderConfigured } from './llm.client.js';
import { evaluateEscalationRules } from './escalation.rules.js';

/**
 * Decide whether a human agent must handle this message (MAIN.md §4.6).
 *
 * Order of operations is deliberate: deterministic rules first (cheap, auditable),
 * the LLM only for the grey zone. Any LLM failure fails *safe* — escalation,
 * never silent auto-handling — because the cost asymmetry is lopsided: an
 * unnecessary human review costs minutes, a missed fraud threat costs the brand
 * a public thread. `triggeredBy: 'rule'` on an LLM-skipped auto decision marks
 * that no grey-zone review happened, so reports can count those separately.
 *
 * @param {object} params - Decision inputs.
 * @param {string} params.message - Raw customer message.
 * @param {string} params.intent - Classified intent; feed the fallback intent, not `null`,
 *   or the always-escalate check silently skips.
 * @param {number} params.classifierConfidence - Classifier confidence.
 * @param {boolean} [params.skipLlmReview=false] - Force a rules-only decision (eval, offline mode).
 * @param {string} [params.requestId] - Correlation id for logs.
 * @returns {Promise<{ decision: 'auto'|'escalate', reason: string, triggeredBy: 'rule'|'llm', flags: Array<{ code: string, detail: string }>, llmReviewed: boolean }>} Decision.
 * @throws {AppError} Only for unexpected programming errors; LLM outages are handled internally.
 */
export async function decideEscalation({
  message,
  intent,
  classifierConfidence,
  skipLlmReview = false,
  requestId,
}) {
  const log = requestId ? logger.child({ requestId }) : logger;
  const ruleOutcome = evaluateEscalationRules({ message, intent, classifierConfidence });

  if (ruleOutcome.triggered) {
    log.debug({ flags: ruleOutcome.flags.map((flag) => flag.code) }, 'escalation decided by rules');
    return { ...ruleOutcome, decision: 'escalate', llmReviewed: false };
  }

  if (skipLlmReview || !isProviderConfigured()) {
    return {
      decision: 'auto',
      reason: skipLlmReview
        ? 'No escalation rule triggered; LLM review skipped by request.'
        : 'No escalation rule triggered; LLM review unavailable (no GROQ_API_KEY).',
      triggeredBy: 'rule',
      flags: skipLlmReview ? [] : [{ code: 'llm_review_skipped', detail: 'GROQ_API_KEY not configured' }],
      llmReviewed: false,
    };
  }

  try {
    const prompt = buildEscalationPrompt({ intent, classifierConfidence, customerMessage: message });
    const response = await complete({ ...prompt, label: 'escalation', maxTokens: 256, requestId });
    const verdict = parseYesNoVerdict(response.text, 'YES');

    return {
      decision: verdict.decision ? 'escalate' : 'auto',
      reason: verdict.reason,
      triggeredBy: 'llm',
      flags: verdict.decision ? [{ code: 'llm_review', detail: verdict.reason }] : [],
      llmReviewed: true,
    };
  } catch (error) {
    // Fail safe: an unreviewed message is a human's problem, not an auto-reply's.
    log.warn({ err: error.message }, 'escalation LLM review failed — escalating as a precaution');
    return {
      decision: 'escalate',
      reason: 'LLM escalation review failed; defaulting to human review.',
      triggeredBy: 'llm',
      flags: [{ code: 'llm_review_failed', detail: error.message }],
      llmReviewed: true,
    };
  }
}
