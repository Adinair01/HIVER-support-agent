import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { EvalResult } from '../src/models/EvalResult.model.js';
import { heading, parseArgs, percent, print, printPairs, resolvePath, runScript } from './lib/cli.js';

/** @type {string} Where `runEval.js` writes raw run JSON. */
const RESULTS_DIR = path.resolve(process.cwd(), 'eval/results');

/**
 * `npm run report` — compile the evaluation artifacts into one JSON summary plus
 * paste-ready markdown tables (MAIN.md §5.2 "compile metrics → report JSON").
 *
 * Usage:
 *   npm run report                       # newest eval/results/*.json
 *   npm run report -- --file=eval/results/eval-....json
 *   npm run report -- --run=eval-....    # read from MongoDB instead
 */
await runScript('report', async () => {
  const args = parseArgs();
  const run = await loadRun(args);

  const summary = compileSummary(run);
  const outPath = resolvePath(args.out, path.join(RESULTS_DIR, `report-${run.runId}.json`));
  await writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  heading(`Report tables — ${run.runId}`);
  printPairs({ source: run.source, json: outPath });

  print('');
  print('### Classification accuracy by variant');
  print('');
  print('| Variant | Accuracy | Macro F1 | Macro precision | Macro recall |');
  print('|---|---|---|---|---|');
  for (const [variant, metrics] of Object.entries(run.metrics.classification)) {
    print(
      `| ${variant} | ${percent(metrics.accuracy)} | ${percent(metrics.macro.f1)} | ` +
        `${percent(metrics.macro.precision)} | ${percent(metrics.macro.recall)} |`,
    );
  }

  print('');
  print('### Escalation decision');
  print('');
  print('| Metric | Value |');
  print('|---|---|');
  const escalation = run.metrics.escalation;
  print(`| Precision | ${percent(escalation.precision)} |`);
  print(`| Recall | ${percent(escalation.recall)} |`);
  print(`| F1 | ${percent(escalation.f1)} |`);
  print(`| Accuracy | ${percent(escalation.accuracy)} |`);
  print(`| Decided by rules | ${escalation.decidedByRules} |`);

  print('');
  print('### Reply quality and judge');
  print('');
  print('| Metric | Value |');
  print('|---|---|');
  const { replyQuality, judge } = run.metrics;
  print(`| Mean ROUGE-L | ${replyQuality.meanRougeL} |`);
  print(`| Mean keyword coverage | ${percent(replyQuality.meanKeywordCoverage)} |`);
  print(`| Length appropriate | ${percent(replyQuality.lengthAppropriateRate)} |`);
  print(`| Judge mean total | ${judge.summary.meanTotal} / ${judge.summary.maxTotal} |`);
  print(
    `| Cohen's κ | ${judge.agreement.humanScoredRows > 0 ? judge.agreement.kappa : 'pending human scores'} |`,
  );

  print('');
  print('Markdown tables above are paste-ready for report/report.md.');
});

/**
 * Load a run either from a JSON artifact or from MongoDB.
 *
 * @param {Record<string, string|boolean>} args - Parsed CLI flags.
 * @returns {Promise<{ runId: string, metrics: object, source: string }>} Run payload.
 * @throws {Error} When no run can be found.
 */
async function loadRun(args) {
  if (typeof args.file === 'string') {
    const filePath = resolvePath(args.file, '');
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    return { runId: parsed.runId, metrics: parsed.metrics, source: filePath };
  }

  if (typeof args.run === 'string') {
    await connectDatabase();
    const stored = await EvalResult.findByRunId(args.run);
    await disconnectDatabase();
    if (!stored) throw new Error(`No stored eval run with id "${args.run}".`);
    return { runId: stored.runId, metrics: stored, source: `mongodb:eval_results/${stored.runId}` };
  }

  const newest = await findNewestResultFile();
  const parsed = JSON.parse(await readFile(newest, 'utf8'));
  return { runId: parsed.runId, metrics: parsed.metrics, source: newest };
}

/**
 * Find the most recently written run JSON.
 *
 * @returns {Promise<string>} Absolute path.
 * @throws {Error} When `eval/results/` has no run artifacts.
 */
async function findNewestResultFile() {
  const entries = await readdir(RESULTS_DIR).catch(() => []);
  const runs = entries.filter((name) => name.startsWith('eval-') && name.endsWith('.json')).sort();
  const newest = runs.at(-1);
  if (!newest) {
    throw new Error(`No run artifacts in ${RESULTS_DIR}. Run "npm run eval" first.`);
  }
  return path.join(RESULTS_DIR, newest);
}

/**
 * Reduce a run into the numbers the report quotes.
 *
 * @param {{ runId: string, metrics: object, source: string }} run - Run payload.
 * @returns {object} Compiled summary.
 */
function compileSummary(run) {
  const { classification, escalation, replyQuality, judge } = run.metrics;

  const bestVariant = Object.entries(classification)
    .map(([variant, metrics]) => ({ variant, accuracy: metrics.accuracy }))
    .sort((a, b) => b.accuracy - a.accuracy)[0];

  return {
    runId: run.runId,
    source: run.source,
    compiledAt: new Date().toISOString(),
    headline: {
      bestVariant: bestVariant?.variant ?? null,
      bestAccuracy: bestVariant?.accuracy ?? 0,
      escalationRecall: escalation.recall,
      escalationPrecision: escalation.precision,
      judgeMeanTotal: judge.summary.meanTotal,
      judgeMaxTotal: judge.summary.maxTotal,
      humanAgreementKappa: judge.agreement.humanScoredRows > 0 ? judge.agreement.kappa : null,
    },
    classification,
    escalation,
    replyQuality,
    judge,
  };
}
