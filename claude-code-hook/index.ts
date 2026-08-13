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
import type { AuditRecord } from '../src/audit/record.ts';
import type { AuditSink } from '../src/audit/audit-sink.ts';
import type { EvaluatorPort } from '../src/gating/evaluator-port.ts';
import type { Vote } from '../src/gating/consensus.ts';
import type { MagiMode, ProposedAction } from '../src/gating/proposed-action.ts';
import type { Verdict } from '../src/gating/verdict.ts';

/**
 * Claude Code `PreToolUse` hook adapter — resolves `mode` from `MAGI_MODE`
 * (`shadow` or `enforced`, see `resolveMode` below) and actually enforces a
 * `deny` verdict once `mode === 'enforced'` (per `sdd/magi-p3-enforcing-
 * override/design`, decisions #1/#2/#6/#7).
 *
 * Pipeline order (per `sdd/magi/tasks` Phase 9): trivial-scope allowlist
 * short-circuit -> severity classification -> evaluators in parallel ->
 * consensus/verdict assembly -> durable audit sink append -> enforcing-mode
 * gate.
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
   * `false` only when `action.mode === 'enforced'` AND the computed
   * verdict's `decision === 'deny'` — every other combination (shadow mode,
   * any allow verdict, or the trivial short-circuit) allows. See design
   * decision #6 (failure asymmetry): an evaluator `abstain` folding into a
   * consensus `deny` DOES block under enforcement (fail-closed — a real
   * signal), while an adapter-side exception never reaches this function at
   * all and is handled as fail-open in `main()` below.
   */
  allow: boolean;
  /** True when the action was resolved via the trivial-scope allowlist short-circuit — evaluators/audit were never invoked. */
  trivial: boolean;
  /** The full computed verdict, or `null` when the trivial short-circuit applied (no verdict is computed for trivial actions). */
  verdict: Verdict | null;
  /** The audit record `auditSink.append()` returned, or `null` when the trivial short-circuit applied (no record is ever written for trivial actions). Supplies the hash the block reason and the `magi audit override` hint need. */
  record: AuditRecord | null;
}

/**
 * Runs the full MAGI gating pipeline for one proposed action: trivial-scope
 * allowlist short-circuit -> severity classification -> evaluators
 * (parallel, via `collectVotes`) -> consensus/verdict assembly -> durable
 * audit sink append -> enforcing-mode gate.
 *
 * The verdict is ALWAYS durably recorded to the audit sink FIRST,
 * regardless of mode — `auditSink.append()` is awaited-through (it is
 * itself synchronous and already durable-before-return, per
 * `src/audit/fs-append-sink.ts`) before this function resolves. Only AFTER
 * that durable write does this function compute `allow` from `action.mode`
 * + `verdict.decision` (design decision #2: mode is read once by `main()`
 * and threaded through on `ProposedAction`, so `runHook` itself stays pure
 * and table-testable). See `tests/claude-code-hook/index.test.ts` for the
 * RED tests proving these properties independently.
 */
export async function runHook(action: ProposedAction, options: RunHookOptions = {}): Promise<HookOutcome> {
  if (isTrivial(action)) {
    return { allow: true, trivial: true, verdict: null, record: null };
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
  // before this function's promise resolves. This happens unconditionally,
  // in both modes — enforcing mode changes what `main()` tells Claude Code,
  // never whether the action gets audited.
  const record = auditSink.append(verdict, now);

  const allow = !(action.mode === 'enforced' && verdict.decision === 'deny');

  return { allow, trivial: false, verdict, record };
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

/** `permissionDecisionReason` values are capped at this length before being written to stdout (see the Interfaces/Contracts section of `sdd/magi-p3-enforcing-override/design`). */
const MAX_REASON_LENGTH = 10_000;

/**
 * Caps `reason` at `MAX_REASON_LENGTH` characters. Truncation always drops
 * from the END of the string, never the start — `buildBlockReason` puts its
 * header (BLOCKED line, action, audit hash, override hint) FIRST specifically
 * so those fields survive truncation even when the evaluator rationales that
 * follow are long enough to be cut off.
 */
export function capReason(reason: string): string {
  return reason.length > MAX_REASON_LENGTH ? reason.slice(0, MAX_REASON_LENGTH) : reason;
}

/**
 * Emits Claude Code's documented `PreToolUse` hook output contract — for
 * BOTH `allow` and `deny` (design decision #1: this replaces the previous
 * non-contractual `{decision:'allow',reason}` shape outright, it is not kept
 * as a second shape). Exit code is never derived from `decision` — see
 * `main()` and design decision #7 (JSON is the sole authority; exit code
 * always stays `0`).
 */
function writeHookOutput(decision: 'allow' | 'deny', reason: string): void {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: capReason(reason),
      },
    })}\n`,
  );
}

function formatVoteLine(vote: Vote | undefined): string {
  if (!vote) return '';
  return `${vote.evaluator.toUpperCase()} — ${vote.vote}: ${vote.rationale}`;
}

/**
 * Assembles the block reason for an enforcing-mode deny, per spec
 * Requirement: Block Includes Full Evaluator Rationale — the reason MUST
 * include each evaluator's individual verdict and rationale, not just an
 * aggregate decision and pointer. The header line comes first (design's
 * fixed template) so the audit hash and override hint always survive
 * `capReason`'s truncation even when the rationales below are long.
 */
export function buildBlockReason(action: string, hash: string, verdict: Verdict): string {
  const findVote = (name: Vote['evaluator']): Vote | undefined =>
    verdict.votes.find((v) => v.evaluator === name);

  const lines = [
    `magi: BLOCKED — consensus deny (severity: ${verdict.severity})`,
    `Action: ${action}   Audit: ${hash}`,
    `Override: magi audit override ${hash} --reason "<why>"`,
    '',
    formatVoteLine(findVote('melchior')),
    formatVoteLine(findVote('balthasar')),
    formatVoteLine(findVote('casper')),
  ];
  return lines.join('\n');
}

/**
 * The real `PreToolUse` hook entrypoint: reads the hook payload from
 * stdin, runs the gating pipeline, and prints the documented
 * `hookSpecificOutput` contract — `deny` only when `mode === 'enforced'`
 * and the verdict is `deny`, `allow` otherwise. Returns the process exit
 * code (always `0`, per design decision #7 — JSON is the sole authority)
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
    // A malformed hook payload is OUR OWN adapter-side problem — an adapter
    // exception is always fail-open (design decision #6), regardless of
    // mode. It never reaches the mode/decision gate in `runHook`.
    writeHookOutput('allow', `magi: malformed hook input, allowed (fail-open): ${describeError(error)}`);
    return 0;
  }

  try {
    const mode = resolveMode();
    const action = normalizeToProposedAction(hookInput, mode);
    const outcome = await runHook(action);

    if (outcome.trivial) {
      writeHookOutput('allow', 'magi: trivial-scope allowlisted, not gated');
      return 0;
    }

    const verdict = outcome.verdict;
    if (!verdict) {
      // Defensive only: every non-trivial outcome carries a verdict by
      // construction (see `runHook`) — this branch should be unreachable.
      // Fail-open rather than ever throwing a block from an inconsistent
      // internal state.
      writeHookOutput('allow', 'magi: internal error, allowed (fail-open): missing verdict');
      return 0;
    }

    if (!outcome.allow) {
      const hash = outcome.record?.hash ?? 'unknown';
      writeHookOutput('deny', buildBlockReason(verdict.action, hash, verdict));
      return 0;
    }

    const reason =
      mode === 'enforced'
        ? `magi: verdict "${verdict.decision}" recorded, action allowed`
        : `magi: shadow mode — verdict "${verdict.decision}" recorded, action allowed`;
    writeHookOutput('allow', reason);
    return 0;
  } catch (error) {
    // Even a genuine internal failure (e.g. audit sink write error) must
    // never block Claude Code — an adapter-side exception is always
    // fail-open (design decision #6), regardless of mode. Surface the
    // failure on stderr for operator visibility.
    process.stderr.write(`magi: internal error, allowed (fail-open): ${describeError(error)}\n`);
    writeHookOutput('allow', 'magi: internal error, allowed (fail-open)');
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
      process.stderr.write(`magi: unhandled internal error, allowed (fail-open): ${describeError(error)}\n`);
      writeHookOutput('allow', 'magi: unhandled internal error, allowed (fail-open)');
      process.exit(0);
    });
}
