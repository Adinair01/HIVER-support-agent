import { z } from 'zod';
import { INTENTS } from '../utils/intents.js';

/** @type {ReadonlyArray<string>} Classifier variants selectable per request. */
export const CLASSIFIER_VARIANTS = Object.freeze(['keyword', 'zero-shot', 'few-shot']);

/** @type {ReadonlyArray<string>} Variants actually used by the production pipeline. */
export const PIPELINE_VARIANTS = Object.freeze(['keyword', 'few-shot']);

const messageField = z
  .string()
  .trim()
  .min(3, 'message must be at least 3 characters')
  .max(1000, 'message must be at most 1000 characters');

const variantField = z.enum(CLASSIFIER_VARIANTS);

/** `POST /api/agent/classify` — classify a single message. */
export const classifyBodySchema = z.object({
  message: messageField,
  variant: variantField.default('few-shot'),
  /** Optional golden-set id used to exclude a self-match during few-shot prompting. */
  threadId: z.string().trim().max(64).optional(),
});

/** `POST /api/agent/process` — the full pipeline. */
export const processBodySchema = classifyBodySchema.extend({
  useRetrieval: z.boolean().default(true),
  /** Bypass retrieval+responder and only return classification + escalation. */
  classifyOnly: z.boolean().default(false),
  /** Skip the LLM escalation review even when rules do not trigger. */
  skipLlmEscalation: z.boolean().default(false),
  /** Caller-supplied correlation id, echoed back for tracing. */
  requestId: z.string().trim().min(1).max(64).optional(),
});

/** `GET /api/agent/thread/:id` — path params. */
export const threadParamsSchema = z.object({
  id: z.string().trim().min(1, 'thread id is required').max(64),
});

/**
 * Optional filter for listing golden-set intents (exposed for debugging).
 * Kept here so route files never build a schema inline (MAIN.md §3.2).
 */
export const intentQuerySchema = z.object({
  intent: z.enum(INTENTS).optional(),
});
