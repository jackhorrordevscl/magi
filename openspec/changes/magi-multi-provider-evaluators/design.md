# Design: Gemini Evaluator Backend

## Technical Approach

One new flat file, `src/gating/gemini-evaluator.ts`, structurally parallel to `groq-evaluator.ts`: module-level defaults, a `CAST_VOTE` tool constant, wire-shape interfaces, an injectable client interface, a `Fetch*Client` default implementation, and a `GeminiEvaluator implements EvaluatorPort` class whose `castVote` wraps one client call in an `AbortController` deadline and fail-closes every failure to `deny`. It imports `CalibrationFacet` from `anthropic-evaluator.ts` and `VoteDecisionSchema` from `consensus.ts`, exactly as Groq does. Nothing existing is refactored; `melchior`/`balthasar`/`casper` keep importing `GroqEvaluator`. The public shape of the change is one constructible class plus one test file.

## Architecture Decisions

| # | Decision | Choice | Rejected alternative | Rationale |
|---|---|---|---|---|
| 1 | Code sharing | Four independent flat files, no abstract base | `AbstractToolCallEvaluator` with a template method, or a shared `denyVote`/timeout helper | Only ~10 lines are genuinely shared (`AbortController` setup, `denyVote`, `describeError`); the prompt builders are identical today but are per-provider tuning surface tomorrow. A base class would have to abstract three fully divergent axes (auth, request, response) and would couple the fail-closed path of three backends into one edit target. Duplication is the cheaper failure mode when each file is the sole owner of one wire contract. |
| 2 | HTTP layer | Native `fetch` behind an injectable `GeminiClient` interface | `@google/generative-ai` npm package | Matches the precedent Groq already set. Zero new runtime dependency (`package.json` deps stay `zod` + `@anthropic-ai/sdk`), no SDK retry/backoff behavior smuggled under a hard 2500 ms deadline, and the fake-client seam keeps every test offline and key-less. |
| 3 | Endpoint modeling | `baseUrl` is a **base path**; the client concatenates `/v1beta/models/{model}:generateContent` | `baseUrl` as a complete endpoint (Groq's shape) | Gemini interpolates the model into the path, so a complete-endpoint option would make `options.model` silently inert. Documented divergence from `GroqEvaluatorOptions.baseUrl`. |
| 4 | Default model | `gemini-2.5-flash-lite` | `gemini-2.5-flash`, `gemini-2.5-pro` | Highest free-tier quota and lowest latency against the unchanged 2500 ms sync deadline. One forced tool call with a 512-token cap needs no reasoning tier. One-constant override. |
| 5 | Constructor validation | None — no model-ID allowlist, no key presence check | Validate `model` at construction | Consistent with both existing evaluators. An invalid model surfaces as a non-2xx that the existing catch already fail-closes to `deny`; adding a throw path would be the only evaluator that can reject instead of deny. |
| 6 | Backend selection (wiring) | Reuse the existing seam unchanged: compile-time import in `melchior.ts`/`balthasar.ts`/`casper.ts` for defaults, DI override via `RunHookOptions.evaluators` and `MainDeps.evaluators` | A `MAGI_EVALUATOR_BACKEND` env var or a `magi.config.json` backend key | **Verified against the code: no env-var or config backend switch exists today.** Groq-vs-Anthropic is chosen either by editing the named-evaluator file or by constructing the evaluator and passing it into the three-tuple (`claude-code-hook/index.ts:175`, `src/cli/main.ts:80`). Gemini becomes a third option through that same seam with zero edits to existing files. Introducing a runtime switch would add a config surface the proposal explicitly rules out and would contradict `MagiConfig`'s "single mode source" discipline. |

## Divergence From Groq — the three branches

| Axis | Groq | Gemini |
|---|---|---|
| Auth | `authorization: Bearer ${key}` header, key from `GROQ_API_KEY` | `x-goog-api-key: ${key}` header, key from `GEMINI_API_KEY`, no `Authorization` header |
| Request | `messages: [{role:'system'},{role:'user'}]`, `tools:[{type:'function',function:{...}}]`, forced by `tool_choice` | `contents: [{role:'user',parts:[{text}]}]` with `systemInstruction`, `tools:[{functionDeclarations:[...]}]`, forced by `toolConfig.functionCallingConfig.mode: 'ANY'` |
| Response | `choices[0].message.tool_calls[].function.arguments` — a **JSON string**, needs `JSON.parse` in a try/catch | `candidates[0].content.parts[].functionCall.args` — an **already-parsed object**; no `JSON.parse`, so the "invalid JSON" deny branch does not exist and is replaced by a wrong-shape-args deny caught by `CastVoteInputSchema.safeParse` |

## Data Flow

```
castVote(action, severity)
  ├ AbortController(timeoutMs=2500)
  ├ client.create({ contents, systemInstruction, tools, toolConfig, generationConfig }, {signal})
  │     └ FetchGeminiClient → POST `${baseUrl}/v1beta/models/${model}:generateContent`
  │            headers: content-type, x-goog-api-key        !response.ok → throw
  ├ extractVote(response)
  │     candidates[0].content.parts.find(p => p.functionCall?.name === 'cast_vote')
  │        ├ absent / wrong name ─────────────→ denyVote(no cast_vote function call)
  │        └ CastVoteInputSchema.safeParse(part.functionCall.args)   ← NO JSON.parse
  │               ├ !success ─────────────────→ denyVote(schema validation)
  │               └ success ──────────────────→ { evaluator, vote, rationale }
  └ catch (transport / non-2xx / abort) ──────→ denyVote(error/timeout)
```

Downstream is untouched: `collectVotes` → `resolveConsensus` → `assembleVerdict` → audit sink → mode gate.

## File Changes

| File | Action | Description |
|---|---|---|
| `src/gating/gemini-evaluator.ts` | Create | `GeminiEvaluator`, `GeminiEvaluatorOptions`, `GeminiClient`, `FetchGeminiClient`, `CAST_VOTE_DECLARATION`, `CastVoteInputSchema`, own `extractVote`/`denyVote`/prompt builders |
| `tests/gating/gemini-evaluator.test.ts` | Create | Mirrors `tests/gating/groq-evaluator.test.ts`'s four `describe` blocks, with the invalid-JSON case replaced by malformed-args |
| `MANUAL.md` | Note only | Recommended: a section-4 sibling to "Volver a Anthropic" (line 113) documenting manual `GeminiEvaluator` construction plus the free-tier caveat, in the file's existing Spanish register. Recorded here as a design note; `sdd-tasks` decides whether it lands in this change |
| `package.json` | Unchanged | Asserted, not edited |
| `melchior.ts` / `balthasar.ts` / `casper.ts` | Unchanged | Defaults stay on Groq by decision 6 |

## Interfaces / Contracts

```ts
export interface GeminiEvaluatorOptions {
  client?: GeminiClient;              // injectable fake; default is fetch-backed
  apiKey?: string;                    // → x-goog-api-key; defaults to GEMINI_API_KEY
  model?: string;                     // default 'gemini-2.5-flash-lite'
  timeoutMs?: number;                 // default 2500
  maxTokens?: number;                 // default 512 → generationConfig.maxOutputTokens
  /** BASE PATH, not a complete endpoint — the client appends
   *  `/v1beta/models/${model}:generateContent`. Diverges from GroqEvaluatorOptions.baseUrl. */
  baseUrl?: string;                   // default 'https://generativelanguage.googleapis.com'
}

interface GeminiGenerateContentRequest {
  contents: Array<{ role: 'user'; parts: Array<{ text: string }> }>;
  systemInstruction: { parts: Array<{ text: string }> };
  tools: [{ functionDeclarations: [typeof CAST_VOTE_DECLARATION] }];
  toolConfig: { functionCallingConfig: { mode: 'ANY' } };
  generationConfig: { maxOutputTokens: number };
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ functionCall?: { name: string; args: unknown } }> };
  }>;
}

export interface GeminiClient {
  create(
    body: GeminiGenerateContentRequest,
    options?: { signal?: AbortSignal },
  ): Promise<GeminiGenerateContentResponse>;
}
```

`args` is typed `unknown` on purpose: it arrives parsed, so the only gate is `CastVoteInputSchema.safeParse(args)`. The `model` field is absent from the body — it lives in the URL. Node's strip-only TS execution forbids constructor parameter properties; assign every field explicitly in the constructor body.

## Testing Strategy

| Layer | What to test | Approach |
|---|---|---|
| Unit — conforming | Well-formed `functionCall` → matching vote; request carries `functionDeclarations[0].name === 'cast_vote'` and `toolConfig.functionCallingConfig.mode === 'ANY'` and no other tool; `AbortSignal` reaches the client | Fake `GeminiClient` capturing the body, `node:test` + `assert/strict` |
| Unit — non-conforming | No `candidates`; empty `parts`; no `functionCall`; wrong function name; `args` missing `rationale`; empty-string `rationale`; `vote` outside the enum — each → `deny`, exactly one client call, no retry | Fake client with a call counter |
| Unit — fail-closed | Client rejects; non-2xx surfaced as a throw; never-resolving client vs. the abort deadline; a late "allow" after timeout is never repaired into allow | Same shape as Groq's third `describe` |
| Unit — identity | `name` reflects the constructor argument | Direct assertion |
| Unit — URL/auth | Default client hits a path ending `/v1beta/models/gemini-2.5-flash-lite:generateContent` and sends `x-goog-api-key` with no `Authorization` | Stubbed `globalThis.fetch` |
| Regression | Every existing suite passes unchanged; `melchior`/`balthasar`/`casper` still resolve to `GroqEvaluator` | Full `node --test` run |

No test may require a network or a real key.

## Threat Matrix

N/A — no routing, shell parsing, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary is added. `src/gating/severity.ts` and `allowlist.ts` are untouched; this change adds one outbound HTTPS client behind an existing port. The security-relevant invariant it must preserve is the existing one: every failure path resolves to `deny`, never `allow`, and is never retried or repaired — covered by the fail-closed test rows above.

## Migration / Rollout

No migration. Purely additive and inert until a caller constructs `GeminiEvaluator`; no default, schema, config, or audit-record change. Rollback is `git revert` of one commit. Estimated ~230 authored lines source + ~230 test — near the 400-line budget, so `sdd-tasks` should forecast a possible two-slice split (slice 1: client + request build + auth/URL tests; slice 2: `extractVote` + fail-closed matrix + MANUAL note).

## Open Questions

- [ ] Does the `MANUAL.md` section land in this change or in a follow-up? Recorded here as a note, not a task.
- [ ] `systemInstruction` is supported on `v1beta` `generateContent`; if a given model rejects it, the fallback is prepending the system text to the first `contents` part. Confirm at implementation time against one live call.
- [ ] Free-tier prompts may be used for training. Caveat only, not a blocker — it belongs in the MANUAL note, not the code.
