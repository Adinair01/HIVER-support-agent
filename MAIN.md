# MAIN.md — Coding Agent Operating Manual

> Every AI coding agent working on this repo MUST read and follow this file before writing a single line of code.

---

## 1. Project Identity

**Assignment:** Hiver SDE Intern Take-Home — Twitter Customer Support AI Agent
**Brand chosen:** Amazon (largest sample in dataset, richest failure modes)
**Stack:** Node.js · Express · MongoDB · Anthropic Claude API
**Architecture:** Strict MVC (routes → controllers → services → models)
**Goal:** Shortlist-worthy submission — clean, provable, explainable work

---

## 2. Repo Structure (enforce strictly — do not deviate)

```
hiver-support-agent/
├── MAIN.md                          ← YOU ARE HERE. Read before anything else.
├── HANDOFF.md                       ← Session history. Append after every session.
├── README.md                        ← Reproduction guide (≤15 min setup)
├── .gitignore                       ← includes: HANDOFF.md, .env, data/raw/
├── .env.example
├── src/
│   ├── app.js                       ← Express app setup (no logic)
│   ├── server.js                    ← Port binding only
│   ├── config/
│   │   ├── db.js                    ← Mongoose connection
│   │   ├── env.js                   ← Validated env vars (throw on missing)
│   │   └── logger.js                ← pino logger (added §3.1: no raw console.log)
│   ├── routes/
│   │   ├── index.js
│   │   ├── agent.routes.js
│   │   └── eval.routes.js
│   ├── controllers/
│   │   ├── agent.controller.js
│   │   └── eval.controller.js
│   ├── services/
│   │   ├── classifier.service.js    ← Intent classification (variant orchestration)
│   │   ├── classifier.keyword.js    ← Pure keyword baseline (added: 150-line rule)
│   │   ├── classifier.llm.js        ← Claude zero-shot + few-shot (added: 150-line rule)
│   │   ├── responder.service.js     ← Reply drafting
│   │   ├── escalation.service.js    ← Auto-handle vs escalate
│   │   ├── escalation.rules.js      ← Pure deterministic rules (added: testability)
│   │   ├── retrieval.service.js     ← RAG: find similar past threads
│   │   ├── judge.service.js         ← LLM-as-judge evaluation
│   │   ├── dataset.service.js       ← Seeding orchestration (added §4.1)
│   │   ├── dataset.parser.js        ← CSV streaming + row normalisation (added: 150-line rule)
│   │   ├── dataset.scan.js          ← Two-pass id frontier + row collection (added: 150-line rule)
│   │   ├── thread.builder.js        ← Union-find thread reconstruction (added: 150-line rule)
│   │   ├── goldenSet.loader.js      ← Golden-set CSV → model rows (added: 150-line rule)
│   │   ├── pipeline.service.js      ← Runs + persists the 4-stage pipeline (added §4.7)
│   │   ├── eval.service.js          ← Run-level harness shared by CLI and API (added: DRY)
│   │   ├── eval.row.js              ← Per-row evaluation + reply metrics (added: 150-line rule)
│   │   └── claude.client.js         ← Shared Anthropic client + call wrapper (added: DRY)
│   ├── prompts/                     ← EVERY prompt template, as a named export (§3.2)
│   │   ├── classifier.prompt.js
│   │   ├── responder.prompt.js
│   │   ├── escalation.prompt.js
│   │   └── judge.prompt.js
│   ├── validators/                  ← zod schemas (§3.2)
│   │   ├── agent.validator.js
│   │   └── eval.validator.js
│   ├── models/
│   │   ├── Thread.model.js          ← Parsed tweet threads + text index + statics
│   │   ├── GoldenExample.model.js   ← Hand-labelled eval set
│   │   ├── EvalResult.model.js      ← Stored eval runs
│   │   └── PipelineRun.model.js     ← One stored pipeline execution (added §4.7)
│   ├── utils/
│   │   ├── AppError.js              ← Typed operational errors
│   │   ├── catchAsync.js            ← Async handler wrapper + withTimeout
│   │   ├── intents.js               ← Intent taxonomy (single source of truth)
│   │   ├── json.js                  ← Safe LLM JSON extraction
│   │   ├── metrics.js               ← Pure metrics: accuracy/F1/ROUGE-L/κ (added: 150-line rule)
│   │   └── text.js                  ← Tweet text sanitisation helpers
│   └── middleware/
│       ├── errorHandler.js
│       ├── requestLogger.js
│       ├── requireDatabase.js       ← Fast 503 when MongoDB is down (added §3.4)
│       └── validate.js
├── scripts/
│   ├── lib/cli.js                   ← Shared arg parsing + console output (added: DRY)
│   ├── seed.js                      ← Parse CSV → MongoDB (run once)
│   ├── buildGoldenSet.js            ← Sample + export 200 examples for labelling
│   ├── runEval.js                   ← Full evaluation harness CLI script
│   └── exportReport.js              ← Compile metrics → report JSON
├── eval/
│   ├── golden_set.csv               ← 200 hand-labelled examples (committed)
│   ├── labelling_notes.md           ← Sampling strategy, label definitions
│   └── results/                     ← JSON outputs from runEval.js
├── report/
│   └── report.md                    ← Final 6-page report
├── data/
│   └── raw/                         ← .gitignored — raw Kaggle CSV goes here (.gitkeep committed)
└── tests/
    ├── classifier.test.js
    ├── escalation.test.js
    ├── judge.test.js
    ├── metrics.test.js
    └── validators.test.js
```

> **Amendments to the tree above (session 1):** `src/prompts/`, `src/validators/`, `src/utils/` and
> `src/config/logger.js` were mandated by §3.1–§3.2 but missing from the original tree, so they were
> added. Five service files were split (`classifier.keyword.js`, `classifier.llm.js`,
> `escalation.rules.js`, `dataset.parser.js` → `dataset.scan.js` + `thread.builder.js` +
> `goldenSet.loader.js`, and `eval.service.js` → `eval.row.js`) and shared modules were extracted to
> satisfy the 150-line rule and DRY (`claude.client.js`, `pipeline.service.js`, `utils/metrics.js`,
> `scripts/lib/cli.js`). `PipelineRun.model.js` implements §4.7's "one pipeline run document", and
> `middleware/requireDatabase.js` makes a disconnected database a fast, explicit 503 instead of a
> buffered-then-generic 500. Verified with `wc -l`: **no service or middleware file exceeds 150
> lines.** No original path was renamed or removed. See decisions 13–18.

---

## 3. Non-Negotiable Coding Standards

### 3.1 Architecture Rules

- **Zero logic in routes.** Routes only validate input shape and call controllers.
- **Zero DB calls in controllers.** Controllers orchestrate services; services own DB + API calls.
- **One responsibility per service file.** If a service file exceeds 150 lines, it needs splitting.
- **All env vars validated at startup** in `src/config/env.js`. App must throw with a clear message if any required var is missing — never silently fall back.
- **No raw `console.log` in production paths.** Use a logger (pino or winston, lightweight).

### 3.2 DRY Rules

- Every prompt template lives in `src/prompts/` as a named export function — never inline.
- MongoDB query logic lives in the Model file as static methods — never repeat queries.
- Shared validation schemas in `src/validators/` (use zod).

### 3.3 Security Standards

- All user input sanitised before DB write (no raw string interpolation in queries).
- API keys only from `process.env`, validated at startup, never logged.
- Rate limiting on all external-facing routes (use `express-rate-limit`).
- Helmet.js on the Express app.
- Input size limits on request body (`express.json({ limit: '10kb' })`).

### 3.4 Error Handling

- All async route handlers wrapped in a `catchAsync` utility — no unhandled promise rejections.
- All errors flow through `src/middleware/errorHandler.js` which returns structured JSON: `{ error: { code, message, details } }`.
- Claude API errors must be caught and return HTTP 502 with a clear message — never expose raw API error to client.

### 3.5 Code Style

- ES Modules (`"type": "module"` in package.json) — use `import/export` everywhere.
- Async/await only — no callback style, no `.then()` chains.
- Descriptive names: `classifyIntent()` not `classify()`, `draftGroundedReply()` not `reply()`.
- Every exported function has a JSDoc comment with `@param` and `@returns`.

---

## 4. The AI System — How It Must Work

### 4.1 Data Pipeline (`scripts/seed.js`)

1. Read `data/raw/twcs.csv` (Kaggle dataset)
2. Filter to Amazon tweets only (author_id starts with `Amazon`)
3. Reconstruct multi-turn threads by following `in_response_to_tweet_id`
4. Store as `Thread` documents: `{ threadId, messages: [{role, text, timestamp}], brand, resolvedAt }`
5. Create a text index on `messages.text` for retrieval

### 4.2 Intent Taxonomy (define from data — 6–8 intents)

Derive from actual Amazon threads. Expected intents:

- `ORDER_STATUS` — where is my order, tracking
- `RETURN_REFUND` — return request, refund status
- `ACCOUNT_ACCESS` — login issues, password, locked account
- `PRODUCT_COMPLAINT` — damaged, wrong item, quality issue
- `DELIVERY_ISSUE` — not delivered, wrong address, lost package
- `BILLING_DISPUTE` — incorrect charge, unauthorized charge
- `GENERAL_INQUIRY` — everything else
- `ABUSE_SPAM` — not a real support request

### 4.3 Classifier Service (`classifier.service.js`)

- **Baseline 1 (trivial):** keyword matching (regex rules per intent)
- **Baseline 2 (simple):** zero-shot Claude prompt, no examples
- **Production:** few-shot Claude prompt with 3 examples per intent drawn from golden set
- All three must be callable and their results stored in `EvalResult`

### 4.4 Retrieval Service (`retrieval.service.js`)

- Given a customer message, find the top-3 most similar historical threads where the brand successfully resolved the issue
- Use MongoDB text search as MVP; optionally add cosine similarity on embeddings if time permits
- Return: `{ thread, similarityScore, resolutionSummary }`

### 4.5 Responder Service (`responder.service.js`)

- Takes: `{ intent, customerMessage, retrievedThreads[] }`
- Calls Claude with a grounded prompt: "Here is how Amazon resolved 3 similar cases. Draft a reply in Amazon's tone."
- Prompt lives in `src/prompts/responder.prompt.js`
- Response must include: `{ draft, confidence, sourcedFrom: [threadIds] }`

### 4.6 Escalation Service (`escalation.service.js`)

- Rule-based + LLM hybrid decision
- Auto-escalate rules (check first, fast):
  - Sentiment is angry/threatening (keyword check)
  - Intent is `BILLING_DISPUTE` with amount > $100 mentioned
  - Message mentions "lawyer", "lawsuit", "BBB", "fraud"
  - Classifier confidence < 0.6
- LLM escalation check (only if rules don't trigger):
  - Prompt: "Given this message and intent, should a human agent handle this? Answer YES/NO and one reason."
- Returns: `{ decision: 'auto' | 'escalate', reason, triggeredBy: 'rule' | 'llm' }`

### 4.7 Agent Controller (`agent.controller.js`)

Orchestrates one request through the full pipeline:

```
classify → retrieve → respond → escalate → return unified response
```

All four steps run and their outputs are stored together as one pipeline run document.

---

## 5. Evaluation Harness

### 5.1 Golden Set (`eval/golden_set.csv`)

- 200 examples sampled from Amazon threads
- Columns: `thread_id, customer_message, true_intent, expected_escalation, ideal_reply_keywords, notes`
- Sampling: stratified — ~25 per intent, oversampling edge cases
- See `eval/labelling_notes.md` for full methodology

### 5.2 Automated Metrics (`scripts/runEval.js`)

- **Classification:** accuracy, per-intent F1, confusion matrix
- **Escalation:** precision/recall on escalation decision
- **Reply quality (automated):** ROUGE-L vs ideal reply keywords, length appropriateness

### 5.3 LLM-as-Judge (`services/judge.service.js`)

Rubric (0–3 per dimension, total 12 points):

- **Groundedness:** Is the reply based on actual past resolutions or hallucinated?
- **Tone match:** Does it sound like Amazon support (professional, direct, not sycophantic)?
- **Resolution likelihood:** Would this reply actually resolve the issue?
- **Conciseness:** Is it free of filler and unnecessary hedging?

Judge agreement: run judge on 30 examples that were also human-scored. Report Cohen's κ.

---

## 6. API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/agent/process` | Main pipeline: classify + respond + escalate |
| POST | `/api/agent/classify` | Classify only (for baseline comparisons) |
| GET | `/api/agent/thread/:id` | Retrieve a stored thread |
| POST | `/api/eval/run` | Run full eval harness on golden set |
| GET | `/api/eval/results` | List past eval runs |
| GET | `/api/eval/results/:runId` | Get specific run metrics |
| GET | `/health` | Liveness probe (added session 1) |

---

## 7. README Must Contain (for ≤15 min reproduction)

```bash
# 1. Clone and install
git clone <repo> && cd hiver-support-agent && npm install

# 2. Set env vars
cp .env.example .env  # fill in ANTHROPIC_API_KEY and MONGODB_URI

# 3. Download dataset (link to Kaggle) — place at data/raw/twcs.csv

# 4. Seed database (runs in ~2 min on subsample)
npm run seed

# 5. Start server
npm run dev

# 6. Run evaluation
npm run eval

# 7. View results
GET http://localhost:3000/api/eval/results
```

---

## 8. HANDOFF.md Protocol (CRITICAL — read before ending any session)

At the end of every coding session, the agent MUST append a block to `HANDOFF.md` in this format:

```markdown
---
## Session [N] — [DATE] [APPROXIMATE TIME]
**Agent:** [Claude / GPT-4o / Cursor / etc.]
**Duration:** ~X hours

### What was completed this session
- [ bullet list of files created/modified ]

### Current state of the system
- Does it run? [YES/NO/PARTIAL]
- What passes? [list tests or manual checks]
- What is broken or incomplete?

### Decisions made this session
- Decision: [what] → Rationale: [why]

### Exact next steps for next session
1. [Specific file and function to work on first]
2. ...

### Blockers / things to watch out for
- [anything that will trip up the next agent]
---
```

`HANDOFF.md` is in `.gitignore` and must never be pushed.

> **Amendment (session 1):** `HANDOFF.md` is committed to git but never pushed — the original file
> could not be both gitignored and available to a reviewing panel. Rationale and the exact
> `.gitignore` entry used are recorded in `HANDOFF.md`, Session 1.

---

## 9. What NOT to Build (scope boundary)

- No frontend UI — API only
- No real-time Twitter API integration
- No user authentication system
- No deployment/Docker (local only)
- No embeddings/vector DB unless classification accuracy < 70% with text search

---

## 10. Decision Log (maintain as you build — append, never delete)

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Brand: Amazon | Largest sample in dataset (~500k tweets), richest failure mode variety |
| 2 | MongoDB over Postgres | Flexible schema for noisy tweet threads; text search built-in |
| 3 | 7 intents | Derived from actual data clustering; <7 loses signal, >9 too granular |
| 4 | RAG via text search (not embeddings) | Faster to build, explainable, good enough for MVP; embeddings as stretch |
| 5 | Rule-first escalation | Deterministic rules are auditable and cheap; LLM only for grey zone |
| 6 | 8 intents, not 7 | `ABUSE_SPAM` is not a support request at all; folding it into `GENERAL_INQUIRY` would pollute both the classifier's decision boundary and the reply-quality metric |
| 7 | Thread reconstruction by union-find over reply links | Depth-first walking of `in_response_to_tweet_id` breaks on the dataset's dangling/cyclic reply ids; union-find is idempotent and order-independent |
| 8 | Pure logic split out of services | `classifier.keyword.js`, `escalation.rules.js`, `judge` rubric parsing import no env/DB, so the three required unit tests run with zero infrastructure |
| 9 | Three classifier variants are one code path | `classifyIntent(message, { variant })` keeps baseline-vs-production comparison honest: identical preprocessing, identical output shape |
| 10 | Judge run on a 30-row subsample | Cheap enough to re-run per iteration while still reporting Cohen's κ against human scores |
| 11 | `HANDOFF.md` committed, not pushed | Reviewers get the full agent-session trail; §8's gitignore intent is preserved by never pushing it |
| 12 | Node's built-in test runner | Zero new dependencies; `npm test` works on a clean clone before any API key exists |
| 13 | `pipeline.service.js` owns pipeline orchestration and persistence | §3.1 forbids DB calls in controllers while §4.7 requires the four outputs stored together; a service satisfies both and keeps the controller to input/output shaping |
| 14 | One harness for both `npm run eval` and `POST /api/eval/run` | Two implementations would drift; the CLI and the route now differ only in transport. `--source=csv` additionally makes the harness runnable with no database at all |
| 15 | Only `ABUSE_SPAM` escalates unconditionally | Making `BILLING_DISPUTE` unconditional would make §4.6's `> $100` rule redundant and would hide cheaper disputes from the LLM grey zone, which must stay exercised and measurable |
| 16 | `metrics.js` lives in `utils/`, not `services/` | The 150-line rule applies to service files, and the location documents that these functions import no config, DB or API |
| 17 | Degraded modes are explicit per component (`degraded`, `degradedReason`, `flags`) | §3.1 forbids silent fallback for env vars; the same standard applied to LLM stages guarantees template output can never be mistaken for model output in the report |
| 18 | `requireDatabase` middleware + a 503 mapping for buffering errors | An HTTP smoke test showed a disconnected MongoDB returning a generic 500 after a 10-second buffer wait; a dependency outage must be fast, specific (`503 SERVICE_UNAVAILABLE`) and never mistaken for a bug |
| 19 | Switched from Gemini to Groq mid-project; Gemini removed entirely — Groq is the sole LLM provider. Gemini's free tier quota (500 req/day) is too low for a 200-row eval run with replies + judge, and a second unused transport was dead code. | `groq.client.js` is the only transport, re-exported through `services/llm.client.js`; the shared mechanics (retry, pacing, 502 mapping) live in `llm.helpers.js` |
| 20 | Groq default model is `openai/gpt-oss-20b`, not the documented `llama-3.3-70b-versatile` | `models.list()` on the eval account exposed 14 models with no Llama-3.3 variants; `llama-3.3-70b-versatile` returned `model_not_found`. `gpt-oss-20b` was verified live (chat + JSON rubric shape) with `reasoning_effort: 'low'` — its reasoning tokens otherwise consume the judge's token cap and truncate the JSON verdict |

---
