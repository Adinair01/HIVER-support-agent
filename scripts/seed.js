import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { Thread } from '../src/models/Thread.model.js';
import { DEFAULT_CSV_PATH } from '../src/services/dataset.download.js';
import { seedThreadsFromCsv } from '../src/services/dataset.service.js';
import { seedGoldenSetFromCsv } from '../src/services/goldenSet.loader.js';
import { heading, parseArgs, print, printPairs, resolvePath, runScript } from './lib/cli.js';

/**
 * `npm run seed` — parse `data/raw/twcs.csv`, reconstruct Amazon threads and
 * insert them (MAIN.md §4.1 / §7 step 4).
 *
 * Usage:
 *   npm run seed                        # env SEED_MAX_THREADS threads
 *   npm run seed -- --limit=500 --golden
 *   npm run seed -- --csv=data/raw/twcs.csv --drop
 */
await runScript('seed', async () => {
  const args = parseArgs();
  const csvPath = resolvePath(args.csv, DEFAULT_CSV_PATH);
  const limit = args.limit ? Number(args.limit) : env.SEED_MAX_THREADS;

  await connectDatabase();

  if (args.drop) {
    const removed = await Thread.deleteMany({});
    print(`Dropped ${removed.deletedCount ?? 0} existing thread documents.`);
  }

  heading('Seeding threads from raw tweets');
  printPairs({ csv: csvPath, maxThreads: limit || 'unlimited', nodeEnv: env.NODE_ENV });

  const stats = await seedThreadsFromCsv({
    csvPath,
    maxThreads: limit,
    onProgress: (message) => print(`  · ${message}`),
  });

  heading('Seed summary');
  printPairs({
    rowsScanned: stats.rowsScanned.toLocaleString(),
    rowsRetained: stats.rowsRetained.toLocaleString(),
    components: stats.components.toLocaleString(),
    threadsBuilt: stats.threadsBuilt.toLocaleString(),
    threadsInserted: stats.threadsInserted.toLocaleString(),
    duplicatesSkipped: stats.duplicateThreads.toLocaleString(),
    droppedNoBrandReply: stats.dropped.noBrand,
    droppedTooLarge: stats.dropped.tooLarge,
    durationMs: stats.durationMs,
  });

  if (args.golden) {
    heading('Loading golden set');
    const golden = await seedGoldenSetFromCsv();
    printPairs({ inserted: golden.inserted, deleted: golden.deleted, skipped: golden.skipped.length });
    for (const skip of golden.skipped.slice(0, 10)) {
      print(`  ! line ${skip.line}: ${skip.reason}`);
    }
  }

  const resolvable = await Thread.countResolvedThreads();
  print('');
  print(`Retrieval index ready: ${resolvable.toLocaleString()} threads with a brand reply.`);
  print('Next: npm run dev  (then POST /api/agent/process)');

  logger.info({ ...stats }, 'seed script finished');
  await disconnectDatabase();
});
