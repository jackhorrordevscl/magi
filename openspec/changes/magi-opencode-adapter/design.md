# Design: OpenCode Adapter

## Technical Approach

`opencode-adapter/index.ts` is a peer entrypoint to `claude-code-hook/index.ts`, with the same two-layer split: pure, unit-testable normalization plus a thin client-shaped export. `runHook` is called verbatim — a diff inside `src/gating/**`, `src/audit/**`, `src/calibration/**`, or `claude-code-hook/index.ts` invalidates this design.

Four things are genuinely new: OpenCode's `tool.execute.before` payload → `ProposedAction`; OpenCode's lowercase tool vocabulary → synthetic command; deny communicated by `throw`; and filesystem roots anchored on the plugin's project directory, because a plugin is long-lived in-process (the hook is a one-shot process that inherits the project cwd — this is the process-model divergence the proposal named).

## Architecture Decisions

| # | Decision | Chosen | Rejected | Rationale |
|---|---|---|---|---|
| 1 | Plugin loading | Operator writes a 1-line shim in `.opencode/plugin/magi.ts` re-exporting from an absolute path into the MAGI checkout | Bundled `dist/magi-opencode-plugin.mjs`; npm publish | Mirrors the hook's existing absolute-path registration. Module resolution stays rooted in MAGI's own `node_modules`, so `@anthropic-ai/sdk`/`zod` resolve. A bundle relocated into the operator's repo cannot resolve externalized deps. npm is out of scope (operator decision, obs #1098.3) |
| 2 | Deny mechanism | Plain `throw new Error(reason)`, thrown **outside** the try/catch | Throw inside the guarded block; custom `Error` subclass | Throwing inside means the fail-open `catch` swallows every block — a silent, total gate failure. A subclass risks OpenCode serializing only `name`/`message` inconsistently |
| 3 | Block reason text | Adapter owns its own builder; a cross-adapter **parity test** asserts byte-equality against the hook's `buildBlockReason` for a fixture verdict | Import `buildBlockReason` from the hook; move it to `src/` | Import violates "neither adapter imports the other" and drags the hook's `import.meta.url` entrypoint guard into a live plugin. Moving it forces a `claude-code-hook` diff. The parity test converts the accepted drift risk into a failing test |
| 4 | Reason length | No cap; header-first ordering kept | Reuse `capReason`'s 10 000 chars | That cap is a documented *Claude Code* contract, not a fact about OpenCode. Header-first ordering already protects hash + override hint under any truncation OpenCode applies |
| 5 | Filesystem roots | Anchor audit dir, corpus dir, and `configPath` on the plugin's project directory via existing seams (`auditSink`, `corpus`, `configPath`, and both constructors' `dir` args) | Rely on `process.cwd()` | A long-lived server's cwd is not guaranteed to be the project; unanchored, the audit chain silently lands in an unrelated repo. Existing seams make this a zero-`src/`-diff change |

**Smaller, fixed:** mode resolved per invocation (`MagiModeSchema.safeParse(process.env.MAGI_MODE)`, default `shadow`); exactly **one** named export (a second export registers the plugin twice → double evaluation, double audit record); tool-arg readers are tolerant (`filePath || file_path || path`) so an unconfirmed arg name degrades to the generic non-trivial path, never to a wrong allow.

## Data Flow

    tool.execute.before(input{tool,sessionID,callID}, output{args})
        │
        ├─ resolveMode()  ── MAGI_MODE ─→ shadow|enforced
        ├─ synthesizeCommand(tool, args)   [OpenCode tool map]
        ├─ normalizeToProposedAction ─→ ProposedAction{source:'coding_agent'}
        │
        └─ runHook(action, {auditSink, corpus, configPath})   ← UNCHANGED
              isTrivial → severity → exemplars → 3 evaluators → verdict → audit append
                                                                   │
                    outcome.allow ? return : ─→ throw Error(blockReason)
                                                     (outside try/catch)

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `opencode-adapter/index.ts` | Create | Tool map, normalization, block-reason builder, plugin export |
| `tests/opencode-adapter/index.test.ts` | Create | Mirrors `tests/claude-code-hook/index.test.ts` + parity test |
| `MANUAL.md` | Modify | OpenCode registration section (**Spanish** — MANUAL.md's context language) |
| `openspec/specs/enforcing-mode-gate/spec.md` | Modify (delta) | Generalize Claude-Code-literal wording to "a gating adapter" |
| `package.json` | Modify | `@opencode-ai/plugin` as a **devDependency**; no runtime dep, not in `dist/magi.mjs` |
| `esbuild.config.mjs` | Unchanged | No bundle entry in v1 (decision 1) |

## Interfaces / Contracts

```typescript
// The load-bearing structure: the block throw MUST sit outside the guard.
export const MagiGate: Plugin = async ({ directory }) => ({
  'tool.execute.before': async (input, output) => {
    let block: string | null = null;
    try {
      block = await gateToolCall(input, output.args, directory);
    } catch (error) {
      process.stderr.write(`magi: internal error, allowed (fail-open): ${describeError(error)}\n`);
      return; // adapter-side failure ALWAYS allows
    }
    if (block) throw new Error(block); // enforced deny — never swallowed
  },
});
```

Tool map (trivial-reachable): `read`→`cat <filePath>`, `grep`→`grep <pattern> <path|.>`, `glob`→`find <path|.> -name <pattern>`, `list`→`find <path|.>`, `bash`→`command` verbatim. Everything else → `<tool> <target>`, never trivial.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | Normalization table: every mapped tool → exact synthetic command; unknown tool → non-trivial | Table test on the pure function |
| Unit | Tolerant arg readers: missing/renamed arg degrades to non-trivial, never to trivial | Fixture with `file_path`, `filePath`, and neither |
| Unit | enforced+deny throws with severity, 3 rationales, hash, override hint; shadow+deny returns | Stub evaluators + in-memory sink via `runHook` seams |
| Unit | Fail-open: throwing sink / throwing evaluator / malformed args → handler returns, no throw | Injected failures |
| Unit | Trivial short-circuit does zero evaluator calls and zero audit writes | Spy sink + spy evaluators |
| Parity | Adapter block reason === `buildBlockReason` output for one fixture verdict | Test-only import of both |
| Integration | Anchoring: cwd ≠ project dir still writes to `<directory>/.magi/audit` | Temp dirs, `process.chdir` |
| Manual (gate) | Plugin loads; thrown message surfaces verbatim; subagent interception | Real OpenCode install — see Open Questions |

## Threat Matrix

| Boundary | Applicability | Design response | Planned RED tests |
|---|---|---|---|
| Documentation-like paths | N/A — the adapter never classifies files as executable; severity classification is unchanged | — | — |
| Git repository selection | **Applicable** — `directory` vs `process.cwd()` is a repository-authority choice, and `bash` args (`git -C`, relative/absolute paths) pass through verbatim | Anchor all fs roots on `directory` (decision 5); never re-parse or rewrite git arguments — the unchanged classifier owns them | Anchoring test above; a `git -C /other push --force` fixture reaching `classify()` byte-identically |
| Commit state | N/A — the adapter performs no VCS automation | — | — |
| Push state | N/A — same | — | — |
| PR commands | N/A — the adapter composes no commands; it only forwards a string | — | — |

## Migration / Rollout

No migration. Purely additive: same `AuditRecord` shape, same chain, `source: 'coding_agent'`. Operator-level disable = delete the shim from `.opencode/plugin/`. Rollout is shadow-first, identical to the hook.

## Open Questions

- [ ] **Subagent interception gap (OpenCode #5894) — v1 GATE, unresolved.** Not reproducible in this phase: no shell/network access to a real OpenCode install. Reproduction procedure for apply/verify: `MAGI_MODE=enforced`, run a denied command directly (expect block), then via a `task` subagent (compare). Record observed behavior; if confirmed, document the coverage boundary in MANUAL.md. MUST NOT be silently downgraded to "handled".
- [x] **Plugin directory name — RESOLVED.** Verified empirically against the installed `opencode-ai@1.18.18` CLI (`opencode debug config` in a scratch project): both `.opencode/plugin/` (singular) and `.opencode/plugins/` (plural) are auto-discovered and injected into the resolved `plugin` config array (`plugin_origins[].source` points at the `.opencode` dir, `scope: "local"`). The proposal's plural naming is valid; no MANUAL.md correction needed. Singular is also valid if preferred for consistency with `command/`/`agent/`.
- [x] **`PluginInput` project-dir field name — RESOLVED.** `dist/index.d.ts` (`@opencode-ai/plugin@1.18.18`) confirms `PluginInput` carries both `directory: string` and `worktree: string` as required (non-optional) fields — decision 5's anchor on `directory` needs no fallback. `tool.execute.before` shape also confirmed exactly as assumed: input `{ tool: string; sessionID: string; callID: string }`, output `{ args: any }`. **Still open**: the exact lowercase tool-name vocabulary (`read`/`grep`/`glob`/`list`/`bash`/...) is not in the type package — those are runtime constants in the compiled binary, not exposed via types. Needs a live session (`tool.execute.before` observed at runtime) to confirm at apply time.
- [ ] **Does OpenCode surface a thrown plugin `Error.message` verbatim (multi-line)?** If it truncates or single-lines it, header-first ordering preserves hash + override hint; if it drops the message entirely, decision 2 needs re-opening.
- [ ] **Partial anchoring**: `loadEvaluatorConfig` has no `configPath` seam, so evaluator backend config still resolves against `process.cwd()`. Mitigated by a one-time stderr warning when `process.cwd() !== directory`. A real seam requires an `src/` diff — out of scope here.
- [ ] `todowrite`/`todoread` fire often and are not read-only; measure whether 3 model calls each make OpenCode unusable before adding any mapping.
