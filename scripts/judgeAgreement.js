import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RUBRIC_DIMENSIONS } from '../src/prompts/judge.prompt.js';
import { computeAgreement, readJudgeSampleCsv } from '../src/services/judge.agreement.js';
import { heading, parseArgs, print, printPairs, printTable, resolvePath, runScript } from './lib/cli.js';

/** @type {string} Default sample file written by `export-judge-sample`. */
const DEFAULT_SAMPLE = path.resolve(process.cwd(), 'eval/judge_sample_30.csv');
/** @type {string} Where the agreement report is written. */
const RESULTS_DIR = path.resolve(process.cwd(), 'eval/results');

/**
 * Compute Cohen's κ between human and LLM judge scores.
 *
 * Exported (not just a top-level script) because `runEval.js --judge-agreement`
 * reuses it: two κ implementations would eventually disagree with each other,
 * which is the one failure this metric cannot survive.
 *
 * @param {Record<string, string|boolean>} [args] - Parsed CLI flags; `--sample` overrides the CSV path.
 * @returns {Promise<void>} Resolves once the report is printed and written.
 */
export async function reportJudgeAgreement(args = {}) {
  const samplePath = resolvePath(args.sample, DEFAULT_SAMPLE);
  const records = readJudgeSampleCsv(samplePath);
  const report = computeAgreement(records);

  heading('LLM-as-judge agreement (human vs judge)');
  printPairs({ sample: samplePath, rows: report.n, compared: report.compared });

  if (!report.ready) {
    print('');
    print(`! κ cannot be computed yet: ${report.reason}.`);
    print('  Fill the human_score_* columns, then re-run: npm run eval --judge-agreement');
    return;
  }

  print('');
  printTable(
    ['dimension', 'κ', 'exact agree', 'mean human', 'mean judge', 'bias (judge-human)'],
    RUBRIC_DIMENSIONS.map((dimension) => {
      const stats = report.dimensions[dimension.key];
      return [
        dimension.key,
        stats.kappa,
        stats.exactAgreement,
        stats.meanHuman,
        stats.meanJudge,
        stats.meanBias,
      ];
    }),
  );

  print('');
  printPairs({
    overallKappa: report.total.kappa,
    observedAgreement: report.total.observedAgreement,
    expectedAgreement: report.total.expectedAgreement,
    meanHumanTotal: `${report.total.meanHumanTotal} / 12`,
    meanJudgeTotal: `${report.total.meanJudgeTotal} / 12`,
  });

  print('');
  print(`Interpretation: ${interpretKappa(report.total.kappa)}`);

  await mkdir(RESULTS_DIR, { recursive: true });
  const outPath = path.join(RESULTS_DIR, `judge-agreement-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(outPath, `${JSON.stringify({ samplePath, ...report }, null, 2)}\n`, 'utf8');
  printPairs({ json: outPath });
}

/**
 * Landis & Koch style verbal reading of a κ value, used verbatim in the report.
 *
 * @param {number} kappa - Cohen's κ.
 * @returns {string} Interpretation.
 */
export function interpretKappa(kappa) {
  if (kappa >= 0.81) return 'almost perfect agreement';
  if (kappa >= 0.61) return 'substantial agreement';
  if (kappa >= 0.41) return 'moderate agreement — the judge is usable but should not gate decisions';
  if (kappa >= 0.21) return 'fair agreement — treat judge scores as a weak signal only';
  if (kappa > 0) return 'slight agreement — the judge does not yet track human judgement';
  return 'no agreement beyond chance — investigate the rubric before trusting the judge';
}

// Only run the CLI when this file is the entry point: `runEval.js` imports
// `reportJudgeAgreement` for its `--judge-agreement` flag, and without this guard
// the import would execute the script a second time.
const invokedDirectly =
  typeof process.argv[1] === 'string' && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  await runScript('eval:judge-agreement', () => reportJudgeAgreement(parseArgs()));
}
