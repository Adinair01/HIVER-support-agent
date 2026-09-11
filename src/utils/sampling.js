/**
 * Deterministic sampling helpers.
 *
 * A fixed stride — rather than `Math.random()` — is what makes measurements
 * comparable between runs: the same inputs always yield the same subsample, so a
 * change in the numbers reflects a real change in the system.
 */

/**
 * Take an evenly spaced subsample of a list.
 *
 * @param {Array<T>} items - Source list, in a stable order.
 * @param {number} size - Desired sample size. `0` or negative yields an empty array.
 * @returns {Array<T>} Evenly spaced sample (never longer than `items`).
 * @template T
 */
export function selectStridedSample(items, size) {
  if (!Array.isArray(items) || items.length === 0 || size <= 0) return [];
  const take = Math.min(size, items.length);
  if (take === items.length) return [...items];

  const stride = items.length / take;
  /** @type {Array<T>} */
  const sample = [];
  for (let index = 0; index < take; index += 1) {
    sample.push(items[Math.floor(index * stride)]);
  }
  return sample;
}

/**
 * Escape a value for CSV output, quoting only when necessary.
 *
 * @param {unknown} value - Raw cell value.
 * @returns {string} CSV-safe cell.
 */
export function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Serialise rows to CSV text.
 *
 * @param {string[]} header - Column names.
 * @param {Array<Array<unknown>>} rows - Row values, matching the header order.
 * @returns {string} CSV document, newline terminated.
 */
export function toCsv(header, rows) {
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return `${lines.join('\n')}\n`;
}
