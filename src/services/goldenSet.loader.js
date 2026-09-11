import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { GoldenExample } from '../models/GoldenExample.model.js';
import { AppError } from '../utils/AppError.js';
import { isIntent } from '../utils/intents.js';
import { sanitizeTweetText } from '../utils/text.js';

/**
 * Golden-set CSV loading, split out of `dataset.service.js` so raw-tweet seeding
 * and label loading each keep one responsibility (MAIN.md §3.1).
 */

/** @type {string} Committed golden set. */
export const DEFAULT_GOLDEN_SET_PATH = path.resolve(process.cwd(), 'eval/golden_set.csv');

/**
 * Parse `eval/golden_set.csv` into model-ready rows (MAIN.md §5.1).
 *
 * Invalid rows are reported rather than silently dropped: a label typo must
 * surface as a line number in the seed output, not as a quietly smaller eval
 * set. Line numbers are 1-based including the header, so they match the editor.
 *
 * @param {string} [csvPath=DEFAULT_GOLDEN_SET_PATH] - Golden set path.
 * @returns {{ rows: Array<object>, skipped: Array<{ line: number, reason: string }> }} Parsed rows.
 * @throws {AppError} 503 when the file is missing.
 */
export function parseGoldenSetCsv(csvPath = DEFAULT_GOLDEN_SET_PATH) {
  const { rows, skipped } = readGoldenSetRecords(csvPath);
  /** @type {Array<object>} */
  const valid = [];

  for (const [index, record] of rows.entries()) {
    const trueIntent = String(record.true_intent ?? '').trim().toUpperCase();
    const customerMessage = sanitizeTweetText(record.customer_message ?? '');

    if (!isIntent(trueIntent)) {
      skipped.push({ line: index + 2, reason: `unknown true_intent "${trueIntent}"` });
      continue;
    }
    if (customerMessage.length < 3) {
      skipped.push({ line: index + 2, reason: 'customer_message is empty' });
      continue;
    }

    valid.push({
      threadId: String(record.thread_id ?? `golden-${index}`).trim(),
      customerMessage,
      trueIntent,
      expectedEscalation: parseBoolean(record.expected_escalation),
      idealReplyKeywords: String(record.ideal_reply_keywords ?? '').trim(),
      notes: String(record.notes ?? '').trim(),
      humanScore: record.human_score === undefined || record.human_score === '' ? null : Number(record.human_score),
      source: 'kaggle:twcs',
    });
  }

  return { rows: valid, skipped };
}

/**
 * Read raw records from the golden-set CSV, raising an actionable error if absent.
 *
 * @param {string} csvPath - Golden set path.
 * @returns {{ rows: Array<Record<string, string>>, skipped: Array<{ line: number, reason: string }> }} Raw records.
 * @throws {AppError} 503 when the file is missing.
 */
function readGoldenSetRecords(csvPath) {
  try {
    const rows = parse(readFileSync(csvPath, 'utf8'), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });
    return { rows, skipped: [] };
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new AppError(
        `Golden set not found at ${csvPath}. Run "npm run build:golden" to generate one first.`,
        { statusCode: 503, code: 'GOLDEN_SET_MISSING' },
      );
    }
    throw error;
  }
}

/**
 * Coerce the CSV's several boolean spellings.
 *
 * Anything unrecognised is `false`, never an error — hand-labelled columns will
 * contain "", "false", "no", and the occasional "fals"; only `expected_escalation`
 * consumers treat the result as load-bearing, and the labelling notes document
 * the accepted spellings.
 *
 * @param {unknown} value - Raw cell.
 * @returns {boolean} Parsed boolean.
 */
function parseBoolean(value) {
  return ['true', 'yes', '1', 'y'].includes(String(value ?? '').trim().toLowerCase());
}

/**
 * Load the golden set into MongoDB so services can query it.
 *
 * Replace-all, not upsert: hand-edited CSV rows have no stable `_id`, so merging
 * would leave stale rows from the previous labelling round mixed into the new set.
 *
 * @param {string} [csvPath=DEFAULT_GOLDEN_SET_PATH] - Golden set path.
 * @returns {Promise<{ inserted: number, deleted: number, skipped: Array<object> }>} Load stats.
 */
export async function seedGoldenSetFromCsv(csvPath = DEFAULT_GOLDEN_SET_PATH) {
  const { rows, skipped } = parseGoldenSetCsv(csvPath);
  const result = await GoldenExample.replaceAll(rows);
  return { ...result, skipped };
}
