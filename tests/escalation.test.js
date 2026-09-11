import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// `decideEscalation` reaches the model client through the escalation service,
// which validates env at startup. Stub the values so the hybrid decision can be
// tested offline without an API key.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/hiver_test_unused';
process.env.GROQ_API_KEY = 'groq-test-key-1234567890abcdef';

const { decideEscalation } = await import('../src/services/escalation.service.js');
const {
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_MONEY_THRESHOLD,
  ESCALATION_PHRASES,
  evaluateEscalationRules,
  isShouting,
} = await import('../src/services/escalation.rules.js');
const { extractMaxDollarAmount } = await import('../src/utils/text.js');

/** Helper: run the rules for one message. */
function rules(message, intent, confidence = 0.9) {
  return evaluateEscalationRules({ message, intent, classifierConfidence: confidence });
}

/** Helper: does the outcome include a given flag code? */
function hasFlag(outcome, code) {
  return outcome.flags.some((flag) => flag.code === code);
}

describe('escalation rules', () => {
  it('does not escalate a routine, confident, self-serve question', () => {
    const outcome = rules('Where is my order? I cannot find the tracking link.', 'ORDER_STATUS', 0.9);
    assert.equal(outcome.triggered, false);
    assert.equal(outcome.reason, null);
    assert.equal(outcome.triggeredBy, null);
    assert.deepEqual(outcome.flags, []);
  });

  it('escalates legal threats', () => {
    const outcome = rules('This is the last time I ask before I talk to my lawyer.', 'GENERAL_INQUIRY');
    assert.equal(outcome.triggered, true);
    assert.equal(hasFlag(outcome, 'legal_threat'), true);
    assert.equal(outcome.triggeredBy, 'rule');
  });

  it('escalates fraud and unauthorised-charge language', () => {
    const outcome = rules('Someone hacked my account and made a fraudulent order.', 'ACCOUNT_ACCESS');
    assert.equal(hasFlag(outcome, 'fraud_or_unauthorized'), true);
  });

  it('escalates a billing dispute above the money threshold', () => {
    const outcome = rules('You charged me $249.99 for an order I cancelled.', 'BILLING_DISPUTE');
    assert.equal(hasFlag(outcome, 'high_value_billing'), true);
    assert.equal(outcome.triggered, true);
  });

  it('leaves a cheap billing dispute to the LLM grey zone', () => {
    const outcome = rules('I was charged $12 twice for the same ebook.', 'BILLING_DISPUTE');
    assert.equal(hasFlag(outcome, 'high_value_billing'), false);
    assert.equal(outcome.triggered, false);
  });

  it('escalates angry sentiment and shouting', () => {
    assert.equal(hasFlag(rules('This is absolutely unacceptable service.', 'GENERAL_INQUIRY'), 'angry_sentiment'), true);
    assert.equal(isShouting('THIS IS THE THIRD TIME I HAVE ASKED ABOUT THIS'), true);
    assert.equal(isShouting('this is the third time i have asked about this'), false);
    assert.equal(isShouting('TOO SHORT'), false, 'short messages are not treated as shouting');
  });

  it('always escalates abuse or spam before any public reply', () => {
    const outcome = rules('Buy followers now, dm me!', 'ABUSE_SPAM');
    assert.equal(hasFlag(outcome, 'abuse_or_spam'), true);
  });

  it('escalates low-confidence classifications', () => {
    const outcome = rules('Something about my thing is off.', 'GENERAL_INQUIRY', 0.4);
    assert.equal(hasFlag(outcome, 'low_confidence'), true);
    assert.equal(DEFAULT_CONFIDENCE_THRESHOLD, 0.6);
  });

  it('escalates when confidence is missing entirely', () => {
    const outcome = evaluateEscalationRules({
      message: 'Where is my order?',
      intent: 'ORDER_STATUS',
      classifierConfidence: undefined,
    });
    assert.equal(hasFlag(outcome, 'low_confidence'), true);
  });

  it('exposes documented thresholds and phrase lists for the report', () => {
    assert.equal(DEFAULT_MONEY_THRESHOLD, 100);
    for (const group of ['legal', 'fraud', 'angry', 'threatening']) {
      assert.ok(ESCALATION_PHRASES[group].length > 0, `${group} phrase list must not be empty`);
    }
  });
});

describe('money extraction', () => {
  const cases = [
    ['I was charged $85.50 for one item', 85.5],
    ['the total was 1,299 dollars which is wrong', 1299],
    ['they took 50 usd from my card', 50],
    ['this cost a hundred dollars', 100],
    ['no amount here at all', 0],
    ['charged $20 and then $310 later', 310],
  ];

  for (const [message, expected] of cases) {
    it(`extracts ${expected} from "${message}"`, () => {
      assert.equal(extractMaxDollarAmount(message), expected);
    });
  }
});

describe('hybrid escalation decision', () => {
  it('short-circuits to escalate on a rule hit without calling the LLM', async () => {
    const decision = await decideEscalation({
      message: 'I will contact my lawyer and the BBB about this fraud.',
      intent: 'BILLING_DISPUTE',
      classifierConfidence: 0.95,
    });

    assert.equal(decision.decision, 'escalate');
    assert.equal(decision.triggeredBy, 'rule');
    assert.equal(decision.llmReviewed, false);
    assert.ok(decision.reason.includes('rule'));
  });

  it('returns auto when no rule fires and LLM review is skipped', async () => {
    const decision = await decideEscalation({
      message: 'What is the return window for electronics?',
      intent: 'RETURN_REFUND',
      classifierConfidence: 0.9,
      skipLlmReview: true,
    });

    assert.equal(decision.decision, 'auto');
    assert.equal(decision.triggeredBy, 'rule');
    assert.equal(decision.llmReviewed, false);
    assert.deepEqual(decision.flags, []);
  });

  it('never returns auto without an explicit decision path', async () => {
    const decision = await decideEscalation({
      message: 'My package arrived with a broken screen.',
      intent: 'PRODUCT_COMPLAINT',
      classifierConfidence: 0.8,
      skipLlmReview: true,
    });
    assert.ok(['auto', 'escalate'].includes(decision.decision));
    assert.ok(decision.reason.length > 0, 'every decision carries a reason');
  });
});
