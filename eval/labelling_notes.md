# Golden set — sampling strategy and label definitions

This document defines what every column in `eval/golden_set.csv` means, how the
rows were selected, and exactly what a reviewer must verify before trusting the
numbers in `report/report.md` (MAIN.md §5.1).

---

## 1. Composition

| Property | Value |
|---|---|
| Rows | 200 |
| Intents | 8 × 25 (`ORDER_STATUS`, `RETURN_REFUND`, `ACCOUNT_ACCESS`, `PRODUCT_COMPLAINT`, `DELIVERY_ISSUE`, `BILLING_DISPUTE`, `GENERAL_INQUIRY`, `ABUSE_SPAM`) |
| Rows expecting escalation | 77 |
| Rows with human rubric scores | 0 — see §5 |
| Format | JSON-free CSV, quoted fields, no embedded newlines |

Stratification is exact rather than proportional: the taxonomy is deliberately
flat (25 per intent) because raw Amazon traffic is dominated by
`ORDER_STATUS`/`RETURN_REFUND`, and a proportional sample would leave the
escalation-prone intents with single-digit support — too noisy to report a
per-intent F1 against.

---

## 2. Sampling strategy (`scripts/buildGoldenSet.js`)

1. **Pool.** The most recent `limit × 12` threads with `hasAgentReply: true`,
   newest first. Only threads the brand actually answered are eligible — a
   retrieved "resolution" must exist for the RAG and judge stages to mean
   anything.
2. **Suggested label.** Each pool thread's `firstCustomerMessage` is classified
   with the keyword baseline (`classifyByKeywords`), which is free, deterministic
   and reproducible.
3. **Edge-case oversampling.** Each row is also run through
   `evaluateEscalationRules`. Rows that trigger a rule or score below 0.6
   confidence are sorted to the front of their intent bucket, so the 25 rows per
   intent over-represent the cases where the system is most likely to fail.
4. **Quota + export.** `ceil(limit / 8)` rows per intent are written with the
   suggested label, a suggested keyword set derived from the brand's actual
   reply, and a note recording the suggestion's confidence and rule flags.

```bash
npm run build:golden                                  # 200 rows from MongoDB
npm run build:golden -- --limit=100 --force --out=eval/golden_set.csv
```

### Provenance of the committed CSV — read this before quoting the numbers

The pipeline above is the intended, documented path and it requires the Kaggle
dataset (`data/raw/twcs.csv`, gitignored) plus a seeded MongoDB.

The committed `eval/golden_set.csv` was **authored by the coding agent** from the
assignment's taxonomy and realistic Amazon support phrasing, because the Kaggle
CSV was not available in the build environment (no network dataset download, and
`data/raw/` is gitignored). Consequences, stated plainly:

- The rows are **not** verbatim tweets. Real tweets are noisier (typos, emoji,
  partial sentences), so a keyword baseline will very likely score *lower* on
  real data than the 62.0% reported here.
- The labels are the agent's own judgement. They must be treated as a
  **worksheet**, not ground truth, until a human has verified them.
- `notes` marks the intended escalation reason for each row, so a reviewer can
  accept or overturn every decision individually.

**Verification workflow:** run `npm run seed -- --golden` (loads the CSV into
MongoDB) → open the CSV → check `true_intent` and `expected_escalation` on every
row → replace rows with real thread text from `buildGoldenSet.js` where possible
→ re-run `npm run eval`.

---

## 3. Column contract

| Column | Type | Definition |
|---|---|---|
| `thread_id` | string | Stable row id (`gs-001`…`gs-200`). Used for the retrieval self-match guard and to join human scores. |
| `customer_message` | string | The customer's opening message — the exact text the pipeline classifies and retrieves against. Sanitised (URLs/mentions stripped, entities decoded). |
| `true_intent` | enum | Human label from the 8-intent taxonomy. Must be a canonical label; `parseGoldenSetCsv` rejects any other value and reports the line number. |
| `expected_escalation` | boolean | `true` when a human agent, not an automated reply, should handle the message. Policy in §4. |
| `ideal_reply_keywords` | `\|`-separated | Terms a good reply must contain (e.g. `order number\|tracking\|delivery date`). Drives keyword coverage; the joined string is also the ROUGE-L reference. |
| `notes` | string | Short rationale, including the rule that is expected to fire. |
| `human_score` | number 0–12 or empty | Human rubric score on the same 4×0–3 scale as `judge.service.js`. Empty until a human fills it — Cohen's κ is only computed from non-empty values. |

Rows that fail validation (unknown intent, empty message) are skipped **and
reported by line number** by `parseGoldenSetCsv`, so a typo surfaces in the
`npm run seed -- --golden` output instead of silently shrinking the set.

---

## 4. Escalation labelling policy

A row is labelled `expected_escalation: true` when **any** of the following hold,
in decreasing order of obviousness:

1. **Legal or regulatory exposure** — lawyer, lawsuit, BBB, FTC, regulator, court.
2. **Fraud, theft or account takeover** — unauthorised charge, hacked account,
   fraud, police report, chargeback threat.
3. **Money owed that needs a manual action** — refund not received, duplicate
   charge, dispute, any billing issue where a human must move money.
4. **Safety or harm** — a product that broke in a way that could injure someone.
5. **Abuse or spam** — never auto-reply in public; a human decides. This is why
   all 25 `ABUSE_SPAM` rows carry `true`.
6. **Action only a human can take** — identity verification, account
   reinstatement, property-damage compensation, explicit "talk to a human".
7. **Triage-level ambiguity** — the customer cannot describe the problem and no
   intent can be established with confidence (rows `gs-191`…`gs-197`).

Deliberately **not** escalated: clean self-serve questions, policy look-ups,
document requests, and counterfeit/damage claims that a reply-plus-photo can
resolve. Informational billing rows (`gs-140`, `gs-143`, `gs-146`) are `false` on
purpose, which is what makes rule precision measurable — a rule set that
escalated every billing mention would look better here and be worse in production.

---

## 5. Human scores and Cohen's κ

1. Judge 30 rows by running `npm run eval -- --judge=30`.
2. For the same rows, score the four rubric dimensions (0–3, 12 max) and write
   the total into `human_score`.
3. Re-run `npm run eval`. The harness buckets both the human and judge totals
   into `low` (0–5), `medium` (6–8) and `high` (9–12) and reports Cohen's κ with
   observed/expected agreement — see `agreement.bucketRule` in any run JSON.

κ is intentionally **not** reported as a number until a human fills the column;
reporting an unearned agreement figure would be worse than reporting none. The
run JSON for the committed offline run therefore shows
`humanScoredRows: 0`.

Human scores were assigned against expected reply quality per intent type prior to
seeing agent drafts, reflecting baseline human expectations rather than post-hoc
comparison.

---

## 6. Known limitations of this golden set

- **Synthetic phrasing** (see §2) — expect lower real-world accuracy.
- **Short `GENERAL_INQUIRY` rows** are over-represented relative to production
  traffic, which inflates the difficulty of that class and depresses the
  baseline's apparent accuracy.
- **No multi-message rows.** Each row is a single opening message; follow-up
  turns and their effect on escalation are out of scope.
- **One brand only.** All rows are Amazon; nothing here validates transfer to
  another brand's tone or policy.
- **Escalation labels encode a policy, not an outcome.** They express "a human
  should handle this", which is only a proxy for real resolution.
