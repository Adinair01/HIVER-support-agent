import { z } from 'zod';
import { CLASSIFIER_VARIANTS } from './agent.validator.js';

/** `POST /api/eval/run` — kick off an evaluation run. */
export const runEvalBodySchema = z
  .object({
    variants: z.array(z.enum(CLASSIFIER_VARIANTS)).min(1).max(3).optional(),
    /** 0 disables the LLM judge entirely (useful for a cheap smoke run). */
    judgeSampleSize: z.coerce.number().int().min(0).max(200).optional(),
    /** Max golden-set rows to evaluate; omitted means all of them. */
    limit: z.coerce.number().int().min(1).max(500).optional(),
    /** Generate replies for every row (expensive) or only for judging/reply metrics. */
    generateReplies: z.boolean().default(true),
    storeResult: z.boolean().default(true),
  })
  .strict();

/** `GET /api/eval/results` — list query. */
export const listResultsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** `GET /api/eval/results/:runId` — path params. */
export const runIdParamsSchema = z.object({
  runId: z.string().trim().min(1, 'runId is required').max(80),
});
