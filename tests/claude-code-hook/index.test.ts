import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { runHook, normalizeToProposedAction, buildBlockReason, capReason } from '../../claude-code-hook/index.ts';
import type { ClaudeCodeHookInput } from '../../claude-code-hook/index.ts';
import { FsAppendAuditSink } from '../../src/audit/fs-append-sink.ts';
import { CalibrationCorpus } from '../../src/calibration/corpus.ts';
import type { AuditRecord } from '../../src/audit/record.ts';
import type { EvaluatorPort } from '../../src/gating/evaluator-port.ts';
import type { Vote } from '../../src/gating/consensus.ts';
import type { CalibrationEntry } from '../../src/calibration/corpus-schema.ts';

const repoRoot = path.resolve(import.meta.dirname, '../../');
const hookPath = path.join(repoRoot, 'claude-code-hook/index.ts');

function tmpAuditDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'magi-hook-audit-'));
}

function readDayFileRecords(auditDir: string, date: Date): AuditRecord[] {
  const fileName = `${date.toISOString().slice(0, 10)}.jsonl`;
  const filePath = path.join(auditDir, fileName);
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AuditRecord);
}

function countingEvaluator(name: Vote['evaluator'], vote: Vote['vote']): { evaluator: EvaluatorPort; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    evaluator: {
      name,
      async castVote(): Promise<Vote> {
        calls.push(1);
        return { evaluator: name, vote, rationale: `${name}-${vote}` };
      },
    },
  };
}

describe('normalizeToProposedAction — Claude Code tool payload -> ProposedAction', () => {
  function hookInput(overrides: Partial<ClaudeCodeHookInput> = {}): ClaudeCodeHookInput {
    return { tool_name: 'Bash', tool_input: { command: 'echo hi' }, ...overrides };
  }

  test('Bash tool maps tool_input.command verbatim', () => {
    const action = normalizeToProposedAction(
      hookInput({ tool_name: 'Bash', tool_input: { command: 'git status' } }),
      'shadow',
    );
    assert.equal(action.source, 'coding_agent');
    if (action.source === 'coding_agent') assert.equal(action.command, 'git status');
    assert.equal(action.mode, 'shadow');
  });

  test('Read tool synthesizes a cat command over file_path', () => {
    const action = normalizeToProposedAction(
      hookInput({ tool_name: 'Read', tool_input: { file_path: '/tmp/foo.txt' } }),
      'shadow',
    );
    if (action.source === 'coding_agent') assert.equal(action.command, 'cat /tmp/foo.txt');
  });

  test('Grep tool synthesizes a grep command over pattern + path', () => {
    const action = normalizeToProposedAction(
      hookInput({ tool_name: 'Grep', tool_input: { pattern: 'TODO', path: 'src' } }),
      'shadow',
    );
    if (action.source === 'coding_agent') assert.equal(action.command, 'grep TODO src');
  });

  test('Glob tool synthesizes a find command over path + pattern', () => {
    const action = normalizeToProposedAction(
      hookInput({ tool_name: 'Glob', tool_input: { path: 'src', pattern: '*.ts' } }),
      'shadow',
    );
    if (action.source === 'coding_agent') assert.equal(action.command, 'find src -name *.ts');
  });

  test('an unrecognized tool synthesizes a conservative, non-git, non-trivial command', () => {
    const action = normalizeToProposedAction(
      hookInput({ tool_name: 'Write', tool_input: { file_path: '/tmp/danger.txt' } }),
      'shadow',
    );
    if (action.source === 'coding_agent') assert.equal(action.command, 'write /tmp/danger.txt');
  });

  test('session_id becomes actor; missing session_id falls back to a stable default', () => {
    const withSession = normalizeToProposedAction(hookInput({ session_id: 'sess-123' }), 'shadow');
    assert.equal(withSession.actor, 'sess-123');
    const withoutSession = normalizeToProposedAction(hookInput(), 'shadow');
    assert.ok(withoutSession.actor.length > 0);
  });
});

describe('runHook — trivial-scope allowlist short-circuit', () => {
  test('a trivial Read action is allowed without invoking any evaluator or writing an audit record', async () => {
    const dir = tmpAuditDir();
    const auditSink = new FsAppendAuditSink(dir);
    const melchiorSpy = countingEvaluator('melchior', 'deny');
    const balthasarSpy = countingEvaluator('balthasar', 'deny');
    const casperSpy = countingEvaluator('casper', 'deny');
    const now = new Date('2026-08-12T10:00:00.000Z');

    const action = normalizeToProposedAction(
      { tool_name: 'Read', tool_input: { file_path: '/tmp/foo.txt' } },
      'shadow',
    );

    const outcome = await runHook(action, {
      auditSink,
      now,
      evaluators: [melchiorSpy.evaluator, balthasarSpy.evaluator, casperSpy.evaluator],
    });

    assert.equal(outcome.allow, true);
    assert.equal(outcome.trivial, true);
    assert.equal(outcome.verdict, null);
    assert.equal(outcome.record, null);
    assert.equal(melchiorSpy.calls.length, 0);
    assert.equal(balthasarSpy.calls.length, 0);
    assert.equal(casperSpy.calls.length, 0);
    assert.deepEqual(readDayFileRecords(dir, now), []);
  });

  test('a trivial action short-circuits identically even under enforced mode', async () => {
    const dir = tmpAuditDir();
    const auditSink = new FsAppendAuditSink(dir);
    const melchiorSpy = countingEvaluator('melchior', 'allow');
    const now = new Date('2026-08-12T10:00:00.000Z');

    const action = normalizeToProposedAction({ tool_name: 'Bash', tool_input: { command: 'git log' } }, 'enforced');
    const outcome = await runHook(action, {
      auditSink,
      now,
      evaluators: [melchiorSpy.evaluator, melchiorSpy.evaluator, melchiorSpy.evaluator],
    });

    assert.equal(outcome.allow, true);
    assert.equal(outcome.trivial, true);
    assert.equal(outcome.record, null);
    assert.equal(melchiorSpy.calls.length, 0);
    assert.deepEqual(readDayFileRecords(dir, now), []);
  });
});

describe('runHook — shadow mode NEVER blocks, regardless of the computed verdict', () => {
  test('a critical-severity, all-deny action still returns allow:true, while the recorded verdict is genuinely deny', async () => {
    const dir = tmpAuditDir();
    const auditSink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    const denyEvaluator = (name: Vote['evaluator']): EvaluatorPort => ({
      name,
      async castVote(): Promise<Vote> {
        return { evaluator: name, vote: 'deny', rationale: `${name}-deny-for-test` };
      },
    });

    const action = normalizeToProposedAction(
      { tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } },
      'shadow',
    );

    const outcome = await runHook(action, {
      auditSink,
      now,
      evaluators: [denyEvaluator('melchior'), denyEvaluator('balthasar'), denyEvaluator('casper')],
    });

    assert.equal(outcome.allow, true, 'shadow mode must always allow, even for a computed deny verdict');
    assert.equal(outcome.trivial, false);
    assert.equal(outcome.verdict?.severity, 'critical');
    assert.equal(outcome.verdict?.decision, 'deny', 'the recorded verdict must genuinely reflect the real decision');
    assert.ok(outcome.record, 'the verdict must still be durably recorded even though shadow mode never blocks');
  });

  test('a low-severity action with 2-of-3 allow is recorded allow and still returned as allow', async () => {
    const dir = tmpAuditDir();
    const auditSink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    const evaluators: [EvaluatorPort, EvaluatorPort, EvaluatorPort] = [
      { name: 'melchior', async castVote(): Promise<Vote> { return { evaluator: 'melchior', vote: 'allow', rationale: 'ok' }; } },
      { name: 'balthasar', async castVote(): Promise<Vote> { return { evaluator: 'balthasar', vote: 'allow', rationale: 'ok' }; } },
      { name: 'casper', async castVote(): Promise<Vote> { return { evaluator: 'casper', vote: 'abstain', rationale: 'unsure' }; } },
    ];

    const action = normalizeToProposedAction({ tool_name: 'Write', tool_input: { file_path: 'notes.md' } }, 'shadow');
    const outcome = await runHook(action, { auditSink, now, evaluators });

    assert.equal(outcome.allow, true);
    assert.equal(outcome.verdict?.decision, 'allow');
  });
});

describe('runHook — enforcing mode blocks deny verdicts (mode x decision x trivial matrix)', () => {
  const denyEvaluator = (name: Vote['evaluator']): EvaluatorPort => ({
    name,
    async castVote(): Promise<Vote> {
      return { evaluator: name, vote: 'deny', rationale: `${name}-deny-for-test` };
    },
  });
  const allowEvaluator = (name: Vote['evaluator']): EvaluatorPort => ({
    name,
    async castVote(): Promise<Vote> {
      return { evaluator: name, vote: 'allow', rationale: `${name}-allow-for-test` };
    },
  });

  test('enforced mode + deny verdict -> allow:false, verdict/record still populated', async () => {
    const dir = tmpAuditDir();
    const auditSink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    const action = normalizeToProposedAction(
      { tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } },
      'enforced',
    );
    const outcome = await runHook(action, {
      auditSink,
      now,
      evaluators: [denyEvaluator('melchior'), denyEvaluator('balthasar'), denyEvaluator('casper')],
    });

    assert.equal(outcome.allow, false, 'enforced mode must block a genuine deny verdict');
    assert.equal(outcome.trivial, false);
    assert.equal(outcome.verdict?.decision, 'deny');
    assert.ok(outcome.record, 'the blocked action must still be durably audited');
    assert.equal(outcome.record?.decision, 'deny');
  });

  test('enforced mode + allow verdict -> allow:true, identical to shadow mode', async () => {
    const dir = tmpAuditDir();
    const auditSink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    const action = normalizeToProposedAction({ tool_name: 'Bash', tool_input: { command: 'npm install' } }, 'enforced');
    const outcome = await runHook(action, {
      auditSink,
      now,
      evaluators: [allowEvaluator('melchior'), allowEvaluator('balthasar'), allowEvaluator('casper')],
    });

    assert.equal(outcome.allow, true);
    assert.equal(outcome.verdict?.decision, 'allow');
  });

  test('an evaluator abstain that resolves to a consensus deny still blocks under enforcement (fail-closed)', async () => {
    const dir = tmpAuditDir();
    const auditSink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    const abstainEvaluator = (name: Vote['evaluator']): EvaluatorPort => ({
      name,
      async castVote(): Promise<Vote> {
        return { evaluator: name, vote: 'abstain', rationale: `${name}-abstain-for-test` };
      },
    });

    const action = normalizeToProposedAction({ tool_name: 'Write', tool_input: { file_path: 'notes.md' } }, 'enforced');
    const outcome = await runHook(action, {
      auditSink,
      now,
      evaluators: [abstainEvaluator('melchior'), abstainEvaluator('balthasar'), abstainEvaluator('casper')],
    });

    assert.equal(outcome.verdict?.decision, 'deny', 'abstain never counts toward allow — consensus resolves to deny');
    assert.equal(outcome.allow, false, 'a real abstain signal blocks under enforcement, unlike an adapter exception');
  });
});

describe('buildBlockReason — full evaluator rationale + audit hash', () => {
  test('includes all three evaluator rationales, the action, and the audit hash', () => {
    const verdict = {
      actor: 'test-actor',
      mode: 'enforced' as const,
      action: 'git push --force origin main',
      severity: 'critical' as const,
      votes: [
        { evaluator: 'melchior' as const, vote: 'deny' as const, rationale: 'melchior sees a contradiction' },
        { evaluator: 'balthasar' as const, vote: 'deny' as const, rationale: 'balthasar flags blast radius' },
        { evaluator: 'casper' as const, vote: 'abstain' as const, rationale: 'casper is unsure' },
      ] as [Vote, Vote, Vote],
      decision: 'deny' as const,
      calibrationCorpusHash: '',
      exemplarIds: [],
      corpusDegraded: false,
    };

    const reason = buildBlockReason(verdict.action, 'abc123hash', verdict);

    assert.match(reason, /BLOCKED/);
    assert.match(reason, /abc123hash/);
    assert.match(reason, /git push --force origin main/);
    assert.match(reason, /melchior sees a contradiction/);
    assert.match(reason, /balthasar flags blast radius/);
    assert.match(reason, /casper is unsure/);
    assert.match(reason, /magi audit override abc123hash/);
  });
});

describe('capReason — 10,000 character cap', () => {
  test('reasons under the cap are returned unchanged', () => {
    const short = 'magi: BLOCKED — short reason';
    assert.equal(capReason(short), short);
  });

  test('reasons over the cap are truncated to exactly 10,000 chars, preserving the header at the start', () => {
    const header = 'magi: BLOCKED — consensus deny (severity: critical)\nAction: x   Audit: abc123\n';
    const longReason = header + 'x'.repeat(20_000);

    const capped = capReason(longReason);

    assert.equal(capped.length, 10_000);
    assert.ok(capped.startsWith(header), 'the header must survive truncation, since truncation drops from the end');
  });
});

describe('runHook — audit durability (record present on disk by the time runHook resolves)', () => {
  test('the audit record is synchronously readable immediately after runHook resolves', async () => {
    const dir = tmpAuditDir();
    const auditSink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    const allowEvaluator = (name: Vote['evaluator']): EvaluatorPort => ({
      name,
      async castVote(): Promise<Vote> {
        return { evaluator: name, vote: 'allow', rationale: `${name}-allow` };
      },
    });

    const action = normalizeToProposedAction({ tool_name: 'Bash', tool_input: { command: 'npm install' } }, 'shadow');
    const outcome = await runHook(action, {
      auditSink,
      now,
      evaluators: [allowEvaluator('melchior'), allowEvaluator('balthasar'), allowEvaluator('casper')],
    });

    // No await/setImmediate beyond the runHook() promise itself — if the
    // audit write were not durable before resolution, this sync read would
    // miss the record.
    const onDisk = readDayFileRecords(dir, now);
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0]?.action, outcome.verdict?.action);
    assert.equal(onDisk[0]?.decision, outcome.verdict?.decision);
  });
});

class CountingCalibrationCorpus extends CalibrationCorpus {
  calls = 0;
  override listWithDiagnostics(): { entries: CalibrationEntry[]; skippedCount: number } {
    this.calls += 1;
    return super.listWithDiagnostics();
  }
}

function calibrationEntryInput(overrides: Partial<CalibrationEntry> = {}) {
  return {
    tag: overrides.tag ?? 'git push --force origin main',
    severity: overrides.severity ?? ('critical' as const),
    exemplar: overrides.exemplar ?? 'Force-pushing to main destroys shared history; always deny.',
  };
}

function exemplarCapturingEvaluator(
  name: Vote['evaluator'],
): { evaluator: EvaluatorPort; captured: (readonly CalibrationEntry[] | undefined)[] } {
  const captured: (readonly CalibrationEntry[] | undefined)[] = [];
  return {
    captured,
    evaluator: {
      name,
      async castVote(_action, _severity, exemplars): Promise<Vote> {
        captured.push(exemplars);
        return { evaluator: name, vote: 'allow', rationale: `${name}-allow` };
      },
    },
  };
}

describe('runHook — shared exemplar selection (spec Requirement: Single Shared Exemplar Selection Per Action)', () => {
  test('exactly one corpus.list() call per non-trivial action, shared by all 3 evaluators and the verdict', async () => {
    const dir = tmpAuditDir();
    const auditSink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    const corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magi-hook-corpus-'));
    const corpus = new CountingCalibrationCorpus(corpusDir);
    corpus.add(calibrationEntryInput(), now);

    const melchior = exemplarCapturingEvaluator('melchior');
    const balthasar = exemplarCapturingEvaluator('balthasar');
    const casper = exemplarCapturingEvaluator('casper');

    const action = normalizeToProposedAction(
      { tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } },
      'shadow',
    );

    const outcome = await runHook(action, {
      auditSink,
      now,
      corpus,
      evaluators: [melchior.evaluator, balthasar.evaluator, casper.evaluator],
    });

    assert.equal(corpus.calls, 1, 'exactly one corpus.list() call per non-trivial action');
    assert.equal(melchior.captured.length, 1);
    assert.equal(balthasar.captured.length, 1);
    assert.equal(casper.captured.length, 1);
    assert.deepEqual(melchior.captured[0], balthasar.captured[0]);
    assert.deepEqual(balthasar.captured[0], casper.captured[0]);
    assert.equal(melchior.captured[0]?.length, 1);

    assert.deepEqual(
      outcome.verdict?.exemplarIds,
      melchior.captured[0]?.map((e) => e.contentHash),
      'exemplarIds in the resulting verdict must equal the retrieved exemplars\' contentHash[]',
    );
    assert.notEqual(outcome.verdict?.calibrationCorpusHash, '');
  });

  test('zero corpus.list() calls for a trivial action — the corpus is never touched', async () => {
    const dir = tmpAuditDir();
    const auditSink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    const corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magi-hook-corpus-'));
    const corpus = new CountingCalibrationCorpus(corpusDir);
    corpus.add(calibrationEntryInput(), now);

    const melchiorSpy = countingEvaluator('melchior', 'deny');

    const action = normalizeToProposedAction({ tool_name: 'Read', tool_input: { file_path: '/tmp/foo.txt' } }, 'shadow');
    await runHook(action, {
      auditSink,
      now,
      corpus,
      evaluators: [melchiorSpy.evaluator, melchiorSpy.evaluator, melchiorSpy.evaluator],
    });

    assert.equal(corpus.calls, 0, 'a trivial action must never read the calibration corpus');
  });

  test('an empty corpus still produces exemplarIds:[] and a real (non-"") empty-snapshot calibrationCorpusHash', async () => {
    const dir = tmpAuditDir();
    const auditSink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    const corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magi-hook-corpus-empty-'));
    const corpus = new CountingCalibrationCorpus(corpusDir);

    const melchior = exemplarCapturingEvaluator('melchior');
    const balthasar = exemplarCapturingEvaluator('balthasar');
    const casper = exemplarCapturingEvaluator('casper');

    const action = normalizeToProposedAction({ tool_name: 'Bash', tool_input: { command: 'npm install' } }, 'shadow');
    const outcome = await runHook(action, {
      auditSink,
      now,
      corpus,
      evaluators: [melchior.evaluator, balthasar.evaluator, casper.evaluator],
    });

    assert.equal(corpus.calls, 1);
    assert.deepEqual(outcome.verdict?.exemplarIds, []);
    assert.equal(outcome.verdict?.calibrationCorpusHash, '', 'an empty corpus snapshot hash is genuinely "" per computeCorpusSnapshotHash');
    assert.equal(outcome.verdict?.corpusDegraded, false, 'a genuinely empty (but valid) corpus must not be flagged as degraded');
  });
});

describe('runHook — RunHookOptions.configPath seam (issue #3: tiers.sync.k must be overridable, not hardcoded to bare process.cwd())', () => {
  test('a configPath pointing at a custom tiers.sync.k bounds the retrieved exemplars end-to-end through runHook', async () => {
    const dir = tmpAuditDir();
    const auditSink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magi-hook-config-'));
    const configPath = path.join(configDir, 'magi.config.json');
    fs.writeFileSync(configPath, JSON.stringify({ tiers: { sync: { k: 1 } } }), 'utf8');

    const corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magi-hook-corpus-configpath-'));
    const corpus = new CountingCalibrationCorpus(corpusDir);
    corpus.add(calibrationEntryInput({ exemplar: 'exemplar one' }), now);
    corpus.add(calibrationEntryInput({ exemplar: 'exemplar two' }), now);
    corpus.add(calibrationEntryInput({ exemplar: 'exemplar three' }), now);

    const melchior = exemplarCapturingEvaluator('melchior');
    const balthasar = exemplarCapturingEvaluator('balthasar');
    const casper = exemplarCapturingEvaluator('casper');

    const action = normalizeToProposedAction(
      { tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } },
      'shadow',
    );

    const outcome = await runHook(action, {
      auditSink,
      now,
      corpus,
      configPath,
      evaluators: [melchior.evaluator, balthasar.evaluator, casper.evaluator],
    });

    assert.equal(
      outcome.verdict?.exemplarIds.length,
      1,
      'the configured k=1 (from the overridden configPath) must bound the exemplars, not the default k=5',
    );
  });

  test('omitting configPath keeps the pre-existing default-k behavior unchanged (additive seam, back-compat)', async () => {
    const dir = tmpAuditDir();
    const auditSink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    const corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magi-hook-corpus-nodefault-'));
    const corpus = new CountingCalibrationCorpus(corpusDir);
    corpus.add(calibrationEntryInput({ exemplar: 'exemplar one' }), now);
    corpus.add(calibrationEntryInput({ exemplar: 'exemplar two' }), now);

    const melchior = exemplarCapturingEvaluator('melchior');
    const balthasar = exemplarCapturingEvaluator('balthasar');
    const casper = exemplarCapturingEvaluator('casper');

    const action = normalizeToProposedAction(
      { tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } },
      'shadow',
    );

    const outcome = await runHook(action, {
      auditSink,
      now,
      corpus,
      evaluators: [melchior.evaluator, balthasar.evaluator, casper.evaluator],
    });

    assert.equal(outcome.verdict?.exemplarIds.length, 2, 'no configPath supplied -> default k=5 -> both entries returned');
  });
});

/** Captures everything written to `process.stderr` for the duration of `fn` (mirrors `tests/calibration/exemplar-injection.test.ts`'s helper). */
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

describe('runHook — corrupt corpus degrades to zero exemplars end-to-end, never forces a deny (D4 integration, spec scenario: corrupt corpus degrades to zero exemplars)', () => {
  test('a corrupt corpus file flows through runHook to EMPTY_SELECTION-shaped verdict fields + warn log, while evaluators still vote normally (allow, not forced deny)', async () => {
    const dir = tmpAuditDir();
    const auditSink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    // A corrupt corpus: a directory containing one malformed JSON entry file
    // and nothing else. `CalibrationCorpus.list()` skips the unparseable
    // file (per-file isolation, `JSON.parse` failure caught internally) and
    // returns an empty entry list — this is architecturally distinct from an
    // evaluator's own fail-closed-to-deny transport-error catch (see
    // `src/calibration/exemplar-injection.ts`'s doc comment).
    const corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magi-hook-corrupt-corpus-'));
    fs.writeFileSync(path.join(corpusDir, `${'c'.repeat(64)}.json`), '{ this is not valid json', 'utf8');
    const corpus = new CountingCalibrationCorpus(corpusDir);

    // All 3 evaluators vote allow: if the corpus-read failure forced a deny
    // (fail-closed) rather than merely degrading to zero exemplars, the
    // resulting decision would be deny regardless of these votes. Asserting
    // an allow decision here proves the evaluators cast their OWN, genuine
    // votes from actual model-call logic (via injected test doubles), never
    // a vote manufactured by the corpus-read failure itself.
    const melchior = exemplarCapturingEvaluator('melchior');
    const balthasar = exemplarCapturingEvaluator('balthasar');
    const casper = exemplarCapturingEvaluator('casper');

    const action = normalizeToProposedAction(
      { tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } },
      'shadow',
    );

    let outcome: Awaited<ReturnType<typeof runHook>> | undefined;
    const stderr = await captureStderr(async () => {
      outcome = await runHook(action, {
        auditSink,
        now,
        corpus,
        evaluators: [melchior.evaluator, balthasar.evaluator, casper.evaluator],
      });
    });

    assert.equal(corpus.calls, 1, 'the corrupt corpus is still read exactly once (the skip happens inside that one call)');

    // (a) resolveExemplarSelection returned an empty selection: every
    // evaluator received exemplars:[] (the same shared selection, per spec
    // Requirement: Single Shared Exemplar Selection Per Action).
    assert.deepEqual(melchior.captured[0], []);
    assert.deepEqual(balthasar.captured[0], []);
    assert.deepEqual(casper.captured[0], []);

    // (b) a warn-level log occurred (the corrupt-entry-skip path, NOT the
    // silent empty-but-valid-corpus path — see the exemplar-injection.test.ts
    // "distinguishing empty corpus from failed read" tests).
    assert.match(stderr, /calibration entry unreadable, skipping/i);

    // The resulting verdict's calibrationCorpusHash/exemplarIds reflect the
    // same EMPTY_SELECTION-shaped degraded selection as a genuinely empty
    // (but valid) corpus would produce.
    assert.deepEqual(outcome?.verdict?.exemplarIds, []);
    assert.equal(outcome?.verdict?.calibrationCorpusHash, '');
    assert.equal(
      outcome?.verdict?.corpusDegraded,
      true,
      'a corrupt-entry-skip must be flagged degraded, unlike a genuinely empty corpus (D3.1: audit trail must distinguish the two)',
    );

    // (c) the evaluators still produced a normal, non-forced-deny vote: a
    // real allow decision from the evaluators' own vote logic, not a deny
    // manufactured by the corpus-read failure.
    assert.equal(outcome?.verdict?.decision, 'allow', 'the corpus-read failure must never force a deny vote');
    assert.equal(outcome?.allow, true);
  });
});

interface HookSpecificOutputJson {
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
}

function parseHookStdout(stdout: string): HookSpecificOutputJson {
  return JSON.parse(stdout.trim().split('\n')[0] ?? '{}') as HookSpecificOutputJson;
}

describe('claude-code-hook binary — stdin/stdout/exit-code contract (spawned process)', () => {
  test('a trivial Bash command is allowed via the hookSpecificOutput contract and exit code 0', () => {
    const result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git log' } }),
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, MAGI_MODE: 'shadow' },
      timeout: 15000,
    });

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const parsed = parseHookStdout(result.stdout);
    assert.equal(parsed.hookSpecificOutput?.hookEventName, 'PreToolUse');
    assert.equal(parsed.hookSpecificOutput?.permissionDecision, 'allow');
  });

  test('malformed stdin JSON still allows (fail-open, even on adapter-side errors), exit code 0', () => {
    const result = spawnSync(process.execPath, [hookPath], {
      input: 'not valid json {{{',
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, MAGI_MODE: 'shadow' },
      timeout: 15000,
    });

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const parsed = parseHookStdout(result.stdout);
    assert.equal(parsed.hookSpecificOutput?.permissionDecision, 'allow');
  });

  test('MAGI_MODE=enforced + a deny verdict blocks via permissionDecision:"deny", exit code 0', () => {
    const dir = tmpAuditDir();
    // Deliberately strip ANTHROPIC_API_KEY so all three real evaluators fail
    // fast and deterministically to `deny` (fail-closed, per
    // src/gating/anthropic-evaluator.ts) with no network call required —
    // this makes the deny verdict reproducible without a real API key. A
    // dedicated tmp `cwd` keeps the resulting audit write out of the repo's
    // own `.magi/audit/` directory.
    const { ANTHROPIC_API_KEY: _unusedApiKey, ...envWithoutApiKey } = process.env;
    const env = { ...envWithoutApiKey, MAGI_MODE: 'enforced' };

    const result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } }),
      cwd: dir,
      encoding: 'utf8',
      env,
      timeout: 15000,
    });

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const parsed = parseHookStdout(result.stdout);
    assert.equal(parsed.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(parsed.hookSpecificOutput?.permissionDecisionReason ?? '', /BLOCKED/);
    assert.match(parsed.hookSpecificOutput?.permissionDecisionReason ?? '', /magi audit override/);
  });

  test('MAGI_MODE unset defaults to shadow — a deny-verdict scenario is still allowed, exit code 0', () => {
    const dir = tmpAuditDir();
    // Same fail-closed-to-deny setup as the enforced-mode test above (strip
    // ANTHROPIC_API_KEY so all three real evaluators deny deterministically),
    // but this time MAGI_MODE itself is deleted from the child env entirely
    // (not set to 'shadow' — genuinely absent) to prove resolveMode() falls
    // through to 'shadow' by default and shadow mode never blocks, even on
    // a deny verdict.
    const { ANTHROPIC_API_KEY: _unusedApiKey, MAGI_MODE: _unusedMode, ...envWithoutModeOrApiKey } = process.env;

    const result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } }),
      cwd: dir,
      encoding: 'utf8',
      env: envWithoutModeOrApiKey,
      timeout: 15000,
    });

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const parsed = parseHookStdout(result.stdout);
    assert.equal(parsed.hookSpecificOutput?.permissionDecision, 'allow');
  });
});
