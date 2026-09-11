import { INTENT_DESCRIPTIONS } from '../utils/intents.js';
import { truncate } from '../utils/text.js';

/**
 * @typedef {object} RubricDimension
 * @property {string} key - Key used in the judge's JSON output.
 * @property {string} label - Human label for reports.
 * @property {string} description - What the judge must score.
 */

/** @type {ReadonlyArray<RubricDimension>} MAIN.md §5.3 rubric — 4 dimensions × 0–3 points. */
export const RUBRIC_DIMENSIONS = Object.freeze([
  {
    key: 'groundedness',
    label: 'Groundedness',
    description:
      'Is the reply based on the supplied past resolutions, or does it invent orders, amounts, dates or policies?',
  },
  {
    key: 'toneMatch',
    label: 'Tone match',
    description:
      'Does it sound like Amazon support: professional, direct, helpful — not sycophantic, not robotic?',
  },
  {
    key: 'resolutionLikelihood',
    label: 'Resolution likelihood',
    description: 'Would this reply actually move the customer toward resolution, with a clear next step?',
  },
  {
    key: 'conciseness',
    label: 'Conciseness',
    description: 'Is it free of filler, repeated apologies and unnecessary hedging?',
  },
]);

/** @type {number} Maximum total rubric score. */
export const MAX_RUBRIC_SCORE = RUBRIC_DIMENSIONS.length * 3;

/** @type {string} Judge system framing. */
export const JUDGE_SYSTEM_PROMPT = [
  'You are a strict evaluator of customer-support replies for Amazon Help on Twitter.',
  'Score each dimension 0–3: 0 = fails, 1 = weak, 2 = acceptable, 3 = excellent.',
  'Judge only what is written. Do not reward length. Penalise any invented fact harshly',
  '(groundedness must be 0 or 1 when the reply states something absent from the evidence).',
  'Be consistent: the same reply must always receive the same score.',
].join('\n');

/**
 * Build the rubric-scoring prompt for one draft reply (MAIN.md §5.3).
 *
 * @param {object} params - Prompt inputs.
 * @param {string} params.customerMessage - Sanitised customer message.
 * @param {string} params.intent - Intent of the message.
 * @param {string} params.draftReply - Reply produced by the responder.
 * @param {Array<{ threadId: string, resolutionSummary: string }>} [params.retrievedThreads] - Evidence given to the responder.
 * @returns {{ system: string, user: string }} Messages for the model API.
 */
export function buildJudgePrompt({ customerMessage, intent, draftReply, retrievedThreads = [] }) {
  const evidence = retrievedThreads.length
    ? retrievedThreads
        .map((thread) => `- ${thread.threadId}: ${truncate(thread.resolutionSummary, 300)}`)
        .join('\n')
    : '(none)';

  const rubric = RUBRIC_DIMENSIONS.map(
    (dimension, index) => `${index + 1}. ${dimension.key} — ${dimension.description}`,
  ).join('\n');

  const schema = `{${RUBRIC_DIMENSIONS.map((dimension) => `"${dimension.key}": <0-3>`).join(', ')}, "notes": "<max 30 words>"}`;

  return {
    system: JUDGE_SYSTEM_PROMPT,
    user: [
      `Intent: ${intent} (${INTENT_DESCRIPTIONS[intent] ?? 'unclassified'})`,
      `Customer message: """${truncate(customerMessage, 600)}"""`,
      '',
      'Evidence available to the responder:',
      evidence,
      '',
      `Draft reply to score: """${truncate(draftReply, 900)}"""`,
      '',
      'Rubric:',
      rubric,
      '',
      'Respond with ONLY a JSON object:',
      schema,
    ].join('\n'),
  };
}
