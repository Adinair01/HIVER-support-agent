export {
  complete,
  isProviderConfigured,
  getProviderClient,
  setGenerationTransport,
  resetGenerationTransport,
} from './groq.client.js';

/**
 * The LLM facade — now a direct re-export of the Groq transport.
 *
 * It survives as a module (rather than services importing groq.client.js
 * directly) because every consumer, test and log line already names
 * `llm.client.js`; keeping the indirection means a future provider change is
 * still a one-file swap, which is how the Gemini → Groq move stayed painless.
 */
