import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// The controller imports services, which validate env at startup.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/hiver_test_unused';
process.env.GROQ_API_KEY = 'groq-test-key-1234567890abcdef';

const { serialisePipelineResponse } = await import('../src/controllers/agent.controller.js');

/** A realistic pipeline result, shaped exactly as `runSupportPipeline` returns it. */
const pipelineResult = {
  requestId: 'req-123',
  threadId: 'gs-001',
  customerMessage: 'Tracking says delivered but I never received it.',
  classification: {
    intent: 'DELIVERY_ISSUE',
    confidence: 0.95,
    variant: 'few-shot',
    rationale: 'Customer reports a missing delivery.',
    matchedRules: [],
    degraded: false,
    parseError: null,
  },
  retrieval: {
    searchQuery: 'tracking delivered never received',
    evidence: [
      {
        threadId: '99887766',
        similarityScore: 1,
        resolutionSummary: 'Agent asked for the order number and opened a claim.',
        messageCount: 3,
        resolvedAt: '2020-10-05T12:00:00.000Z',
      },
    ],
  },
  response: { draft: 'Please send the order number so we can open a claim.', confidence: 0.8, sourcedFrom: ['99887766'], degraded: false },
  escalation: {
    decision: 'escalate',
    reason: 'Escalated by rule "fraud_or_unauthorized": mentions police report.',
    triggeredBy: 'rule',
    flags: [{ code: 'fraud_or_unauthorized', detail: 'mentions police report' }],
    llmReviewed: false,
  },
  timings: { classification: 900, retrieval: 12, response: 1400, escalation: 2 },
  degraded: [],
};

describe('POST /api/agent/process response shape', () => {
  const body = serialisePipelineResponse(pipelineResult);

  it('exposes the documented flat contract', () => {
    assert.equal(body.intent, 'DELIVERY_ISSUE');
    assert.equal(body.confidence, 0.95);
    assert.equal(typeof body.reply.draft, 'string');
    assert.deepEqual(body.reply.sourcedFrom, ['99887766']);
    assert.equal(body.escalation.decision, 'escalate');
    assert.equal(body.escalation.triggeredBy, 'rule');
    assert.ok(body.escalation.reason.length > 0);
  });

  it('keeps the supporting detail without mutating the service contract', () => {
    assert.equal(body.classifier.variant, 'few-shot');
    assert.equal(body.replyDetail.degraded, false);
    assert.equal(body.escalationDetail.llmReviewed, false);
    assert.equal(body.evidence.length, 1);
    assert.equal(body.retrievalQuery, 'tracking delivered never received');
    assert.equal(body.timings.response, 1400);
    assert.equal(body.requestId, 'req-123');
  });

  it('does not leak the raw customer message back to the caller', () => {
    assert.equal('customerMessage' in body, false);
  });

  it('survives a degraded, partially-populated pipeline result', () => {
    const degraded = serialisePipelineResponse({
      requestId: 'req-456',
      classification: { intent: 'ORDER_STATUS', confidence: 0.6, variant: 'keyword', degraded: true },
      retrieval: { searchQuery: '', evidence: [] },
      response: { draft: 'Template reply.', degraded: true },
      escalation: { decision: 'auto', reason: 'No rule triggered.', triggeredBy: 'rule' },
      degraded: ['classification', 'response'],
    });

    assert.equal(degraded.intent, 'ORDER_STATUS');
    assert.equal(degraded.reply.sourcedFrom.length, 0);
    assert.deepEqual(degraded.escalationDetail.flags, []);
    assert.deepEqual(degraded.degraded, ['classification', 'response']);
  });

  it('always emits a complete object, even from an empty result', () => {
    const empty = serialisePipelineResponse({});

    assert.equal(empty.intent, null);
    assert.equal(empty.confidence, 0);
    assert.equal(empty.reply.draft, '');
    assert.equal(empty.escalation.decision, 'escalate', 'fails safe when nothing is known');
    assert.ok(empty.escalation.reason.length > 0);
  });
});
