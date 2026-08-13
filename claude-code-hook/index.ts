#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { isTrivial } from '../src/gating/allowlist.ts';
import { classify } from '../src/gating/severity.ts';
import { collectVotes } from '../src/gating/evaluator-port.ts';
import { assembleVerdict } from '../src/gating/verdict.ts';
import { melchior } from '../src/gating/melchior.ts';
import { balthasar } from '../src/gating/balthasar.ts';
import { casper } from '../src/gating/casper.ts';
import { FsAppendAuditSink } from '../src/audit/fs-append-sink.ts';
import { MagiModeSchema } from '../src/gating/proposed-action.ts';
import type { AuditSink } from '../src/audit/audit-sink.ts';
import type { EvaluatorPort } from '../src/gating/evaluator-port.ts';
import type { MagiMode, ProposedAction } from '../src/gating/proposed-action.ts';
import type { Verdict } from '../src/gating/verdict.ts';

/**
 * Claude Code `PreToolUse` hook adapter, running in `MAGI_MODE=shadow`
 * (the only mode this PR wires up — see the note on `runHook` below).
 *
 * Pipeline order (per `sdd/magi/tasks` Phase 9): trivial-scope allowlist
 * short-circuit -> severity classification -> evaluators in parallel ->
 * consensus/verdict assembly -> durable audit sink append.
 *
 * This file has two layers, matching the separation already established
 * by `src/audit/verify.ts` and `src/cli/calibrate.ts`:
 *  - `normalizeToProposedAction` / `runHook`: pure(ish), fully unit-testable
 *    library functions with no process/stdio coupling.
 *  - `main()` + the bottom-of-file entrypoint guard: the actual
 *    stdin/stdout/exit-code binary Claude Code invokes as a `PreToolUse`
 *    hook command.
 */

// --- Claude Code hook payload -> ProposedAction normalization -------------

/**
 * Minimal shape of a Claude Code `PreToolUse` hook payload this adapter
 * depends on. The real payload carries additional fields (session_id,
 * transcript_path, cwd, hook_event_name, ...); only the fields this
 * adapter actually reads are declared here, and unknown extra fields are
 * tolerated (not rejected) via the index signature.
 */
export interface ClaudeCodeHookInput {
  session_id?: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
  [key: string]: unknown;
}

function stringField(input: Record<string, unknown>, key: string, fallback = ''): string {
  const value = input[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * Tool names this adapter maps onto the exact read-only executables
 * `src/gating/allowlist.ts` already recognizes as trivial (`cat`, `grep`,
 * `find`). This is what makes the trivial-scope allowlist's short-circuit
 * actually reachable from Claude Code's native tool set — answering the
 * design's own open question #1 ("gating every Read/Grep/Glob via 3 model
 * calls makes the hook unusable") the way the allowlist was built to
 * answer it. Every tool NOT in this map falls through to a generic,
 * conservative synthetic command (see `synthesizeCommand` below) that the
 * allowlist will never recognize as trivial, so it always goes through the
 * full severity/quorum pipeline — the safe default.
 */
const READ_ONLY_COMMAND_TOOLS: Record<string, (input: Record<string, unknown>) => string> = {
  Read: (input) => `cat ${stringField(input, 'file_path')}`.trim(),
  Grep: (input) => `grep ${stringField(input, 'pattern')} ${stringField(input, 'path', '.')}`.trim(),
  Glob: (input) => `find ${stringField(input, 'path', '.')} -name ${stringField(input, 'pattern', '*')}`.trim(),
};

/**
 * Synthesizes a shell-command-like string for the existing (git/shell
 * focused, per the PR1-PR3 threat matrix) severity classifier and trivial
 * allowlist to reason about, for Claude Code tool calls that are not
 * literally shell commands. `Bash` is passed through verbatim since its
 * `tool_input.command` already IS a real shell command.
 */
function synthesizeCommand(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash') return stringField(input, 'command') || toolName;
  const mapper = READ_ONLY_COMMAND_TOOLS[toolName];
  if (mapper) return mapper(input);
  const target =
    stringField(input, 'file_path') ||
    stringField(input, 'path') ||
    stringField(input, 'url') ||
    JSON.stringify(input);
  return `${toolName.toLowerCase()} ${target}`.trim();
}

/**
 * Normalizes a raw Claude Code `PreToolUse` hook payload into a
 * `ProposedAction`, per spec Requirement: ProposedAction Normalization.
 * `mode` is threaded through explicitly (rather than read from `process.env`
 * inside this function) so the normalization itself stays a pure function.
 */
export function normalizeToProposedAction(raw: ClaudeCodeHookInput, mode: MagiMode): ProposedAction {
  const toolName = raw.tool_name || 'unknown_tool';
  const toolInput = raw.tool_input ?? {};
  const command = synthesizeCommand(toolName, toolInput) || toolName;
  const target =
    stringField(toolInput, 'file_path') ||
    stringField(toolInput, 'path') ||
    stringField(toolInput, 'pattern') ||
    command;
  const actor = raw.session_id && raw.session_id.length > 0 ? raw.session_id : 'claude-code-agent';

  return {
    source: 'coding_agent',
    actor,
    actionType: toolName,
    target,
    environment: 'local',
    mode,
    command,
  };
}

// --- Pipeline assembly: allowlist -> severity -> evaluators -> verdict -> audit ---

const DEFAULT_EVALUATORS: readonly [EvaluatorPort, EvaluatorPort, EvaluatorPort] = [melchior, balthasar, casper];

export interface RunHookOptions {
  evaluators?: readonly [EvaluatorPort, EvaluatorPort, EvaluatorPort];
  auditSink?: AuditSink;
  now?: Date;
}

export interface HookOutcome {
  /**
   * Always `true` in this PR: `MAGI_MODE=shadow` never blocks, regardless
   * of the computed verdict's decision. `MAGI_MODE=enforced` is a valid
   * `ProposedAction.mode` value (accepted for forward-compatible audit
   * records), but actually enforcing a `deny` verdict is explicitly out of
   * this PR's scope — deferred to a later PR per `sdd/magi/design`'s P4
   * rollout. See the `runHook` doc comment below.
   */
  allow: true;
  /** True when the action was resolved via the trivial-scope allowlist short-circuit — evaluators/audit were never invoked. */
  trivial: boolean;
  /** The full computed verdict, or `null` when the trivial short-circuit applied (no verdict is computed for trivial actions). */
  verdict: Verdict | null;
}

/**
 * Runs the full MAGI gating pipeline for one proposed action: trivial-scope
 * allowlist short-circuit -> severity classification -> evaluators
 * (parallel, via `collectVotes`) -> consensus/verdict assembly -> durable
 * audit sink append.
 *
 * Per `sdd/magi/tasks` Phase 9 (`MAGI_MODE=shadow` is the only mode this PR
 * wires up): the action is ALWAYS allowed, regardless of the computed
 * verdict's decision. The verdict is nevertheless ALWAYS durably recorded
 * to the audit sink FIRST — `auditSink.append()` is awaited-through (it is
 * itself synchronous and already durable-before-return, per
 * `src/audit/fs-append-sink.ts`) before this function resolves. See
 * `tests/claude-code-hook/index.test.ts` for the RED tests proving both
 * properties independently.
 */
export async function runHook(action: ProposedAction, options: RunHookOptions = {}): Promise<HookOutcome> {
  if (isTrivial(action)) {
    return { allow: true, trivial: true, verdict: null };
  }

  const evaluators = options.evaluators ?? DEFAULT_EVALUATORS;
  const auditSink = options.auditSink ?? new FsAppendAuditSink();
  const now = options.now ?? new Date();

  const severity = classify(action);
  const votes = await collectVotes(evaluators, action, severity);
  const verdict = assembleVerdict(action, severity, votes);

  // Durable audit write BEFORE returning — `FsAppendAuditSink.append()` is
  // itself synchronous (write + fsync complete before it returns), so
  // awaiting nothing further here is what guarantees the record is on disk
  // before this function's promise resolves.
  auditSink.append(verdict, now);

  return { allow: true, trivial: false, verdict };
}

// --- Process-level entrypoint: stdin JSON in, stdout JSON + exit code out ---

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Resolves the operating mode from `MAGI_MODE`, defaulting to `shadow` on
 * anything unset or invalid — never fails closed to a mode this PR doesn't
 * implement enforcement for.
 */
function resolveMode(): MagiMode {
  const parsed = MagiModeSchema.safeParse(process.env.MAGI_MODE);
  return parsed.success ? parsed.data : 'shadow';
}

function writeDecision(reason: string): void {
  process.stdout.write(`${JSON.stringify({ decision: 'allow', reason })}\n`);
}

/**
 * The real `PreToolUse` hook entrypoint: reads the hook payload from
 * stdin, runs the gating pipeline, and always prints an `allow` decision
 * (shadow mode). Returns the process exit code (always `0` in this PR)
 * rather than calling `process.exit` itself, so it stays testable without
 * spawning a process (the spawn-based tests in
 * `tests/claude-code-hook/index.test.ts` additionally prove the real
 * binary's stdin/stdout/exit-code contract end-to-end).
 */
export async function main(): Promise<number> {
  const raw = await readStdin();

  let hookInput: ClaudeCodeHookInput;
  try {
    hookInput = JSON.parse(raw) as ClaudeCodeHookInput;
  } catch (error) {
    // A malformed hook payload is OUR OWN adapter-side problem, not a
    // reason to ever block Claude Code in shadow mode.
    writeDecision(`magi: malformed hook input, allowed (shadow mode): ${describeError(error)}`);
    return 0;
  }

  try {
    const mode = resolveMode();
    const action = normalizeToProposedAction(hookInput, mode);
    const outcome = await runHook(action);

    const reason = outcome.trivial
      ? 'magi: trivial-scope allowlisted, not gated'
      : `magi: shadow mode — verdict "${outcome.verdict?.decision ?? 'unknown'}" recorded, action allowed`;
    writeDecision(reason);
    return 0;
  } catch (error) {
    // Even a genuine internal failure (e.g. audit sink write error) must
    // not block Claude Code in shadow mode — always allow, but surface the
    // failure on stderr for operator visibility.
    process.stderr.write(`magi: internal error, allowed (shadow mode): ${describeError(error)}\n`);
    writeDecision('magi: internal error, allowed (shadow mode)');
    return 0;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`magi: unhandled internal error, allowed (shadow mode): ${describeError(error)}\n`);
      writeDecision('magi: unhandled internal error, allowed (shadow mode)');
      process.exit(0);
    });
}
