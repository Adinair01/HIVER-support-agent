import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { Thread } from '../models/Thread.model.js';
import { DEFAULT_CSV_PATH, ensureDatasetCsv } from './dataset.download.js';
import { buildThreadsFromRows } from './thread.builder.js';
import { buildAmazonIdFrontier, collectFrontierRows } from './dataset.scan.js';

/** 500: big enough that batch overhead vanishes, small enough that one failed
 *  batch doesn't discard tens of thousands of resumable inserts. */
const INSERT_BATCH_SIZE = 500;

/**
 * Parse `data/raw/twcs.csv` into thread documents and insert them (MAIN.md §4.1).
 *
 * The dataset is fetched first if it is missing and Kaggle credentials are
 * configured, so a fresh clone needs one command rather than a manual download.
 *
 * @param {object} [options] - Seeding options.
 * @param {string} [options.csvPath=DEFAULT_CSV_PATH] - Path to `twcs.csv`.
 * @param {number} [options.maxThreads=env.SEED_MAX_THREADS] - Thread cap (`0` = unlimited within the row cap).
 * @param {(message: string, meta?: object) => void} [options.onProgress] - Progress reporter.
 * @param {string} [options.requestId] - Correlation id for logs.
 * @returns {Promise<object>} Seeding statistics.
 * @throws {AppError} 503 when the CSV is missing and cannot be downloaded.
 */
export async function seedThreadsFromCsv({
  csvPath = DEFAULT_CSV_PATH,
  maxThreads = env.SEED_MAX_THREADS,
  onProgress,
  requestId,
} = {}) {
  const acquisition = await ensureDatasetCsv({
    csvPath,
    onProgress: (message) => onProgress?.(message, { phase: 'download' }),
  });
  const log = requestId ? logger.child({ requestId }) : logger;
  const startedAt = Date.now();
  const threadCap = maxThreads > 0 ? maxThreads : Number.MAX_SAFE_INTEGER;

  onProgress?.(`pass 1/2 — scanning ${csvPath} for Amazon conversations`, { phase: 'scan' });
  const frontier = await buildAmazonIdFrontier({
    csvPath,
    // Brand tweets arrive in bursts, so oversample to guarantee enough threads.
    maxAmazonTweets: Math.min(threadCap * 4, 200_000),
    onProgress: (rows) => onProgress?.(`  scanned ${rows.toLocaleString()} rows`, { phase: 'scan' }),
  });

  onProgress?.(
    `pass 2/2 — collecting ${frontier.brandTweetIds.size.toLocaleString()} brand tweets ` +
      `(+${frontier.customerTweetIds.size.toLocaleString()} linked customer tweets)`,
    { phase: 'collect' },
  );
  const { rowsById } = await collectFrontierRows({
    csvPath,
    brandTweetIds: frontier.brandTweetIds,
    customerTweetIds: frontier.customerTweetIds,
    onProgress: (rows) => onProgress?.(`  scanned ${rows.toLocaleString()} rows`, { phase: 'collect' }),
  });

  const { threads, stats } = buildThreadsFromRows(rowsById, { maxThreads: threadCap });
  log.info({ ...stats, rowsScanned: frontier.rowsScanned }, 'thread reconstruction complete');

  onProgress?.(`reconstructed ${threads.length.toLocaleString()} threads — writing to MongoDB`, {
    phase: 'insert',
  });
  const inserted = await insertThreads(threads);

  // Build the text index the retrieval service depends on.
  await Thread.createIndexes();

  return {
    datasetSource: acquisition.source,
    datasetBytes: acquisition.bytes,
    rowsScanned: frontier.rowsScanned,
    rowsRetained: rowsById.size,
    components: stats.components,
    dropped: stats.dropped,
    threadsBuilt: stats.threadsBuilt,
    threadsInserted: inserted,
    duplicateThreads: threads.length - inserted,
    cappedAt: threadCap === Number.MAX_SAFE_INTEGER ? null : threadCap,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Insert threads in batches, tolerating duplicate keys so seeding is resumable.
 *
 * `ordered: false` is load-bearing: with it, one duplicate aborts the whole
 * batch and a re-run re-scans from scratch. Duplicate detection is by error
 * code/message because Mongo's bulk-write error shape varies by driver version.
 *
 * @param {Array<object>} threads - Raw thread documents.
 * @returns {Promise<number>} Number actually inserted (excluding duplicates).
 */
async function insertThreads(threads) {
  let inserted = 0;

  for (let offset = 0; offset < threads.length; offset += INSERT_BATCH_SIZE) {
    const batch = threads.slice(offset, offset + INSERT_BATCH_SIZE);
    const documents = batch.map((thread) => ({
      ...thread,
      ...Thread.deriveThreadFields(thread.messages),
    }));

    try {
      const result = await Thread.insertMany(documents, { ordered: false });
      inserted += result.length;
    } catch (error) {
      // With `ordered: false` the valid documents still land; only duplicates fail.
      inserted += Array.isArray(error?.insertedDocs) ? error.insertedDocs.length : 0;
      if (error?.code !== 11000 && !String(error?.message ?? '').includes('duplicate key')) throw error;
    }
  }

  return inserted;
}

