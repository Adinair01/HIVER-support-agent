import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RUBRIC_DIMENSIONS } from '../src/prompts/judge.prompt.js';
import {
  HUMAN_SCORE_COLUMNS,
  LLM_SCORE_COLUMNS,
  RUBRIC_COLUMN_SLUGS,
} from '../src/services/judge.agreement.js';
import { selectStridedSample, toCsv } from '../src/utils/sampling.js';
import { heading, parseArgs, print, printPairs, resolvePath, runScript } from './lib/cli.js';

/** @type {string} Where `runEval.js` writes run artifacts. */
const RESULTS_DIR = path.resolve(process.cwd(), 'eval/results');
/** @type {string} Default export path. */
const DEFAULT_OUT = path.resolve(process.cwd(), 'eval/judge_sample_30.csv');

/**
 * `npm run export-judge-sample` — export the judge's scored sample as a worksheet
 * for human scoring, so Cohen's κ can be computed (MAIN.md §5.3).
 *
 * Drafts and judge scores are read from a completed run artifact, so the human
 * scores the exact replies the judge scored — and no quota is spent re-running it.
 *
 * Usage:
 *   npm run export-judge-sample
 *   npm run export-judge-sample -- --file=eval/results/eval-....json --size=30
 */
await runScript('export-judge-sample', async () => {
  const args = parseArgs();
  const outPath = resolvePath(args.out, DEFAULT_OUT);
  const size = args.size ? Number(args.size) : 30;

  const { runId, source, rows, judgeResults } = await loadRun(args);

  if (rows.length === 0) {
    print('That run recorded no per-row results, so there is nothing to judge.');
    process.exitCode = 1;
    return;
  }

  const drafts = rows.filter((row) => row.reply?.draft);
  const sample = selectStridedSample(drafts.length > 0 ? drafts : rows, size);
  const judgeByThreadId = new Map(judgeResults.map((result) => [result.threadId, result]));

  const header = [
    'thread_id',
    'customer_message',
    'agent_reply',
    ...LLM_SCORE_COLUMNS,
    'llm_total',
    ...HUMAN_SCORE_COLUMNS,
    'notes',
  ];

  const cells = sample.map((row) => {
    const judgement = judgeByThreadId.get(row.threadId);
    return [
      row.threadId,
      row.customerMessage ?? '',
      row.reply?.draft ?? '',
      ...RUBRIC_DIMENSIONS.map((dimension) => judgement?.scores?.[dimension.key] ?? ''),
      judgement?.valid ? judgement.total : '',
      '', // human_score_groundedness      — to be filled in by a human
      '', // human_score_tone_match         — to be filled in by a human
      '', // human_score_resolution_likelihood — to be filled in by a human
      '', // human_score_conciseness        — to be filled in by a human
      '', // notes
    ];
  });

  await writeFile(outPath, toCsv(header, cells), 'utf8');

  heading('Judge sample exported');
  printPairs({
    output: outPath,
    runId,
    readFrom: source,
    rows: cells.length,
    rowsWithJudgeScores: sample.filter((row) => judgeByThreadId.get(row.threadId)?.valid).length,
    humanColumnsToFill: HUMAN_SCORE_COLUMNS.join(', '),
  });

  const filled = sample.filter((row) => judgeByThreadId.get(row.threadId)?.valid).length;
  if (filled === 0) {
    print('');
    print('! This run has no judge scores (it ran with --judge=0, or the judge failed).');
    print('  Re-run with the judge enabled to populate the llm_score_* columns:');
    print('    npm run eval -- --judge=30');
  }

  print('');
  heading('Next: score it like a human reviewer');
  for (const dimension of RUBRIC_DIMENSIONS) {
    print(`  human_score_${RUBRIC_COLUMN_SLUGS[dimension.key]}: 0-3 — ${dimension.description}`);
  }
  print('');
  print('  Score each row 0-3 per dimension using ONLY what the reply says.');
  print('  Save the file, then run: npm run eval --judge-agreement');
});

/**
 * Load a run artifact: explicitly named, from MongoDB, or the newest on disk.
 *
 * @param {Record<string, string|boolean>} args - Parsed CLI flags.
 * @returns {Promise<{ runId: string, source: string, rows: Array<object>, judgeResults: Array<object> }>} Run data.
 * @throws {Error} When no run with per-row data can be found.
 */
async function loadRun(args) {
  if (typeof args.file === 'string') {
    const filePath = resolvePath(args.file, '');
    return { ...(await readArtifact(filePath)), source: filePath };
  }

  if (typeof args.run === 'string') {
    const { connectDatabase, disconnectDatabase } = await import('../src/config/db.js');
    const { EvalResult } = await import('../src/models/EvalResult.model.js');
    await connectDatabase();
    const stored = await EvalResult.findByRunId(args.run);
    await disconnectDatabase();
    if (!stored) throw new Error(`No stored eval run with id "${args.run}".`);
    return {
      runId: stored.runId,
      source: `mongodb:eval_results/${stored.runId}`,
      rows: [],
      judgeResults: [],
    };
  }

  const newest = await findNewestArtifact();
  return { ...(await readArtifact(newest)), source: newest };
}

/**
 * Read and normalise a run artifact file.
 *
 * @param {string} filePath - Artifact path.
 * @returns {Promise<{ runId: string, rows: Array<object>, judgeResults: Array<object> }>} Artifact contents.
 */
async function readArtifact(filePath) {
  const parsed = JSON.parse(await readFile(filePath, 'utf8'));
  return {
    runId: parsed.runId ?? path.basename(filePath, '.json'),
    rows: Array.isArray(parsed.rows) ? parsed.rows : [],
    judgeResults: Array.isArray(parsed.judgeResults) ? parsed.judgeResults : [],
  };
}

/**
 * Newest run artifact in `eval/results/`.
 *
 * @returns {Promise<string>} Absolute path.
 * @throws {Error} When no artifact exists.
 */
async function findNewestArtifact() {
  const entries = await readdir(RESULTS_DIR).catch(() => []);
  const runs = entries.filter((name) => name.startsWith('eval-') && name.endsWith('.json')).sort();
  const newest = runs.at(-1);
  if (!newest) throw new Error(`No run artifacts in ${RESULTS_DIR}. Run "npm run eval" first.`);
  return path.join(RESULTS_DIR, newest);
}
