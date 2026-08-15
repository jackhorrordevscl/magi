import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSyncExemplarK } from '../../src/calibration/tiers-config.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'magi-tiers-config-'));
}

function writeConfig(dir: string, content: unknown): string {
  const configPath = path.join(dir, 'magi.config.json');
  const body = typeof content === 'string' ? content : JSON.stringify(content);
  fs.writeFileSync(configPath, body, 'utf8');
  return configPath;
}

function unusedConfigPath(dir: string): string {
  return path.join(dir, 'magi.config.json');
}

/** Captures everything written to `process.stderr` for the duration of `fn`. */
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

describe('loadSyncExemplarK — fail-safe matrix, never throws', () => {
  test('no config file present -> default k=5, no warning needed', async () => {
    const dir = tmpDir();
    let result: number | undefined;
    const stderr = await captureStderr(() => {
      result = loadSyncExemplarK(unusedConfigPath(dir));
    });
    assert.equal(result, 5);
    assert.equal(stderr, '');
  });

  test('invalid JSON -> default k=5, warning emitted, no throw', async () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, '{ this is not valid json');
    let result: number | undefined;
    const stderr = await captureStderr(() => {
      assert.doesNotThrow(() => {
        result = loadSyncExemplarK(configPath);
      });
    });
    assert.equal(result, 5);
    assert.match(stderr, /parse/i);
  });

  test('tiers.sync.k absent -> default k=5, no warning needed', () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, { evaluators: {} });
    assert.equal(loadSyncExemplarK(configPath), 5);
  });

  test('tiers.sync.k wrong type (string) -> default k=5, warning emitted', async () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, { tiers: { sync: { k: 'lots' } } });
    let result: number | undefined;
    const stderr = await captureStderr(() => {
      result = loadSyncExemplarK(configPath);
    });
    assert.equal(result, 5);
    assert.match(stderr, /tiers\.sync\.k/);
  });

  test('tiers.sync.k zero or negative -> default k=5, warning emitted', async () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, { tiers: { sync: { k: -3 } } });
    let result: number | undefined;
    const stderr = await captureStderr(() => {
      result = loadSyncExemplarK(configPath);
    });
    assert.equal(result, 5);
    assert.match(stderr, /tiers\.sync\.k/);
  });

  test('a valid configured value is honored', () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, { tiers: { sync: { k: 8 } } });
    assert.equal(loadSyncExemplarK(configPath), 8);
  });
});

describe('loadSyncExemplarK — memoized, read once per path', () => {
  test('a second call against the same path returns the cached result, ignoring a rewrite in between', () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, { tiers: { sync: { k: 3 } } });

    const first = loadSyncExemplarK(configPath);
    assert.equal(first, 3);

    writeConfig(dir, { tiers: { sync: { k: 9 } } });
    const second = loadSyncExemplarK(configPath);

    assert.equal(second, 3);
  });
});
