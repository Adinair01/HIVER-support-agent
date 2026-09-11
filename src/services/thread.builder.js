import { isBrandAuthor } from './dataset.parser.js';

/**
 * Thread reconstruction: turn the retained frontier rows into ordered
 * conversation documents.
 *
 * Split out of `dataset.parser.js` so each module keeps one responsibility and
 * stays inside the 150-line limit (MAIN.md §3.1). Everything this module needs
 * must live here or be imported: the split initially left
 * `MAX_MESSAGES_PER_THREAD` behind in the parser, which made every seed run throw
 * (see HANDOFF.md, Session 2). `tests/thread-builder.test.js` now covers it.
 */

/**
 * Guard against runaway merged components: the dataset occasionally chains many
 * unrelated replies into one component through malformed reply ids.
 *
 * @type {number}
 */
export const MAX_MESSAGES_PER_THREAD = 40;

/**
 * Minimal union-find over tweet ids.
 *
 * @returns {{ find: (id: string) => string, union: (a: string, b: string) => void }} Disjoint-set API.
 */
export function createUnionFind() {
  /** @type {Map<string, string>} */
  const parent = new Map();

  /**
   * @param {string} id - Node id; unknown ids self-register as singletons.
   * @returns {string} Root id.
   */
  function find(id) {
    if (!parent.has(id)) {
      parent.set(id, id);
      return id;
    }
    let root = id;
    while (parent.get(root) !== root) root = /** @type {string} */ (parent.get(root));
    // Path compression keeps repeated lookups cheap on large components.
    let current = id;
    while (parent.get(current) !== root) {
      const next = /** @type {string} */ (parent.get(current));
      parent.set(current, root);
      current = next;
    }
    return root;
  }

  /**
   * @param {string} a - First node.
   * @param {string} b - Second node.
   * @returns {void}
   */
  function union(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    // Deterministic: the numerically smaller id always wins, so rebuilds are stable.
    if (rootA < rootB) parent.set(rootB, rootA);
    else parent.set(rootA, rootB);
  }

  return { find, union };
}

/**
 * Group frontier rows into conversation threads and drop unusable components.
 *
 * Drop order matters for the stats: over-merged components are counted before
 * brand/customer checks, because a 50-message merged blob is a pipeline artifact
 * while a brand-only component is a data quirk — the report treats them differently.
 *
 * @param {Map<string, object>} rowsById - Rows from `collectFrontierRows`.
 * @param {object} [options] - Build options.
 * @param {number} [options.maxThreads=5000] - Maximum threads to return; newest-first, so the
 *   cut silently drops the oldest.
 * @returns {{ threads: Array<{ threadId: string, brand: string, messages: Array<{ role: string, text: string, timestamp: Date, tweetId: string }> }>, stats: { components: number, dropped: { noBrand: number, noCustomer: number, tooLarge: number }, threadsBuilt: number } }} Threads plus build stats.
 */
export function buildThreadsFromRows(rowsById, { maxThreads = 5000 } = {}) {
  const unionFind = createUnionFind();

  for (const row of rowsById.values()) {
    if (row.parentId && rowsById.has(row.parentId)) unionFind.union(row.tweetId, row.parentId);
    for (const responseId of row.responseIds) {
      if (rowsById.has(responseId)) unionFind.union(row.tweetId, responseId);
    }
  }

  /** @type {Map<string, object[]>} */
  const components = new Map();
  for (const row of rowsById.values()) {
    const root = unionFind.find(row.tweetId);
    const bucket = components.get(root);
    if (bucket) bucket.push(row);
    else components.set(root, [row]);
  }

  const dropped = { noBrand: 0, noCustomer: 0, tooLarge: 0 };
  /** @type {Array<object>} */
  const threads = [];

  for (const rows of components.values()) {
    if (rows.length > MAX_MESSAGES_PER_THREAD) {
      dropped.tooLarge += 1;
      continue;
    }
    if (!rows.some((row) => isBrandAuthor(row.authorId))) {
      dropped.noBrand += 1;
      continue;
    }
    if (!rows.some((row) => !isBrandAuthor(row.authorId))) {
      dropped.noCustomer += 1;
      continue;
    }
    threads.push(toThreadDocument(rows));
  }

  threads.sort((a, b) => b.messages.at(-1).timestamp - a.messages.at(-1).timestamp);

  return {
    threads: threads.slice(0, maxThreads),
    stats: { components: components.size, dropped, threadsBuilt: threads.length },
  };
}

/**
 * Convert one component's rows into an ordered thread document.
 *
 * Ordering is `createdAt` then file index, because equal-timestamp tweets do
 * occur and unstable ordering would make re-seeds produce different threads.
 * `threadId` is the earliest tweet's id — synthetic ids would break the
 * self-match guard in retrieval.
 *
 * @param {object[]} rows - Rows in the same conversation (any order).
 * @returns {{ threadId: string, brand: string, messages: Array<{ role: string, text: string, timestamp: Date, tweetId: string }> }} Thread document without derived fields.
 */
function toThreadDocument(rows) {
  const ordered = [...rows].sort((a, b) => a.createdAt - b.createdAt || a.index - b.index);

  /** @type {Array<{ role: string, text: string, timestamp: Date, tweetId: string }>} */
  const messages = [];
  for (const row of ordered) {
    const role = isBrandAuthor(row.authorId) ? 'agent' : 'customer';
    const previous = messages.at(-1);
    // Twitter threads repeat the same text when users reply to themselves.
    if (previous && previous.role === role && previous.text === row.text) continue;
    messages.push({ role, text: row.text, timestamp: row.createdAt, tweetId: row.tweetId });
  }

  return { threadId: ordered[0].tweetId, brand: 'Amazon', messages };
}
