import { execFile } from 'node:child_process';
import { stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../utils/AppError.js';

const execFileAsync = promisify(execFile);

/**
 * Kaggle dataset slug.
 *
 * Defined here (rather than in `dataset.download.js`) so the dependency between
 * the two modules is one-way: download → kaggleApi. A cycle would put this
 * constant in its temporal dead zone while the URL below is built.
 *
 * @type {string}
 */
export const KAGGLE_DATASET = 'thoughtvector/customer-support-on-twitter';

/** @type {string} Kaggle REST endpoint that streams the dataset as a zip. */
const KAGGLE_DOWNLOAD_URL = `https://www.kaggle.com/api/v1/datasets/download/${KAGGLE_DATASET}`;
/** @type {string} File we need out of the archive. */
const TARGET_FILE = 'twcs.csv';

/**
 * Download the dataset archive from the Kaggle REST API and extract the CSV.
 *
 * Uses Node's built-in `fetch` plus the system `unzip`, so the fallback path adds
 * no dependency at all. `kagglehub` (Python) is preferred when it is installed.
 * The whole ~500 MB archive is buffered into memory before writing — streaming
 * to disk would be nicer, but the buffering keeps the auth/redirect handling in
 * one place and the archive fits comfortably in a Node heap.
 *
 * @param {object} params - Download parameters.
 * @param {string} params.csvPath - Destination CSV path (the zip lands next to it, then is deleted).
 * @param {(message: string) => void} [params.onProgress] - Progress reporter.
 * @returns {Promise<{ source: 'kaggle-api', csvPath: string, bytes: number }>} Result.
 * @throws {AppError} 502 when Kaggle rejects the request, 503 when `unzip` is missing, 500 on extraction failure.
 */
export async function downloadWithKaggleApi({ csvPath, onProgress }) {
  const credentials = Buffer.from(`${env.KAGGLE_USERNAME}:${env.KAGGLE_KEY}`).toString('base64');
  const zipPath = `${csvPath}.download.zip`;

  onProgress?.('downloading the dataset from the Kaggle API (~500 MB, this takes a few minutes)');

  const response = await fetch(KAGGLE_DOWNLOAD_URL, {
    headers: { Authorization: `Basic ${credentials}` },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new AppError(
      `Kaggle returned ${response.status} while downloading "${KAGGLE_DATASET}". ` +
        'Check KAGGLE_USERNAME/KAGGLE_KEY in .env, or download twcs.csv manually and place it at ' +
        `${csvPath}.`,
      { statusCode: 502, code: 'KAGGLE_DOWNLOAD_FAILED' },
    );
  }

  const archive = Buffer.from(await response.arrayBuffer());
  await writeFile(zipPath, archive);
  onProgress?.(`downloaded ${(archive.length / 1e6).toFixed(1)} MB — extracting ${TARGET_FILE}`);

  try {
    // `-j` flattens paths and `-o` overwrites: POSIX unzip flags, present on
    // macOS and Linux, which is what this project targets.
    await execFileAsync('unzip', ['-o', '-j', zipPath, TARGET_FILE, '-d', path.dirname(csvPath)], {
      timeout: 5 * 60 * 1000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    if (String(error.message).includes('ENOENT')) {
      throw new AppError(
        'The dataset archive downloaded but the system `unzip` binary was not found. ' +
          `Extract ${TARGET_FILE} from ${zipPath} into ${path.dirname(csvPath)} manually.`,
        { statusCode: 503, code: 'UNZIP_UNAVAILABLE' },
      );
    }
    throw new AppError(`Could not extract ${TARGET_FILE}: ${error.message}`, {
      statusCode: 500,
      code: 'EXTRACTION_FAILED',
      cause: error,
    });
  } finally {
    await unlink(zipPath).catch(() => {});
  }

  const bytes = await measure(csvPath);
  if (bytes === null) {
    throw new AppError(`Extraction finished but ${csvPath} is missing.`, {
      statusCode: 500,
      code: 'EXTRACTION_FAILED',
    });
  }

  logger.info({ source: 'kaggle-api', bytes }, 'dataset acquired');
  return { source: 'kaggle-api', csvPath, bytes };
}

/**
 * Size of a file, or `null` when it is absent or empty.
 *
 * A zero-byte file counts as missing: an interrupted earlier download leaves
 * exactly that, and proceeding would poison the whole seed with a truncated CSV.
 *
 * @param {string} filePath - File to measure.
 * @returns {Promise<number | null>} Size in bytes.
 */
async function measure(filePath) {
  try {
    const info = await stat(filePath);
    return info.size > 0 ? info.size : null;
  } catch {
    return null;
  }
}
