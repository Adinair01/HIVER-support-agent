import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { EVAL_VARIANTS, runEvaluation } from '../src/services/eval.service.js';
import { isProviderConfigured } from '../src/services/llm.client.js';
import { heading, parseArgs, percent, print, printPairs, printTable, resolvePath, runScript } from './lib/cli.js';

/** @type {string} Default output directory for raw run JSON (MAIN.md §5: `eval/results/`). */
const RESULTS_DIR = path.resolve(process.cwd(), 'eval/results');

/**
 * `npm run eval` — run the full evaluation harness on the golden set
 * (MAIN.md §5.2 / §5.3 / §7 step 6).
 *
 * Usage:
 *   npm run eval
 *   npm run eval -- --variants=keyword,few-shot --judge=30
 *   npm run eval -- --source=csv --variants=keyword --judge=0 --no-store   # offline, GitHub-reviewable
 *   npm run eval --judge-agreement        # Cohen's κ between human and judge scores
 */
if (parseArgs()['judge-agreement']) {
  await runScript('eval:judge-agreement', async () => {
    const { reportJudgeAgreement } = await import('./judgeAgreement.js');
    await reportJudgeAgreement(parseArgs());
  });
} else {
await runScript('eval', async () => {
  const args = parseArgs();
  const variants = parseVariants(args.variants);
  const judgeSampleSize = args.judge === undefined ? env.EVAL_JUDGE_SAMPLE_SIZE : Number(args.judge);
  const limit = args.limit ? Number(args.limit) : undefined;
  const outDir = resolvePath(args.out, RESULTS_DIR);
  const source = args.source === 'csv' ? 'csv' : 'mongo';
  const storeResult = !args['no-store'] && source === 'mongo';

  // The CSV source reads eval/golden_set.csv directly, so no database is needed.
  if (source === 'mongo' || storeResult) await connectDatabase();

  heading('Running evaluation harness');
  printPairs({
    source: source === 'csv' ? 'eval/golden_set.csv (no database)' : 'mongodb:golden_examples',
    variants: variants.join(', '),
    judgeSampleSize: judgeSampleSize === 0 ? 'disabled' : judgeSampleSize,
    limit: limit ?? 'all golden rows',
    model: isProviderConfigured() ? env.GROQ_MODEL : 'unset — LLM steps will degrade',
    storeResult,
  });

  const { runId, config, metrics, rows, judgeResults } = await runEvaluation({
    variants,
    judgeSampleSize,
    limit,
    source,
    generateReplies: !args['no-replies'],
    // RAG evidence lives in MongoDB, so it is only used when the DB is in play.
    useRetrieval: Boolean(args.retrieval) || source === 'mongo',
    storeResult,
    onProgress: (done, total) => {
      if (done === total || done % 25 === 0) print(`  · evaluated ${done}/${total} rows`);
    },
  });

  // The artifact keeps per-row detail (including each draft) so the report's
  // failure analysis and `npm run export-judge-sample` can both work from a
  // completed run instead of re-spending quota to reproduce it.
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${runId}.json`);
  await writeFile(outPath, `${JSON.stringify({ runId, config, metrics, rows, judgeResults }, null, 2)}\n`, 'utf8');

  printClassification(metrics.classification);
  printEscalation(metrics.escalation);
  printReplyQuality(metrics.replyQuality);
  printJudge(metrics.judge);

  heading('Artifacts');
  printPairs({ runId, json: outPath, storedInMongo: storeResult });
  print('Next: npm run report   (compiles eval/results into the report tables)');

  logger.info({ runId, outPath, source, rows: rows.length, judged: judgeResults.length }, 'evaluation finished');
  if (source === 'mongo' || storeResult) await disconnectDatabase();
});
}

/**
 * Parse and validate the `--variants` argument.
 *
 * @param {unknown} value - Raw flag value.
 * @returns {string[]} Requested variants.
 */
function parseVariants(value) {
  if (typeof value !== 'string' || !value.trim()) return ['keyword', 'few-shot'];
  const requested = value
    .split(',')
    .map((variant) => variant.trim())
    .filter((variant) => EVAL_VARIANTS.includes(variant));
  return requested.length > 0 ? requested : ['keyword', 'few-shot'];
}

/**
 * Print the classification table for every variant.
 *
 * @param {Record<string, object>} classification - Per-variant metrics.
 * @returns {void}
 */
function printClassification(classification) {
  heading('Classification');
  printTable(
    ['variant', 'accuracy', 'macro F1', 'macro P', 'macro R', 'unparsed'],
    Object.entries(classification).map(([variant, metrics]) => [
      variant,
      percent(metrics.accuracy),
      percent(metrics.macro.f1),
      percent(metrics.macro.precision),
      percent(metrics.macro.recall),
      metrics.unparsedOrFailed,
    ]),
  );

  for (const [variant, metrics] of Object.entries(classification)) {
    print('');
    print(`  per-intent F1 (${variant})`);
    printTable(
      ['intent', 'P', 'R', 'F1', 'support'],
      Object.entries(metrics.perIntent).map(([intent, scores]) => [
        intent,
        percent(scores.precision),
        percent(scores.recall),
        percent(scores.f1),
        scores.support,
      ]),
    );
  }
}

/**
 * Print the escalation metrics.
 *
 * @param {object} escalation - Escalation metrics.
 * @returns {void}
 */
function printEscalation(escalation) {
  heading('Escalation decision');
  printPairs({
    precision: percent(escalation.precision),
    recall: percent(escalation.recall),
    f1: percent(escalation.f1),
    accuracy: percent(escalation.accuracy),
    truePositives: escalation.tp,
    falsePositives: escalation.fp,
    falseNegatives: escalation.fn,
    trueNegatives: escalation.tn,
    decidedByRules: escalation.decidedByRules,
  });
}

/**
 * Print the automated reply-quality metrics.
 *
 * @param {object} replyQuality - Reply metrics.
 * @returns {void}
 */
function printReplyQuality(replyQuality) {
  heading('Reply quality (automated)');
  printPairs({
    evaluated: replyQuality.evaluated,
    meanRougeL: replyQuality.meanRougeL,
    meanKeywordCoverage: percent(replyQuality.meanKeywordCoverage),
    lengthAppropriate: percent(replyQuality.lengthAppropriateRate),
    meanWordCount: replyQuality.meanWordCount,
    degradedReplies: percent(replyQuality.degradedRate),
  });

  if (replyQuality.topMissingKeywords.length > 0) {
    print('');
    printTable(
      ['missing keyword', 'rows'],
      replyQuality.topMissingKeywords.map((entry) => [entry.keyword, entry.count]),
    );
  }
}

/**
 * Print the judge summary and human agreement.
 *
 * @param {object} judge - Judge metrics.
 * @returns {void}
 */
function printJudge(judge) {
  heading('LLM-as-judge');
  printPairs({
    judged: judge.summary.judged,
    valid: judge.summary.valid,
    meanTotal: `${judge.summary.meanTotal} / ${judge.summary.maxTotal}`,
    normalizedMean: percent(judge.summary.normalizedMean),
    kappa: judge.agreement.humanScoredRows > 0 ? judge.agreement.kappa : 'not computed (no human scores)',
    humanScoredRows: judge.agreement.humanScoredRows,
  });

  print('');
  printTable(
    ['dimension', 'mean (0-3)'],
    Object.entries(judge.summary.meanByDimension).map(([dimension, score]) => [dimension, score]),
  );
}
