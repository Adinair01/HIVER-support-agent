import { INTENT_DESCRIPTIONS } from '../utils/intents.js';
import { truncate } from '../utils/text.js';

/** @type {string} Framing for the grey-zone escalation review. */
export const ESCALATION_SYSTEM_PROMPT = [
  'You are the duty manager for Amazon Help on Twitter.',
  'A deterministic rule set has already screened this message and did NOT auto-escalate it.',
  'Decide whether a human agent must still handle it instead of an automated reply.',
  'Escalate YES when the message implies money loss, legal or regulatory risk, safety risk,',
  'a repeat contact about the same unresolved issue, or requires an action only a human can take',
  '(manual refund, account reinstatement, contacting a courier, verifying identity).',
  'Escalate NO for routine, self-serve questions where a standard reply resolves it.',
].join('\n');

/**
 * Build the LLM escalation-review prompt (MAIN.md §4.6).
 *
 * @param {object} params - Prompt inputs.
 * @param {string} params.intent - Classified intent.
 * @param {number} params.classifierConfidence - Confidence from the classifier.
 * @param {string} params.customerMessage - Sanitised customer message.
 * @returns {{ system: string, user: string }} Messages for the model API.
 */
export function buildEscalationPrompt({ intent, classifierConfidence, customerMessage }) {
  return {
    system: ESCALATION_SYSTEM_PROMPT,
    user: [
      `Detected intent: ${intent} (${INTENT_DESCRIPTIONS[intent] ?? 'unclassified'})`,
      `Classifier confidence: ${classifierConfidence}`,
      '',
      `Customer message: """${truncate(customerMessage, 900)}"""`,
      '',
      'Respond with ONLY a JSON object:',
      '{"answer": "YES" | "NO", "reason": "<one sentence, max 25 words>"}',
    ].join('\n'),
  };
}
