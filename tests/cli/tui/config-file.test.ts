import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readConfigFile,
  detectIndent,
  normalizeEvaluators,
  writeEvaluatorsSection,
} from '../../../src/cli/tui/config-file.ts';
import type { EvaluatorsConfig } from '../../../src/gating/evaluator-config.ts';

// --- Fixtures ---------------------------------------------------------

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'magi-tui-config-file-'));
}

function writeConfig(dir: string, content: unknown): string {
  const configPath = path.join(dir, 'magi.config.json');
  const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  fs.writeFileSync(configPath, body, 'utf8');
  return configPath;
}

function unusedConfigPath(dir: string): string {
  return path.join(dir, 'magi.config.json');
}

function otherFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f !== 'magi.config.json');
}

// --- readConfigFile ------------------------------------------------------

describe('readConfigFile', () => {
  test('missing file -> status: missing', () => {
    const dir = tmpDir();
    const configPath = unusedConfigPath(dir);
    assert.deepEqual(readConfigFile(configPath), { status: 'missing', path: configPath });
  });

  test('invalid JSON -> status: unparseable, message names the parse failure', () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, '{ this is not valid json');
    const result = readConfigFile(configPath);
    assert.equal(result.status, 'unparseable');
    if (result.status === 'unparseable') {
      assert.match(result.message, /json/i);
    }
  });

  test('non-object top-level JSON (array) -> status: unparseable', () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, '[1, 2, 3]');
    assert.equal(readConfigFile(configPath).status, 'unparseable');
  });

  test('valid JSON -> status: ok with parsed raw, text, and detected indent', () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, {
      tiers: { sync: { k: 5 } },
      evaluators: { casper: { model: 'x' } },
    });
    const result = readConfigFile(configPath);
    assert.equal(result.status, 'ok');
    if (result.status === 'ok') {
      assert.deepEqual(result.raw.tiers, { sync: { k: 5 } });
      assert.equal(result.indent, 2);
      assert.equal(typeof result.text, 'string');
    }
  });

  test('no memoization: a second read after a rewrite reflects the new bytes, in the same process', () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, { evaluators: { casper: { model: 'first-model' } } });

    const first = readConfigFile(configPath);
    fs.writeFileSync(configPath, JSON.stringify({ evaluators: { casper: { model: 'second-model' } } }), 'utf8');
    const second = readConfigFile(configPath);

    assert.equal(first.status, 'ok');
    assert.equal(second.status, 'ok');
    if (first.status === 'ok' && second.status === 'ok') {
      const firstEvaluators = first.raw.evaluators as { casper: { model: string } };
      const secondEvaluators = second.raw.evaluators as { casper: { model: string } };
      assert.equal(firstEvaluators.casper.model, 'first-model');
      assert.equal(secondEvaluators.casper.model, 'second-model');
    }
  });
});

// --- detectIndent ----------------------------------------------------------

describe('detectIndent', () => {
  test('2-space indent detected', () => {
    assert.equal(detectIndent('{\n  "a": 1\n}'), 2);
  });

  test('4-space indent detected', () => {
    assert.equal(detectIndent('{\n    "a": 1\n}'), 4);
  });

  test('tab indent detected', () => {
    assert.equal(detectIndent('{\n\t"a": 1\n}'), '\t');
  });

  test('no indented line -> default 2', () => {
    assert.equal(detectIndent('{"a":1}'), 2);
  });
});

// --- normalizeEvaluators -----------------------------------------------------

describe('normalizeEvaluators', () => {
  test('per-evaluator entries with no set field are omitted', () => {
    const pending: EvaluatorsConfig = { melchior: {}, casper: { model: 'x' } };
    assert.deepEqual(normalizeEvaluators(pending), { casper: { model: 'x' } });
  });

  test('all three evaluators empty -> undefined (caller deletes the evaluators key)', () => {
    const pending: EvaluatorsConfig = { melchior: {}, balthasar: {}, casper: {} };
    assert.equal(normalizeEvaluators(pending), undefined);
  });

  test('no evaluators present at all -> undefined', () => {
    assert.equal(normalizeEvaluators({}), undefined);
  });

  test('a single set field keeps the whole entry', () => {
    const pending: EvaluatorsConfig = { balthasar: { timeoutMs: 4000 } };
    assert.deepEqual(normalizeEvaluators(pending), { balthasar: { timeoutMs: 4000 } });
  });
});

// --- writeEvaluatorsSection — round-trip preservation ------------------------

describe('writeEvaluatorsSection — round-trip preservation', () => {
  test('save leaves tiers/paths/_note byte-for-byte unchanged and reflects the evaluator edit', () => {
    const dir = tmpDir();
    const original = {
      tiers: { sync: { k: 5 }, async: { k: 12 }, divergenceFloorPercent: 40 },
      paths: { calibrationDir: '.magi/calibration/', auditDir: '.magi/audit/' },
      _note: 'hand-authored config',
      evaluators: { melchior: { model: 'old-model' } },
    };
    const configPath = writeConfig(dir, original);

    const result = writeEvaluatorsSection(configPath, { melchior: { model: 'new-model' } });
    assert.deepEqual(result, { ok: true });

    const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(written.tiers, original.tiers);
    assert.deepEqual(written.paths, original.paths);
    assert.equal(written._note, original._note);
    assert.equal(written.evaluators.melchior.model, 'new-model');
  });

  test('empty-state normalization: clearing every field of all evaluators deletes the evaluators key entirely', () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, {
      tiers: { sync: { k: 5 } },
      evaluators: { melchior: { model: 'x' }, balthasar: { timeoutMs: 1 }, casper: { maxTokens: 1 } },
    });

    const result = writeEvaluatorsSection(configPath, { melchior: {}, balthasar: {}, casper: {} });
    assert.deepEqual(result, { ok: true });

    const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal('evaluators' in written, false);
    assert.deepEqual(written.tiers, { sync: { k: 5 } });
  });

  test('indentation is preserved (4-space fixture stays 4-space after save)', () => {
    const dir = tmpDir();
    const configPath = path.join(dir, 'magi.config.json');
    const original = '{\n    "tiers": {\n        "sync": {\n            "k": 5\n        }\n    }\n}\n';
    fs.writeFileSync(configPath, original, 'utf8');

    const result = writeEvaluatorsSection(configPath, { casper: { model: 'x' } });
    assert.deepEqual(result, { ok: true });

    const writtenText = fs.readFileSync(configPath, 'utf8');
    assert.match(writtenText, /^\{\n {4}"tiers"/);
  });
});

// --- writeEvaluatorsSection — refusal paths ----------------------------------

describe('writeEvaluatorsSection — refusal paths never open the target for writing', () => {
  test('missing file: refused, no tmp file left behind', () => {
    const dir = tmpDir();
    const configPath = unusedConfigPath(dir);

    const result = writeEvaluatorsSection(configPath, { casper: { model: 'x' } });
    assert.equal(result.ok, false);
    assert.equal(fs.existsSync(configPath), false);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('unparseable file: refused, message names the parse failure, bytes unchanged, no tmp file left', () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, '{ not valid json at all');
    const before = fs.readFileSync(configPath);

    const result = writeEvaluatorsSection(configPath, { casper: { model: 'x' } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /json|parse/i);

    const after = fs.readFileSync(configPath);
    assert.deepEqual(before, after);
    assert.deepEqual(otherFiles(dir), []);
  });

  test('write-time failure leaves the target byte-identical and reports an error', () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, { evaluators: { casper: { model: 'old' } } });
    const before = fs.readFileSync(configPath);

    // Force the write to fail deterministically and portably across
    // platforms (directory read-only attributes are unreliable on
    // Windows): pre-occupy the exact tmp path the implementation targets
    // with a directory, so fs.writeFileSync(tmpPath) fails.
    const tmpPath = path.join(dir, `.magi.config.json.tmp-${process.pid}`);
    fs.mkdirSync(tmpPath);

    const result = writeEvaluatorsSection(configPath, { casper: { model: 'new' } });
    assert.equal(result.ok, false);

    const after = fs.readFileSync(configPath);
    assert.deepEqual(before, after);
  });
});

// --- writeEvaluatorsSection — save-then-reread freshness ---------------------

describe('writeEvaluatorsSection — save-then-reread freshness', () => {
  test('a save followed by readConfigFile in the same process returns the just-written value', () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, { evaluators: { balthasar: { timeoutMs: 1000 } } });

    const saveResult = writeEvaluatorsSection(configPath, { balthasar: { timeoutMs: 9000 } });
    assert.deepEqual(saveResult, { ok: true });

    const reread = readConfigFile(configPath);
    assert.equal(reread.status, 'ok');
    if (reread.status === 'ok') {
      const evaluators = reread.raw.evaluators as { balthasar: { timeoutMs: number } };
      assert.equal(evaluators.balthasar.timeoutMs, 9000);
    }
  });
});
