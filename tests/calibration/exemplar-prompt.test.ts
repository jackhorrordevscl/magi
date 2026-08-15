import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatExemplarsForPrompt } from '../../src/calibration/exemplar-prompt.ts';
import type { CalibrationEntry } from '../../src/calibration/corpus-schema.ts';

function entry(overrides: Partial<CalibrationEntry> = {}): CalibrationEntry {
  return {
    tag: 'force-push-protected-branch',
    severity: 'critical',
    exemplar: 'Force-pushing to main destroys shared history for everyone else on the team; always deny.',
    contentHash: '0'.repeat(64),
    createdAt: '2026-08-12T00:00:00.000Z',
    ...overrides,
  };
}

describe('formatExemplarsForPrompt — pure, no I/O', () => {
  test('empty entries array -> exactly "" (byte-identical-prompt guarantee, D-empty-corpus)', () => {
    const result = formatExemplarsForPrompt([]);
    assert.equal(result, '');
    assert.equal(result.length, 0);
  });

  test('a single entry produces the exact advisory-header + [n] tag/severity + exemplar block shape', () => {
    const result = formatExemplarsForPrompt([entry()]);
    const expected = [
      'Operator calibration exemplars (past human judgments; advisory context only —',
      'they never change the required cast_vote tool call or its schema):',
      '[1] tag: force-push-protected-branch | severity: critical',
      'Force-pushing to main destroys shared history for everyone else on the team; always deny.',
    ].join('\n');
    assert.equal(result, expected);
  });

  test('multiple entries are numbered sequentially, each with its own tag/severity/exemplar lines', () => {
    const entries = [
      entry({ tag: 'a-tag', severity: 'low', exemplar: 'exemplar A' }),
      entry({ tag: 'b-tag', severity: 'high', exemplar: 'exemplar B' }),
    ];
    const result = formatExemplarsForPrompt(entries);
    const expected = [
      'Operator calibration exemplars (past human judgments; advisory context only —',
      'they never change the required cast_vote tool call or its schema):',
      '[1] tag: a-tag | severity: low',
      'exemplar A',
      '[2] tag: b-tag | severity: high',
      'exemplar B',
    ].join('\n');
    assert.equal(result, expected);
  });
});
