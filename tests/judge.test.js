import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_RUBRIC_SCORE, RUBRIC_DIMENSIONS } from '../src/prompts/judge.prompt.js';
import {
  cohenKappa,
  keywordCoverage,
  lengthAppropriateness,
  normalizeJudgeScores,
  rougeL,
  scoreBucket,
  summarizeJudge,
} from '../src/utils/metrics.js';

describe('judge rubric', () => {
  it('defines the 4 dimensions from MAIN.md §5.3 with a 12-point maximum', () => {
    assert.deepEqual(
      RUBRIC_DIMENSIONS.map((dimension) => dimension.key),
      ['groundedness', 'toneMatch', 'resolutionLikelihood', 'conciseness'],
    );
    assert.equal(MAX_RUBRIC_SCORE, 12);
  });

  it('totals a complete judge verdict', () => {
    const verdict = normalizeJudgeScores({
      groundedness: 3,
      toneMatch: 2,
      resolutionLikelihood: 3,
      conciseness: 1,
      notes: 'clear next step',
    });

    assert.equal(verdict.valid, true);
    assert.equal(verdict.total, 9);
    assert.equal(verdict.maxTotal, 12);
    assert.equal(verdict.notes, 'clear next step');
    assert.equal(verdict.problem, null);
  });

  it('clamps and rounds out-of-range dimension scores', () => {
    const verdict = normalizeJudgeScores({
      groundedness: 5,
      toneMatch: -1,
      resolutionLikelihood: 2.6,
      conciseness: 0,
    });

    assert.deepEqual(verdict.scores, {
      groundedness: 3,
      toneMatch: 0,
      resolutionLikelihood: 3,
      conciseness: 0,
    });
    assert.equal(verdict.total, 6);
  });

  it('marks an incomplete verdict invalid without throwing', () => {
    const verdict = normalizeJudgeScores({ groundedness: 3, toneMatch: 2 });
    assert.equal(verdict.valid, false);
    assert.match(verdict.problem, /missing dimensions/);
    assert.ok(verdict.problem.includes('conciseness'));
  });

  it('handles non-object judge output', () => {
    const verdict = normalizeJudgeScores('the reply was fine');
    assert.equal(verdict.valid, false);
    assert.equal(verdict.total, 0);
    assert.match(verdict.problem, /not an object/);
  });

  it('summarises a batch by dimension and overall', () => {
    const summary = summarizeJudge([
      { valid: true, total: 12, scores: { groundedness: 3, toneMatch: 3, resolutionLikelihood: 3, conciseness: 3 } },
      { valid: true, total: 6, scores: { groundedness: 2, toneMatch: 2, resolutionLikelihood: 1, conciseness: 1 } },
      { valid: false, total: 0, scores: {} },
    ]);

    assert.equal(summary.judged, 3);
    assert.equal(summary.valid, 2);
    assert.equal(summary.invalid, 1);
    assert.equal(summary.meanTotal, 9);
    assert.equal(summary.normalizedMean, 0.75);
    assert.equal(summary.meanByDimension.groundedness, 2.5);
    assert.equal(summary.meanByDimension.conciseness, 2);
    assert.equal(summary.maxTotal, 12);
  });
});

describe("Cohen's kappa", () => {
  it('returns 1 for perfect agreement', () => {
    const kappa = cohenKappa([
      { a: 'high', b: 'high' },
      { a: 'low', b: 'low' },
      { a: 'medium', b: 'medium' },
    ]);
    assert.equal(kappa.kappa, 1);
    assert.equal(kappa.observedAgreement, 1);
    assert.equal(kappa.n, 3);
  });

  it('returns -1 when agreement is exactly what chance would predict only', () => {
    const kappa = cohenKappa([
      { a: 'high', b: 'low' },
      { a: 'low', b: 'high' },
    ]);
    assert.equal(kappa.observedAgreement, 0);
    assert.equal(kappa.expectedAgreement, 0.5);
    assert.equal(kappa.kappa, -1);
  });

  it('computes a partial agreement in between', () => {
    const kappa = cohenKappa([
      { a: 'high', b: 'high' },
      { a: 'high', b: 'medium' },
      { a: 'low', b: 'low' },
      { a: 'medium', b: 'low' },
    ]);
    assert.ok(kappa.kappa > 0 && kappa.kappa < 1);
  });

  it('ignores missing ratings', () => {
    const kappa = cohenKappa([
      { a: 'high', b: null },
      { a: null, b: 'low' },
      { a: 'low', b: 'low' },
    ]);
    assert.equal(kappa.n, 1);
  });

  it('returns zeros for an empty comparison', () => {
    const kappa = cohenKappa([]);
    assert.equal(kappa.kappa, 0);
    assert.equal(kappa.n, 0);
  });

  it('buckets rubric totals the way the report documents', () => {
    assert.equal(scoreBucket(12), 'high');
    assert.equal(scoreBucket(9), 'high');
    assert.equal(scoreBucket(8), 'medium');
    assert.equal(scoreBucket(6), 'medium');
    assert.equal(scoreBucket(3), 'low');
    assert.equal(scoreBucket(0), 'low');
    assert.equal(scoreBucket(Number.NaN), 'low');
  });
});

describe('automated reply-quality metrics', () => {
  it('scores identical text as a perfect ROUGE-L and disjoint text as zero', () => {
    assert.equal(rougeL('send the order number and we will refund it', 'send the order number and we will refund it'), 1);
    assert.equal(rougeL('banana helicopter', 'refund tracking number'), 0);
  });

  it('returns a partial ROUGE-L when only some tokens overlap', () => {
    const score = rougeL('send the order number so we can check tracking', 'order number|tracking');
    assert.ok(score > 0 && score < 1);
  });

  it('returns 0 for empty inputs instead of NaN', () => {
    assert.equal(rougeL('', 'refund'), 0);
    assert.equal(rougeL('refund', ''), 0);
  });

  it('measures keyword coverage and reports what is missing', () => {
    const result = keywordCoverage('Please send the order number so I can start the refund.', 'order number|tracking|refund');
    assert.equal(result.coverage, 0.6667);
    assert.deepEqual(result.matched, ['order number', 'refund']);
    assert.deepEqual(result.missing, ['tracking']);
  });

  it('handles a row with no keywords', () => {
    assert.deepEqual(keywordCoverage('anything', ''), { coverage: 0, matched: [], missing: [] });
  });

  it('flags replies that are too short or too long', () => {
    assert.deepEqual(lengthAppropriateness('Sorry!'), { wordCount: 1, appropriate: false });
    assert.equal(lengthAppropriateness('Send us the order number and we will check the tracking status right away.').appropriate, true);
    assert.equal(lengthAppropriateness(new Array(120).fill('word').join(' ')).appropriate, false);
  });
});
