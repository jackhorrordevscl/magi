import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CalibrationCorpus, computeContentHash } from '../../src/calibration/corpus.ts';
import type { CalibrationEntryInput } from '../../src/calibration/corpus-schema.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'magi-calibration-'));
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
