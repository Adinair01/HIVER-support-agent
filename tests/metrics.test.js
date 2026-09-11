import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  accuracy,
  assembleEvaluationMetrics,
  classificationReport,
  confusionMatrix,
  escalationReport,
  summarizeReplyQuality,
} from '../src/utils/metrics.js';

const LABELS = ['ORDER_STATUS', 'RETURN_REFUND'];

describe('classification metrics', () => {
  it('computes accuracy while ignoring unparsed predictions', () => {
    const score = accuracy([
      { expected: 'ORDER_STATUS', predicted: 'ORDER_STATUS' },
      { expected: 'ORDER_STATUS', predicted: 'RETURN_REFUND' },
      { expected: 'RETURN_REFUND', predicted: 'RETURN_REFUND' },
      { expected: 'RETURN_REFUND', predicted: null },
    ]);
    assert.equal(score, 0.6667);
  });

  it('returns 0 for an empty comparison set', () => {
    assert.equal(accuracy([]), 0);
    assert.equal(accuracy([{ expected: 'A', predicted: null }]), 0);
  });

  it('computes per-intent precision, recall and F1', () => {
    const report = classificationReport(
      [
        { expected: 'ORDER_STATUS', predicted: 'ORDER_STATUS' },
        { expected: 'ORDER_STATUS', predicted: 'RETURN_REFUND' },
        { expected: 'RETURN_REFUND', predicted: 'RETURN_REFUND' },
        { expected: 'RETURN_REFUND', predicted: 'GENERAL_INQUIRY' },
      ],
      LABELS,
    );

    assert.deepEqual(report.perIntent.ORDER_STATUS, { precision: 1, recall: 0.5, f1: 0.6667, support: 2 });
    assert.deepEqual(report.perIntent.RETURN_REFUND, { precision: 0.5, recall: 0.5, f1: 0.5, support: 2 });
    // The macro average is taken over the already-rounded per-intent F1 values.
    assert.deepEqual(report.macro, { precision: 0.75, recall: 0.5, f1: 0.5834 });
  });

  it('builds a confusion matrix with an unparsed bucket', () => {
    const matrix = confusionMatrix(
      [
        { expected: 'ORDER_STATUS', predicted: 'ORDER_STATUS' },
        { expected: 'ORDER_STATUS', predicted: 'RETURN_REFUND' },
        { expected: 'RETURN_REFUND', predicted: null },
        { expected: 'ORDER_STATUS', predicted: 'SOMETHING_ELSE' },
      ],
      LABELS,
    );

    assert.equal(matrix.ORDER_STATUS.ORDER_STATUS, 1);
    assert.equal(matrix.ORDER_STATUS.RETURN_REFUND, 1);
    assert.equal(matrix.RETURN_REFUND.__unparsed, 1);
    assert.equal(matrix.ORDER_STATUS.__unparsed, 1, 'unknown labels are counted as unparsed');
    assert.equal(matrix.RETURN_REFUND.RETURN_REFUND, 0);
  });

  it('handles an intent with no predictions', () => {
    const report = classificationReport([{ expected: 'ORDER_STATUS', predicted: 'ORDER_STATUS' }], LABELS);
    assert.equal(report.perIntent.RETURN_REFUND.precision, 0);
    assert.equal(report.perIntent.RETURN_REFUND.support, 0);
    assert.equal(report.macro.precision, 1, 'labels without support are excluded from the macro average');
  });
});

describe('escalation metrics', () => {
  it('computes precision, recall, F1, accuracy and the confusion counts', () => {
    const report = escalationReport([
      { expected: true, predicted: true },
      { expected: false, predicted: true },
      { expected: true, predicted: false },
      { expected: false, predicted: false },
    ]);

    assert.deepEqual(report, {
      precision: 0.5,
      recall: 0.5,
      f1: 0.5,
      accuracy: 0.5,
      tp: 1,
      fp: 1,
      fn: 1,
      tn: 1,
    });
  });

  it('never divides by zero', () => {
    const report = escalationReport([{ expected: false, predicted: false }]);
    assert.equal(report.precision, 0);
    assert.equal(report.recall, 0);
    assert.equal(report.accuracy, 1);
  });
});

describe('reply quality summary', () => {
  it('aggregates ROUGE-L, coverage, length and missing keywords', () => {
    const summary = summarizeReplyQuality([
      { rougeL: 0.5, coverage: 0.5, appropriate: true, wordCount: 20, missing: ['tracking'] },
      { rougeL: 1, coverage: 1, appropriate: false, wordCount: 1, missing: ['tracking', 'refund'] },
    ]);

    assert.equal(summary.evaluated, 2);
    assert.equal(summary.meanRougeL, 0.75);
    assert.equal(summary.meanKeywordCoverage, 0.75);
    assert.equal(summary.lengthAppropriateRate, 0.5);
    assert.equal(summary.meanWordCount, 10.5);
    assert.deepEqual(summary.topMissingKeywords, [
      { keyword: 'tracking', count: 2 },
      { keyword: 'refund', count: 1 },
    ]);
  });

  it('returns zeros when there is nothing to evaluate', () => {
    const summary = summarizeReplyQuality([]);
    assert.equal(summary.evaluated, 0);
    assert.equal(summary.meanRougeL, 0);
    assert.deepEqual(summary.topMissingKeywords, []);
  });
});

describe('run-level assembly', () => {
  const rowResults = [
    {
      threadId: 't1',
      expectedIntent: 'ORDER_STATUS',
      expectedEscalation: false,
      predictions: {
        keyword: { intent: 'ORDER_STATUS', confidence: 0.75 },
        'few-shot': { intent: 'ORDER_STATUS', confidence: 0.9 },
      },
      escalation: { decision: 'auto', triggeredBy: 'rule', predicted: false },
      reply: { rougeL: 0.6, coverage: 0.5, appropriate: true, wordCount: 18, missing: ['tracking'], degraded: false },
    },
    {
      threadId: 't2',
      expectedIntent: 'BILLING_DISPUTE',
      expectedEscalation: true,
      predictions: {
        keyword: { intent: 'RETURN_REFUND', confidence: 0.6 },
        'few-shot': { intent: 'BILLING_DISPUTE', confidence: 0.95 },
      },
      escalation: { decision: 'escalate', triggeredBy: 'rule', predicted: true },
      reply: { rougeL: 0.4, coverage: 0.5, appropriate: false, wordCount: 3, missing: ['refund'], degraded: true },
    },
  ];

  const judgeResults = [
    { valid: true, total: 10, scores: { groundedness: 3 }, humanScore: 11 },
    { valid: true, total: 3, scores: { groundedness: 1 }, humanScore: 2 },
    { valid: false, total: 0, scores: {}, humanScore: null },
  ];

  const metrics = assembleEvaluationMetrics({
    rowResults,
    variants: ['keyword', 'few-shot'],
    productionVariant: 'few-shot',
    judgeResults,
  });

  it('reports accuracy for every variant, showing the production gain', () => {
    assert.equal(metrics.classification.keyword.accuracy, 0.5);
    assert.equal(metrics.classification['few-shot'].accuracy, 1);
  });

  it('reports escalation precision/recall for the production variant', () => {
    assert.equal(metrics.escalation.productionVariant, 'few-shot');
    assert.equal(metrics.escalation.precision, 1);
    assert.equal(metrics.escalation.recall, 1);
    assert.deepEqual(metrics.escalation.byTrigger, { rule: 2 });
    assert.equal(metrics.escalation.decidedByRules, 2);
  });

  it('aggregates reply quality and the degraded rate', () => {
    assert.equal(metrics.replyQuality.meanRougeL, 0.5);
    assert.equal(metrics.replyQuality.degradedRate, 0.5);
  });

  it('summarises the judge and computes agreement on human-scored rows only', () => {
    assert.equal(metrics.judge.summary.valid, 2);
    assert.equal(metrics.judge.summary.meanTotal, 6.5);
    assert.equal(metrics.judge.agreement.humanScoredRows, 2);
    assert.equal(metrics.judge.agreement.kappa, 1, 'both rows agree on the same bucket');
  });
});
