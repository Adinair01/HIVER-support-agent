import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';

/**
 * Shared LLM transport mechanics: retry budget, retry-delay parsing, rate-limit
 * pacing, timeout constants and the 502 error mapping. groq.client.js uses these
 * so the transport stays under the 150-line limit and failure semantics live in
 * exactly one place.
 */

export const REQUEST_TIMEOUT_MS = 60_000;
export const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
/** Lowest HTTP status worth retrying even if the code is unrecognised. */
export const SERVER_ERROR_FLOOR = 500;
/** 3 attempts, not 2: free-tier 429s routinely need one retry after the hinted delay. */
export const MAX_ATTEMPTS = 3;
/** Retry hints beyond this outlive the request timeout — retrying is pointless. */
export const MAX_RETRY_DELAY_MS = 65_000;

/** Timestamp of the last provider call, used by the pacing queue below. */
let lastCallStartedAt = 0;
/** Serialises calls so the pacing gap is respected across concurrent callers. */
let pacingQueue = Promise.resolve();

/**
 * Test seam, shared by both transports (only one provider is ever active per
 * process, so one seam is enough). When set, `complete()` calls this instead of
 * the network, which is how the LLM wiring is verified without spending quota.
 *
 * @type {((params: { system: string, user: string, maxTokens: number, temperature: number, model: string }) => Promise<{ text: string, model?: string, usage?: object }>) | null}
 */
let injectedTransport = null;

/**
 * Install a fake transport (tests only).
 *
 * @param {typeof injectedTransport} transport - Replacement transport.
 * @returns {void}
 */
export function setGenerationTransport(transport) {
  injectedTransport = transport;
}

/**
 * Remove a previously installed fake transport.
 *
 * @returns {void}
 */
export function resetGenerationTransport() {
  injectedTransport = null;
}

/**
 * Read the currently installed test seam.
 *
 * @returns {typeof injectedTransport} The seam, or `null`.
 */
export function getInjectedTransport() {
  return injectedTransport;
}

/**
 * Promise-based delay used for the retry backoff.
 *
 * @param {number} ms - Milliseconds to wait.
 * @returns {Promise<void>} Resolves after the delay.
 */
export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Run a provider call through a pacing queue.
 *
 * Free tiers cap requests per minute per model, so long eval runs must slow
 * down rather than burn quota into a lockout. `LLM_MIN_INTERVAL_MS` sets the
 * minimum spacing; 0 disables pacing entirely.
 *
 * @template T
 * @param {() => Promise<T>} task - Provider call to run.
 * @returns {Promise<T>} The call's result.
 */
export function paced(task) {
  if (env.LLM_MIN_INTERVAL_MS <= 0) return task();

  const run = pacingQueue.then(async () => {
    const wait = env.LLM_MIN_INTERVAL_MS - (Date.now() - lastCallStartedAt);
    if (wait > 0) await sleep(wait);
    lastCallStartedAt = Date.now();
    return task();
  });

  // Keep the chain alive on failure without swallowing the error for the caller.
  pacingQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Read the provider's own retry hint, from whichever channel it arrives on.
 *
 * Honouring the hint is the difference between recovering from a quota error
 * and hammering the API into a longer lockout. Groq sends `retry-after` in a
 * response header or error metadata; the message-text regex catches SDKs that
 * flatten it into the error string.
 *
 * @param {unknown} error - Thrown provider error.
 * @returns {number | null} Delay in milliseconds, or `null` when absent.
 */
export function retryDelayMs(error) {
  const header = error?.headers?.['retry-after'] ?? error?.error?.metadata?.['retry-after'];
  const message = String(error?.message ?? '');

  const raw =
    header ??
    /retry[- ]after[^0-9]*(\d+(?:\.\d+)?)/i.exec(message)?.[1];
  const seconds = Number.parseFloat(String(raw ?? ''));
  if (!Number.isFinite(seconds)) return null;

  // Add a small cushion and never wait longer than the request timeout allows.
  return Math.min(Math.round(seconds * 1000) + 1_000, MAX_RETRY_DELAY_MS);
}

/**
 * Pull an HTTP status out of a provider error.
 *
 * @param {unknown} error - Thrown provider error.
 * @returns {number | null} Status code, or `null` when unknown — `null` falls
 *   through to message sniffing rather than to `false`.
 */
export function extractStatus(error) {
  const direct = Number(error?.status ?? error?.statusCode);
  if (Number.isFinite(direct) && direct >= 400) return direct;
  const match = /\[(\d{3})\b/.exec(String(error?.message ?? ''));
  return match ? Number(match[1]) : null;
}

/**
 * Decide whether a provider error is worth one retry.
 *
 * The SDKs surface HTTP status in `error.status` / inside the message text, so
 * the status is taken from either before falling back to message sniffing.
 *
 * @param {unknown} error - Thrown provider error.
 * @returns {boolean} `true` when a retry may succeed.
 */
export function isRetryable(error) {
  const status = extractStatus(error);
  if (status) return RETRYABLE_STATUS.has(status) || status >= SERVER_ERROR_FLOOR;
  return /quota|rate limit|overloaded|unavailable|timeout|network|fetch failed/i.test(
    String(error?.message ?? ''),
  );
}

/**
 * Run one provider task under the shared retry budget.
 *
 * AbortError (request timeout) never retries — the caller has already given up
 * on this attempt. Everything else maps to the same 502 `AppError` shape no
 * matter which provider failed, so callers never branch on provider.
 *
 * @template T
 * @param {() => Promise<T>} task - One attempt; called up to `MAX_ATTEMPTS` times.
 * @param {object} options - Logging context.
 * @param {object} options.log - pino logger (request-scoped when available).
 * @param {string} [options.label='completion'] - Pipeline stage name for logs and the 502 message.
 * @returns {Promise<T>} The task's result.
 * @throws {AppError} 502 when every attempt fails.
 */
export async function runWithRetries(task, { log, label = 'completion' }) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (error?.name === 'AbortError' || attempt === MAX_ATTEMPTS || !isRetryable(error)) break;
      const delay = retryDelayMs(error) ?? 600 * attempt;
      log.warn({ err: error.message.slice(0, 160), label, attempt, delayMs: delay }, 'model call failed — retrying');
      await sleep(delay);
    }
  }

  log.error({ err: lastError?.message, label }, 'model call failed');
  throw AppError.badGateway(
    `The language model request (${label}) could not be completed. Please retry shortly.`,
    lastError,
  );
}
