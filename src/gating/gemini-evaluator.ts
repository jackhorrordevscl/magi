import { z } from 'zod';
import { VoteDecisionSchema } from './consensus.ts';
import type { Evaluator as EvaluatorName, Vote } from './consensus.ts';
import type { ProposedAction, SeverityTier } from './proposed-action.ts';
import type { EvaluatorPort } from './evaluator-port.ts';
import type { CalibrationFacet } from './anthropic-evaluator.ts';

/**
 * Sync-tier concrete `EvaluatorPort` backed by Google's Gemini
 * `generateContent` API. Structurally parallel to `groq-evaluator.ts` and
 * `anthropic-evaluator.ts` (forced tool-use, `AbortController` timeout,
 * fail-closed to `deny` on any non-conforming output, transport error, or
 * timeout — never repaired or retried), but with its own wire shape:
 *
 * - Auth is `x-goog-api-key`, not `Authorization: Bearer`.
 * - The model is interpolated into the URL path
 *   (`{baseUrl}/v1beta/models/{model}:generateContent`), not sent in the
 *   request body — so `GeminiEvaluatorOptions.baseUrl` is a **base path**,
 *   not a complete endpoint (diverges from `GroqEvaluatorOptions.baseUrl`).
 * - `functionCall.args` arrives already parsed (no `JSON.parse` needed in
 *   `extractVote`); a malformed `args` object fails schema validation
 *   instead.
 *
 * No new npm dependency is introduced: Gemini's API is called via Node's
 * native `fetch`, not `@google/generative-ai`.
 */

const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

const CAST_VOTE_TOOL_NAME = 'cast_vote';

/**
 * Zod schema for the `cast_vote` function call's already-parsed `args`.
 * Mirrored (by hand, not generated) into the JSON Schema handed to Gemini
 * as `CAST_VOTE_DECLARATION.parameters` below — keep the two in sync if
 * this changes. Identical shape to `GroqEvaluator`/`AnthropicEvaluator`'s
 * `CastVoteInputSchema`.
 */
const CastVoteInputSchema = z.object({
  vote: VoteDecisionSchema,
  rationale: z.string().min(1),
});

const CAST_VOTE_DECLARATION = {
  name: CAST_VOTE_TOOL_NAME,
  description:
    'Cast your single vote on the proposed action: "allow", "deny", or "abstain", plus a short rationale. You must call this tool exactly once — it is the only way to respond.',
  parameters: {
    type: 'object',
    properties: {
      vote: { type: 'string', enum: ['allow', 'deny', 'abstain'] },
      rationale: { type: 'string', minLength: 1 },
    },
    required: ['vote', 'rationale'],
  },
};

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

/**
 * The narrow slice of Gemini's `generateContent` surface this evaluator
 * depends on. Defined as an interface (rather than depending on a concrete
 * HTTP client) so tests can inject a fake implementation without any
 * network access or a real API key — mirrors `GroqChatClient` in
 * `groq-evaluator.ts`.
 */
export interface GeminiClient {
  create(
    body: GeminiGenerateContentRequest,
    options?: { signal?: AbortSignal },
  ): Promise<GeminiGenerateContentResponse>;
}

export interface GeminiEvaluatorOptions {
  /** Injectable fake for tests; defaults to a real `fetch`-backed client. */
  client?: GeminiClient;
  /** Forwarded as the `x-goog-api-key` header when `client` is not supplied. Defaults to `GEMINI_API_KEY`. */
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  maxTokens?: number;
  /**
   * BASE PATH, not a complete endpoint — the client appends
   * `/v1beta/models/${model}:generateContent`. Diverges from
   * `GroqEvaluatorOptions.baseUrl`, which is a complete endpoint.
   */
  baseUrl?: string;
}

/**
 * Default `GeminiClient`: a thin `fetch` wrapper over Gemini's
 * `generateContent` endpoint. `fetch` does not throw on a non-2xx status,
 * so `response.ok` is checked explicitly and turned into a thrown error —
 * `castVote`'s catch block then fail-closes it to `deny` exactly like any
 * other transport failure.
 */
class FetchGeminiClient implements GeminiClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(apiKey: string | undefined, baseUrl: string, model: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.model = model;
  }

  async create(
    body: GeminiGenerateContentRequest,
    options?: { signal?: AbortSignal },
  ): Promise<GeminiGenerateContentResponse> {
    const url = `${this.baseUrl}/v1beta/models/${this.model}:generateContent`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': this.apiKey ?? '',
      },
      body: JSON.stringify(body),
      signal: options?.signal ?? null,
    });
    if (!response.ok) {
      throw new Error(`Gemini API responded with non-2xx status ${response.status}`);
    }
    return (await response.json()) as GeminiGenerateContentResponse;
  }
}

export class GeminiEvaluator implements EvaluatorPort {
  readonly name: EvaluatorName;
  private readonly facet: CalibrationFacet;
  private readonly client: GeminiClient;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;

  // NOTE: Node's native TS strip-only execution does not support
  // constructor parameter-property shorthand — every field is assigned
  // explicitly in the constructor body (mirrors GroqEvaluator/
  // AnthropicEvaluator).
  constructor(name: EvaluatorName, facet: CalibrationFacet, options: GeminiEvaluatorOptions = {}) {
    this.name = name;
    this.facet = facet;
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.client =
      options.client ??
      new FetchGeminiClient(options.apiKey ?? process.env.GEMINI_API_KEY, options.baseUrl ?? DEFAULT_BASE_URL, this.model);
  }

  async castVote(action: ProposedAction, severity: SeverityTier): Promise<Vote> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.client.create(
        {
          contents: [{ role: 'user', parts: [{ text: this.buildUserPrompt(action, severity) }] }],
          systemInstruction: { parts: [{ text: this.buildSystemPrompt() }] },
          tools: [{ functionDeclarations: [CAST_VOTE_DECLARATION] }],
          toolConfig: { functionCallingConfig: { mode: 'ANY' } },
          generationConfig: { maxOutputTokens: this.maxTokens },
        },
        { signal: controller.signal },
      );
      return this.extractVote(response);
    } catch (error) {
      return this.denyVote(`evaluator error/timeout, fail-closed to deny: ${describeError(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private extractVote(response: GeminiGenerateContentResponse): Vote {
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    const part = parts.find((p) => p.functionCall);
    const functionCall = part?.functionCall;
    if (!functionCall || functionCall.name !== CAST_VOTE_TOOL_NAME) {
      // Non-conforming: no functionCall at all, or none named cast_vote.
      // Fail-closed immediately — never repaired or retried.
      return this.denyVote('model response contained no cast_vote function call (fail-closed, not repaired)');
    }

    // args arrives already parsed by the Gemini API — no JSON.parse here.
    const parsed = CastVoteInputSchema.safeParse(functionCall.args);
    if (!parsed.success) {
      return this.denyVote(
        `cast_vote args failed schema validation (fail-closed, not repaired): ${parsed.error.message}`,
      );
    }

    return { evaluator: this.name, vote: parsed.data.vote, rationale: parsed.data.rationale };
  }

  private denyVote(rationale: string): Vote {
    return { evaluator: this.name, vote: 'deny', rationale };
  }

  private buildSystemPrompt(): string {
    return [
      `You are ${this.name}, one of three independent evaluators gating a proposed action.`,
      `Your evaluation facet: ${this.facet.description}.`,
      this.facet.guidance,
      'Vote independently. You must call the cast_vote tool exactly once with your decision and a short rationale.',
    ].join('\n');
  }

  private buildUserPrompt(action: ProposedAction, severity: SeverityTier): string {
    const lines = [
      `Actor: ${action.actor}`,
      `Action type: ${action.actionType}`,
      `Target: ${action.target}`,
      `Environment: ${action.environment}`,
      `Severity (orchestrator-classified): ${severity}`,
    ];
    if (action.source === 'coding_agent') {
      lines.push(`Command: ${action.command}`);
    } else {
      lines.push(`Pipeline id: ${action.pipelineId}`);
    }
    lines.push('Cast your vote (allow / deny / abstain) with a rationale via the cast_vote tool.');
    return lines.join('\n');
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
