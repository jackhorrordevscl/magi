import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveSettings } from '../../../src/cli/tui/effective-settings.ts';
import type { Evaluator as EvaluatorName } from '../../../src/gating/consensus.ts';
import type { EvaluatorBackend } from '../../../src/gating/evaluator-config.ts';

// Independent expectations (deliberately not imported from production
// source) so this test would fail if the wiring under test drifted, not
// just reflect whatever the source currently says.
const NAMED = {
  melchior: { backend: 'groq' as EvaluatorBackend, model: 'openai/gpt-oss-120b' },
  balthasar: { backend: 'groq' as EvaluatorBackend, model: 'llama-3.3-70b-versatile' },
  casper: { backend: 'groq' as EvaluatorBackend, model: 'llama-3.1-8b-instant' },
} satisfies Record<EvaluatorName, { backend: EvaluatorBackend; model: string }>;

const BUILTIN = {
  groq: { model: 'llama-3.3-70b-versatile', timeoutMs: 2500, maxTokens: 512 },
  anthropic: { model: 'claude-3-5-haiku-latest', timeoutMs: 2500, maxTokens: 512 },
  gemini: { model: 'gemini-2.5-flash-lite', timeoutMs: 2500, maxTokens: 512 },
} satisfies Record<EvaluatorBackend, { model: string; timeoutMs: number; maxTokens: number }>;

const EVALUATORS: EvaluatorName[] = ['melchior', 'balthasar', 'casper'];
const BACKENDS: EvaluatorBackend[] = ['anthropic', 'groq', 'gemini'];

describe('effectiveSettings — fully unset entry, per evaluator', () => {
  for (const name of EVALUATORS) {
    test(`${name}: backend/model/timeoutMs/maxTokens all show the named default, source 'default'`, () => {
      const result = effectiveSettings(name, {});
      const named = NAMED[name];

      assert.deepEqual(result.backend, { value: named.backend, source: 'default' });
      assert.deepEqual(result.model, { value: named.model, source: 'default' });
      assert.deepEqual(result.timeoutMs, { value: BUILTIN[named.backend].timeoutMs, source: 'default' });
      assert.deepEqual(result.maxTokens, { value: BUILTIN[named.backend].maxTokens, source: 'default' });
    });
  }
});

describe('effectiveSettings — 3 evaluators × 3 backends: unset model follows the resolved backend, not the named literal', () => {
  for (const name of EVALUATORS) {
    for (const backend of BACKENDS) {
      const named = NAMED[name];
      const isNamedBackend = backend === named.backend;

      test(`${name} with backend '${backend}' and unset model: ${isNamedBackend ? 'shows the named literal' : "shows that backend's own built-in default"}`, () => {
        const result = effectiveSettings(name, { backend });

        assert.deepEqual(result.backend, { value: backend, source: 'config' });
        assert.equal(result.model.source, 'default');
        const expectedModel = isNamedBackend ? named.model : BUILTIN[backend].model;
        assert.equal(result.model.value, expectedModel);

        // timeoutMs/maxTokens always fall back to the resolved backend's own
        // built-in defaults, regardless of whether that backend matches the
        // evaluator's named baseline.
        assert.deepEqual(result.timeoutMs, { value: BUILTIN[backend].timeoutMs, source: 'default' });
        assert.deepEqual(result.maxTokens, { value: BUILTIN[backend].maxTokens, source: 'default' });
      });
    }
  }
});

describe('effectiveSettings — explicit fields are always source: config, regardless of backend', () => {
  test('an explicit model override is honored even when the backend also switches', () => {
    const result = effectiveSettings('casper', { backend: 'anthropic', model: 'custom-model' });
    assert.deepEqual(result.model, { value: 'custom-model', source: 'config' });
    assert.deepEqual(result.backend, { value: 'anthropic', source: 'config' });
  });

  test('explicit timeoutMs/maxTokens are honored over the built-in default', () => {
    const result = effectiveSettings('melchior', { timeoutMs: 7000, maxTokens: 999 });
    assert.deepEqual(result.timeoutMs, { value: 7000, source: 'config' });
    assert.deepEqual(result.maxTokens, { value: 999, source: 'config' });
  });

  test('an explicit model equal to the named default is still reported as source: config', () => {
    const result = effectiveSettings('balthasar', { model: NAMED.balthasar.model });
    assert.deepEqual(result.model, { value: NAMED.balthasar.model, source: 'config' });
  });
});
