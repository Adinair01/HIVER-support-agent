import { classifyIntent } from '../services/classifier.service.js';
import { runSupportPipeline } from '../services/pipeline.service.js';
import { getThreadById } from '../services/retrieval.service.js';
import { catchAsync } from '../utils/catchAsync.js';

/**
 * Shape the pipeline result for the API.
 *
 * The service deliberately returns a rich, self-describing object; the public
 * contract is flatter so a caller can read `intent`, `reply.draft` and
 * `escalation.decision` without knowing the internal structure. Serialisation
 * belongs here, in the controller — the service contracts are unchanged.
 *
 * @param {object} pipeline - Result of `runSupportPipeline()`.
 * @returns {object} Public response payload.
 */
export function serialisePipelineResponse(pipeline) {
  const classification = pipeline?.classification ?? {};
  const response = pipeline?.response ?? {};
  const escalation = pipeline?.escalation ?? {};

  return {
    requestId: pipeline?.requestId ?? null,
    // --- documented contract (flat) ---
    intent: classification.intent ?? null,
    confidence: classification.confidence ?? 0,
    reply: {
      draft: response.draft ?? '',
      confidence: response.confidence ?? 0,
      sourcedFrom: response.sourcedFrom ?? [],
    },
    escalation: {
      decision: escalation.decision ?? 'escalate',
      reason: escalation.reason ?? 'No decision was produced.',
      triggeredBy: escalation.triggeredBy ?? 'rule',
    },
    // --- supporting detail, for debugging and demos ---
    classifier: {
      variant: classification.variant ?? null,
      degraded: Boolean(classification.degraded),
      rationale: classification.rationale ?? '',
      matchedRules: classification.matchedRules ?? [],
    },
    replyDetail: { degraded: Boolean(response.degraded) },
    escalationDetail: { flags: escalation.flags ?? [], llmReviewed: Boolean(escalation.llmReviewed) },
    evidence: pipeline?.retrieval?.evidence ?? [],
    retrievalQuery: pipeline?.retrieval?.searchQuery ?? '',
    timings: pipeline?.timings ?? {},
    degraded: pipeline?.degraded ?? [],
  };
}

/**
 * `POST /api/agent/process` — classify → retrieve → respond → escalate
 * (MAIN.md §4.7).
 *
 * Body fields are passed through as-is: the validator owns shape/coercion and the
 * pipeline owns defaults, so this handler stays a transport adapter.
 *
 * @param {import('express').Request} req - Validated request (zod body via `validateBody`).
 * @param {import('express').Response} res - Response.
 * @returns {Promise<void>} Resolves once the response is sent.
 */
export const processMessage = catchAsync(async (req, res) => {
  const { message, variant, useRetrieval, skipLlmEscalation, threadId, requestId } = req.body;

  const result = await runSupportPipeline({
    customerMessage: message,
    variant,
    useRetrieval,
    skipLlmEscalation,
    threadId,
    requestId,
  });

  res.status(200).json({ data: serialisePipelineResponse(result) });
});

/**
 * `POST /api/agent/classify` — classification only, for baseline comparisons
 * (MAIN.md §6).
 *
 * Exists so the report's variant comparison can be reproduced without running the
 * full pipeline (and without spending responder/retrieval quota).
 *
 * @param {import('express').Request} req - Validated request.
 * @param {import('express').Response} res - Response.
 * @returns {Promise<void>} Resolves once the response is sent.
 */
export const classifyMessage = catchAsync(async (req, res) => {
  const { message, variant, threadId } = req.body;
  const classification = await classifyIntent(message, { variant, requestId: threadId });

  res.status(200).json({
    data: {
      message,
      variant: classification.variant,
      intent: classification.intent,
      confidence: classification.confidence,
      rationale: classification.rationale,
      matchedRules: classification.matchedRules,
      degraded: Boolean(classification.degraded),
      parseError: classification.parseError ?? null,
    },
  });
});

/**
 * `GET /api/agent/thread/:id` — fetch one stored thread.
 *
 * @param {import('express').Request} req - Request with validated params.
 * @param {import('express').Response} res - Response.
 * @returns {Promise<void>} Resolves once the response is sent.
 */
export const getThread = catchAsync(async (req, res) => {
  const thread = await getThreadById(req.validatedParams.id);
  res.status(200).json({ data: thread });
});
