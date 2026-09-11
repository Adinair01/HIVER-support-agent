import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  HUMAN_SCORE_COLUMNS,
  LLM_SCORE_COLUMNS,
  computeAgreement,
  readJudgeSampleCsv,
} from '../src/services/judge.agreement.js';
import { toCsv } from '../src/utils/sampling.js';

/** Build one sample row: human and judge scores per dimension. */
function sampleRow(threadId, human, judge) {
  return [
    threadId,
    `message ${threadId}`,
    `reply ${threadId}`,
    ...judge,
    judge.every((value) => value !== '') ? judge.reduce((sum, value) => sum + value, 0) : '',
    ...human,
    '',
  ];
}

const HEADER = ['thread_id', 'customer_message', 'agent_reply', ...LLM_SCORE_COLUMNS, 'llm_total', ...HUMAN_SCORE_COLUMNS, 'notes'];

describe('judge agreement', () => {
  it('exposes the CSV contract the exporter must match', () => {
    assert.deepEqual(HUMAN_SCORE_COLUMNS, [
      'human_score_groundedness',
      'human_score_tone_match',
      'human_score_resolution_likelihood',
      'human_score_conciseness',
    ]);
    assert.deepEqual(LLM_SCORE_COLUMNS, [
      'llm_score_groundedness',
      'llm_score_tone_match',
      'llm_score_resolution_likelihood',
      'llm_score_conciseness',
    ]);
  });

  it('reports agreement as 1 when human and judge score identically', () => {
    const report = computeAgreement(
      [1, 2, 3].map((index) => {
        const record = {};
        HEADER.forEach((column, position) => {
          record[column] = String(sampleRow(String(index), [3, 2, 3, 2], [3, 2, 3, 2])[position] ?? '');
        });
        return record;
      }),
    );

    assert.equal(report.ready, true);
    assert.equal(report.compared, 3);
    assert.equal(report.total.kappa, 1);
    assert.equal(report.dimensions.groundedness.kappa, 1);
    assert.equal(report.dimensions.groundedness.meanBias, 0);
    assert.equal(report.total.meanHumanTotal, 10);
    assert.equal(report.total.meanJudgeTotal, 10);
  });

  it('detects a systematically lenient judge', () => {
    const records = [
      ['1', [2, 2, 2, 2], [3, 3, 3, 3]],
      ['2', [1, 1, 1, 1], [3, 3, 3, 3]],
      ['3', [2, 2, 2, 2], [3, 3, 3, 3]],
    ].map(([id, human, judge]) => {
      const record = {};
      HEADER.forEach((column, position) => {
        record[column] = String(sampleRow(id, human, judge)[position] ?? '');
      });
      return record;
    });

    const report = computeAgreement(records);

    assert.equal(report.ready, true);
    assert.ok(report.dimensions.groundedness.meanBias > 0, 'bias is positive when the judge scores higher');
    assert.ok(report.total.kappa < 0.5, 'low agreement is reported as low, not rounded up');
  });

  it('is not ready until the human columns are filled', () => {
    const record = {};
    HEADER.forEach((column, position) => {
      record[column] = String(sampleRow('1', ['', '', '', ''], [3, 2, 3, 2])[position] ?? '');
    });

    const report = computeAgreement([record]);

    assert.equal(report.ready, false);
    assert.equal(report.compared, 0);
    assert.match(report.reason, /human columns first/);
  });

  it('handles an empty sample file', () => {
    const report = computeAgreement([]);
    assert.equal(report.ready, false);
    assert.match(report.reason, /no rows/);
  });

  it('ignores out-of-range scores rather than inflating agreement', () => {
    const record = {};
    HEADER.forEach((column, position) => {
      record[column] = String(sampleRow('1', [9, 2, 3, 2], [3, 2, 3, 2])[position] ?? '');
    });

    const report = computeAgreement([record]);
    assert.equal(report.ready, false, 'a 9/3 score is invalid, so no total can be compared');
  });

  it('compares only the rows that have both sides scored', () => {
    const complete = {};
    const incomplete = {};
    HEADER.forEach((column, position) => {
      complete[column] = String(sampleRow('1', [3, 3, 3, 3], [3, 3, 3, 3])[position] ?? '');
      incomplete[column] = String(sampleRow('2', ['', '', '', ''], [1, 1, 1, 1])[position] ?? '');
    });

    const report = computeAgreement([complete, incomplete]);
    assert.equal(report.ready, true);
    assert.equal(report.n, 2);
    assert.equal(report.compared, 1);
  });

  it('reads a CSV written by the exporter and survives quoted newlines', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'hiver-judge-'));
    const csvPath = path.join(directory, 'judge_sample_30.csv');

    // The awkward message is placed in the row *before* serialisation so the
    // writer is the thing being exercised (it must quote the field itself).
    const first = sampleRow('gs-001', [3, 3, 2, 3], [3, 2, 2, 3]);
    first[1] = 'message gs-001, with a comma and "quotes" and a\nnewline';

    await writeFile(
      csvPath,
      toCsv(HEADER, [first, sampleRow('gs-002', [2, 2, 2, 2], [2, 2, 2, 2])]),
      'utf8',
    );

    const records = readJudgeSampleCsv(csvPath);
    const report = computeAgreement(records);

    assert.equal(records.length, 2);
    assert.match(records[0].customer_message, /with a comma and "quotes" and a\nnewline/);
    assert.equal(report.ready, true);
    assert.equal(report.compared, 2);
    assert.ok(report.total.kappa >= 0);
  });

  it('gives an actionable error when the sample file is missing', () => {
    assert.throws(
      () => readJudgeSampleCsv('/tmp/definitely-not-here-judge-sample.csv'),
      (error) => {
        assert.equal(error.statusCode, 503);
        assert.equal(error.code, 'JUDGE_SAMPLE_MISSING');
        return true;
      },
    );
  });
});

after(() => {
  // Nothing to tear down: fixtures live in the OS temp directory.
});
