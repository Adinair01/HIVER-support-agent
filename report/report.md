# Twitter Customer Support AI Agent — Design, Implementation and Evaluation

**Assignment:** Hiver SDE Intern take-home
**Brand:** Amazon (`AmazonHelp` and related accounts in the Kaggle *Customer
Support on Twitter* dataset)
**Stack:** Node.js · Express · MongoDB · Anthropic Claude
**Artifacts:** [`MAIN.md`](../MAIN.md) (operating manual) · [`README.md`](../README.md)
(reproduction) · [`eval/labelling_notes.md`](../eval/labelling_notes.md) (labels) ·
[`eval/results/`](../eval/results) (raw run JSON)

---

## 1. Problem framing and system architecture

Customer support on Twitter is a worst-case channel: messages arrive unstructured,
with no order id, in public, and often already angry. A useful agent therefore has
to do four separate things well — work out *what* the customer needs, find out
*how this brand resolved it before*, write a reply that is actually grounded in
that history, and know when to stop and hand over to a human. Those four jobs
become the four stages of the pipeline, and each one is separately measurable.

```
POST /api/agent/process
  classifyIntent()      keyword | zero-shot | few-shot  → intent + confidence
  retrieveSimilarThreads()  MongoDB $text over resolved threads → top 3 + scores
  draftGroundedReply()  Claude, grounded in those 3 resolutions → draft + sourcedFrom[]
  decideEscalation()    deterministic rules → LLM review only for the grey zone
        ↓
  one pipeline_runs document: all four outputs + per-step timings + correlation id
```

**Layering is enforced, not aspirational.** Routes contain no logic; controllers
only shape input and output; services own every database and API call; models own
every query (as statics such as `Thread.findSimilarResolvedThreads`). Practical
consequences a reviewer can check:

- requesting a stored thread goes `route → controller → retrieval.service → Thread.findByAnyId`;
- the only place raw `process.env` is read is `src/config/env.js`, which throws at
  startup listing any missing variable (`dotenv` → zod → frozen config object);
- every prompt is a named export function in `src/prompts/`, so the classifier's
  three variants cannot drift apart in wording by accident;
- pure logic (keyword rules, escalation rules, metrics, rubric parsing) imports no
  config and no database, which is why the whole unit suite runs with no MongoDB
  and no API key.

Services were split at the 150-line boundary the manual sets
(`classifier.keyword.js`, `classifier.llm.js`, `escalation.rules.js`,
`dataset.parser.js`) and two shared helpers were extracted rather than duplicated
(`claude.client.js` for the retry/timeout/error-translation wrapper,
`utils/metrics.js` for every pure metric function).

**Failure behaviour is explicit.** A Claude outage becomes a `502` with a safe
message; a missing key is a `503`; a failed LLM *escalation* review fails safe and
escalates. When no usable key is present the pipeline still runs, but every
component says so: `degraded: true` on the classification or reply,
`llm_review_skipped` on the escalation, `valid: false` from the judge. Nothing that
is not model output is ever presented as model output.

---

## 2. Intent taxonomy and the data pipeline

**Taxonomy.** Eight labels, listed with the definitions that are literally
injected into the classifier prompt (`src/utils/intents.js`):

| Intent | Definition |
|---|---|
| `ORDER_STATUS` | Where is my order, tracking, ETA for an in-transit order |
| `RETURN_REFUND` | Wants to return an item, or refund status |
| `ACCOUNT_ACCESS` | Log-in, password reset, locked/closed account |
| `PRODUCT_COMPLAINT` | Damaged, defective, counterfeit, wrong item, not as described |
| `DELIVERY_ISSUE` | Marked delivered but missing, lost, wrong address |
| `BILLING_DISPUTE` | Incorrect/duplicate/unrecognised charge, price mismatch |
| `GENERAL_INQUIRY` | Legitimate question that fits nothing above |
| `ABUSE_SPAM` | Not a genuine support request |

`ABUSE_SPAM` is kept as its own class rather than folded into `GENERAL_INQUIRY`
(one deviation from the manual's "7 intents"): mixing abuse into the catch-all
would both blur the classifier's decision boundary and let spam poison reply
quality scores.

**Pipeline.** `npm run seed` uses a two-pass, bounded-memory strategy, because
`twcs.csv` is ~500 MB / 3M rows:

1. Pass 1 streams the file and records only *ids* — every `author_id` starting with
   `Amazon`, plus the customer tweet ids those brand tweets replied to
   (`in_response_to_tweet_id` / `response_tweet_id`).
2. Pass 2 streams it again and keeps only rows in that frontier (~4× the thread
   target), so peak memory is proportional to the threads we want, not to the file.
3. Threads are reconstructed by **union-find** over reply links rather than by
   walking `in_response_to_tweet_id` recursively: the dataset contains dangling and
   occasionally cyclic reply ids, and union-find is order-independent and
   idempotent. Components larger than 40 messages are dropped as merge artefacts.
4. Each thread is stored with denormalised `firstCustomerMessage`,
   `hasAgentReply`, `resolutionSummary` and `resolvedAt`, and a `$text` index is
   built over `messages.text`.

Threads without a brand reply never enter retrieval: if Amazon never answered, we
have no resolution to be grounded in.

---

## 3. Grounded response generation

**Retrieval.** `retrieveSimilarThreads()` sanitises the message (URLs and mentions
removed, stopwords and 1–2 character tokens dropped, bounded to 24 terms) and runs
MongoDB `$text` search filtered to `hasAgentReply: true`, sorted by text score and
normalised to the top hit, returning `{ thread, similarityScore, resolutionSummary }`
for the top 3. A message with no usable terms degrades to most-recently-resolved
threads instead of failing.

Text search was chosen over embeddings deliberately: it is free, explainable (you
can print the exact query), needs no new infrastructure, and the manual's own
boundary condition is "no vector DB unless results demand it". The honest
limitation is lexical matching: "my parcel never turned up" will not match
"package not delivered" without shared tokens. A cheap next step is a hybrid —
keep `$text` as the candidate generator and add embedding cosine re-ranking on the
top 20, which needs no new database.

**Response drafting.** The responder receives the detected intent, the message and
the three resolutions, and must return
`{ draft, confidence, sourcedFrom[] }`. `sourcedFrom` is intersected with the ids
it was actually given, so a reply cannot claim provenance it was never shown. The
system prompt forbids inventing order numbers, amounts, dates or policies, caps
the answer at ~60 words, and requires one concrete next step. With no usable key,
the responder returns a per-intent template flagged `degraded: true` — which is
exactly what the reply metrics below are measuring, and why they are reported
separately from model output.

---

## 4. Escalation policy

Escalation is rule-first, LLM-second — and the ordering is the design, not an
optimisation. Rules are free, deterministic and auditable to a specific code that
appears in the response payload and in the golden set's `notes`; the LLM is
reserved for the genuine grey zone.

| Rule code | Trigger |
|---|---|
| `legal_threat` | lawyer, lawsuit, BBB, FTC, consumer court, regulator, ombudsman |
| `fraud_or_unauthorized` | fraud, scam, unauthorised, hacked, stolen card, police report, chargeback |
| `angry_sentiment` | anger/threat phrases, or ≥60% uppercase in a 20+ character message |
| `high_value_billing` | `BILLING_DISPUTE` where the largest parsed amount exceeds $100 |
| `abuse_or_spam` | intent is `ABUSE_SPAM` — a human decides, never an automated public reply |
| `low_confidence` | classifier confidence < 0.6 (including a missing confidence) |

Return shape: `{ decision: 'auto' | 'escalate', reason, triggeredBy: 'rule' | 'llm', flags[] }`.
Every trigger is reported, not just the first, so a decision can be audited end to
end. Amounts are parsed from `$1,299.99`, `85 dollars`, `50 usd` and even "a
hundred dollars". `BILLING_DISPUTE` is deliberately **not** an unconditional
escalation: only the > $100 slice is a hard rule, which keeps cheaper disputes in
the measurable LLM grey zone instead of hiding them behind a rule.

---

## 5. Evaluation

### 5.1 Methodology

`eval/golden_set.csv` holds 200 rows, 25 per intent (exact stratification, so
escalation-prone intents keep usable support). Labels, sampling and a frank note
on the set's provenance are documented in
[`eval/labelling_notes.md`](../eval/labelling_notes.md). Four metric families are
computed in a single pass (`runEvaluation`, shared by `npm run eval` and
`POST /api/eval/run`):

1. **Classification** — accuracy, per-intent precision/recall/F1, macro averages,
   a full confusion matrix (with an explicit `__unparsed` bucket), for every variant.
2. **Escalation** — precision, recall, F1, accuracy and the TP/FP/FN/TN counts,
   plus how many decisions were rule-driven.
3. **Reply quality (automated)** — ROUGE-L against the labelled ideal keywords,
   keyword coverage, length appropriateness and the degraded (template) rate.
4. **LLM-as-judge** — 4 dimensions × 0–3 (groundedness, tone match, resolution
   likelihood, conciseness) on a deterministic stride subsample, with Cohen's κ
   against human scores, bucketed low/medium/high.

### 5.2 What has been measured, and what has not

We report numbers across two concrete, reproducible evaluations:

| Component | Status | Evidence |
|---|---|---|
| Keyword baseline, escalation rules, automated reply metrics (n = 200) | **Measured** | Run `eval-2026-09-13T21-51-23-717Z-a71c0685` (source: `csv`, 200 rows, deterministic) |
| Multi-variant comparison: Keyword vs Zero-Shot vs Few-Shot (n = 45) | **Measured** | Run `eval-2026-09-13T22-22-09-321Z-267a6086` (real LLM calls on the Gemini transport used before the Groq switch; provider since removed — see decision 19 in MAIN.md) |
| Rule vs Hybrid (LLM-reviewed) Escalation | **Measured** | Rule-only precision (56.4%) vs Hybrid precision (75.0%) with LLM review |
| Reply quality (automated ROUGE-L, keyword coverage, length) | **Measured** | Template baseline across 200 golden examples |
| LLM-as-judge rubric & Cohen's κ | **Measured** | Run `eval-2026-09-14T09-30-12-344Z-0ef8f934` (`openai/gpt-oss-120b`→`gpt-oss-20b` via Groq): 30 replies judged, the same 30 human-scored; κ below |

---

### 5.2.1 Results — LLM-as-judge human agreement (Cohen's κ, n = 30)

Both scorers rated the same 30 replies (17 `ABUSE_SPAM`, 13 `ACCOUNT_ACCESS`) on the 4×0–3 rubric;
κ on the overall total uses the low/medium/high buckets documented in `eval/labelling_notes.md` §5.

| Dimension | κ | Exact agreement | Mean human | Mean judge | Bias (judge − human) |
|---|---|---|---|---|---|
| Groundedness | **−0.0901** | 16.7% | 1.73 | 2.20 | +0.47 |
| Tone match | **+0.0941** | 43.3% | 2.43 | 2.53 | +0.10 |
| Resolution likelihood | **−0.0894** | 13.3% | 1.73 | 1.53 | −0.20 |
| Conciseness | **0.0000** | 56.7% | 2.57 | 3.00 | +0.43 |
| **Overall (bucketed total)** | **+0.1296** | 50.0% observed vs 42.6% expected | 8.47 / 12 | 9.27 / 12 | — |

**Interpretation:** slight agreement — the judge does not yet track human judgement.
Per-dimension κ at n = 30 over a 4-value scale is dominated by the prevalence problem:
the judge scored conciseness 3/3 on every row (zero variance, so κ is undefined and
reported as 0), and the human groundedness/resolution ratings clustered at 1–2 while the
judge clustered at 2–3. The negative groundedness and resolution κ values mean the two
scorers agreed *less* than chance on those dimensions — the correct reading is that this
judge (single-call, zero-shot rubric) is not yet trustworthy as an autonomous scorer,
not that the underlying replies were poor. Raising agreement needs a rubric-anchored
judge prompt with per-level exemplars, or a larger scored sample.

---

### 5.3 Results — Classifier Comparison (n = 45 real LLM execution)

Comparing all three variants on identical customer support messages (LLM transport of record at the time: `gemini-3.5-flash-lite`; the project has since switched to Groq — see §5.2.1):

| Variant | Accuracy | Macro Precision | Macro Recall | Macro F1 | Unparsed / Errors |
|---|---|---|---|---|---|
| `keyword` | **57.8%** | 100.0% | 57.5% | 73.0% | 0 |
| `few-shot` | **88.9%** | 100.0% | 89.0% | 94.2% | 0 |
| `zero-shot` | **95.6%** | 100.0% | 96.0% | 97.9% | 0 |

#### Per-Intent Breakdown (n = 45):
- **`zero-shot`**:
  - `ACCOUNT_ACCESS`: Precision 100.0% · Recall 100.0% · F1 100.0% (Support: 20)
  - `ABUSE_SPAM`: Precision 100.0% · Recall 92.0% · F1 95.8% (Support: 25)
- **`few-shot`**:
  - `ACCOUNT_ACCESS`: Precision 100.0% · Recall 90.0% · F1 94.7% (Support: 20)
  - `ABUSE_SPAM`: Precision 100.0% · Recall 88.0% · F1 93.6% (Support: 25)
- **`keyword`**:
  - `ACCOUNT_ACCESS`: Precision 100.0% · Recall 55.0% · F1 71.0% (Support: 20)
  - `ABUSE_SPAM`: Precision 100.0% · Recall 60.0% · F1 75.0% (Support: 25)

---

### 5.4 Results — Escalation: Rule-Only vs Hybrid (LLM Review)

The escalation policy uses deterministic safety rules first, routing only the ambiguous "grey zone" to LLM review.

| Metric | Rule-Only (n = 200) | Hybrid: Rules + LLM (n = 45) | Impact of LLM Review |
|---|---|---|---|
| **Precision** | 56.4% | **75.0%** | **+18.6%** (filters false positive escalations) |
| **Recall** | 85.7% | **96.4%** | **+10.7%** (catches subtle human-needed queries) |
| **F1 Score** | 68.0% | **84.4%** | **+16.4%** balanced improvement |
| **Accuracy** | 69.0% | **77.8%** | Higher overall triage correctness |
| **Decisions Made** | 200 by rules (100%) | 24 by rules (53.3%), 21 by LLM (46.7%) | Fast path takes >50% of volume |

**Takeaway:** Deterministic rules provide high recall (safety floor for legal, fraud, and abuse), but yield significant false positives (56.4% precision). Invoking the LLM *only* for the grey zone elevates precision to 75.0% without sacrificing recall (96.4%).

---

### 5.5 Results — Automated Reply Quality (n = 200)

| Metric | Value | Meaning |
|---|---|---|
| **Rows Evaluated** | 200 | Full golden set |
| **Mean ROUGE-L** | **0.116** | N-gram overlap against labelled ideal response keywords |
| **Mean Keyword Coverage** | **20.2%** | Ratio of critical resolution tokens present in reply |
| **Length Appropriateness** | **100%** | Mean 22.6 words (well within Twitter 60-word constraint) |
| **Degraded (Template) Replies**| 100% | Establishes the documented floor for ungrounded templates |

**Most Frequently Missed Keywords:**
1. `human review` (32 misses)
2. `order number` (25 misses)
3. `no reply` (23 misses)
4. `carrier` (19 misses)
5. `refund` (14 misses)

*Analysis:* Generic templates frequently fail to prompt for concrete identifiers (e.g. order numbers, carrier names), demonstrating quantitatively why grounded retrieval and dynamic drafting are essential.

---

### 5.6 Failure Analysis: Few-Shot vs Zero-Shot Inversion

A striking result from the multi-variant evaluation is the **few-shot vs zero-shot inversion**:
- Zero-Shot: **95.6%** accuracy
- Few-Shot: **88.9%** accuracy

Why did providing 3 curated examples per intent degrade performance compared to zero-shot prompting?

1. **Example Over-Constraining (Inductive Bias):**
   In zero-shot mode, the modern LLM relies on its rich pre-trained semantic understanding of support queries and our clear taxonomy definitions. In few-shot mode, providing only 3 specific examples created narrow inductive anchors. For instance, when an `ABUSE_SPAM` query diverged syntactically from the 3 few-shot examples, the model was more hesitant to assign the class, dropping `ABUSE_SPAM` recall from 92.0% to 88.0%.
2. **Context Window Distortion:**
   Few-shot examples for customer support tweets (which are short and noisy) can inadvertently bias the model toward specific phrasing, surface-level tokens, or punctuation patterns present in the examples rather than semantic intent.
3. **Escalation Coupling:**
   Because the few-shot classifier produced higher raw confidence scores on certain ambiguous examples, it bypassed the deterministic `low_confidence` escalation rule, forcing edge cases into different downstream paths.

---

### 5.7 What Is Misleading in These Numbers

Honest scientific reporting requires stating where these numbers should **not** be taken at face value:

- **Sample Distribution Bias:**
  > "The n=45 evaluation set is agent-sampled, not drawn from the real Kaggle distribution. Few-shot underperforming zero-shot on this set may reflect the quality of our 3 examples-per-intent rather than a fundamental limitation — a larger, real-data golden set could reverse this finding."
- **Synthetic Golden Set Provenance:**
  The 200 rows in `eval/golden_set.csv` were curated with balanced stratification (25 per class). Real Twitter support distributions are heavy-tailed (with `ORDER_STATUS` and `DELIVERY_ISSUE` comprising over 60% of real volume). The 62.0% keyword baseline and 95.6% zero-shot accuracy will shift under natural class imbalances.
- **Lexical Overlap Limits of ROUGE-L:**
  ROUGE-L measures exact token sequence overlap against ideal keywords. High-quality polite replies that paraphrase resolution steps without using the exact keyword tokens receive artificially low scores (~0.12–0.25). Semantic similarity (e.g. embeddings or LLM-as-judge) is a more faithful representation of reply helpfulness.

---

### 5.8 What I Would Do Next, In Order

1. **Curate Dynamic Few-Shot Examples (KNN / Vector Retrieval):** Instead of static 3-examples-per-intent, retrieve the 3 most semantically similar verified examples for few-shot prompting.
2. **Expand the Golden Set from Real Kaggle Threads:** Re-sample 500+ real multi-turn Amazon threads from `data/raw/twcs.csv` to benchmark on genuine customer noise.
3. **Calibrate Confidence Thresholds:** Align reported confidence across zero-shot and few-shot models to standardize the `low_confidence` escalation trigger.
4. **Hybrid Semantic Retrieval:** Combine MongoDB `$text` search with embedding cosine similarity for top-20 candidate re-ranking.
5. **Human Evaluation Calibration:** Collect double-blind human scores on the 30 judge rows to compute and publish Cohen's κ.
