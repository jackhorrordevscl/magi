import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { clearField, deniedRowLabel, fieldValueText, pendingHasUnsavedChanges, runTui } from '../../../src/cli/tui/app.ts';
import { effectiveSettings } from '../../../src/cli/tui/effective-settings.ts';
import type { EvaluatorSettings, EvaluatorsConfig } from '../../../src/gating/evaluator-config.ts';
import type { DeniedRecordRow } from '../../../src/cli/tui/audit-view.ts';

/**
 * `app.ts` builds the `blessed` screen — inherently hard to unit-test
 * headlessly (no tty in CI), and `runTui()` only ever imports `blessed`
 * lazily inside its own function body (design decision 1). This file tests
 * everything in `app.ts` that does NOT touch `blessed`: the pure
 * formatting/diff helpers the widgets are built from. The `magi tui`
 * dispatch wiring itself (that it never eagerly imports `blessed`) is
 * covered in `tests/cli/main.test.ts` via `MainDeps.tui`.
 */

describe('app.ts module import — no blessed load without calling runTui()', () => {
  test('importing the module (this file\'s own top-level import) succeeds without a tty or a real screen', () => {
    // Reaching this line at all proves the module's top-level code never
    // touched `blessed` — a static top-level `import blessed from 'blessed'`
    // or any eager call would have thrown/hung in this non-tty test runner.
    assert.equal(typeof runTui, 'function');
  });
});

describe('fieldValueText — set vs. default rendering', () => {
  test('a set field renders its own value, not the default marker', () => {
    const entry: EvaluatorSettings = { timeoutMs: 4000 };
    const effective = effectiveSettings('melchior', entry);
    assert.equal(fieldValueText('timeoutMs', entry, effective), '4000');
  });

  test('an unset field renders "(default: <effective value>)"', () => {
    const entry: EvaluatorSettings = {};
    const effective = effectiveSettings('melchior', entry);
    assert.equal(fieldValueText('maxTokens', entry, effective), `(default: ${effective.maxTokens.value})`);
  });

  test('an unset model with a non-default backend shows that backend\'s own built-in default, not the named literal', () => {
    const entry: EvaluatorSettings = { backend: 'anthropic' };
    const effective = effectiveSettings('melchior', entry);
    assert.equal(effective.model.source, 'default');
    assert.equal(fieldValueText('model', entry, effective), `(default: ${effective.model.value})`);
  });
});

describe('clearField — sets exactly one field to unset, leaves siblings untouched', () => {
  test('clears the targeted field only', () => {
    const entry: EvaluatorSettings = { backend: 'groq', model: 'llama-3.1-8b-instant', timeoutMs: 3000, maxTokens: 512 };
    const cleared = clearField(entry, 'model');
    assert.equal(cleared.model, undefined);
    assert.equal(cleared.backend, 'groq');
    assert.equal(cleared.timeoutMs, 3000);
    assert.equal(cleared.maxTokens, 512);
    assert.ok(!Object.prototype.hasOwnProperty.call(cleared, 'model'), 'the key is deleted, not set to undefined');
  });

  test('clearing an already-unset field is a no-op', () => {
    const entry: EvaluatorSettings = { backend: 'groq' };
    const cleared = clearField(entry, 'model');
    assert.deepEqual(cleared, { backend: 'groq' });
  });

  test('does not mutate the entry passed in', () => {
    const entry: EvaluatorSettings = { model: 'x' };
    clearField(entry, 'model');
    assert.equal(entry.model, 'x');
  });
});

describe('pendingHasUnsavedChanges — diffs through normalizeEvaluators (design decision 5)', () => {
  test('identical pending/saved report no changes', () => {
    const config: EvaluatorsConfig = { melchior: { timeoutMs: 3000 } };
    assert.equal(pendingHasUnsavedChanges(config, config), false);
  });

  test('a changed field reports unsaved changes', () => {
    const saved: EvaluatorsConfig = { melchior: { timeoutMs: 3000 } };
    const pending: EvaluatorsConfig = { melchior: { timeoutMs: 4000 } };
    assert.equal(pendingHasUnsavedChanges(pending, saved), true);
  });

  test('an empty per-evaluator entry ({}) compares equal to a wholly-empty config (no false positive)', () => {
    const saved: EvaluatorsConfig = {};
    const pending: EvaluatorsConfig = { melchior: {}, balthasar: {}, casper: {} };
    assert.equal(pendingHasUnsavedChanges(pending, saved), false);
  });
});

describe('deniedRowLabel — audit denied-row rendering', () => {
  test('renders seq, timestamp, severity, and an 11-char hash prefix', () => {
    const row: DeniedRecordRow = {
      hash: 'abcdef0123456789',
      seq: 7,
      timestamp: '2026-08-12T10:00:00.000Z',
      severity: 'high',
    };
    assert.equal(deniedRowLabel(row), '7 · 2026-08-12T10:00:00.000Z · high · abcdef01234');
  });
});
