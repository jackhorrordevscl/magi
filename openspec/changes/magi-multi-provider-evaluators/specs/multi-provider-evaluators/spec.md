# Multi-Provider Evaluators Specification

## Purpose

Define the behavior of `GeminiEvaluator`, a new `EvaluatorPort` backend calling Google's Gemini API, so it is interchangeable with `AnthropicEvaluator` and `GroqEvaluator` behind the same contract: forced tool-call voting, fail-closed to `deny` on any non-conforming output.

## Requirements

### Requirement: Gemini Request Shape

The system MUST build a Gemini `generateContent` request using `contents` for the prompt and a single forced function-call tool.

The request body MUST include `tools: [{ functionDeclarations: [...] }]` describing a `cast_vote` function, and MUST set `toolConfig: { functionCallingConfig: { mode: 'ANY' } }` to force exactly one tool call.

#### Scenario: Request forces a single tool call

- GIVEN a `GeminiEvaluator` constructed with a fake `GeminiClient`
- WHEN `castVote` is invoked for a proposed action
- THEN the request passed to the client contains `tools[0].functionDeclarations[0].name === 'cast_vote'`
- AND `toolConfig.functionCallingConfig.mode === 'ANY'`

### Requirement: Auth Header

The system MUST authenticate to Gemini using the `x-goog-api-key` header, not `Authorization: Bearer`.

The system MUST default the API key to `process.env.GEMINI_API_KEY` when no explicit `apiKey` option is supplied and no fake `client` is injected.

#### Scenario: Default client sends x-goog-api-key

- GIVEN a `GeminiEvaluator` constructed without an injected `client`
- WHEN `castVote` triggers the default `fetch`-backed client
- THEN the outgoing request headers include `x-goog-api-key` set to the resolved API key
- AND no `Authorization` header is sent

### Requirement: Base URL and Model Interpolation

The system MUST treat `GeminiEvaluatorOptions.baseUrl` as a base path, not a complete endpoint, and MUST interpolate the model name into the request path as `{baseUrl}/v1beta/models/{model}:generateContent`.

The system MUST default the model to `gemini-2.5-flash-lite` when no `model` option is supplied.

#### Scenario: Default client interpolates model into path

- GIVEN a `GeminiEvaluator` constructed with `model: 'gemini-2.5-flash-lite'` and a default `baseUrl`
- WHEN the default client issues the request
- THEN the request URL ends with `/v1beta/models/gemini-2.5-flash-lite:generateContent`

### Requirement: Vote Extraction From Parsed Args

The system MUST extract the vote from `candidates[0].content.parts[].functionCall` where `args` is already a parsed object, and MUST NOT attempt `JSON.parse` on `args`.

The system MUST validate the extracted `args` against the same `cast_vote` schema (`vote`, `rationale`) used by the other evaluators.

#### Scenario: Well-formed function call yields a vote

- GIVEN a fake `GeminiClient` returning a `candidates[0].content.parts[0].functionCall` with `name: 'cast_vote'` and `args: { vote: 'allow', rationale: 'looks safe' }`
- WHEN `castVote` processes the response
- THEN the resulting `Vote` has `vote: 'allow'` and `rationale: 'looks safe'`

#### Scenario: Malformed args object fails closed

- GIVEN a fake `GeminiClient` returning `functionCall.args` that does not conform to the `cast_vote` schema (e.g. missing `rationale`, or `vote` outside the enum)
- WHEN `castVote` processes the response
- THEN the resulting `Vote` is `deny`
- AND the rationale states fail-closed due to schema validation, not that a repair or retry was attempted

### Requirement: Fail-Closed on Missing or Non-Conforming Tool Call

The system MUST return a `deny` vote when the response contains no `functionCall`, or a `functionCall` whose `name` is not `cast_vote`.

#### Scenario: No function call in response

- GIVEN a fake `GeminiClient` returning a response with no `functionCall` part
- WHEN `castVote` processes the response
- THEN the resulting `Vote` is `deny` with a rationale describing the missing tool call

#### Scenario: Wrong function name

- GIVEN a fake `GeminiClient` returning a `functionCall` with `name` other than `cast_vote`
- WHEN `castVote` processes the response
- THEN the resulting `Vote` is `deny`

### Requirement: Fail-Closed on Transport Failure and Timeout

The system MUST return a `deny` vote when the underlying request throws (network error, non-2xx HTTP status) or is aborted after `timeoutMs` elapses (default `2500`).

The system MUST NOT retry or repair a failed request; each `castVote` call attempts exactly one request.

#### Scenario: Non-2xx HTTP status

- GIVEN a fake `GeminiClient` whose `create` rejects because the response status was not 2xx
- WHEN `castVote` processes the failure
- THEN the resulting `Vote` is `deny` with a rationale describing the transport error

#### Scenario: Request exceeds timeout

- GIVEN a `GeminiEvaluator` with `timeoutMs: 2500` and a client that never resolves before the abort signal fires
- WHEN `castVote` is invoked
- THEN the request is aborted and the resulting `Vote` is `deny`

### Requirement: No Model ID Validation

The system MUST NOT validate the `model` option against a known-model list at construction time.

An invalid or deprecated model ID MUST surface only as a non-2xx response from the provider, handled by the existing fail-closed transport error path — consistent with `AnthropicEvaluator` and `GroqEvaluator`.

#### Scenario: Invalid model ID is not rejected at construction

- GIVEN `new GeminiEvaluator('melchior', facet, { model: 'not-a-real-model' })`
- WHEN the evaluator is constructed
- THEN construction succeeds without throwing
- AND the invalid model only surfaces later as a non-2xx transport failure that fail-closes to `deny`

### Requirement: EvaluatorPort Conformance

The system MUST implement `EvaluatorPort` such that `GeminiEvaluator` is substitutable anywhere `AnthropicEvaluator` or `GroqEvaluator` is used, without changing any of `melchior`, `balthasar`, or `casper`'s default backend.

#### Scenario: Drop-in construction

- GIVEN `new GeminiEvaluator('balthasar', BALTHASAR_FACET, { apiKey: 'test-key' })`
- WHEN passed into `MainDeps.evaluators` or `runHook`
- THEN it satisfies `EvaluatorPort` with no type or runtime error
