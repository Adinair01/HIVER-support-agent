import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// The LLM classifier module imports config/env, which validates at startup.
// Provide throwaway values so these unit tests need no .env and no network.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/hiver_test_unused';
process.env.GROQ_API_KEY = 'groq-test-key-1234567890abcdef';

const { classifyByKeywords, KEYWORD_RULES } = await import('../src/services/classifier.keyword.js');
const { parseClassifierResponse } = await import('../src/services/classifier.llm.js');
const { INTENTS, INTENT_DESCRIPTIONS, formatIntentTaxonomy, normalizeIntentLabel, isIntent } =
  await import('../src/utils/intents.js');

describe('intent taxonomy', () => {
  it('defines 8 unique intents, each with a description', () => {
    assert.equal(INTENTS.length, 8);
    assert.equal(new Set(INTENTS).size, INTENTS.length);
    for (const intent of INTENTS) {
      assert.ok(INTENT_DESCRIPTIONS[intent], `${intent} needs a description`);
      assert.ok(isIntent(intent));
    }
  });

  it('renders every intent into the prompt-ready taxonomy', () => {
    const rendered = formatIntentTaxonomy();
    for (const intent of INTENTS) assert.match(rendered, new RegExp(intent));
  });

  it('normalises exact, messy and prose-wrapped labels', () => {
    assert.deepEqual(normalizeIntentLabel('RETURN_REFUND'), { intent: 'RETURN_REFUND', matched: true });
    assert.deepEqual(normalizeIntentLabel('order status'), { intent: 'ORDER_STATUS', matched: true });
    assert.deepEqual(normalizeIntentLabel('  account-access  '), {
      intent: 'ACCOUNT_ACCESS',
      matched: true,
    });
    assert.deepEqual(normalizeIntentLabel('the intent is DELIVERY_ISSUE.'), {
      intent: 'DELIVERY_ISSUE',
      matched: false,
    });
    assert.deepEqual(normalizeIntentLabel('totally_unknown'), {
      intent: 'GENERAL_INQUIRY',
      matched: false,
    });
    assert.deepEqual(normalizeIntentLabel(null), { intent: 'GENERAL_INQUIRY', matched: false });
  });
});

describe('keyword baseline (variant: keyword)', () => {
  const cases = [
    ['Where is my order? It has been 6 days with no tracking update.', 'ORDER_STATUS'],
    ['I want a refund for this order, how do I send it back?', 'RETURN_REFUND'],
    ['I am locked out of my account and the password reset email never arrives.', 'ACCOUNT_ACCESS'],
    ['The blender arrived damaged and the lid is cracked.', 'PRODUCT_COMPLAINT'],
    ['Tracking says delivered but I never received the package.', 'DELIVERY_ISSUE'],
    ['You charged me twice for the same order this month.', 'BILLING_DISPUTE'],
    ['Do you offer gift wrapping for Prime members?', 'GENERAL_INQUIRY'],
    ['Buy followers cheap, dm me for crypto trading signals!', 'ABUSE_SPAM'],
  ];

  for (const [message, expected] of cases) {
    it(`classifies "${message.slice(0, 40)}…" as ${expected}`, () => {
      const result = classifyByKeywords(message);
      assert.equal(result.intent, expected);
      assert.ok(result.confidence >= 0.35 && result.confidence <= 0.95, 'confidence stays in range');
    });
  }

  it('is deterministic for the same input', () => {
    const message = 'My package says delivered but nothing arrived, I want a refund now';
    assert.deepEqual(classifyByKeywords(message), classifyByKeywords(message));
  });

  it('falls back to GENERAL_INQUIRY with floor confidence when nothing matches', () => {
    const result = classifyByKeywords('hmm ok');
    assert.equal(result.intent, 'GENERAL_INQUIRY');
    assert.equal(result.confidence, 0.35);
    assert.deepEqual(result.matchedRules, []);
  });

  it('reports the rules it matched, for explainability', () => {
    const result = classifyByKeywords('I was charged twice and I need a refund');
    assert.ok(result.matchedRules.length >= 2);
    assert.ok(result.matchedRules.every((rule) => rule.includes(':')));
    assert.ok(result.scores.BILLING_DISPUTE >= 2);
  });

  it('handles noisy tweet text (urls, mentions, entities)', () => {
    const result = classifyByKeywords(
      '@AmazonHelp https://t.co/abc123 my RETURN &amp; refund is still pending',
    );
    assert.equal(result.intent, 'RETURN_REFUND');
  });

  it('has a rule list for every intent except GENERAL_INQUIRY', () => {
    for (const intent of INTENTS) {
      if (intent === 'GENERAL_INQUIRY') continue;
      assert.ok(Array.isArray(KEYWORD_RULES[intent]), `${intent} should have keyword rules`);
      assert.ok(KEYWORD_RULES[intent].length > 0, `${intent} rules must not be empty`);
    }
  });
});

describe('LLM classifier response parsing', () => {
  it('parses a fenced JSON answer', () => {
    const result = parseClassifierResponse(
      '```json\n{"intent": "DELIVERY_ISSUE", "confidence": 0.82, "rationale": "package missing"}\n```',
    );
    assert.equal(result.intent, 'DELIVERY_ISSUE');
    assert.equal(result.confidence, 0.82);
    assert.equal(result.parseError, null);
  });

  it('repairs trailing commas and surrounding prose', () => {
    const result = parseClassifierResponse(
      'Sure! Here is the classification:\n{"intent": "ACCOUNT_ACCESS", "confidence": 0.7,}\nHope that helps.',
    );
    assert.equal(result.intent, 'ACCOUNT_ACCESS');
  });

  it('clamps out-of-range confidence into [0, 1]', () => {
    assert.equal(parseClassifierResponse('{"intent": "ORDER_STATUS", "confidence": 4}').confidence, 1);
    assert.equal(parseClassifierResponse('{"intent": "ORDER_STATUS", "confidence": -2}').confidence, 0);
  });

  it('degrades to GENERAL_INQUIRY at floor confidence when output is unusable', () => {
    const result = parseClassifierResponse('I cannot answer that.');
    assert.equal(result.intent, 'GENERAL_INQUIRY');
    assert.equal(result.confidence, 0.3);
    assert.ok(result.parseError);
  });

  it('flags labels that are outside the taxonomy', () => {
    const result = parseClassifierResponse('{"intent": "SHIPPING_PROBLEM", "confidence": 0.9}');
    assert.equal(result.intent, 'GENERAL_INQUIRY');
    assert.equal(result.confidence, 0.9, 'confidence is preserved even when the label is not');
    assert.ok(result.parseError.includes('SHIPPING_PROBLEM'));
  });
});
