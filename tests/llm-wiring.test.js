import assert from 'assert';
import { describe, it } from 'mocha';

describe('LLM wiring', () => {
  it('GROQ_API_KEY env var is defined', () => {
    assert.ok(process.env.GROQ_API_KEY, 'GROQ_API_KEY must be set in .env');
  });
});
