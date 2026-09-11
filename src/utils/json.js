/**
 * Models wrap JSON in prose or code fences, and sometimes emit trailing commas.
 * These helpers make every model response parseable without inline duplication
 * (MAIN.md §3.2), independently of which provider produced it.
 */

/**
 * Remove ```json … ``` fences and leading/trailing prose fences.
 *
 * @param {string} text - Raw model output.
 * @returns {string} Text with fence markers removed.
 */
export function stripCodeFences(text) {
  return String(text ?? '')
    .replace(/```(?:json|javascript|js)?/gi, '')
    .replace(/```/g, '')
    .trim();
}

/**
 * Scan for the first balanced `{…}` object, ignoring braces inside strings.
 *
 * @param {string} text - Text that may contain a JSON object.
 * @returns {string | null} The substring, or `null` when no object is present.
 */
export function extractFirstJsonObject(text) {
  const source = stripCodeFences(text);
  const start = source.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const char = source[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }

  return null;
}

/**
 * Tolerant JSON parse for model output: fences, prose, trailing commas and
 * smart quotes are all repaired before parsing.
 *
 * @param {string} text - Raw model output.
 * @returns {{ ok: true, value: unknown } | { ok: false, error: string }} Result union.
 */
export function safeParseModelJson(text) {
  const block = extractFirstJsonObject(text);
  if (!block) {
    return { ok: false, error: 'No JSON object found in model output' };
  }

  const repaired = block
    .replace(/[“”]/g, '"')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/:\s*'([^']*)'/g, ': "$1"');

  try {
    return { ok: true, value: JSON.parse(repaired) };
  } catch (error) {
    return { ok: false, error: `Malformed JSON: ${error.message}` };
  }
}

/**
 * Parse `{"answer": "YES", "reason": "…"}`-style verdicts from free text.
 *
 * @param {string} text - Raw model output.
 * @param {string} [token='YES'] - Token to look for.
 * @returns {{ decision: boolean, reason: string }} Verdict plus the textual reason.
 */
export function parseYesNoVerdict(text, token = 'YES') {
  const source = stripCodeFences(text);
  const parsed = safeParseModelJson(source);

  if (parsed.ok && parsed.value && typeof parsed.value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (parsed.value);
    const answer = String(record.answer ?? record.decision ?? '').toUpperCase();
    return {
      decision: answer.includes(token.toUpperCase()),
      reason: String(record.reason ?? record.why ?? source).slice(0, 500),
    };
  }

  const upper = source.toUpperCase();
  const yes = upper.indexOf(token.toUpperCase());
  const no = upper.indexOf('NO');
  const decision =
    yes !== -1 && (no === -1 || yes <= no) && !/\bNO\b/.test(upper.slice(0, Math.max(yes, 1)));

  return { decision, reason: source.replace(/\s+/g, ' ').slice(0, 500) };
}
