import { sanitizeTweetText } from '../utils/text.js';

/**
 * Baseline 1 (MAIN.md §4.3): deterministic regex rules, one row per pattern.
 * Weight 2 marks a phrase that is nearly decisive for its intent, weight 1 is
 * supporting evidence. Patterns are intentionally global-flag-free so `.test()`
 * is stateless and reusable.
 *
 * @type {Readonly<Record<string, ReadonlyArray<{ pattern: RegExp, weight: number, name: string }>>>}
 */
export const KEYWORD_RULES = Object.freeze({
  ORDER_STATUS: [
    { pattern: /\b(where('| i)?s my (order|package|parcel)|where is my order)\b/i, weight: 2, name: 'where-is-order' },
    { pattern: /\b(tracking|track my|shipment|out for delivery|order status)\b/i, weight: 2, name: 'tracking' },
    { pattern: /\b(shipped|dispatched|arriving|arrives|eta|delivery date|expected delivery)\b/i, weight: 1, name: 'ship-eta' },
    { pattern: /\b(when will (it|my order|this) (arrive|ship|be delivered))\b/i, weight: 2, name: 'when-will-arrive' },
  ],
  RETURN_REFUND: [
    { pattern: /\b(refund|money back|reimburse|reimbursement|credited? back)\b/i, weight: 2, name: 'refund' },
    { pattern: /\b(return|send (it|this) back|return label|rma|drop.?off)\b/i, weight: 2, name: 'return' },
    { pattern: /\b(exchange|replacement|swap (it|this))\b/i, weight: 1, name: 'exchange' },
    { pattern: /\bhow (do|can) i (return|get a refund)\b/i, weight: 2, name: 'how-to-return' },
  ],
  ACCOUNT_ACCESS: [
    { pattern: /\b(log ?in|login|sign ?in|signing in)\b/i, weight: 2, name: 'login' },
    { pattern: /\b(password|reset my password|forgot (my )?password)\b/i, weight: 2, name: 'password' },
    { pattern: /\b(locked out|account (is )?(locked|suspended|closed|deactivated)|can'?t access my account)\b/i, weight: 2, name: 'locked-account' },
    { pattern: /\b(otp|one.?time (code|password)|verification code|2fa|two.?factor|authenticator)\b/i, weight: 1, name: 'otp' },
  ],
  PRODUCT_COMPLAINT: [
    { pattern: /\b(damaged|broken|defective|faulty|dented|cracked|leaking|leaked)\b/i, weight: 2, name: 'damaged' },
    { pattern: /\b(wrong (item|product|size|colour|color)|not what i ordered|different (item|product))\b/i, weight: 2, name: 'wrong-item' },
    { pattern: /\b(fake|counterfeit|knock.?off|not genuine|not as described|misleading listing)\b/i, weight: 2, name: 'counterfeit' },
    { pattern: /\b(poor quality|bad quality|stopped working|doesn'?t work|not working|missing parts|incomplete)\b/i, weight: 1, name: 'quality' },
  ],
  DELIVERY_ISSUE: [
    { pattern: /\b(never (arrived|received|came|got (it|my))|didn'?t (arrive|receive))\b/i, weight: 2, name: 'never-arrived' },
    { pattern: /\b(marked as delivered|says delivered|delivered but|but i never got|no package)\b/i, weight: 2, name: 'delivered-but-missing' },
    { pattern: /\b(lost (package|parcel|order)|missing (package|parcel|item)|stolen|porch pirate)\b/i, weight: 2, name: 'lost-package' },
    { pattern: /\b(wrong address|old address|address (is|was) wrong|deliver(ed)? to the wrong)\b/i, weight: 2, name: 'wrong-address' },
  ],
  BILLING_DISPUTE: [
    { pattern: /\b(charged (me )?twice|double charge|duplicate charge|duplicate payment)\b/i, weight: 2, name: 'double-charge' },
    { pattern: /\b(unauthori[sz]ed|fraudulent|didn'?t (authorise|authorize|place)|never ordered)\b/i, weight: 2, name: 'unauthorised' },
    { pattern: /\b(overcharged|wrong amount|price (change|increase|difference)|charged me more|higher than (the )?(listed|advertised))\b/i, weight: 2, name: 'overcharge' },
    { pattern: /\b(billing|invoice|credit card|payment method|debited)\b/i, weight: 1, name: 'billing' },
  ],
  ABUSE_SPAM: [
    { pattern: /\b(buy followers|check (out )?my (store|page|profile)|dm me|follow ?back|get rich|work from home)\b/i, weight: 2, name: 'spam-cta' },
    { pattern: /\b(crypto|bitcoin|forex|trading signals|investment opportunity|loan offer)\b/i, weight: 2, name: 'spam-finance' },
    { pattern: /\b(idiot|stupid|moron|shut up|useless company|hate you)\b/i, weight: 1, name: 'abusive' },
  ],
  GENERAL_INQUIRY: [],
});

/** @type {string} Fallback when no rule fires — GENERAL_INQUIRY is the cheapest intent to be wrong about. */
const FALLBACK_INTENT = 'GENERAL_INQUIRY';

/** Floor of 0.35, not 0: escalation's `low_confidence` rule fires below 0.6, and a
 *  zero-confidence fallback would make every no-match message escalate. */
const MIN_CONFIDENCE = 0.35;

/**
 * Classify a message with the keyword baseline.
 *
 * Confidence is a documented function of matched rule weights:
 * `clamp(0.45 + 0.15·topScore − 0.05·runnerUpScore, 0.35, 0.95)` — deterministic,
 * auditable, and comparable across runs (unlike a model-reported probability).
 * The runner-up penalty keeps two strong intents (e.g. refund + damage) from
 * both reading as confident; ties break alphabetically for reproducibility.
 *
 * @param {string} customerMessage - Raw customer message; sanitised before matching, so
 *   URLs and mentions never contribute scores.
 * @returns {{ intent: string, confidence: number, rationale: string, matchedRules: string[], scores: Record<string, number> }} Classification result;
 *   `scores` is empty and `intent` is `GENERAL_INQUIRY` at `MIN_CONFIDENCE` when nothing matches.
 */
export function classifyByKeywords(customerMessage) {
  const text = sanitizeTweetText(customerMessage);
  /** @type {Record<string, number>} */
  const scores = {};
  /** @type {string[]} */
  const matchedRules = [];

  for (const [intent, rules] of Object.entries(KEYWORD_RULES)) {
    let score = 0;
    for (const rule of rules) {
      if (rule.pattern.test(text)) {
        score += rule.weight;
        matchedRules.push(`${intent}:${rule.name}`);
      }
    }
    if (score > 0) scores[intent] = score;
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (ranked.length === 0) {
    return {
      intent: FALLBACK_INTENT,
      confidence: MIN_CONFIDENCE,
      rationale: 'No keyword rule matched; defaulting to general inquiry.',
      matchedRules: [],
      scores,
    };
  }

  const [topIntent, topScore] = ranked[0];
  const runnerUpScore = ranked[1]?.[1] ?? 0;
  const confidence = Number(
    Math.min(0.95, Math.max(MIN_CONFIDENCE, 0.45 + 0.15 * topScore - 0.05 * runnerUpScore)).toFixed(2),
  );

  return {
    intent: topIntent,
    confidence,
    rationale: `Matched ${matchedRules.length} rule(s) for ${topIntent} (score ${topScore}${
      runnerUpScore ? `, runner-up ${runnerUpScore}` : ''
    }).`,
    matchedRules,
    scores,
  };
}
