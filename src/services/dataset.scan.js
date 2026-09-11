import { cleanId, isBrandAuthor, normalizeTweetRow, streamTweetRows } from './dataset.parser.js';

/**
 * Pass 1: find the ids worth keeping.
 *
 * Only ids are kept, not rows — this pass exists so pass 2 can hold the O(tweets
 * we care about) rows instead of O(file). Brand tweets and their neighbours are
 * collected in the same sweep because a second pass just for parents would
 * double the scan time on a 500 MB file.
 *
 * @param {object} params - Scan parameters.
 * @param {string} params.csvPath - Path to `twcs.csv`.
 * @param {number} params.maxAmazonTweets - Stop after this many brand tweets.
 * @param {number} [params.maxRowsScanned=1_500_000] - Safety cap on rows read.
 * @param {(rowsScanned: number) => void} [params.onProgress] - Progress callback.
 * @returns {Promise<{ brandTweetIds: Set<string>, customerTweetIds: Set<string>, rowsScanned: number, stoppedEarly: boolean }>} Frontier ids;
 *   `stoppedEarly: true` means the frontier is a truncation, not the full conversation set.
 */
export async function buildAmazonIdFrontier({
  csvPath,
  maxAmazonTweets,
  maxRowsScanned = 1_500_000,
  onProgress,
}) {
  /** @type {Set<string>} */
  const brandTweetIds = new Set();
  /** @type {Set<string>} */
  const customerTweetIds = new Set();

  const { rowsScanned, stoppedEarly } = await streamTweetRows(
    csvPath,
    (record) => {
      const authorId = String(record.author_id ?? '');
      if (!isBrandAuthor(authorId)) return true;

      const tweetId = cleanId(record.tweet_id);
      if (tweetId) brandTweetIds.add(tweetId);

      const parent = cleanId(record.in_response_to_tweet_id);
      if (parent) customerTweetIds.add(parent);
      for (const responseId of String(record.response_tweet_id ?? '').split(',')) {
        const child = cleanId(responseId);
        if (child) customerTweetIds.add(child);
      }

      return brandTweetIds.size < maxAmazonTweets;
    },
    { maxRows: maxRowsScanned, onProgress },
  );

  return { brandTweetIds, customerTweetIds, rowsScanned, stoppedEarly };
}

/**
 * Pass 2: retain every row belonging to the frontier.
 *
 * Unnormalised rows are skipped before `normalizeTweetRow` runs — the Set lookup
 * is the hot path on a 3M-row scan, and parsing is the expensive part.
 *
 * @param {object} params - Scan parameters.
 * @param {string} params.csvPath - Path to `twcs.csv`.
 * @param {Set<string>} params.brandTweetIds - Ids of brand tweets.
 * @param {Set<string>} params.customerTweetIds - Ids of tweets the brand replied to.
 * @param {number} [params.maxRowsScanned=1_500_000] - Safety cap on rows read.
 * @param {(rowsScanned: number) => void} [params.onProgress] - Progress callback.
 * @returns {Promise<{ rowsById: Map<string, object>, rowsScanned: number, stoppedEarly: boolean }>} Retained rows keyed by tweet id;
 *   duplicate tweet ids in the file overwrite silently (last wins).
 */
export async function collectFrontierRows({
  csvPath,
  brandTweetIds,
  customerTweetIds,
  maxRowsScanned = 1_500_000,
  onProgress,
}) {
  const keep = new Set([...brandTweetIds, ...customerTweetIds]);
  /** @type {Map<string, object>} */
  const rowsById = new Map();

  const { rowsScanned, stoppedEarly } = await streamTweetRows(
    csvPath,
    (record, index) => {
      const tweetId = cleanId(record.tweet_id);
      if (!tweetId || !keep.has(tweetId)) return true;
      const row = normalizeTweetRow(record, index);
      if (row) rowsById.set(row.tweetId, row);
      return true;
    },
    { maxRows: maxRowsScanned, onProgress },
  );

  return { rowsById, rowsScanned, stoppedEarly };
}

