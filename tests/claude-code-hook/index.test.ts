import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { runHook, normalizeToProposedAction, buildBlockReason, capReason } from '../../claude-code-hook/index.ts';
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
