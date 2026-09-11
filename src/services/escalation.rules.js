import { ALWAYS_ESCALATE_INTENTS } from '../utils/intents.js';
import { extractMaxDollarAmount, findPhraseMatches, sanitizeTweetText } from '../utils/text.js';

/**
 * Phrase sets, exported so the report can cite them verbatim.
 *
 * Plain lowercase substrings rather than regexes: the false positives these lists
 * produce are auditable by eye, which regex soup is not. New phrases must be
 * specific — "worst" matches "worst case", but the FP rate on support chatter is
 * low enough that recall wins here.
 *
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
export const ESCALATION_PHRASES = Object.freeze({
  legal: [
    'lawyer', 'attorney', 'lawsuit', 'sue you', 'suing', 'legal action', 'court', 'small claims',
    'bbb', 'better business bureau', 'consumer forum', 'consumer court', 'ftc', 'ombudsman',
    'trading standards', 'regulator',
  ],
  fraud: [
    'fraud', 'fraudulent', 'scam', 'scammed', 'unauthorized', 'unauthorised', 'hacked',
    'stolen card', 'identity theft', 'police', 'reported to my bank', 'chargeback',
  ],
  angry: [
    'furious', 'angry', 'unacceptable', 'ridiculous', 'appalling', 'disgusted', 'fed up',
    'worst', 'terrible', 'useless', 'pathetic', 'never again', 'never using', 'cancel everything',
    'waste of money', 'sick of', 'disgrace', 'lying', 'incompetent',
  ],
  threatening: [
    'you will regret', 'i will ruin', 'going to the press', 'the press', 'news outlet',
    'expose you', 'social media will hear', 'everyone will know', 'i will make sure',
  ],
});

/** @type {number} MAIN.md §4.6: DEFAULT_MONEY_THRESHOLD for BILLING_DISPUTE. */
export const DEFAULT_MONEY_THRESHOLD = 100;
/** @type {number} MAIN.md §4.6: confidence below this escalates. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Detect shouting: long, mostly-uppercase messages read as angry.
 *
 * The 20-letter floor keeps short all-caps tweets ("REFUND NOW", brand acronyms)
 * from triggering; 60% tolerates the odd accidental caps-lock letter.
 *
 * @param {string} text - Sanitised text.
 * @returns {boolean} `true` when ≥60% of letters are uppercase in a 20+ char message.
 */
export function isShouting(text) {
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length < 20) return false;
  const uppercase = letters.replace(/[^A-Z]/g, '').length;
  return uppercase / letters.length >= 0.6;
}

/**
 * Evaluate the deterministic escalation rules (MAIN.md §4.6).
 *
 * Runs before any LLM call because rules are free, auditable and deterministic
 * (decision 5). The first triggered rule becomes `reason`; every trigger is
 * reported in `flags` so the decision is explainable end-to-end. Flag order is
 * meaningful: legal → fraud → anger → money → abuse → confidence, i.e. exposure
 * first, annoyance last.
 *
 * @param {object} params - Evaluation inputs.
 * @param {string} params.message - Raw customer message (sanitised internally).
 * @param {string} params.intent - Classified intent.
 * @param {number} params.classifierConfidence - Confidence of the classification; a non-finite
 *   value (e.g. a lost confidence field) is treated as below the floor.
 * @param {number} [params.moneyThreshold=DEFAULT_MONEY_THRESHOLD] - Billing amount that forces escalation.
 * @param {number} [params.confidenceThreshold=DEFAULT_CONFIDENCE_THRESHOLD] - Confidence floor.
 * @returns {{ triggered: boolean, reason: string | null, triggeredBy: 'rule' | null, flags: Array<{ code: string, detail: string }> }} Rule outcome;
 *   `triggeredBy` is `null` only when nothing triggered.
 */
export function evaluateEscalationRules({
  message,
  intent,
  classifierConfidence,
  moneyThreshold = DEFAULT_MONEY_THRESHOLD,
  confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD,
}) {
  const text = sanitizeTweetText(message);
  /** @type {Array<{ code: string, detail: string }>} */
  const flags = [];

  const legal = findPhraseMatches(text, ESCALATION_PHRASES.legal);
  if (legal.length > 0) {
    flags.push({ code: 'legal_threat', detail: `mentions ${legal.join(', ')}` });
  }

  const fraud = findPhraseMatches(text, ESCALATION_PHRASES.fraud);
  if (fraud.length > 0) {
    flags.push({ code: 'fraud_or_unauthorized', detail: `mentions ${fraud.join(', ')}` });
  }

  const angry = findPhraseMatches(text, [...ESCALATION_PHRASES.angry, ...ESCALATION_PHRASES.threatening]);
  if (angry.length > 0 || isShouting(text)) {
    flags.push({ code: 'angry_sentiment', detail: angry.length ? `mentions ${angry.join(', ')}` : 'shouting' });
  }

  const amount = extractMaxDollarAmount(text);
  if (intent === 'BILLING_DISPUTE' && amount > moneyThreshold) {
    flags.push({ code: 'high_value_billing', detail: `$${amount} exceeds $${moneyThreshold}` });
  }

  if (ALWAYS_ESCALATE_INTENTS.includes(intent)) {
    flags.push({
      code: 'abuse_or_spam',
      detail: `${intent} is never answered by an automated public reply`,
    });
  }

  const confidence = Number(classifierConfidence);
  if (!Number.isFinite(confidence) || confidence < confidenceThreshold) {
    flags.push({
      code: 'low_confidence',
      detail: `classifier confidence ${Number.isFinite(confidence) ? confidence : 'n/a'} < ${confidenceThreshold}`,
    });
  }

  if (flags.length === 0) {
    return { triggered: false, reason: null, triggeredBy: null, flags: [] };
  }

  const [primary] = flags;
  return {
    triggered: true,
    reason: `Escalated by rule "${primary.code}": ${primary.detail}.`,
    triggeredBy: 'rule',
    flags,
  };
}
