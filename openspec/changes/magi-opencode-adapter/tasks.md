# Tasks: OpenCode Adapter

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~450-600 (index.ts ~250, tests ~250, MANUAL.md + spec delta + package.json ~80) |
| 400-line budget risk | Medium |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (adapter + tests) → PR 2 (spec delta + docs + package.json) |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | `opencode-adapter/index.ts` + `tests/opencode-adapter/index.test.ts`, fully green | PR 1 | `npm test -- tests/opencode-adapter/index.test.ts` | Real OpenCode install: load plugin, trigger a denied tool call under `MAGI_MODE=enforced`, observe thrown message | Delete `opencode-adapter/` + its test dir |
| 2 | `enforcing-mode-gate` spec delta, `MANUAL.md` section, `package.json` devDependency | PR 2 | `openspec validate magi-opencode-adapter` (or repo's spec lint) | N/A — docs/spec only, no runtime behavior | Revert the delta file, MANUAL.md section, and `package.json` entry |

## Phase 1: Foundation — Types and Tool Map

- [ ] 1.1 Reproduce the subagent interception gap (OpenCode #5894) against a real installed OpenCode: `MAGI_MODE=enforced`, run a denied command directly vs via a `task` subagent; record the observed behavior in `design.md`'s Open Questions before writing any adapter code (proposal Success Criteria, design Open Questions).
- [ ] 1.2 Add `@opencode-ai/plugin` as a devDependency in `package.json` (types-only import, not a runtime dependency, not bundled into `dist/magi.mjs`).
- [ ] 1.3 Create `opencode-adapter/index.ts` skeleton: file header comment mirroring `claude-code-hook/index.ts`'s doc-comment style, imports from `../src/gating/**`, `../src/audit/**`, `../src/calibration/**` unchanged, plus type-only import of `Plugin`/`PluginInput` from `@opencode-ai/plugin`.
- [ ] 1.4 Define `OpenCodeToolExecuteBeforeInput` (`{ tool, sessionID, callID }`) and `OpenCodeToolExecuteBeforeOutput` (`{ args: unknown }`) interfaces in `opencode-adapter/index.ts`, matching the confirmed `@opencode-ai/plugin@1.18.18` shapes (design "Open Questions" resolved item).
- [ ] 1.5 Implement tolerant arg readers (`stringField`-equivalent: `filePath || file_path || path`) mirroring the hook's `stringField` helper, so an unconfirmed arg name degrades to non-trivial, never to a wrong allow (design "Smaller, fixed").
- [ ] 1.6 Implement the OpenCode tool-name → synthetic-command map (`read`→`cat <filePath>`, `grep`→`grep <pattern> <path|.>`, `glob`→`find <path|.> -name <pattern>`, `list`→`find <path|.>`, `bash`→command verbatim; everything else → `<tool> <target>`), scoped inside `opencode-adapter/`, per design "Data Flow" and spec Requirement "OpenCode-Owned Tool-Name Map".

## Phase 2: Normalization (Pure, Unit-Testable Layer)

- [ ] 2.1 Implement `synthesizeCommand(tool, args)` using the Phase 1 tool map, mirroring `claude-code-hook/index.ts`'s `synthesizeCommand` structure.
- [ ] 2.2 Implement `normalizeToProposedAction(raw: OpenCodeToolExecuteBeforeInput, args, mode: MagiMode): ProposedAction` returning `source: 'coding_agent'`, `actor` derived from `sessionID`, `actionType` from `tool`, `command`/`target` from `synthesizeCommand`, `environment: 'local'` — same shape discipline as the hook's `normalizeToProposedAction` (spec Requirement "OpenCode Tool Calls Are Normalized Into ProposedAction").
- [ ] 2.3 Write unit test: normalization table — every mapped tool produces the exact expected synthetic command (`tests/opencode-adapter/index.test.ts`, mirrors hook test's normalization table).
- [ ] 2.4 Write unit test: unmapped tool name falls through to `<tool> <target>` and is never classified trivial (spec Scenario "An unmapped or non-trivial OpenCode tool call reaches full evaluation").
- [ ] 2.5 Write unit test: tolerant arg readers — missing/renamed arg degrades to non-trivial, never to trivial, using fixtures with `file_path`, `filePath`, and neither present.
- [ ] 2.6 Write unit test: `ProposedActionSchema.parse()` accepts every normalized output produced by `normalizeToProposedAction` (spec Scenario "Normalization does not mutate or bypass ProposedActionSchema").

## Phase 3: Gating Pipeline Reuse and Filesystem Anchoring

- [ ] 3.1 Implement `resolveMode()` in `opencode-adapter/index.ts` — `MagiModeSchema.safeParse(process.env.MAGI_MODE)`, default `shadow`, called fresh on every invocation (never cached across the plugin's lifetime), per design "Smaller, fixed" and spec Requirement "Mode Is Resolved Per Invocation".
- [ ] 3.2 Implement `gateToolCall(input, args, directory)`: resolves mode, normalizes to `ProposedAction`, calls `runHook(action, { auditSink: new FsAppendAuditSink(anchored on directory), corpus, configPath })` exactly as-is — no modification to `runHook`'s signature or body (design decision 5, proposal "runHook is called as-is").
- [ ] 3.3 Anchor `FsAppendAuditSink`, corpus dir, and `configPath` on `directory` (from `PluginInput`) rather than `process.cwd()`, using existing constructor `dir` args / seams only (design decision 5).
- [ ] 3.4 Add a one-time stderr warning when `process.cwd() !== directory`, documenting the partial-anchoring gap for `loadEvaluatorConfig` (design Open Questions — evaluator config still resolves against cwd).
- [ ] 3.5 Write integration test: anchoring — with `process.chdir` to a temp dir different from the plugin's `directory`, audit records still land under `<directory>/.magi/audit` (design Testing Strategy "Anchoring").
- [ ] 3.6 Write unit test: trivial short-circuit — a read-only OpenCode tool call makes zero evaluator calls and zero audit writes (spy sink + spy evaluators), matching spec Scenario "A read-only OpenCode tool short-circuits through the trivial allowlist".
- [ ] 3.7 Write unit test: mode resolved per invocation — a running "process" (same module state) resolves `shadow` on one call and `enforced` on the next after `process.env.MAGI_MODE` changes, with no caching (spec Scenario "A mode change takes effect on the next tool call").

## Phase 4: Block Reason and Enforcement

- [ ] 4.1 Implement `buildBlockReason(action, hash, verdict)` in `opencode-adapter/index.ts` — adapter-owned, header-first ordering (hash + override hint before rationales), structurally matching the hook's `buildBlockReason` byte-for-byte for the same fixture verdict (design decision 3).
- [ ] 4.2 Write parity test: adapter's `buildBlockReason` output === hook's `buildBlockReason` output for one fixture verdict, test-only import of both (design Testing Strategy "Parity").
- [ ] 4.3 Implement the plugin export's `tool.execute.before` handler exactly per design's Interfaces/Contracts snippet: `gateToolCall` inside try/catch; on caught error, write to stderr and return (fail-open, never throw); on a non-null block reason, `throw new Error(block)` **outside** the try/catch (design decision 2 — load-bearing structural requirement).
- [ ] 4.4 Write unit test: enforced mode + deny verdict throws an `Error` whose message includes severity, all three evaluator rationales, audit hash, and override hint; tool call does not execute (spec Scenario "Enforced mode blocks a deny verdict by throwing").
- [ ] 4.5 Write unit test: enforced mode + allow verdict returns without throwing (spec Scenario "Enforced mode does not throw on an allow verdict").
- [ ] 4.6 Write unit test: shadow mode + deny verdict returns without throwing, and the deny verdict is still recorded to the audit sink (spec Scenario "Shadow mode never throws, even on a deny verdict").
- [ ] 4.7 Write unit test: consensus deny from evaluator abstention still throws under enforcement — this is a legitimate verdict, not adapter fail-open (spec Scenario "A consensus deny from evaluator abstention still blocks under enforcement").

## Phase 5: Fail-Open Error Handling

- [ ] 5.1 Write unit test: malformed/unparseable OpenCode payload (missing or malformed required fields) — handler catches, returns without throwing, tool call proceeds, error written to stderr (spec Scenario "A malformed OpenCode payload does not block the tool call").
- [ ] 5.2 Write unit test: audit-sink write throws after evaluation completes — handler catches, returns without throwing, tool call proceeds (spec Scenario "An audit-write failure does not block the tool call").
- [ ] 5.3 Write unit test: injected evaluator crash inside `runHook` (not an abstain vote) surfaces as a caught adapter-side exception — handler catches, returns without throwing (design Testing Strategy "Fail-open").
- [ ] 5.4 Verify exactly one named export exists from `opencode-adapter/index.ts` (a second export would register the plugin twice → double evaluation, double audit record) — add a lint/test assertion or code comment enforcing this (design "Smaller, fixed").

## Phase 6: Cross-Chain Audit Verification

- [ ] 6.1 Write integration test: an OpenCode-adapter-produced audit record and a Claude-Code-hook-produced audit record, written to the same `.magi/audit` directory, verify together under `magi audit verify` / the existing verify function, both with `source: 'coding_agent'` (spec Scenario "OpenCode and Claude Code audit records share the same chain").
- [ ] 6.2 Run `git diff` (or equivalent CI check) confirming `src/gating/**`, `src/audit/**`, `src/calibration/**`, and `claude-code-hook/index.ts` have zero changes from this change's implementation (spec Scenario "No gating pipeline file is modified by this capability"; proposal Success Criteria).
- [ ] 6.3 Run the full existing test suite (`npm test`) and confirm every pre-existing test still passes unchanged (proposal Success Criteria).

## Phase 7: Spec Delta and Documentation

- [ ] 7.1 Apply the `enforcing-mode-gate` MODIFIED requirements exactly as drafted in `openspec/changes/magi-opencode-adapter/specs/opencode-adapter/spec.md` to `openspec/specs/enforcing-mode-gate/spec.md` (generalize "the PreToolUse hook adapter" / "Claude Code" wording to "a gating adapter").
- [ ] 7.2 Add the `MANUAL.md` OpenCode registration section (Spanish, matching `MANUAL.md`'s existing context language): `.opencode/plugin/magi.ts` (or `plugins/`, plural) shim re-exporting from an absolute path into the MAGI checkout, per design decision 1.
- [ ] 7.3 Document the subagent interception gap outcome from task 1.1 in `MANUAL.md` (coverage boundary note) if confirmed as a real gap; otherwise note it was investigated and not reproduced.
- [ ] 7.4 Update `openspec/changes/magi-opencode-adapter/design.md` Open Questions checklist to mark resolved items ([x]) based on tasks 1.1 and 4.3's real-OpenCode findings (thrown-message surfacing, tool vocabulary confirmation).

## Key Learnings

1. `opencode-adapter/index.ts` mirrors `claude-code-hook/index.ts`'s exact two-layer split (pure normalization vs thin client export) to keep divergence visible and testable.
2. The block-throw must sit structurally outside the fail-open try/catch, or the adapter's own safety net silently swallows every enforced deny.
3. Filesystem anchoring on `directory` (not `process.cwd()`) is required because an OpenCode plugin is a long-lived in-process server, unlike the Claude Code hook's one-shot process.
4. A cross-adapter parity test on `buildBlockReason` output converts the accepted "two adapters drift" risk into an automatically-failing test instead of silent divergence.
5. Subagent interception (OpenCode #5894) reproduction must happen before adapter code lands, per the proposal's own v1 completion gate.
