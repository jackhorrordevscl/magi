# Tasks: Gemini Evaluator Backend

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~230 (`gemini-evaluator.ts`) + ~230 (`gemini-evaluator.test.ts`) + ~30 (`MANUAL.md`) ≈ 490 total |
| 400-line budget risk | High (aggregate exceeds 400; each PR individually stays under budget) |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (full `GeminiEvaluator` production class: constants/interfaces/`FetchGeminiClient`/`castVote`/`extractVote`, plus request-shape + auth/URL + conforming-response + identity tests) -> PR 2 (fail-closed/non-conforming test matrix + `MANUAL.md` section 4 doc + full-suite regression) |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High (aggregate) / Low (per PR)

**Single-PR alternative considered and rejected**: only 2 core files are touched, which could argue for `size:exception`. Rejected because the aggregate estimate (~490) clears the 400-line budget by a non-marginal ~22%, and the production class is already fully functional and merge-safe at the end of PR 1 — the split moves only test coverage and docs into PR 2, so PR 1 is never a half-working evaluator on `main`. This avoids the awkwardness of splitting a single class's logic across PRs while still respecting the budget.

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Constants/interfaces/`FetchGeminiClient`/`GeminiEvaluator` class (`castVote`, `extractVote`, `denyVote`, prompt builders) | PR 1 | `npm test -- tests/gating/gemini-evaluator.test.ts -t "conforming\|identity\|URL\|auth"` | N/A — pure unit tests over a fake `GeminiClient` and stubbed `fetch` | `git revert` removes `src/gating/gemini-evaluator.ts` entirely; nothing imports it |
| 2 | Fail-closed/non-conforming test matrix (no-call, wrong-name, malformed-args, timeout, transport error, no-repair-on-late-allow) | PR 2 | `npm test -- tests/gating/gemini-evaluator.test.ts -t "deny\|timeout\|fail-closed"` | N/A — pure unit tests, no network/key | Revert the added `describe` blocks; PR 1's production file and its own tests stay valid standalone |
| 3 | `MANUAL.md` section 4 doc (sibling to "Volver a Anthropic") + full-suite regression | PR 2 | `npm test` (full suite) | `npm run typecheck && npm test` | Doc-only revert; no production code touched |

## Phase 1: Foundation — Constants, Types, Client Interface (PR 1)

- [x] 1.1 Create `src/gating/gemini-evaluator.ts`. Add module-level defaults: `DEFAULT_MODEL = 'gemini-2.5-flash-lite'`, `DEFAULT_TIMEOUT_MS = 2500`, `DEFAULT_MAX_TOKENS = 512`, `DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com'`, `CAST_VOTE_TOOL_NAME = 'cast_vote'`.
- [x] 1.2 Add `CastVoteInputSchema` (zod: `vote: VoteDecisionSchema`, `rationale: z.string().min(1)`, imported from `./consensus.ts`) and `CAST_VOTE_DECLARATION` (Gemini `functionDeclarations` shape: `name`, `description`, `parameters` with `vote` enum `['allow','deny','abstain']` and required `rationale`).
- [x] 1.3 Add `GeminiGenerateContentRequest`/`GeminiGenerateContentResponse` interfaces exactly as specified in design.md (`contents`, `systemInstruction`, `tools: [{functionDeclarations:[...]}]`, `toolConfig.functionCallingConfig.mode: 'ANY'`, `generationConfig.maxOutputTokens`; response `candidates[].content.parts[].functionCall.{name, args: unknown}`).
- [x] 1.4 Add `export interface GeminiClient { create(body, options?: {signal?}): Promise<GeminiGenerateContentResponse> }` and `export interface GeminiEvaluatorOptions { client?, apiKey?, model?, timeoutMs?, maxTokens?, baseUrl? }`, with a doc comment on `baseUrl` noting it is a **base path**, not a complete endpoint (diverges from `GroqEvaluatorOptions.baseUrl`).

## Phase 2: Core Implementation — Client + castVote/extractVote (PR 1)

- [x] 2.1 Implement `class FetchGeminiClient implements GeminiClient`: constructor takes `apiKey`/`baseUrl`/`model`; `create()` POSTs to `${baseUrl}/v1beta/models/${model}:generateContent` with headers `content-type: application/json` and `x-goog-api-key: ${apiKey ?? ''}` — **no `Authorization` header**; throws on `!response.ok`. *(Requirements: Auth Header, Base URL and Model Interpolation)*
- [x] 2.2 Implement `export class GeminiEvaluator implements EvaluatorPort`: fields `name`, `facet`, `client`, `model`, `timeoutMs`, `maxTokens` assigned explicitly in the constructor body (no parameter-property shorthand, mirrors `GroqEvaluator`); `client` defaults to `new FetchGeminiClient(...)` reading `options.apiKey ?? process.env.GEMINI_API_KEY`. **No model-ID validation at construction.** *(Requirements: No Model ID Validation, EvaluatorPort Conformance)*
- [x] 2.3 Implement `castVote(action, severity)`: `AbortController` with `setTimeout(timeoutMs)`, calls `client.create({contents, systemInstruction, tools:[{functionDeclarations:[CAST_VOTE_DECLARATION]}], toolConfig:{functionCallingConfig:{mode:'ANY'}}, generationConfig:{maxOutputTokens}}, {signal})`, catches any throw/abort into `denyVote`. *(Requirement: Gemini Request Shape, Fail-Closed on Transport Failure and Timeout)*
- [x] 2.4 Implement `private extractVote(response)`: find `candidates?.[0]?.content?.parts?.find(p => p.functionCall)`; absent or `name !== 'cast_vote'` → `denyVote('missing tool call')`; else `CastVoteInputSchema.safeParse(part.functionCall.args)` directly on the already-parsed object — **no `JSON.parse` anywhere in this path**; `!success` → `denyVote('schema validation failed')`; success → `{evaluator: this.name, vote, rationale}`. *(Requirements: Vote Extraction From Parsed Args, Fail-Closed on Missing or Non-Conforming Tool Call)*
- [x] 2.5 Implement `private denyVote(rationale)` and `buildSystemPrompt`/`buildUserPrompt` (adapt Groq's action/severity formatting verbatim — no behavior divergence intended here).

## Phase 3a: Tests — Conforming, Request Shape, Auth/URL, Identity (PR 1)

- [x] 3.1 In `tests/gating/gemini-evaluator.test.ts`, add `describe('GeminiEvaluator — conforming responses')`: well-formed `functionCall` with `args: {vote:'allow', rationale:'looks safe'}` yields matching `Vote`, single client call.
- [x] 3.2 Add a test asserting `tools[0].functionDeclarations[0].name === 'cast_vote'` and `toolConfig.functionCallingConfig.mode === 'ANY'` on the captured request body (mirrors Groq's `tool_choice` test). *(Requirement: Gemini Request Shape)*
- [x] 3.3 Add a test passing an `AbortSignal` through to the client call (mirrors Groq).
- [x] 3.4 Add `describe('GeminiEvaluator — auth and URL')` with a stubbed `globalThis.fetch`: default client request URL ends with `/v1beta/models/gemini-2.5-flash-lite:generateContent`, headers include `x-goog-api-key` and omit `Authorization`. *(Requirements: Auth Header, Base URL and Model Interpolation)*
- [x] 3.5 Add `describe('GeminiEvaluator — evaluator identity')`: `name` reflects the constructor argument (mirrors Groq).
- [x] 3.6 Add a construction-time test: `new GeminiEvaluator('melchior', facet, {model: 'not-a-real-model'})` does not throw. *(Requirement: No Model ID Validation)*

## Phase 3b: Tests — Fail-Closed / Non-Conforming Matrix (PR 2)

- [x] 3.7 Add `describe('GeminiEvaluator — non-conforming output is denied, never repaired/retried')`: no `functionCall` part → `deny`; wrong `functionCall.name` → `deny`; `args` missing `rationale` → `deny`; `args.vote` outside the enum → `deny`; empty-string `rationale` → `deny` — each asserts exactly one client call. *(Requirements: Vote Extraction From Parsed Args — malformed-args scenario, Fail-Closed on Missing or Non-Conforming Tool Call)*
- [x] 3.8 Add `describe('GeminiEvaluator — fail-closed on timeout/error/non-2xx, never allow')`: client throws/rejects → `deny`; non-2xx surfaced as thrown error (e.g. `429`) → `deny` with rationale mentioning the status; client never resolves before the abort fires → `deny` within a short bound; a late resolve after timeout with `vote:'allow'` is never repaired into `allow`. *(Requirement: Fail-Closed on Transport Failure and Timeout)*
- [x] 3.9 Add a drop-in construction test: `new GeminiEvaluator('balthasar', BALTHASAR_FACET, {apiKey:'test-key'})` type-checks and runs as `EvaluatorPort` with no error. *(Requirement: EvaluatorPort Conformance)*

## Phase 4: Documentation (PR 2)

- [x] 4.1 In `MANUAL.md`, add a new `###` subsection sibling to "Volver a Anthropic" (after it, before "Lo que NO existe todavía", section 4, current line ~127) documenting manual `GeminiEvaluator` construction: import path, `GeminiEvaluatorOptions` shape, `GEMINI_API_KEY` env var, default model `gemini-2.5-flash-lite`, and how to pass it into `RunHookOptions.evaluators`/`MainDeps.evaluators` — same Spanish register as the surrounding section.
- [x] 4.2 In the same subsection, add a brief caveat that free-tier Gemini prompts may be used for training, so operators choosing this backend opt in knowingly (no pricing/cost comparison table — explicitly out of scope).

## Phase 5: Cross-Cutting Verification (PR 2)

- [x] 5.1 Confirm `package.json` `dependencies` are unchanged (`zod`, `@anthropic-ai/sdk` only) — no `@google/generative-ai` added.
- [x] 5.2 Confirm `melchior.ts`, `balthasar.ts`, `casper.ts` are untouched and still resolve to `GroqEvaluator` (no diff in these files).
- [x] 5.3 Run `npm run typecheck && npm test` end to end; confirm zero regressions across the existing suite.

## Result Contract

- `status`: `done` — 21/21 tasks complete across both PR 1 and PR 2.
- `executive_summary`: 21 ordered, dependency-sequenced tasks across 5 phases (foundation, core implementation, split test coverage, documentation, verification) implementing `GeminiEvaluator` as a third `EvaluatorPort` backend, chained across 2 PRs (~320 + ~170 lines) to stay under the 400-line budget per PR. Both PRs are now applied.
- `artifacts`: `openspec/changes/magi-multi-provider-evaluators/tasks.md`, `src/gating/gemini-evaluator.ts`, `tests/gating/gemini-evaluator.test.ts`, `MANUAL.md`, Engram `sdd/magi-multi-provider-evaluators/tasks`, `sdd/magi-multi-provider-evaluators/apply-progress`
- `next_recommended`: `sdd-verify`
- `risks`: (1) The `melchior`/`balthasar`/`casper` wiring is deliberately never touched by any task — the entire change is unreachable except via manual construction or DI override (`RunHookOptions.evaluators`/`MainDeps.evaluators`), matching design decision 6; confirmed untouched after PR 2 (`git diff` empty for all three files). (2) `systemInstruction` support on Gemini's `v1beta generateContent` is an open question in design.md, never exercised against a live call in either PR — no code changes anticipated, all tests use fake/stubbed clients. (3) `npm test` full-suite run (PR 2, Phase 5.3) surfaced one pre-existing failure in `tests/cli/audit-override.test.ts` ("the original record is unchanged after a successful override") — reproduces identically in complete isolation with zero Gemini files loaded, confirming it predates and is unrelated to this change; not fixed here as out of scope.

## Key Learnings

1. Gemini's `functionCall.args` arrives already parsed, so `extractVote` has one fewer failure branch than Groq's (no `JSON.parse` try/catch) and the "invalid JSON" case is replaced by a malformed-args-object case caught by `CastVoteInputSchema.safeParse`.
2. `GeminiEvaluatorOptions.baseUrl` is a base path with the model interpolated into the URL (`{baseUrl}/v1beta/models/{model}:generateContent`), diverging from `GroqEvaluatorOptions.baseUrl`, which is a complete endpoint.
3. Splitting a single self-contained class across PRs is safer when done by test/doc coverage (PR 2) rather than by production logic (PR 1 ships the whole class), avoiding a half-functional evaluator ever landing on `main`.
4. Design decision 6 (verified against the code, not assumed) confirms no env-var or config-driven backend switch exists today — Gemini becomes reachable only through the same manual-construction/DI seam Groq-vs-Anthropic already uses.
5. The aggregate ~490-line estimate clears the 400-line review budget by roughly 22%, justifying a 2-PR chain over a `size:exception` single PR despite the change touching only 2 core files.
