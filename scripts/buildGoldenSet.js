import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { logger } from '../src/config/logger.js';
import { Thread } from '../src/models/Thread.model.js';
import { classifyByKeywords } from '../src/services/classifier.keyword.js';
import { evaluateEscalationRules } from '../src/services/escalation.rules.js';
import { INTENTS } from '../src/utils/intents.js';
import { toCsv } from '../src/utils/sampling.js';
import { truncate } from '../src/utils/text.js';
import { heading, parseArgs, print, printPairs, printTable, resolvePath, runScript } from './lib/cli.js';

/**
 * `npm run build-golden-set` — stratified sample of real threads, written as an
 * **unlabelled worksheet** that a human must complete (MAIN.md §5.1).
 *
 * This script never writes labels. It emits `true_intent`, `expected_escalation`
 * and `ideal_reply_keywords` as EMPTY cells and records the machine's opinion in
 * separate `suggested_*` columns, so no baseline prediction can be mistaken for
 * ground truth. `eval/golden_set.csv` is never overwritten.
 *
 * Usage:
 *   npm run build-golden-set
 *   npm run build-golden-set -- --per-intent=25 --edge=25 --out=eval/golden_set_raw.csv --force
 */

/** @type {string} Default destination — deliberately NOT golden_set.csv. */
const DEFAULT_OUT = path.resolve(process.cwd(), 'eval/golden_set_raw.csv');
/** @type {ReadonlyArray<string>} Intents that get a stratified quota. */
const SUPPORT_INTENTS = INTENTS.filter((intent) => intent !== 'ABUSE_SPAM');
/** @type {string[]} Worksheet columns: labels first, then machine suggestions. */
const CSV_HEADER = [
  'thread_id',
  'customer_message',
  'true_intent',
  'expected_escalation',
  'ideal_reply_keywords',
  'notes',
  'human_score',
  'suggested_intent',
  'suggested_confidence',
  'suggested_rule_flags',
];

await runScript('build-golden-set', async () => {
  const args = parseArgs();
  const perIntent = args['per-intent'] ? Number(args['per-intent']) : 25;
  const edgeTarget = args.edge === undefined ? 25 : Number(args.edge);
  const outPath = resolvePath(args.out, DEFAULT_OUT);
  const poolSize = args.pool ? Number(args.pool) : Math.max(500, perIntent * 8 * 10);

  await connectDatabase();

  const pool = await Thread.find({ hasAgentReply: true }).sort({ resolvedAt: -1 }).limit(poolSize).lean();
  if (pool.length === 0) {
    print('No resolved threads found. Seed the database first: npm run seed');
    await disconnectDatabase();
    process.exitCode = 1;
    return;
  }

  const { stratified, edgeCases, buckets, totals } = sampleThreads(pool, { perIntent, edgeTarget });
  const selected = [...stratified, ...edgeCases];

  await writeFile(outPath, toCsv(CSV_HEADER, selected.map(toRow)), 'utf8');

  heading('Golden set raw file written (UNLABELLED)');
  printPairs({
    output: outPath,
    pooledThreads: pool.length,
    stratifiedRows: stratified.length,
    edgeCaseRows: edgeCases.length,
    totalRows: selected.length,
    perIntentTarget: perIntent,
    edgeTarget,
  });

  print('');
  print('Sampling balance (what a full dataset should produce):');
  printTable(
    ['intent', 'pooled', 'were picked', 'shortfall'],
    SUPPORT_INTENTS.map((intent) => [
      intent,
      buckets.get(intent)?.length ?? 0,
      Math.min(perIntent, buckets.get(intent)?.length ?? 0),
      Math.max(0, perIntent - (buckets.get(intent)?.length ?? 0)),
    ]),
  );

  if (pool.length < (perIntent * SUPPORT_INTENTS.length) + edgeTarget) {
    print('');
    print(`! The pool held ${pool.length} threads but a full sample needs ` +
      `${perIntent * SUPPORT_INTENTS.length + edgeTarget}. Seed more threads (npm run seed) to fill every quota.`);
  }

  print('');
  print(`Spot-check — first 5 rows of each bucket (${totals.threadsWithEdgeFlag} pool threads carried an edge-case signal):`);
  for (const intent of SUPPORT_INTENTS) {
    const rows = (buckets.get(intent) ?? []).slice(0, 5);
    if (rows.length === 0) continue;
    print('');
    print(`  ${intent} (${rows.length} shown of ${buckets.get(intent)?.length ?? 0} pooled)`);
    for (const row of rows) {
      print(`    ${row.thread.threadId}  ${truncate(row.thread.firstCustomerMessage, 96)}`);
    }
  }

  print('');
  heading('Your turn — this file has no labels yet');
  print('  1. Open eval/golden_set_raw.csv and fill in, for every row:');
  print('       true_intent          one of the 8 canonical labels (see eval/labelling_notes.md §3)');
  print('       expected_escalation  true if a human agent should handle it (policy in §4)');
  print('       ideal_reply_keywords 2-4 terms a good reply must contain, separated by |');
  print('       notes                why, and any ambiguity you hit');
  print('     suggested_intent / suggested_confidence / suggested_rule_flags are the keyword');
  print("     baseline's opinion. They are NOT labels — overwrite your own judgement over them.");
  print('  2. Save it as eval/golden_set.csv (keep the same columns).');
  print('  3. Load and evaluate it:');
  print('       npm run seed -- --golden');
  print('       npm run eval -- --source=csv --variants=keyword,zero-shot,few-shot --judge=30');

  logger.info({ outPath, rows: selected.length }, 'golden set raw file built');
  await disconnectDatabase();
});

/**
 * Pick the stratified rows plus the edge-case rows.
 *
 * @param {Array<object>} pool - Resolved threads, newest first.
 * @param {{ perIntent: number, edgeTarget: number }} targets - Quotas.
 * @returns {{ stratified: Array<object>, edgeCases: Array<object>, buckets: Map<string, Array<object>>, totals: { threadsWithEdgeFlag: number } }} Selections.
 */
function sampleThreads(pool, { perIntent, edgeTarget }) {
  /** @type {Map<string, Array<object>>} */
  const buckets = new Map(SUPPORT_INTENTS.map((intent) => [intent, []]));
  /** @type {Array<object>} */
  const flagged = [];

  for (const thread of pool) {
    const suggestion = classifyByKeywords(thread.firstCustomerMessage);
    const escalation = evaluateEscalationRules({
      message: thread.firstCustomerMessage,
      intent: suggestion.intent,
      classifierConfidence: suggestion.confidence,
    });
    const entry = { thread, suggestion, escalation };

    const bucket = buckets.get(suggestion.intent);
    if (bucket) bucket.push(entry);
    if (escalation.triggered || suggestion.confidence < 0.6) flagged.push(entry);
  }

  /** @type {Array<object>} */
  const stratified = [];
  for (const intent of SUPPORT_INTENTS) {
    stratified.push(...(buckets.get(intent) ?? []).slice(0, perIntent));
  }

  const chosen = new Set(stratified.map((entry) => entry.thread.threadId));
  const edgeCases = flagged.filter((entry) => !chosen.has(entry.thread.threadId)).slice(0, edgeTarget);

  return { stratified, edgeCases, buckets, totals: { threadsWithEdgeFlag: flagged.length } };
}

/**
 * Map a selection onto worksheet cells: is the row stratified or an edge case, and
 * why the baseline flagged it.
 *
 * @param {object} entry - Selection entry.
 * @returns {Array<unknown>} CSV cells in header order.
 */
function toRow(entry) {
  const { thread, suggestion, escalation } = entry;
  return [
    thread.threadId,
    thread.firstCustomerMessage,
    '', // true_intent — human decision
    '', // expected_escalation — human decision
    '', // ideal_reply_keywords — human decision
    '', // notes
    '', // human_score
    suggestion.intent,
    suggestion.confidence,
    escalation.triggered ? escalation.flags.map((flag) => flag.code).join('+') : '',
  ];
}
