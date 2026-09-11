import { INTENT_DESCRIPTIONS } from '../utils/intents.js';
import { truncate } from '../utils/text.js';

/** @type {string} Amazon-voice framing for the drafting model. */
export const RESPONDER_SYSTEM_PROMPT = [
  'You draft replies for the Amazon Help customer-support team on Twitter.',
  'Voice: professional, direct, warm but not sycophantic. 1–2 short sentences plus one clear next step.',
  'Hard rules:',
  '- Never invent order numbers, refund amounts, dates or policies that are not in the evidence.',
  '- If the evidence is insufficient, say what you need from the customer instead of guessing.',
  '- Include the single most useful next action (link-free, e.g. "check your Orders page").',
  '- No emojis, no hashtags, no marketing language, never promise compensation.',
  '- Sign off as a support agent only if it fits in the length budget.',
].join('\n');

/**
 * Build the retrieval-grounded drafting prompt (MAIN.md §4.5).
 *
 * @param {object} params - Prompt inputs.
 * @param {string} params.intent - Classified intent label.
 * @param {string} params.customerMessage - Sanitised customer message.
 * @param {Array<{ threadId: string, similarityScore: number, resolutionSummary: string }>} params.retrievedThreads - Similar resolved threads.
 * @returns {{ system: string, user: string }} Messages for the model API.
 */
export function buildResponderPrompt({ intent, customerMessage, retrievedThreads = [] }) {
  const evidence = retrievedThreads.length
    ? retrievedThreads
        .map(
          (thread, index) =>
            `[${index + 1}] threadId=${thread.threadId} (similarity ${thread.similarityScore})\n` +
            `    how Amazon resolved it: ${truncate(thread.resolutionSummary, 400)}`,
        )
        .join('\n')
    : '(no similar resolved threads were found — do not claim history you do not have)';

  const allowedIds = retrievedThreads.map((thread) => thread.threadId);

  return {
    system: RESPONDER_SYSTEM_PROMPT,
    user: [
      `Detected intent: ${intent} (${INTENT_DESCRIPTIONS[intent] ?? 'unclassified'})`,
      '',
      'Customer message:',
      `"""${truncate(customerMessage, 900)}"""`,
      '',
      `Evidence — how Amazon resolved ${retrievedThreads.length} similar case(s):`,
      evidence,
      '',
      'Draft the reply using only the evidence above.',
      'Respond with ONLY a JSON object:',
      '{"draft": "<the reply, max 60 words>", "confidence": <0..1>, ' +
        `"sourcedFrom": [thread ids you actually used, allowed: ${JSON.stringify(allowedIds)}]}`,
    ].join('\n'),
  };
}
