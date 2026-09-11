/**
 * Wrap an async Express handler so a rejected promise reaches the error
 * middleware instead of crashing the process (MAIN.md §3.4).
 *
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<unknown>} handler - Async handler.
 * @returns {import('express').RequestHandler} Synchronous wrapper that forwards rejections.
 */
export function catchAsync(handler) {
  return function wrappedHandler(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * Run an async task with a timeout, so a hung upstream can never pin a request.
 *
 * @param {Promise<T>} promise - Task to await.
 * @param {number} ms - Timeout in milliseconds.
 * @param {string} label - Name used in the timeout message.
 * @returns {Promise<T>} The task's resolution.
 * @template T
 * @throws {Error} When `ms` elapses first.
 */
export async function withTimeout(promise, ms, label = 'operation') {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
