import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deriveExemplarTag,
  resolveExemplarSelection,
  EMPTY_SELECTION,
} from '../../src/calibration/exemplar-injection.ts';
import { CalibrationCorpus } from '../../src/calibration/corpus.ts';
import type { CalibrationEntryInput } from '../../src/calibration/corpus-schema.ts';
import type { CodingAgentAction, InfraPipelineAction, SeverityTier } from '../../src/gating/proposed-action.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'magi-exemplar-injection-'));
}

function codingAction(overrides: Partial<CodingAgentAction> = {}): CodingAgentAction {
  return {
    source: 'coding_agent',
    actor: 'test-agent',
    actionType: 'shell_exec',
    target: 'repo',
    environment: 'local',
    mode: 'shadow',
    command: 'git push --force origin main',
    ...overrides,
  };
}

function infraAction(overrides: Partial<InfraPipelineAction> = {}): InfraPipelineAction {
  return {
    source: 'infra_pipeline',
    actor: 'ci-bot',
    actionType: 'pipeline_step',
    target: 'build-artifacts',
    environment: 'ci',
    mode: 'shadow',
    pipelineId: 'build-42',
    ...overrides,
  };
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

function entryInput(overrides: Partial<CalibrationEntryInput> = {}): CalibrationEntryInput {
  return {
    tag: 'force-push-protected-branch',
    severity: 'critical',
    exemplar: 'Force-pushing to main destroys shared history for everyone else on the team; always deny.',
    ...overrides,
  };
}

describe('deriveExemplarTag — minimal tag derivation, no schema change', () => {
  test('coding_agent source uses action.command verbatim', () => {
    const a = codingAction({ command: 'rm -rf /tmp/build' });
    assert.equal(deriveExemplarTag(a), 'rm -rf /tmp/build');
  });

  test('infra_pipeline source combines pipelineId + target', () => {
    const a = infraAction({ pipelineId: 'deploy-99', target: 'production-cluster' });
    assert.equal(deriveExemplarTag(a), 'deploy-99 production-cluster');
  });
});

describe('resolveExemplarSelection — total, never throws (D4 containment)', () => {
  test('unreadable "directory" (a file where a directory is expected) degrades to EMPTY_SELECTION + warn log', async () => {
    const dir = tmpDir();
    const fakeDirPath = path.join(dir, 'not-a-real-directory');
    fs.writeFileSync(fakeDirPath, 'this is a file, not a directory', 'utf8');
    const corpus = new CalibrationCorpus(fakeDirPath);

    let result: ReturnType<typeof resolveExemplarSelection> | undefined;
    const stderr = await captureStderr(() => {
      assert.doesNotThrow(() => {
        result = resolveExemplarSelection(codingAction(), 'low', { corpus });
      });
    });

    assert.deepEqual(result, EMPTY_SELECTION);
    assert.match(stderr, /calibration corpus unavailable/i);
  });

  test('a corrupt JSON entry file degrades to EMPTY_SELECTION + warn log (spec scenario: corrupt corpus degrades to zero exemplars)', async () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${'a'.repeat(64)}.json`), '{ this is not valid json', 'utf8');
    const corpus = new CalibrationCorpus(dir);

    let result: ReturnType<typeof resolveExemplarSelection> | undefined;
    const stderr = await captureStderr(() => {
      assert.doesNotThrow(() => {
        result = resolveExemplarSelection(codingAction(), 'critical', { corpus });
      });
    });

    assert.deepEqual(result, EMPTY_SELECTION);
    assert.match(stderr, /calibration entry unreadable, skipping/i);
  });
});

describe('resolveExemplarSelection — distinguishing empty corpus from failed read', () => {
  test('an empty-but-valid corpus yields EMPTY_SELECTION with NO warn log, unlike a corrupt corpus', async () => {
    const dir = tmpDir();
    const corpus = new CalibrationCorpus(dir); // directory does not exist yet -> list() returns []

    let result: ReturnType<typeof resolveExemplarSelection> | undefined;
    const stderr = await captureStderr(() => {
      result = resolveExemplarSelection(codingAction(), 'low', { corpus });
    });

    assert.deepEqual(result, EMPTY_SELECTION);
    assert.equal(stderr, '', 'an empty-but-valid corpus must never emit a read-failure warning');
  });

  test('same two runs side by side: both empty exemplar sets, only the corrupt run warns', async () => {
    const emptyDir = tmpDir();
    const emptyCorpus = new CalibrationCorpus(path.join(emptyDir, 'does-not-exist'));

    const corruptDir = tmpDir();
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, `${'b'.repeat(64)}.json`), 'not json at all', 'utf8');
    const corruptCorpus = new CalibrationCorpus(corruptDir);

    let emptyResult: ReturnType<typeof resolveExemplarSelection> | undefined;
    const emptyStderr = await captureStderr(() => {
      emptyResult = resolveExemplarSelection(codingAction(), 'low', { corpus: emptyCorpus });
    });

    let corruptResult: ReturnType<typeof resolveExemplarSelection> | undefined;
    const corruptStderr = await captureStderr(() => {
      corruptResult = resolveExemplarSelection(codingAction(), 'low', { corpus: corruptCorpus });
    });

    assert.deepEqual(emptyResult?.exemplars, []);
    assert.deepEqual(corruptResult?.exemplars, []);
    assert.equal(emptyStderr, '');
    assert.match(corruptStderr, /calibration entry unreadable, skipping/i);
  });
});

describe('resolveExemplarSelection — uniform injection across all severity tiers (D1)', () => {
  const tiers: SeverityTier[] = ['low', 'medium', 'high', 'critical'];

  test('a populated corpus injects identically regardless of severity tier', () => {
    const dir = tmpDir();
    const corpus = new CalibrationCorpus(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');
    corpus.add(entryInput({ tag: 'git push --force origin main' }), now);

    for (const severity of tiers) {
      const result = resolveExemplarSelection(codingAction(), severity, { corpus });
      assert.equal(result.exemplars.length, 1, `severity ${severity} must still receive the exemplar`);
      assert.notEqual(result.corpusHash, '');
    }
  });
});

describe('resolveExemplarSelection — no relevance floor, weak matches still injected (D2)', () => {
  test('a corpus with only weak lexical matches against the derived tag still returns the top-k entries unfiltered', () => {
    const dir = tmpDir();
    const corpus = new CalibrationCorpus(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');
    corpus.add(entryInput({ tag: 'completely-unrelated-topic', severity: 'low' }), now);

    const result = resolveExemplarSelection(codingAction({ command: 'zzz nothing in common' }), 'critical', { corpus });

    assert.equal(result.exemplars.length, 1, 'weak matches are still injected, no relevance floor');
  });
});

describe('resolveExemplarSelection — k resolved from configured tier setting', () => {
  test('a configured tiers.sync.k bounds the number of exemplars retrieved', () => {
    const configDir = tmpDir();
    const configPath = path.join(configDir, 'magi.config.json');
    fs.writeFileSync(configPath, JSON.stringify({ tiers: { sync: { k: 2 } } }), 'utf8');

    const corpusDir = tmpDir();
    const corpus = new CalibrationCorpus(corpusDir);
    const now = new Date('2026-08-12T10:00:00.000Z');
    for (let i = 0; i < 5; i += 1) {
      corpus.add(entryInput({ tag: 'git push --force origin main', exemplar: `exemplar narrative number ${i}` }), now);
    }

    const result = resolveExemplarSelection(codingAction(), 'critical', { corpus, configPath });
    assert.equal(result.exemplars.length, 2);
  });
});
