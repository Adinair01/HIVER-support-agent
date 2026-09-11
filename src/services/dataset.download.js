import { execFile } from 'node:child_process';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../utils/AppError.js';
import { KAGGLE_DATASET, downloadWithKaggleApi } from './dataset.kaggleApi.js';

const execFileAsync = promisify(execFile);

/** @type {string} Expected location of the raw Kaggle CSV (gitignored). */
export const DEFAULT_CSV_PATH = path.resolve(process.cwd(), 'data/raw/twcs.csv');
/** @type {string} File we need out of the dataset archive. */
const TARGET_FILE = 'twcs.csv';

/**
 * Make sure the raw CSV exists, downloading it when it does not.
 *
 * Order of preference:
 *   1. an existing local file (nothing to do);
 *   2. `kagglehub` via `python3` when installed — it is a Python package, so it
 *      is shelled out to rather than imported;
 *   3. the Kaggle REST API with basic auth (`dataset.kaggleApi.js`).
 *
 * @param {object} params - Acquisition parameters.
 * @param {string} [params.csvPath=DEFAULT_CSV_PATH] - Where the CSV must end up.
 * @param {(message: string) => void} [params.onProgress] - Progress reporter.
 * @returns {Promise<{ source: 'local'|'kagglehub'|'kaggle-api', csvPath: string, bytes: number }>} Acquisition result.
 * @throws {AppError} 503 when the file is absent and cannot be downloaded.
 */
export async function ensureDatasetCsv({ csvPath = DEFAULT_CSV_PATH, onProgress } = {}) {
  const localBytes = await sizeOf(csvPath);
  if (localBytes !== null) {
    return { source: 'local', csvPath, bytes: localBytes };
  }

  if (!env.kaggleConfigured) {
    throw missingDatasetError(
      csvPath,
      'KAGGLE_USERNAME/KAGGLE_KEY are not set so it cannot be downloaded automatically.',
    );
  }

  await mkdir(path.dirname(csvPath), { recursive: true });

  const viaHub = await downloadWithKaggleHub({ csvPath, onProgress });
  if (viaHub) return viaHub;

  return downloadWithKaggleApi({ csvPath, onProgress });
}

/**
 * Download through the Python `kagglehub` package when it is available.
 *
 * `null` on any failure — never throw — because kagglehub is a convenience, not a
 * requirement; the REST fallback exists precisely for machines without it. The
 * 15-minute timeout matches the dataset's ~500 MB on a slow connection.
 *
 * @param {object} params - Download parameters.
 * @param {string} params.csvPath - Destination CSV path.
 * @param {(message: string) => void} [params.onProgress] - Progress reporter.
 * @returns {Promise<{ source: 'kagglehub', csvPath: string, bytes: number } | null>} Result, or `null` to fall through to the REST path.
 */
async function downloadWithKaggleHub({ csvPath, onProgress }) {
  try {
    const { stdout } = await execFileAsync(
      'python3',
      ['-c', `import kagglehub; print(kagglehub.dataset_download("${KAGGLE_DATASET}"))`],
      { timeout: 15 * 60 * 1000, maxBuffer: 1024 * 1024 },
    );

    const directory = stdout.trim().split('\n').filter(Boolean).at(-1);
    if (!directory) return null;

    onProgress?.(`kagglehub downloaded the dataset to ${directory} — locating ${TARGET_FILE}`);
    const found = await findFile(directory, TARGET_FILE);
    if (!found) return null;

    await copyFile(found, csvPath);
    const bytes = (await sizeOf(csvPath)) ?? 0;
    logger.info({ source: 'kagglehub', bytes }, 'dataset acquired');
    return { source: 'kagglehub', csvPath, bytes };
  } catch (error) {
    // kagglehub is optional: a missing module or missing credentials falls
    // through to the REST path instead of failing the whole seed.
    onProgress?.(
      `kagglehub unavailable (${String(error.message).slice(0, 80)}) — falling back to the Kaggle API`,
    );
    return null;
  }
}

/**
 * @param {string} filePath - File to measure.
 * @returns {Promise<number | null>} Size in bytes, or `null` when absent or empty.
 */
async function sizeOf(filePath) {
  try {
    const info = await stat(filePath);
    return info.size > 0 ? info.size : null;
  } catch {
    return null;
  }
}

/**
 * Breadth-first search for a file inside a downloaded dataset directory.
 *
 * kagglehub's cache layout has changed between versions, so the path is searched
 * rather than assumed. Unreadable directories are skipped silently — permissions
 * on the user-level cache are not this function's problem.
 *
 * @param {string} directory - Root directory.
 * @param {string} fileName - File to find.
 * @returns {Promise<string | null>} Absolute path, or `null` when absent.
 */
async function findFile(directory, fileName) {
  /** @type {string[]} */
  const queue = [directory];

  while (queue.length > 0) {
    const current = /** @type {string} */ (queue.shift());
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.name === fileName) return full;
    }
  }

  return null;
}

/**
 * The actionable "you need the dataset" error.
 *
 * Both fixes are spelled out in the message because this error reaches users with
 * no codebase context — a bare 503 would just produce a support question.
 *
 * @param {string} csvPath - Expected CSV path.
 * @param {string} reason - Why it could not be fetched automatically.
 * @returns {AppError} 503 error with both fixes spelled out.
 */
export function missingDatasetError(csvPath, reason) {
  return new AppError(
    `Raw dataset not found at ${csvPath} and ${reason} Fix it either way: ` +
      '(a) download twcs.csv from https://www.kaggle.com/datasets/thoughtvector/customer-support-on-twitter/data ' +
      `and place it at ${csvPath}, or (b) put KAGGLE_USERNAME and KAGGLE_KEY in .env and re-run ` +
      '"npm run seed" to download it automatically.',
    { statusCode: 503, code: 'DATASET_MISSING' },
  );
}
