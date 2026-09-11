import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyBodySchema,
  processBodySchema,
  threadParamsSchema,
} from '../src/validators/agent.validator.js';
import {
  listResultsQuerySchema,
  runEvalBodySchema,
  runIdParamsSchema,
} from '../src/validators/eval.validator.js';

describe('agent body validation', () => {
  it('applies documented defaults to the process endpoint', () => {
    const parsed = processBodySchema.parse({ message: 'Where is my order please?' });
    assert.equal(parsed.variant, 'few-shot');
    assert.equal(parsed.useRetrieval, true);
    assert.equal(parsed.classifyOnly, false);
    assert.equal(parsed.skipLlmEscalation, false);
  });

  it('rejects messages that are too short or too long', () => {
    assert.equal(processBodySchema.safeParse({ message: 'hi' }).success, false);
    assert.equal(processBodySchema.safeParse({ message: 'x'.repeat(1001) }).success, false);
    assert.equal(processBodySchema.safeParse({ message: 'x'.repeat(1000) }).success, true);
  });

  it('rejects unknown classifier variants', () => {
    const result = classifyBodySchema.safeParse({ message: 'Where is my order?', variant: 'magic' });
    assert.equal(result.success, false);
    assert.match(result.error.issues[0].message, /Invalid option|expected one of/i);
  });

  it('trims the message and accepts a valid variant override', () => {
    const parsed = classifyBodySchema.parse({
      message: '  My parcel never arrived  ',
      variant: 'keyword',
      threadId: '1234567890',
    });
    assert.equal(parsed.message, 'My parcel never arrived');
    assert.equal(parsed.variant, 'keyword');
    assert.equal(parsed.threadId, '1234567890');
  });

  it('strips unknown keys from the body', () => {
    const parsed = classifyBodySchema.parse({ message: 'Where is my order?', evil: 'payload' });
    assert.equal('evil' in parsed, false);
  });

  it('requires a thread id on the params schema', () => {
    assert.equal(threadParamsSchema.safeParse({}).success, false);
    assert.deepEqual(threadParamsSchema.parse({ id: ' abc ' }), { id: 'abc' });
  });
});

describe('eval validation', () => {
  it('defaults generateReplies and storeResult to true', () => {
    const parsed = runEvalBodySchema.parse({});
    assert.equal(parsed.generateReplies, true);
    assert.equal(parsed.storeResult, true);
  });

  it('coerces numeric strings for judgeSampleSize and limit', () => {
    const parsed = runEvalBodySchema.parse({ judgeSampleSize: '30', limit: '40' });
    assert.equal(parsed.judgeSampleSize, 30);
    assert.equal(parsed.limit, 40);
  });

  it('lets the judge be disabled with 0', () => {
    assert.equal(runEvalBodySchema.parse({ judgeSampleSize: 0 }).judgeSampleSize, 0);
  });

  it('rejects invalid variants and out-of-range sample sizes', () => {
    assert.equal(runEvalBodySchema.safeParse({ variants: ['keyword', 'other'] }).success, false);
    assert.equal(runEvalBodySchema.safeParse({ judgeSampleSize: 500 }).success, false);
    assert.equal(runEvalBodySchema.safeParse({ variants: [] }).success, false);
  });

  it('rejects unknown keys outright, so the harness cannot be misconfigured silently', () => {
    assert.equal(runEvalBodySchema.safeParse({ variant: 'keyword' }).success, false);
  });

  it('defaults the results list limit and rejects nonsense', () => {
    assert.equal(listResultsQuerySchema.parse({}).limit, 25);
    assert.equal(listResultsQuerySchema.parse({ limit: '5' }).limit, 5);
    assert.equal(listResultsQuerySchema.safeParse({ limit: 0 }).success, false);
  });

  it('requires a runId param', () => {
    assert.equal(runIdParamsSchema.safeParse({ runId: ' ' }).success, false);
    assert.equal(runIdParamsSchema.safeParse({ runId: 'eval-123' }).success, true);
  });
});
