/**
 * Single source of truth for the intent taxonomy (MAIN.md §4.2).
 *
 * The same list feeds the keyword classifier, every prompt template, the zod
 * validators and the metric computation — so adding an intent here changes the
 * whole pipeline coherently.
 *
 * @typedef {'ORDER_STATUS'|'RETURN_REFUND'|'ACCOUNT_ACCESS'|'PRODUCT_COMPLAINT'|'DELIVERY_ISSUE'|'BILLING_DISPUTE'|'GENERAL_INQUIRY'|'ABUSE_SPAM'} Intent
 */

/** @type {ReadonlyArray<Intent>} Canonical intent labels, stable ordering. */
export const INTENTS = Object.freeze([
  'ORDER_STATUS',
  'RETURN_REFUND',
  'ACCOUNT_ACCESS',
  'PRODUCT_COMPLAINT',
  'DELIVERY_ISSUE',
  'BILLING_DISPUTE',
  'GENERAL_INQUIRY',
  'ABUSE_SPAM',
]);

/** @type {Readonly<Record<Intent, string>>} One-line definitions used verbatim in prompts. */
export const INTENT_DESCRIPTIONS = Object.freeze({
  ORDER_STATUS: 'Where is my order, tracking number, delivery ETA for an order in transit',
  RETURN_REFUND: 'Wants to return an item or asks about the status of a refund',
  ACCOUNT_ACCESS: 'Log-in problems, password reset, locked/closed account, account details',
  PRODUCT_COMPLAINT:
    'Received item is damaged, defective, counterfeit, wrong item or not as described',
  DELIVERY_ISSUE:
    'Order was marked delivered but never arrived, lost package, wrong delivery address',
  BILLING_DISPUTE:
    'Incorrect, duplicate or unrecognised charge; price mismatch; fraud on a payment method',
  GENERAL_INQUIRY: 'Any legitimate support question that fits none of the above',
  ABUSE_SPAM: 'Not a genuine support request: spam, advertising, abuse, politics, bots',
});

/**
 * Intents whose *only* correct handling is a human hand-off.
 *
 * `BILLING_DISPUTE` is deliberately NOT listed: MAIN.md §4.6 makes only the
 * `> $100` slice of billing disputes a hard rule and leaves cheaper disputes to
 * the LLM review, which keeps the grey-zone path exercised and measurable.
 *
 * @type {ReadonlyArray<Intent>}
 */
export const ALWAYS_ESCALATE_INTENTS = Object.freeze(['ABUSE_SPAM']);

/**
 * @param {unknown} value - Candidate label.
 * @returns {boolean} `true` when `value` is exactly a canonical intent.
 */
export function isIntent(value) {
  return typeof value === 'string' && INTENTS.includes(/** @type {Intent} */ (value));
}

/**
 * Coerce a model-produced label into a canonical intent.
 *
 * Models occasionally answer `order status`, `"ORDER_STATUS"` or
 * `the intent is ORDER_STATUS.` — all three must resolve, and falls back to
 * `GENERAL_INQUIRY` only when nothing matches (never throws mid-pipeline).
 *
 * @param {unknown} raw - Raw model output.
 * @returns {{ intent: Intent, matched: boolean }} Canonical intent plus whether it was exact.
 */
export function normalizeIntentLabel(raw) {
  if (typeof raw !== 'string') return { intent: 'GENERAL_INQUIRY', matched: false };

  const normalized = raw
    .toUpperCase()
    .replace(/[^A-Z]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (isIntent(normalized)) return { intent: normalized, matched: true };

  // Look for the longest canonical label contained anywhere in the answer.
  const contained = INTENTS.filter((intent) => normalized.includes(intent)).sort(
    (a, b) => b.length - a.length,
  );
  if (contained.length > 0) return { intent: contained[0], matched: false };

  return { intent: 'GENERAL_INQUIRY', matched: false };
}

/**
 * Render the taxonomy as a prompt-ready bullet list.
 *
 * @returns {string} Markdown-style bullets, one per intent.
 */
export function formatIntentTaxonomy() {
  return INTENTS.map((intent) => `- ${intent}: ${INTENT_DESCRIPTIONS[intent]}`).join('\n');
}
