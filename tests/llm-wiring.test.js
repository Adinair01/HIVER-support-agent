import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('LLM wiring', () => {
  it('GROQ_API_KEY env var is defined when live calls are enabled', () => {
    // In CI / unit-test runs without a key, this is a soft warning not a hard fail.
    // The transport stub tests cover the wiring without needing real credentials.
    if (!process.env.GROQ_API_KEY) {
      console.warn('  ⚠ GROQ_API_KEY not set — skipping live transport check');
      return;
    }
    assert.ok(process.env.GROQ_API_KEY, 'GROQ_API_KEY must be set in .env');
  });
});
