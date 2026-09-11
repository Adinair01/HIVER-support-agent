import { createReadStream } from 'node:fs';
import { parse } from 'csv-parse';
import { sanitizeTweetText } from '../utils/text.js';

/**
 * Kaggle `twcs.csv` parsing and thread reconstruction.
 *
 * Memory strategy (matters — the raw file is ~500 MB / 3M rows):
 *   pass 1 streams the file to find Amazon-authored tweets and the customer
 *          tweets they replied to, keeping only ids;
 *   pass 2 streams it again and retains only rows whose id is in that frontier.
 * Peak memory is therefore O(tweets we care about), not O(file).
 *
 * Reconstruction uses union-find over `in_response_to_tweet_id` /
 * `response_tweet_id` because the dataset contains dangling and occasionally
 * cyclic reply ids that break naive depth-first walking (MAIN.md decision 7).
 */

/** @type {string} Accounts whose author_id starts with this are treated as the brand. */
const BRAND_PREFIX = 'Amazon';

/**
 * @param {string} authorId - Tweet author id.
 * @returns {boolean} `true` when the author is an Amazon account.
 */
export function isBrandAuthor(authorId) {
  return typeof authorId === 'string' && authorId.startsWith(BRAND_PREFIX);
}

/**
 * Parse one raw CSV record into a normalised row, or `null` when unusable.
 *
 * `null` — not a throw — because 3M rows guarantee some garbage, and one bad row
 * must not kill a 20-minute scan. The dataset has no header-validated schema:
 * every field is re-checked here despite what `columns: true` implies.
 *
 * @param {Record<string, string>} record - CSV row.
 * @param {number} index - Row ordinal (used for progress logs and stable tie-breaking).
 * @returns {object | null} Normalised row, or `null` for a missing id/author/text/date.
 */
export function normalizeTweetRow(record, index) {
  const tweetId = String(record.tweet_id ?? '').trim();
  const authorId = String(record.author_id ?? '').trim();
  const text = sanitizeTweetText(record.text ?? '');
  const createdAt = new Date(record.created_at ?? '');

  if (!tweetId || !authorId || !text || Number.isNaN(createdAt.getTime())) return null;

  return {
    tweetId,
    authorId,
    text,
    createdAt,
    parentId: cleanId(record.in_response_to_tweet_id),
    responseIds: String(record.response_tweet_id ?? '')
      .split(',')
      .map((value) => cleanId(value))
      .filter(Boolean),
    index,
  };
}

/**
 * Drop the dataset's placeholder values for "no link".
 *
 * The raw CSV encodes "no reply link" as literal `NaN`/`0` strings; treating any
 * of those as a real id would weld unrelated threads together in union-find.
 *
 * @param {unknown} value - Raw id cell.
 * @returns {string | null} Usable id, or `null`.
 */
export function cleanId(value) {
  const text = String(value ?? '').trim();
  if (!text || text === 'NaN' || text === 'null' || text === '0') return null;
  return text;
}

/**
 * Stream a CSV and hand each parsed record to a callback.
 *
 * `skip_records_with_error` trades silent row loss for scan survival on a
 * 500 MB file with a handful of corrupt lines — the alternative (strict mode)
 * dies at row ~2.1M with no resumable checkpoint. Callers that need every row
 * should not use this.
 *
 * @param {string} csvPath - Path to `twcs.csv`.
 * @param {(row: object, rowIndex: number) => void} onRow - Raw record handler (not normalised);
 *   returning `false` stops the stream early.
 * @param {object} [options] - Stream options.
 * @param {number} [options.maxRows=Infinity] - Hard row cap.
 * @param {(rowsScanned: number) => void} [options.onProgress] - Progress callback, every 100k rows.
 * @returns {Promise<{ rowsScanned: number, stoppedEarly: boolean }>} Scan stats.
 */
export async function streamTweetRows(csvPath, onRow, { maxRows = Number.POSITIVE_INFINITY, onProgress } = {}) {
  const parser = createReadStream(csvPath).pipe(
    parse({ columns: true, relax_quotes: true, relax_column_count: true, skip_records_with_error: true }),
  );

  let rowsScanned = 0;
  let stoppedEarly = false;

  for await (const record of parser) {
    if (rowsScanned >= maxRows) {
      stoppedEarly = true;
      break;
    }

    rowsScanned += 1;
    if (onProgress && rowsScanned % 100_000 === 0) onProgress(rowsScanned);

    if (onRow(record, rowsScanned) === false) {
      stoppedEarly = true;
      break;
    }
  }

  return { rowsScanned, stoppedEarly };
}

