import { formatIntentTaxonomy } from '../utils/intents.js';
import { truncate } from '../utils/text.js';

/** Contract shared by every classifier variant. */
const OUTPUT_CONTRACT = `Respond with ONLY a JSON object, no prose and no code fences:
{"intent": "<one label from the taxonomy>", "confidence": <number between 0 and 1>, "rationale": "<max 20 words>"}`;

/** @type {string} Role framing reused by both variants. */
export const CLASSIFIER_SYSTEM_PROMPT = [
  'You classify inbound customer-support tweets sent to the Amazon Help account.',
  'You must pick exactly one label from the fixed taxonomy below — never invent a label.',
  'Confidence is your calibrated probability that the label is correct:',
  'use 0.9+ only when the message states the problem unambiguously.',
  '',
  'Taxonomy:',
  formatIntentTaxonomy(),
].join('\n');

/**
 * Baseline 2 (MAIN.md §4.3): zero-shot classification, no examples.
 *
 * @param {object} params - Prompt inputs.
 * @param {string} params.customerMessage - Sanitised customer message.
 * @returns {{ system: string, user: string }} Messages for the model API.
 */
export function buildZeroShotClassifierPrompt({ customerMessage }) {
  return {
    system: CLASSIFIER_SYSTEM_PROMPT,
    user: [
      'Classify this customer message.',
      '',
      `Message: """${truncate(customerMessage, 900)}"""`,
      '',
      OUTPUT_CONTRACT,
    ].join('\n'),
  };
}

/**
 * Production variant (MAIN.md §4.3): few-shot classification with labelled
 * examples drawn per intent from the golden set.
 *
 * @param {object} params - Prompt inputs.
 * @param {string} params.customerMessage - Sanitised customer message.
 * @param {Array<{ customerMessage: string, trueIntent: string }>} params.examples - Labelled examples (3 per intent).
 * @returns {{ system: string, user: string }} Messages for the model API.
 */
export function buildFewShotClassifierPrompt({ customerMessage, examples = [] }) {
  const shots = examples.length
    ? examples
        .map(
          (example) =>
            `Message: """${truncate(example.customerMessage, 280)}"""\nIntent: ${example.trueIntent}`,
        )
        .join('\n\n')
    : '(no examples available — fall back to the taxonomy definitions)';

  return {
    system: CLASSIFIER_SYSTEM_PROMPT,
    user: [
      'Labelled examples from past Amazon support threads:',
      '',
      shots,
      '',
      'Now classify this customer message.',
      `Message: """${truncate(customerMessage, 900)}"""`,
      '',
      OUTPUT_CONTRACT,
    ].join('\n'),
  };
}
