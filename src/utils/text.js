/**
 * Text utilities shared by the classifier, retrieval, escalation and metrics
 * layers. All of these are pure so they can be unit-tested with no
 * infrastructure (see MAIN.md decision 8).
 */

const HTML_ENTITIES = Object.freeze({
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
});

const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'yours', 'are', 'was', 'were', 'have', 'has', 'had', 'this',
  'that', 'these', 'those', 'with', 'from', 'about', 'into', 'but', 'not', 'can', 'cant', 'could',
  'would', 'should', 'will', 'just', 'been', 'they', 'them', 'their', 'there', 'here', 'what',
  'when', 'where', 'which', 'who', 'how', 'why', 'all', 'any', 'our', 'ours', 'out', 'get', 'got',
  'its', 'it', 'is', 'be', 'to', 'of', 'in', 'on', 'at', 'as', 'or', 'if', 'do', 'did', 'does',
  'my', 'me', 'we', 'us', 'he', 'she', 'his', 'her', 'am', 'so', 'no', 'yes', 'now', 'then',
  'than', 'too', 'very', 'also', 'still', 'even', 'back', 'over', 'again', 'please', 'pls', 'plz',
  'thanks', 'thank', 'hi', 'hello', 'hey', 'rt', 'via', 'http', 'https', 'www', 'com', 'amp',
]);

/**
 * Decode entities, drop URLs/mentions, collapse whitespace and remove control
 * characters. Always call this before persisting or prompting (MAIN.md §3.3).
 *
 * @param {string} text - Raw tweet or user input.
 * @returns {string} Sanitised single-line text.
 */
export function sanitizeTweetText(text) {
  let output = String(text ?? '');

  for (const [entity, replacement] of Object.entries(HTML_ENTITIES)) {
    output = output.split(entity).join(replacement);
  }

  return output
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ')
    .replace(/@\w+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

/**
 * Lowercase, strip punctuation and remove stopwords/twitter noise.
 *
 * @param {string} text - Any text.
 * @returns {string[]} Significant tokens.
 */
export function tokenize(text) {
  return sanitizeTweetText(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s$._-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/^[._-]+|[._-]+$/g, ''))
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

/**
 * Build a MongoDB `$text` search string from a raw customer message.
 *
 * Tokens are OR-ed implicitly by MongoDB, which is what we want for recall on
 * short, noisy tweets. The query is bounded so a pathological message cannot
 * produce a multi-kilobyte search string.
 *
 * @param {string} text - Raw customer message.
 * @param {number} [maxTerms=24] - Maximum number of terms to include.
 * @returns {string} Space-separated terms, or `''` when nothing usable remains.
 */
export function buildTextSearchQuery(text, maxTerms = 24) {
  return [...new Set(tokenize(text))].slice(0, maxTerms).join(' ');
}

/**
 * Case-insensitive substring match for a list of phrases.
 *
 * @param {string} text - Text to search.
 * @param {ReadonlyArray<string>} phrases - Phrases to look for.
 * @returns {string[]} The phrases that matched.
 */
export function findPhraseMatches(text, phrases) {
  // Punctuation is flattened to spaces so "…my lawyer." still matches "lawyer",
  // while keeping the space padding that prevents "sue" matching "issue".
  const haystack = ` ${normalizeForMatching(text)} `;
  return phrases.filter((phrase) => haystack.includes(` ${normalizeForMatching(phrase)} `));
}

/**
 * Lowercase text with everything but letters, digits and spaces removed.
 *
 * @param {string} text - Text to normalise.
 * @returns {string} Normalised, space-padded-safe text.
 */
function normalizeForMatching(text) {
  return sanitizeTweetText(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Largest money amount mentioned anywhere in the text.
 *
 * Handles `$1,299.99`, `85 dollars`, `50 usd` and the spoken "a hundred dollars".
 *
 * @param {string} text - Text that may mention an amount.
 * @returns {number} Largest amount found, or `0` when none is mentioned.
 */
export function extractMaxDollarAmount(text) {
  const source = sanitizeTweetText(text).toLowerCase();
  const amounts = [];

  for (const match of source.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g)) {
    amounts.push(toNumber(match[1]));
  }
  for (const match of source.matchAll(/(\d[\d,]*(?:\.\d{1,2})?)\s?(?:usd|dollars?|bucks|dollor)/g)) {
    amounts.push(toNumber(match[1]));
  }
  for (const [word, value] of [
    ['hundred dollars', 100],
    ['thousand dollars', 1000],
  ]) {
    if (source.includes(word)) amounts.push(value);
  }

  const finite = amounts.filter((amount) => Number.isFinite(amount));
  return finite.length > 0 ? Math.max(...finite) : 0;
}

/**
 * Parse a numeric string with thousands separators.
 *
 * @param {string} raw - Numeric substring.
 * @returns {number} Parsed number.
 */
function toNumber(raw) {
  return Number.parseFloat(String(raw).replace(/,/g, ''));
}

/**
 * Truncate on a word boundary, appending an ellipsis when cut.
 *
 * @param {string} text - Text to shorten.
 * @param {number} maxChars - Maximum length.
 * @returns {string} Shortened text.
 */
export function truncate(text, maxChars) {
  const source = String(text ?? '');
  if (source.length <= maxChars) return source;
  const cut = source.slice(0, maxChars - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Normalise a raw string for comparison in metrics (case/space/punctuation).
 *
 * @param {string} text - Text to normalise.
 * @returns {string} Comparison key.
 */
export function normalizeForComparison(text) {
  return sanitizeTweetText(text).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
