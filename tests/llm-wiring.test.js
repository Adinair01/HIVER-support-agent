import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('LLM wiring', () => {
  it('GROQ_API_KEY env var is defined in environment', () => {
    assert.ok(
      process.env.GROQ_API_KEY,
      'GROQ_API_KEY must be set in .env before running live LLM calls'
    );
  });
});
