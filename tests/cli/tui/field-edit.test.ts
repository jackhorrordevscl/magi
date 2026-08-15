import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateFieldEdit } from '../../../src/cli/tui/field-edit.ts';
import type { FieldName } from '../../../src/cli/tui/field-edit.ts';
import type { EvaluatorSettings } from '../../../src/gating/evaluator-config.ts';

// --- validateFieldEdit — table test: the schema is the only judge ---------

interface Case {
  description: string;
  field: FieldName;
  rawInput: string;
  entry: EvaluatorSettings;
  expected: 'accepted' | 'rejected';
  messagePattern?: RegExp;
  acceptedValue?: unknown;
}

const cases: Case[] = [
  {
    description: 'timeoutMs: -500 (non-positive) rejected',
    field: 'timeoutMs',
    rawInput: '-500',
    entry: {},
    expected: 'rejected',
    messagePattern: /positive/i,
  },
  {
    description: 'backend: "openai" rejected, message names anthropic/groq/gemini',
    field: 'backend',
    rawInput: 'openai',
    entry: {},
    expected: 'rejected',
    messagePattern: /anthropic.*groq.*gemini|anthropic, groq, gemini/i,
  },
  {
    description:
      'model: "" rejected — an empty edit-box submission is a real (invalid) candidate value, not the ' +
      'separate clear-field ("d" key) path, so it must never be silently accepted as "unset"',
    field: 'model',
    rawInput: '',
    entry: {},
    expected: 'rejected',
    messagePattern: /non-empty/i,
  },
  {
    description: 'maxTokens: "600" parsed to 600 (accepted)',
    field: 'maxTokens',
    rawInput: '600',
    entry: {},
    expected: 'accepted',
    acceptedValue: 600,
  },
  {
    description: 'timeoutMs: 2.5 (non-integer) rejected',
    field: 'timeoutMs',
    rawInput: '2.5',
    entry: {},
    expected: 'rejected',
    messagePattern: /positive integer/i,
  },
];

describe('validateFieldEdit — table test, drop-detection is the only judge', () => {
  for (const c of cases) {
    test(c.description, () => {
      const result = validateFieldEdit('melchior', c.field, c.rawInput, c.entry);
      if (c.expected === 'rejected') {
        assert.equal(result.ok, false);
        if (!result.ok && c.messagePattern) assert.match(result.message, c.messagePattern);
      } else {
        assert.equal(result.ok, true);
        if (result.ok) assert.equal(result.entry[c.field], c.acceptedValue);
      }
    });
  }
});

describe('validateFieldEdit — valid-edit scenario (spec: "Valid edits are accepted")', () => {
  test('casper.model non-empty string and casper.maxTokens 600 are both accepted without error', () => {
    let entry: EvaluatorSettings = {};

    const modelResult = validateFieldEdit('casper', 'model', 'llama-3.1-70b-versatile', entry);
    assert.equal(modelResult.ok, true);
    if (modelResult.ok) entry = modelResult.entry;

    const maxTokensResult = validateFieldEdit('casper', 'maxTokens', '600', entry);
    assert.equal(maxTokensResult.ok, true);
    if (maxTokensResult.ok) entry = maxTokensResult.entry;

    assert.equal(entry.model, 'llama-3.1-70b-versatile');
    assert.equal(entry.maxTokens, 600);
  });
});

describe('validateFieldEdit — rejection leaves the prior value conceptually unchanged', () => {
  test('a rejected edit does not mutate the entry passed in', () => {
    const entry: EvaluatorSettings = { timeoutMs: 3000 };
    const result = validateFieldEdit('melchior', 'timeoutMs', '-500', entry);
    assert.equal(result.ok, false);
    assert.equal(entry.timeoutMs, 3000);
  });

  test('an accepted edit preserves sibling fields already set on the entry', () => {
    const entry: EvaluatorSettings = { backend: 'anthropic', timeoutMs: 3000 };
    const result = validateFieldEdit('melchior', 'model', 'claude-3-5-haiku-latest', entry);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.entry.backend, 'anthropic');
      assert.equal(result.entry.timeoutMs, 3000);
      assert.equal(result.entry.model, 'claude-3-5-haiku-latest');
    }
  });
});

describe('validateFieldEdit — backend accepts each of its three enum values', () => {
  for (const backend of ['anthropic', 'groq', 'gemini'] as const) {
    test(`backend: "${backend}" accepted`, () => {
      const result = validateFieldEdit('balthasar', 'backend', backend, {});
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.entry.backend, backend);
    });
  }
});
