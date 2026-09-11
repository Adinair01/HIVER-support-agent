import path from 'node:path';
import process from 'node:process';

/**
 * Tiny argument parser shared by every script, so `npm run seed -- --limit=100`
 * behaves identically everywhere.
 *
 * Supports `--flag`, `--key=value`, `--key value` and `--no-flag`.
 *
 * @param {string[]} [argv=process.argv.slice(2)] - Raw arguments.
 * @returns {Record<string, string | boolean>} Parsed flags.
 */
export function parseArgs(argv = process.argv.slice(2)) {
  /** @type {Record<string, string | boolean>} */
  const flags = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;

    const [rawKey, inlineValue] = token.slice(2).split('=');
    const key = rawKey.trim();

    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      flags[key] = argv[i + 1];
      i += 1;
    } else {
      flags[key] = true;
    }
  }

  return flags;
}

/**
 * Print one line to stdout. Scripts are human-facing CLI tools, which is why
 * they write directly instead of going through the pino logger.
 *
 * @param {string} [message=''] - Line to print.
 * @returns {void}
 */
export function print(message = '') {
  process.stdout.write(`${message}\n`);
}

/**
 * Print a section heading.
 *
 * @param {string} title - Heading text.
 * @returns {void}
 */
export function heading(title) {
  print('');
  print(`── ${title} ${'─'.repeat(Math.max(0, 46 - title.length))}`);
}

/**
 * Print aligned key/value pairs.
 *
 * @param {Record<string, unknown>} values - Values to print.
 * @returns {void}
 */
export function printPairs(values) {
  const width = Math.max(...Object.keys(values).map((key) => key.length));
  for (const [key, value] of Object.entries(values)) {
    print(`  ${key.padEnd(width)}  ${value}`);
  }
}

/**
 * Print a simple markdown-ish table.
 *
 * @param {string[]} headers - Column headers.
 * @param {Array<Array<string|number>>} rows - Table rows.
 * @returns {void}
 */
export function printTable(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(String(header).length, ...rows.map((row) => String(row[index] ?? '').length)),
  );
  print(headers.map((header, index) => String(header).padEnd(widths[index])).join('  '));
  print(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) {
    print(row.map((cell, index) => String(cell ?? '').padEnd(widths[index])).join('  '));
  }
}

/**
 * Format a number as a percentage.
 *
 * @param {number} value - Value in `[0, 1]`.
 * @returns {string} Percentage string.
 */
export function percent(value) {
  return `${(Number(value ?? 0) * 100).toFixed(1)}%`;
}

/**
 * Resolve a path argument relative to the project root.
 *
 * @param {unknown} value - Raw `--flag` value.
 * @param {string} fallback - Default absolute path.
 * @returns {string} Absolute path.
 */
export function resolvePath(value, fallback) {
  return typeof value === 'string' && value.trim() ? path.resolve(process.cwd(), value) : fallback;
}

/**
 * Run a script body with consistent error reporting and exit codes.
 *
 * @param {string} name - Script name used in the failure banner.
 * @param {() => Promise<void>} body - Script body.
 * @returns {Promise<void>} Resolves on success.
 */
export async function runScript(name, body) {
  try {
    await body();
  } catch (error) {
    print('');
    print(`✖ ${name} failed: ${error?.message ?? error}`);
    if (process.env.DEBUG) print(error?.stack ?? '');
    // An open Mongoose connection keeps the event loop alive, so a failing
    // script would otherwise hang forever with no output. Closing it lets Node
    // exit naturally (with the failing code) instead of being killed by a timeout.
    await disconnectIfConnected();
    process.exitCode = 1;
  }
}

/**
 * Best-effort close of the database connection, used on the failure path.
 *
 * @returns {Promise<void>} Resolves once the connection is closed or the attempt failed.
 */
async function disconnectIfConnected() {
  try {
    const { disconnectDatabase } = await import('../../src/config/db.js');
    await disconnectDatabase();
  } catch {
    // The script may have failed before the config was even valid; nothing to close.
  }
}
