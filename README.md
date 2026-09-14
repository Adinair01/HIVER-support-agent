# hiver-support-agent

An AI customer-support agent for **Amazon Help on Twitter**, built for the Hiver
SDE Intern take-home. One request runs a full pipeline - classify intent →
retrieve similar resolved threads → draft a grounded reply → decide
auto-handle vs escalate - and every step is measured by an evaluation harness
with an LLM-as-judge rubric.

Stack: **Node.js · Express · MongoDB · Groq**, strict MVC. The
operating manual that governs the codebase is [`MAIN.md`](./MAIN.md); read it
first.

---

## Results at a glance

Every component is evaluated on a committed golden set (`eval/golden_set.csv`) using our single-pass evaluation harness (`npm run eval`).

| Stage | Baseline / Method | Production (LLM-backed) | Key Metric / Finding |
|---|---|---|---|
| **Classification (n=200)** | **Keyword:** 62.0% accuracy, 65.6% Macro F1 | — | Deterministic baseline; high precision (≥79% on 7/8 intents), misses outcomes |
| **Classification (n=45)** | **Keyword:** 57.8% accuracy | **Zero-Shot:** 95.6% acc<br>**Few-Shot:** 88.9% acc | Zero-shot outperforms few-shot on this subset (inversion analyzed in report) |
| **Escalation (n=200)** | **Deterministic rules only:** 56.4% Prec, 85.7% Recall | **Hybrid (Rules + LLM):** 75.0% Prec, 96.4% Recall | Rule-first filters critical risk; LLM review lifts precision by +18.6% |
| **Reply Quality (n=200)** | **Template fallback:** Mean ROUGE-L: 0.116 | Keyword coverage: 20.2% | Length appropriate: 100% (mean 22.6 words); establishes grounded floor |
| **Evaluation Harness** | **133 unit tests passing** (`npm test`) | **Offline & live reproducibility** | Runs with or without DB/API key; degraded paths testable offline |

---

## 1. Setup (≤15 minutes)

```bash
# 1. Clone and install
git clone <repo> && cd hiver-support-agent && npm install

# 2. Set env vars
cp .env.example .env        # fill in ANTHROPIC_API_KEY and MONGODB_URI

# 3. Download the dataset (link below) and place it at data/raw/twcs.csv
#    https://www.kaggle.com/datasets/thoughtvector/customer-support-on-twitter
#    (~500 MB; the loader only needs the file, not the full extraction)

# 4. Seed the database — ~2 minutes for the default 5,000-thread subsample
npm run seed -- --golden    # --golden also loads eval/golden_set.csv

# 5. Start the server
npm run dev

# 6. Run the evaluation harness
npm run eval

# 7. View the results
curl http://localhost:3000/api/eval/results | jq
```

### Prerequisites

| Requirement | Notes |
|---|---|
| Node.js ≥ 20 | ES modules throughout; developed on Node 26 |
| MongoDB | Local `mongod` or a free Atlas cluster. `MONGODB_URI` accepts either. |
| Anthropic API key | Required for the LLM steps. Without a real key the LLM-backed parts degrade loudly instead of failing silently — see §5. |
| Kaggle dataset | Only needed for `npm run seed` against real tweets. The evaluation harness can run from the committed golden set with no dataset and no database. |

### Environment variables

Everything is validated at startup in `src/config/env.js`; the process throws
with a list of offending variables rather than falling back to a default.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GROQ_API_KEY` | yes | — | Groq access for classifier/responder/escalation/judge |
| `MONGODB_URI` | yes | — | Thread store, golden set, eval results |
| `PORT` | no | `3000` | HTTP port |
| `NODE_ENV` | no | `development` | `production` hides internal error messages |
| `LOG_LEVEL` | no | `info` | pino level |
| `GROQ_MODEL` | no | `openai/gpt-oss-20b` | Model for every LLM step |
| `LLM_MAX_TOKENS` | no | `2048` | Output cap per call |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | no | `60000` / `60` | Global limiter on `/api` |
| `SEED_MAX_THREADS` | no | `5000` | Thread cap per seed run |
| `EVAL_JUDGE_SAMPLE_SIZE` | no | `30` | Rows scored by the LLM judge |

---

## 2. What the pipeline does

```
POST /api/agent/process
  ├─ classify   keyword | zero-shot | few-shot (3 examples per intent from the golden set)
  ├─ retrieve   MongoDB $text search over resolved threads → top 3, with similarity scores
  ├─ respond    Groq, grounded in "how Amazon resolved these 3 cases" → { draft, confidence, sourcedFrom }
  └─ escalate   deterministic rules first, LLM review only for the grey zone
                → { decision, reason, triggeredBy: 'rule' | 'llm' }
        ↓
  one `pipeline_runs` document holds all four outputs for the request
```

Escalation rules (checked before any LLM call, all deterministic):

| Rule | Trigger |
|---|---|
| `legal_threat` | lawyer / lawsuit / BBB / FTC / regulator / court |
| `fraud_or_unauthorized` | fraud, unauthorised charge, hacked, police report, chargeback |
| `angry_sentiment` | anger or threatening phrases, or a mostly-uppercase message |
| `high_value_billing` | `BILLING_DISPUTE` mentioning more than $100 |
| `abuse_or_spam` | intent is `ABUSE_SPAM` — never auto-reply publicly |
| `low_confidence` | classifier confidence < 0.6 |

---

## 3. API

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/agent/process` | Full pipeline. Body: `{ message, variant?, useRetrieval?, skipLlmEscalation?, threadId? }` |
| `POST` | `/api/agent/classify` | Classification only, for baseline comparisons |
| `GET` | `/api/agent/thread/:id` | Fetch a stored thread by thread id or Mongo id |
| `POST` | `/api/eval/run` | Run the harness. Body: `{ variants?, judgeSampleSize?, limit?, generateReplies?, storeResult? }` |
| `GET` | `/api/eval/results` | List past runs (`?limit=25`) |
| `GET` | `/api/eval/results/:runId` | Full metrics for one run |
| `GET` | `/health` | Liveness + database state |

Every error — including upstream Claude failures — returns the same shape:
`{ "error": { "code", "message", "details" } }`. A Claude outage is a `502`; a
missing API key is a `503`; nothing internal or secret is ever echoed back.

```bash
# Full pipeline
curl -s localhost:3000/api/agent/process \
  -H 'content-type: application/json' \
  -d '{"message":"Tracking says delivered but my parcel never arrived.","variant":"few-shot"}' | jq

# Compare classifier variants on one message
for v in keyword zero-shot few-shot; do
  curl -s localhost:3000/api/agent/classify -H 'content-type: application/json' \
    -d "{\"message\":\"I was charged twice for the same order.\",\"variant\":\"$v\"}" | jq '.data | {variant,intent,confidence}'
done
```

Requests are rate limited (60/min globally, 5/min for eval runs) and bodies are
capped at 10 kb.

---

## 4. Scripts

| Command | What it does |
|---|---|
| `npm run seed` | Parse `data/raw/twcs.csv`, reconstruct Amazon threads, insert + build the text index. `--limit=N`, `--csv=path`, `--drop`, `--golden` |
| `npm run build:golden` | Stratified sample of resolved threads → labelling worksheet at `eval/golden_set.csv`. `--limit=200`, `--force` |
| `npm run eval` | Full harness on the golden set → metrics JSON in `eval/results/` + stored run in MongoDB |
| `npm run report` | Compile the newest run into paste-ready markdown + `report-<runId>.json` |
| `npm test` | Unit tests (no database, no API key needed) |
| `npm run dev` / `npm start` | Watch mode / production start |

Offline evaluation — no MongoDB, no API key, no dataset:

```bash
npm run eval -- --source=csv --variants=keyword --judge=0 --no-store
```

This reads `eval/golden_set.csv` directly and exercises the deterministic half of
the system (keyword classifier, escalation rules, automated reply metrics).

---

## 5. Degraded modes (deliberate, never silent)

If `GROQ_API_KEY` is missing or still set to the `.env.example` placeholder:

- `classify` with an LLM variant returns the **keyword** result plus
  `degraded: true` and a `degradedReason`;
- the responder returns a documented template reply, flagged `degraded: true`
  (so the report can separate template output from model output);
- escalation skips the LLM review and records the `llm_review_skipped` flag;
- the judge reports `valid: false` with `GROQ_API_KEY not configured`.

Nothing is ever presented as model output when it is not, and an LLM escalation
failure **fails safe** (escalates) rather than auto-replying.

---

## 6. Project structure

```
src/
  app.js · server.js            Express app (no logic) · port binding only
  config/                       env validation, mongoose connection, pino logger
  routes/ → controllers/ → services/ → models/     strict MVC
  prompts/                      every prompt as a named export function
  validators/                   zod schemas for all request shapes
  middleware/                   request logging, validation, terminal error handler
  utils/                        AppError, catchAsync, intents, text, json, metrics
scripts/                        seed · buildGoldenSet · runEval · exportReport
eval/                           golden_set.csv · labelling_notes.md · results/
report/report.md                design, results, limitations
tests/                          84 unit tests (node:test)
```

---

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Raw dataset not found at …/data/raw/twcs.csv` | Download it from the Kaggle link in §1; `data/raw/` is gitignored, so it never ships with the repo. |
| `Invalid environment configuration` | The message lists each missing/invalid variable. Copy `.env.example` → `.env`. |
| `Could not connect to MongoDB at …` | Is `mongod` running? Does `MONGODB_URI` include the database name? |
| `The golden set is empty` | `npm run seed -- --golden`, or use `npm run eval -- --source=csv`. |
| Classification works but replies look like templates | No usable `ANTHROPIC_API_KEY`; responses carry `degraded: true`. |
| `503` with "The database is not connected" | Every `/api` route needs MongoDB. `requireDatabase` fails fast instead of letting the query buffer for 10 s; start `mongod` and retry. `/health` still answers so you can see the state. |
| `Evaluation runs are limited to 5 per minute` | The eval router has its own limiter (each run costs many LLM calls). |
| Retrieval returns nothing | The threads collection is empty — run `npm run seed`; retrieval only searches threads that have a brand reply. |

Full evaluation methodology, label definitions and known limitations:
[`eval/labelling_notes.md`](./eval/labelling_notes.md). Results:
[`report/report.md`](./report/report.md).
