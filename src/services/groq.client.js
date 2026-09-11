import Groq from 'groq-sdk';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../utils/AppError.js';
import { withTimeout } from '../utils/catchAsync.js';
import {
  REQUEST_TIMEOUT_MS,
  getInjectedTransport,
  paced,
  resetGenerationTransport,
  runWithRetries,
  setGenerationTransport,
} from './llm.helpers.js';

/**
 * Groq transport — the sole LLM backend.
 *
 * The interface is `{ system, user }` in, `{ text, model, usage }` out. Retry,
 * pacing, timeout and error mapping live in `llm.helpers.js`; the module stays
 * transport-only so a future provider change is confined to one file.
 */

export { setGenerationTransport, resetGenerationTransport };

/** @type {Groq | null} Lazily-created singleton. */
let client = null;

/**
 * Shape check only — never a network call. Groq keys start `gsk_`; the length
 * and placeholder guards catch `.env.example` paste-throughs.
 *
 * @param {string} [apiKey=env.GROQ_API_KEY] - Key to inspect.
 * @returns {boolean} `true` when a usable key appears to be present.
 */
export function isProviderConfigured(apiKey = env.GROQ_API_KEY) {
  if (!apiKey || apiKey.length < 20) return false;
  return !/x{8,}/i.test(apiKey) && !/^(your|test|placeholder)/i.test(apiKey);
}

/**
 * Get the singleton Groq client.
 *
 * @returns {Groq} Configured SDK client.
 * @throws {AppError} 503 when the key is missing or still a placeholder.
 */
export function getProviderClient() {
  if (!isProviderConfigured()) {
    throw AppError.unavailable(
      'GROQ_API_KEY is not configured. Set a real key in .env to use the LLM-backed endpoints.',
    );
  }
  client ??= new Groq({ apiKey: env.GROQ_API_KEY });
  return client;
}

/**
 * Run one generation and return the text.
 *
 * @param {object} params - Call parameters.
 * @param {string} params.system - System instruction.
 * @param {string} params.user - User prompt.
 * @param {string} [params.label='completion'] - Names the pipeline stage in the 502 message.
 * @param {number} [params.maxTokens=env.LLM_MAX_TOKENS] - Output token cap.
 * @param {number} [params.temperature=0] - Sampling temperature (0 keeps eval reproducible).
 * @param {string} [params.requestId] - Correlation id for logs.
 * @returns {Promise<{ text: string, model: string, usage: { inputTokens: number, outputTokens: number } }>} Model output.
 * @throws {AppError} 502 when the provider fails after all retries.
 */
export async function complete({
  system,
  user,
  label = 'completion',
  maxTokens = env.LLM_MAX_TOKENS,
  temperature = 0,
  requestId,
}) {
  const log = requestId ? logger.child({ requestId }) : logger;

  // The seam is resolved per attempt, not once up front: retry tests install a
  // stub that fails on the first call and succeeds on the second.
  const callOnce = async () => {
    const injected = getInjectedTransport();
    if (injected) {
      const result = await injected({ system, user, maxTokens, temperature, model: env.GROQ_MODEL });
      return {
        // Normalise exactly like the live path so tests exercise real shape.
        text: String(result.text ?? '').trim(),
        model: result.model ?? `${env.GROQ_MODEL} (injected)`,
        usage: result.usage ?? { inputTokens: 0, outputTokens: 0 },
      };
    }
    return paced(() => generateOnce({ system, user, maxTokens, temperature, modelName: env.GROQ_MODEL }));
  };

  return withTimeout(
    runWithRetries(callOnce, { log, label: `groq:${label}` }),
    REQUEST_TIMEOUT_MS,
    `groq:${label}`,
  );
}

/**
 * One non-retried provider call, normalised to the shared result shape.
 *
 * Chat completions return choices; the shared consumers read `text`/`usage`,
 * so token fields are mapped explicitly (prompt/completion, not input/output).
 *
 * @param {object} params - Generation parameters.
 * @param {string} params.system - System instruction.
 * @param {string} params.user - User prompt.
 * @param {number} params.maxTokens - Output token cap.
 * @param {number} params.temperature - Sampling temperature.
 * @param {string} params.modelName - Provider model id.
 * @returns {Promise<{ text: string, model: string, usage: { inputTokens: number, outputTokens: number } }>} Model output.
 */
async function generateOnce({ system, user, maxTokens, temperature, modelName }) {
  const params = {
    model: modelName,
    // Groq has no separate system endpoint; the system message is the convention.
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: maxTokens,
    temperature,
  };

  // gpt-oss emits reasoning before the answer, billed against the same token cap
  // and the same TPD budget. `low` keeps a 45-row eval inside the free tier and
  // stops the judge's JSON verdict from being cut off mid-object.
  if (modelName.startsWith('openai/gpt-oss')) params.reasoning_effort = 'low';

  const response = await getProviderClient().chat.completions.create(params);

  const choice = response?.choices?.[0];
  const text = String(choice?.message?.content ?? '').trim();
  if (!text) {
    const reason = choice?.finish_reason ?? 'unknown';
    throw new Error(`Model returned an empty response (finish_reason: ${reason})`);
  }

  return {
    text,
    model: response.model ?? modelName,
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    },
  };
}
