import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { selectExemplars } from '../../src/calibration/selector.ts';
import type { CalibrationEntry } from '../../src/calibration/corpus-schema.ts';

function entry(overrides: Partial<CalibrationEntry> = {}): CalibrationEntry {
  return {
    tag: 'generic',
    severity: 'low',
    exemplar: 'exemplar text',
    contentHash: '0'.repeat(64),
    createdAt: '2026-08-12T00:00:00.000Z',
    ...overrides,
  };
}

describe('selectExemplars — deterministic lexical tag+severity retrieval', () => {
  test('same input always returns the same top-K, in the same order', () => {
    const entries = [
      entry({ tag: 'force-push', severity: 'critical', contentHash: 'a'.repeat(64) }),
      entry({ tag: 'rm-rf', severity: 'high', contentHash: 'b'.repeat(64) }),
      entry({ tag: 'file-edit', severity: 'low', contentHash: 'c'.repeat(64) }),
      entry({ tag: 'force-push-branch', severity: 'high', contentHash: 'd'.repeat(64) }),
    ];

    const first = selectExemplars(entries, { tag: 'force-push', severity: 'critical' }, 5);
    const second = selectExemplars(entries, { tag: 'force-push', severity: 'critical' }, 5);

    assert.deepEqual(first, second);
  });

  test('the same input still returns the same result when the entries array order is shuffled', () => {
    const entries = [
      entry({ tag: 'force-push', severity: 'critical', contentHash: 'a'.repeat(64) }),
      entry({ tag: 'rm-rf', severity: 'high', contentHash: 'b'.repeat(64) }),
      entry({ tag: 'file-edit', severity: 'low', contentHash: 'c'.repeat(64) }),
    ];
    const shuffled = [entries[2], entries[0], entries[1]] as CalibrationEntry[];

    const a = selectExemplars(entries, { tag: 'force-push', severity: 'critical' }, 5);
    const b = selectExemplars(shuffled, { tag: 'force-push', severity: 'critical' }, 5);

    assert.deepEqual(a, b);
  });

  test('an exact tag+severity match ranks first', () => {
    const entries = [
      entry({ tag: 'unrelated', severity: 'low', contentHash: 'a'.repeat(64) }),
      entry({ tag: 'force-push', severity: 'critical', contentHash: 'b'.repeat(64) }),
    ];

    const [top] = selectExemplars(entries, { tag: 'force-push', severity: 'critical' }, 5);
    assert.equal(top?.contentHash, 'b'.repeat(64));
  });

  test('K limits the result even when more entries match', () => {
    const entries = Array.from({ length: 10 }, (_unused, i) =>
      entry({ tag: 'force-push', severity: 'critical', contentHash: i.toString().padStart(64, '0') }),
    );

    assert.equal(selectExemplars(entries, { tag: 'force-push', severity: 'critical' }, 5).length, 5);
    assert.equal(selectExemplars(entries, { tag: 'force-push', severity: 'critical' }, 12).length, 10);
  });

  test('K=12 (async placeholder tier) works the same generic way as K=5 (sync tier)', () => {
    const entries = Array.from({ length: 20 }, (_unused, i) =>
      entry({ tag: 'force-push', severity: 'critical', contentHash: i.toString().padStart(64, '0') }),
    );
    assert.equal(selectExemplars(entries, { tag: 'force-push', severity: 'critical' }, 12).length, 12);
  });

  test('tied scores are broken deterministically by ascending contentHash', () => {
    const entries = [
      entry({ tag: 'unrelated-a', severity: 'low', contentHash: 'z'.repeat(64) }),
      entry({ tag: 'unrelated-b', severity: 'low', contentHash: 'a'.repeat(64) }),
    ];
    const result = selectExemplars(entries, { tag: 'no-match-at-all', severity: 'medium' }, 5);
    assert.equal(result[0]?.contentHash, 'a'.repeat(64));
    assert.equal(result[1]?.contentHash, 'z'.repeat(64));
  });

  test('an empty corpus returns an empty array', () => {
    assert.deepEqual(selectExemplars([], { tag: 'anything', severity: 'low' }, 5), []);
  });

  test('K=0 returns an empty array', () => {
    const entries = [entry({ tag: 'force-push', severity: 'critical' })];
    assert.deepEqual(selectExemplars(entries, { tag: 'force-push', severity: 'critical' }, 0), []);
  });
});
