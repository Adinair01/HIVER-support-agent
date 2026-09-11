import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

/**
 * Load `.env` from the project root once, before anything reads `process.env`.
 * `quiet` suppresses dotenv's marketing banner so logs stay parseable.
 */
dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true });

/**
 * Strip blank strings so `FOO=` behaves like "not provided" and the schema
 * default (or a clear "required" error) applies instead of a coercion failure.
 *
 * @param {Record<string, unknown>} raw - `process.env`-shaped object.
 * @returns {Record<string, unknown>} Copy with blank values removed.
 */
function dropBlankValues(raw) {
  return Object.fromEntries(
    Object.entries(raw).filter(([, value]) => !(typeof value === 'string' && value.trim() === '')),
  );
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  MONGODB_URI: z.string().min(1),

  GROQ_API_KEY: z.string().min(1),
  GROQ_MODEL: z.string().min(1).default('openai/gpt-oss-20b'),
  // 2048, not 1024: gpt-oss bills reasoning tokens against this cap before the
  // JSON answer starts, so 1024 truncated responder output mid-object.
  LLM_MAX_TOKENS: z.coerce.number().int().positive().max(8192).default(2048),
  /** Minimum spacing between provider calls. 0 = unlimited; set it to respect a free-tier RPM cap. */
  LLM_MIN_INTERVAL_MS: z.coerce.number().int().min(0).max(120_000).default(0),

  /** Optional: only needed to auto-download the Kaggle dataset during seeding. */
  KAGGLE_USERNAME: z.string().min(1).optional(),
  KAGGLE_KEY: z.string().min(1).optional(),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),

  SEED_MAX_THREADS: z.coerce.number().int().min(0).default(5000),
  EVAL_JUDGE_SAMPLE_SIZE: z.coerce.number().int().min(0).default(30),
});

/**
 * Validate the process environment, failing loudly and early.
 *
 * MAIN.md §3.1: the app must throw with a clear message when a required
 * variable is missing — never silently fall back to a default.
 *
 * @param {Record<string, unknown>} [source=process.env] - Raw env source.
 * @returns {object} Frozen, fully-typed config object.
 * @throws {Error} If any required variable is missing or malformed.
 */
export function loadEnv(source = process.env) {
  const parsed = envSchema.safeParse(dropBlankValues(source));

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${details}\n\n` +
        'Fix: copy .env.example to .env at the repo root and fill in the values ' +
        '(at minimum MONGODB_URI and GROQ_API_KEY).',
    );
  }

  const data = parsed.data;

  // Kaggle credentials are optional, but half a pair is a configuration bug that
  // would otherwise surface as a confusing 401 during a download.
  if (Boolean(data.KAGGLE_USERNAME) !== Boolean(data.KAGGLE_KEY)) {
    throw new Error(
      'Invalid environment configuration:\n' +
        '  • KAGGLE_USERNAME and KAGGLE_KEY must be set together (or both omitted).\n' +
        'Set both to enable automatic dataset download, or neither to use a local twcs.csv.',
    );
  }

  return Object.freeze({
    ...data,
    isProduction: data.NODE_ENV === 'production',
    isTest: data.NODE_ENV === 'test',
    kaggleConfigured: Boolean(data.KAGGLE_USERNAME && data.KAGGLE_KEY),
  });
}

/**
 * Validated environment configuration. Import this — never `process.env` —
 * from services, controllers and scripts (MAIN.md §3.1).
 *
 * @type {ReturnType<typeof loadEnv>}
 */
export const env = loadEnv();
