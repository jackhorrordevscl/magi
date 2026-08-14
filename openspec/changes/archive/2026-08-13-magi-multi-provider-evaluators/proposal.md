# Proposal: Gemini Evaluator Backend

## Intent

`EvaluatorPort` (`src/gating/evaluator-port.ts:11`) is provider-agnostic, but only two backends implement it: `AnthropicEvaluator` and `GroqEvaluator`. Groq is the default for all three named evaluators, so an operator who hits Groq's quota, latency, or availability has exactly one fallback — Anthropic, which is paid. The port was designed for substitutable backends; the catalogue never caught up. This change adds one more free-tier-capable backend, changing no default.

## Scope

### In Scope

- `src/gating/gemini-evaluator.ts` — `GeminiEvaluator`, `GeminiEvaluatorOptions`, `GeminiClient`, native-`fetch` client, with its own `extractVote`.
- `tests/gating/gemini-evaluator.test.ts`, mirroring `tests/gating/groq-evaluator.test.ts`'s case structure.
- A `MANUAL.md` section 4 sibling to "Volver a Anthropic" documenting manual construction, in that file's existing Spanish register, plus a brief free-tier-terms caveat.

### Out of Scope

- **OpenAI.** Discarded: no ongoing free tier, and this project is oriented around the Claude Code / Anthropic ecosystem plus free alternatives.
- Any default change. `melchior`/`balthasar`/`casper` zero-arg exports stay on Groq; those three files are not edited.
- A shared abstract evaluator base class, or extracting the ~10 shared lines (`AbortController` timeout, `denyVote`) into a helper.
- New npm dependencies — no `@google/generative-ai`.
- A pricing/cost comparison table in `MANUAL.md`.
- **Named future work**: retrofitting `AnthropicEvaluator` off `@anthropic-ai/sdk` onto native `fetch` — the only SDK dependency, predating the Groq pattern.

## Capabilities

### New Capabilities

- `multi-provider-evaluators`: a constructible Gemini `EvaluatorPort` backend with the same forced-tool-call, fail-closed-to-deny contract as the existing two.

### Modified Capabilities

- None. `enforcing-mode-gate`, `audited-human-override`, and `non-git-threat-matrix` are untouched.

## Approach

**Three decisions this proposal fixes.**

1. **A fully independent flat file, not a `GroqEvaluator` clone.** Gemini's wire format shares nothing with the OpenAI-compatible shape: request is `contents` / `tools[].functionDeclarations` / `toolConfig.functionCallingConfig.mode: 'ANY'` to force a call; auth is `x-goog-api-key`, not `Authorization: Bearer`; the model is interpolated into the path (`…/v1beta/models/{model}:generateContent`), so `GeminiEvaluatorOptions.baseUrl` is a **base** path, not a complete endpoint like Groq's. Structurally this sits closer to `AnthropicEvaluator`'s independence. No base class — flat files match the convention already set.
2. **`extractVote` has a different failure mode.** `candidates[0].content.parts[].functionCall.args` arrives already parsed. No `JSON.parse`, so "invalid JSON arguments" disappears and is replaced by a "wrong-shape args object" case that `CastVoteInputSchema.safeParse` catches. The test file substitutes that case.
3. **Default model tracks the sync tier.** `gemini-2.5-flash-lite`, not `gemini-2.5-flash` — highest free-tier quota (~15 RPM / 1000 RPD), lowest latency against the unchanged 2500 ms deadline. One forced tool call with a 512-token cap needs no reasoning model; it is a one-constant override.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/gating/gemini-evaluator.ts` | New | Independent request build + `extractVote` |
| `tests/gating/gemini-evaluator.test.ts` | New | Groq's cases, malformed-args variant replaces invalid-JSON |
| `MANUAL.md` | Modified | Section 4 sibling to "Volver a Anthropic" |
| `package.json` | Unchanged | No new dependency — explicitly asserted |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Google cuts or revises free-tier quotas without notice (as in Dec 2025) | Med | Documented caveat, not a blocker; Groq stays the default and Anthropic stays available |
| Gemini response shape drifts (`v1beta` is a beta path) | Med | Wire shape confined to one file with fake-client tests; failures degrade to `deny`, never `allow` |
| Deprecated/invalid model ID on a given account | Med | Surfaces as a non-2xx that already fail-closes to `deny`; no constructor-time validation added, consistent with every other evaluator |
| Gemini latency exceeds the 2500 ms default more often than Groq | Med | `timeoutMs` is already an option; documented as the first knob to raise |
| Free-tier prompts may be used for training | Low | Stated caveat in `MANUAL.md`; operators choosing this backend opt in knowingly |
| Near-duplicate evaluator files drift apart | Low | Accepted deliberately; helper extraction is a named non-goal |

## Rollback Plan

Purely additive: one source file, one test file, one doc section. `git revert` removes them with no migration, no schema change, and no behavior change for any existing caller — nothing imports `GeminiEvaluator`, and `melchior`/`balthasar`/`casper` never referenced it. An operator who manually constructed it reverts by constructing `GroqEvaluator` again, exactly as documented today.

## Dependencies

- None. No new packages. `GEMINI_API_KEY` is read from the environment only when a caller constructs `GeminiEvaluator`.

## Success Criteria

- [ ] `new GeminiEvaluator('melchior', MELCHIOR_FACET, {...})` satisfies `EvaluatorPort` and can be passed into `runHook`/`MainDeps.evaluators` unchanged.
- [ ] Fails closed to a `deny` vote on transport error, timeout, missing function call, wrong function name, wrong enum value, and empty rationale — never repaired, never retried.
- [ ] `extractVote` accepts an already-parsed `args` object and denies on a malformed one, with no `JSON.parse` in its path.
- [ ] `GeminiEvaluatorOptions.baseUrl` is a base path the model name is interpolated into, not a complete endpoint.
- [ ] `package.json` runtime dependencies are unchanged (`zod`, `@anthropic-ai/sdk`).
- [ ] `melchior`, `balthasar`, `casper` still resolve to `GroqEvaluator`; every existing test passes unchanged.
- [ ] `MANUAL.md` documents manual construction plus the free-tier caveat.
