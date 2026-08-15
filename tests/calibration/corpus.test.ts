import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CalibrationCorpus, computeContentHash, computeCorpusSnapshotHash } from '../../src/calibration/corpus.ts';
import type { CalibrationEntry, CalibrationEntryInput } from '../../src/calibration/corpus-schema.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'magi-calibration-'));
}

async function captureStderr(fn: () => void | Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let buffer = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: unknown) => {
    buffer += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return buffer;
}

function entryInput(overrides: Partial<CalibrationEntryInput> = {}): CalibrationEntryInput {
  return {
    tag: 'force-push-protected-branch',
    severity: 'critical',
    exemplar: 'Force-pushing to main destroys shared history for everyone else on the team; always deny.',
    ...overrides,
  };
}

describe('computeContentHash — deterministic content addressing', () => {
  test('same (tag, severity, exemplar) always produces the same hash', () => {
    const a = computeContentHash(entryInput());
    const b = computeContentHash(entryInput());
    assert.equal(a, b);
  });

  test('changing any field changes the hash', () => {
    const base = computeContentHash(entryInput());
    assert.notEqual(computeContentHash(entryInput({ tag: 'other-tag' })), base);
    assert.notEqual(computeContentHash(entryInput({ severity: 'high' })), base);
    assert.notEqual(computeContentHash(entryInput({ exemplar: 'different narrative' })), base);
  });

  test('hash is a 64-char lowercase hex sha256 digest', () => {
    const hash = computeContentHash(entryInput());
    assert.match(hash, /^[0-9a-f]{64}$/);
  });
});

describe('CalibrationCorpus — add/list', () => {
  test('add() writes a file named <contentHash>.json and returns the full entry', () => {
    const dir = tmpDir();
    const corpus = new CalibrationCorpus(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    const entry = corpus.add(entryInput(), now);

    assert.equal(entry.tag, 'force-push-protected-branch');
    assert.equal(entry.contentHash, computeContentHash(entryInput()));
    assert.equal(entry.createdAt, now.toISOString());
    assert.ok(fs.existsSync(path.join(dir, `${entry.contentHash}.json`)));
  });

  test('list() returns every added entry, sorted by contentHash', () => {
    const dir = tmpDir();
    const corpus = new CalibrationCorpus(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    corpus.add(entryInput({ tag: 'a' }), now);
    corpus.add(entryInput({ tag: 'b' }), now);
    corpus.add(entryInput({ tag: 'c' }), now);

    const entries = corpus.list();
    assert.equal(entries.length, 3);
    const hashes = entries.map((e) => e.contentHash);
    assert.deepEqual(hashes, [...hashes].sort((x, y) => x.localeCompare(y)));
  });

  test('list() on a corpus directory that does not exist yet returns an empty array', () => {
    const dir = path.join(tmpDir(), 'does-not-exist');
    const corpus = new CalibrationCorpus(dir);
    assert.deepEqual(corpus.list(), []);
  });

  test('list() skips one corrupt entry file and still returns the other valid entries (per-file isolation)', async () => {
    const dir = tmpDir();
    const corpus = new CalibrationCorpus(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    const good1 = corpus.add(entryInput({ tag: 'a' }), now);
    const good2 = corpus.add(entryInput({ tag: 'b' }), now);
    fs.writeFileSync(path.join(dir, `${'f'.repeat(64)}.json`), '{ not valid json', 'utf8');

    let entries: CalibrationEntry[] = [];
    const stderr = await captureStderr(() => {
      entries = corpus.list();
    });

    const hashes = entries.map((e) => e.contentHash).sort();
    assert.deepEqual(hashes, [good1.contentHash, good2.contentHash].sort());
    assert.match(stderr, /calibration entry unreadable, skipping/i);
  });

  test('listWithDiagnostics() reports skippedCount:0 for a fully valid corpus', () => {
    const dir = tmpDir();
    const corpus = new CalibrationCorpus(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    corpus.add(entryInput({ tag: 'a' }), now);
    corpus.add(entryInput({ tag: 'b' }), now);

    const { entries, skippedCount } = corpus.listWithDiagnostics();
    assert.equal(entries.length, 2);
    assert.equal(skippedCount, 0);
  });

  test('listWithDiagnostics() reports skippedCount:0 for a directory that does not exist yet', () => {
    const dir = path.join(tmpDir(), 'does-not-exist');
    const corpus = new CalibrationCorpus(dir);
    const { entries, skippedCount } = corpus.listWithDiagnostics();
    assert.deepEqual(entries, []);
    assert.equal(skippedCount, 0);
  });

  test('listWithDiagnostics() counts each corrupt entry file it skips, distinguishing "empty" from "corrupted-down-to-empty"', async () => {
    const dir = tmpDir();
    const corpus = new CalibrationCorpus(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    const good = corpus.add(entryInput({ tag: 'a' }), now);
    fs.writeFileSync(path.join(dir, `${'e'.repeat(64)}.json`), '{ not valid json', 'utf8');
    fs.writeFileSync(path.join(dir, `${'f'.repeat(64)}.json`), 'also not valid json', 'utf8');

    let result: { entries: CalibrationEntry[]; skippedCount: number } | undefined;
    await captureStderr(() => {
      result = corpus.listWithDiagnostics();
    });

    assert.deepEqual(result?.entries.map((e) => e.contentHash), [good.contentHash]);
    assert.equal(result?.skippedCount, 2, 'both corrupt files must be counted, not just detected as a boolean');
  });

  test('re-adding byte-identical content is idempotent (content-addressed, not duplicated)', () => {
    const dir = tmpDir();
    const corpus = new CalibrationCorpus(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    corpus.add(entryInput(), now);
    corpus.add(entryInput(), now);

    assert.equal(corpus.list().length, 1);
  });

  test('has() reflects whether an entry with this exact content already exists', () => {
    const dir = tmpDir();
    const corpus = new CalibrationCorpus(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    assert.equal(corpus.has(entryInput()), false);
    corpus.add(entryInput(), now);
    assert.equal(corpus.has(entryInput()), true);
    assert.equal(corpus.has(entryInput({ tag: 'different' })), false);
  });
});

function snapshotEntry(overrides: Partial<CalibrationEntry> = {}): CalibrationEntry {
  return {
    tag: 'generic',
    severity: 'low',
    exemplar: 'exemplar text',
    contentHash: '0'.repeat(64),
    createdAt: '2026-08-12T00:00:00.000Z',
    ...overrides,
  };
}

describe('computeCorpusSnapshotHash — digest-of-digests over the full corpus snapshot', () => {
  test('empty entries array -> "" (D3 audit-hash correctness)', () => {
    assert.equal(computeCorpusSnapshotHash([]), '');
  });

  test('same entries always produce the same hash (determinism)', () => {
    const entries = [
      snapshotEntry({ contentHash: 'a'.repeat(64) }),
      snapshotEntry({ contentHash: 'b'.repeat(64) }),
    ];
    assert.equal(computeCorpusSnapshotHash(entries), computeCorpusSnapshotHash(entries));
  });

  test('input-order invariance: shuffling entries does not change the hash', () => {
    const entries = [
      snapshotEntry({ contentHash: 'a'.repeat(64) }),
      snapshotEntry({ contentHash: 'b'.repeat(64) }),
      snapshotEntry({ contentHash: 'c'.repeat(64) }),
    ];
    const shuffled = [entries[2], entries[0], entries[1]] as CalibrationEntry[];
    assert.equal(computeCorpusSnapshotHash(entries), computeCorpusSnapshotHash(shuffled));
  });

  test('createdAt invariance: differing createdAt values on otherwise-identical contentHash sets produce the same hash', () => {
    const entriesA = [
      snapshotEntry({ contentHash: 'a'.repeat(64), createdAt: '2020-01-01T00:00:00.000Z' }),
      snapshotEntry({ contentHash: 'b'.repeat(64), createdAt: '2020-01-01T00:00:00.000Z' }),
    ];
    const entriesB = [
      snapshotEntry({ contentHash: 'a'.repeat(64), createdAt: '2026-08-12T10:00:00.000Z' }),
      snapshotEntry({ contentHash: 'b'.repeat(64), createdAt: '2026-08-12T10:00:00.000Z' }),
    ];
    assert.equal(computeCorpusSnapshotHash(entriesA), computeCorpusSnapshotHash(entriesB));
  });

  test('a different set of contentHash values produces a different hash', () => {
    const a = computeCorpusSnapshotHash([snapshotEntry({ contentHash: 'a'.repeat(64) })]);
    const b = computeCorpusSnapshotHash([snapshotEntry({ contentHash: 'b'.repeat(64) })]);
    assert.notEqual(a, b);
  });

  test('hash is a 64-char lowercase hex sha256 digest', () => {
    const hash = computeCorpusSnapshotHash([snapshotEntry({ contentHash: 'a'.repeat(64) })]);
    assert.match(hash, /^[0-9a-f]{64}$/);
  });
});
