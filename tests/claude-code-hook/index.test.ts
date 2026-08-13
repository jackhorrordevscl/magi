import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { runHook, normalizeToProposedAction } from '../../claude-code-hook/index.ts';
import type { ClaudeCodeHookInput } from '../../claude-code-hook/index.ts';
import { FsAppendAuditSink } from '../../src/audit/fs-append-sink.ts';
import type { AuditRecord } from '../../src/audit/record.ts';
import type { EvaluatorPort } from '../../src/gating/evaluator-port.ts';
import type { Vote } from '../../src/gating/consensus.ts';

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
    assert.equal(melchiorSpy.calls.length, 0);
    assert.equal(balthasarSpy.calls.length, 0);
    assert.equal(casperSpy.calls.length, 0);
    assert.deepEqual(readDayFileRecords(dir, now), []);
  });

  test('a trivial git log Bash action short-circuits identically', async () => {
    const dir = tmpAuditDir();
    const auditSink = new FsAppendAuditSink(dir);
    const melchiorSpy = countingEvaluator('melchior', 'allow');
    const now = new Date('2026-08-12T10:00:00.000Z');

    const action = normalizeToProposedAction({ tool_name: 'Bash', tool_input: { command: 'git log' } }, 'shadow');
    const outcome = await runHook(action, {
      auditSink,
      now,
      evaluators: [melchiorSpy.evaluator, melchiorSpy.evaluator, melchiorSpy.evaluator],
    });

    assert.equal(outcome.trivial, true);
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

describe('claude-code-hook binary — stdin/stdout/exit-code contract (spawned process)', () => {
  test('a trivial Bash command is allowed via stdout decision:"allow" and exit code 0', () => {
    const result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git log' } }),
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, MAGI_MODE: 'shadow' },
      timeout: 15000,
    });

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim().split('\n')[0] ?? '{}') as { decision: string };
    assert.equal(parsed.decision, 'allow');
  });

  test('malformed stdin JSON still allows (shadow mode never blocks, even on adapter-side errors)', () => {
    const result = spawnSync(process.execPath, [hookPath], {
      input: 'not valid json {{{',
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, MAGI_MODE: 'shadow' },
      timeout: 15000,
    });

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim().split('\n')[0] ?? '{}') as { decision: string };
    assert.equal(parsed.decision, 'allow');
  });
});
