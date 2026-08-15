import { z } from 'zod';
import { VoteDecisionSchema } from './consensus.ts';
import { formatExemplarsForPrompt } from '../calibration/exemplar-prompt.ts';
import type { Evaluator as EvaluatorName, Vote } from './consensus.ts';
import type { ProposedAction, SeverityTier } from './proposed-action.ts';
import type { EvaluatorPort } from './evaluator-port.ts';
import type { CalibrationFacet } from './anthropic-evaluator.ts';
import type { CalibrationEntry } from '../calibration/corpus-schema.ts';

/**
 * Sync-tier concrete `EvaluatorPort` backed by Groq's OpenAI-compatible
 * chat completions API instead of Anthropic's. Mirrors
 * `anthropic-evaluator.ts`'s contract exactly (forced tool-use,
 * `AbortController` timeout, fail-closed to `deny` on any non-conforming
 * output, transport error, or timeout — never repaired or retried) so the
 * two evaluator backends are interchangeable behind `EvaluatorPort`. No new
 * npm dependency is introduced: Groq's API is called via Node's native
 * `fetch`, not the (unused) `groq-sdk`/`openai` packages.
 */

const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1/chat/completions';

/** Groq's own built-in defaults, exposed for the TUI's display-only effective-value rule (`src/cli/tui/effective-settings.ts`). No behavior change. */
export const GROQ_BUILTIN_DEFAULTS = { model: DEFAULT_MODEL, timeoutMs: DEFAULT_TIMEOUT_MS, maxTokens: DEFAULT_MAX_TOKENS };

const CAST_VOTE_TOOL_NAME = 'cast_vote';

/**
 * Zod schema for the `cast_vote` tool call's parsed `arguments`. Mirrored
 * (by hand, not generated) into the JSON Schema handed to Groq as
 * `CAST_VOTE_TOOL.function.parameters` below — keep the two in sync if this
 * changes. Identical shape to `AnthropicEvaluator`'s `CastVoteInputSchema`.
 */
const CastVoteInputSchema = z.object({
  vote: VoteDecisionSchema,
  rationale: z.string().min(1),
});

const CAST_VOTE_TOOL = {
  type: 'function' as const,
  function: {
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
  },
};

interface GroqChatMessage {
  role: 'system' | 'user';
  content: string;
}

interface GroqChatRequestBody {
  model: string;
  max_tokens: number;
  messages: GroqChatMessage[];
  tools: [typeof CAST_VOTE_TOOL];
  tool_choice: { type: 'function'; function: { name: string } };
}

interface GroqToolCall {
  type: string;
  function: { name: string; arguments: string };
}

interface GroqChatResponse {
  choices: Array<{
    message: {
      tool_calls?: GroqToolCall[];
    };
  }>;
}

/**
 * The narrow slice of Groq's OpenAI-compatible chat completions surface
 * this evaluator depends on. Defined as an interface (rather than depending
 * on a concrete HTTP client) so tests can inject a fake implementation
 * without any network access or a real API key — mirrors
 * `AnthropicMessagesClient` in `anthropic-evaluator.ts`.
 */
export interface GroqChatClient {
  create(body: GroqChatRequestBody, options?: { signal?: AbortSignal }): Promise<GroqChatResponse>;
}

export interface GroqEvaluatorOptions {
  /** Injectable fake for tests; defaults to a real `fetch`-backed client. */
  client?: GroqChatClient;
  /** Forwarded as the `Authorization: Bearer` header when `client` is not supplied. Defaults to `GROQ_API_KEY`. */
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  maxTokens?: number;
  /** Chat completions endpoint. Defaults to Groq's OpenAI-compatible endpoint. */
  baseUrl?: string;
}

/**
 * Default `GroqChatClient`: a thin `fetch` wrapper over Groq's OpenAI-
 * compatible `/chat/completions` endpoint. `fetch` does not throw on a
 * non-2xx status, so `response.ok` is checked explicitly and turned into a
 * thrown error — `castVote`'s catch block then fail-closes it to `deny`
 * exactly like any other transport failure.
 */
class FetchGroqChatClient implements GroqChatClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;

  constructor(apiKey: string | undefined, baseUrl: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async create(body: GroqChatRequestBody, options?: { signal?: AbortSignal }): Promise<GroqChatResponse> {
    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey ?? ''}`,
      },
      body: JSON.stringify(body),
      signal: options?.signal ?? null,
    });
    if (!response.ok) {
      throw new Error(`Groq API responded with non-2xx status ${response.status}`);
    }
    return (await response.json()) as GroqChatResponse;
  }
}

export class GroqEvaluator implements EvaluatorPort {
  readonly name: EvaluatorName;
  private readonly facet: CalibrationFacet;
  private readonly client: GroqChatClient;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;

  // NOTE: Node's native TS strip-only execution does not support
  // constructor parameter-property shorthand — every field is assigned
  // explicitly in the constructor body (mirrors AnthropicEvaluator).
  constructor(name: EvaluatorName, facet: CalibrationFacet, options: GroqEvaluatorOptions = {}) {
    this.name = name;
    this.facet = facet;
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.client =
      options.client ??
      new FetchGroqChatClient(options.apiKey ?? process.env.GROQ_API_KEY, options.baseUrl ?? DEFAULT_BASE_URL);
  }

  async castVote(action: ProposedAction, severity: SeverityTier, exemplars?: readonly CalibrationEntry[]): Promise<Vote> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.client.create(
        {
          model: this.model,
          max_tokens: this.maxTokens,
          messages: [
            { role: 'system', content: this.buildSystemPrompt() },
            { role: 'user', content: this.buildUserPrompt(action, severity, exemplars) },
          ],
          tools: [CAST_VOTE_TOOL],
          tool_choice: { type: 'function', function: { name: CAST_VOTE_TOOL_NAME } },
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

  private extractVote(response: GroqChatResponse): Vote {
    const toolCalls = response.choices[0]?.message.tool_calls ?? [];
    const call = toolCalls.find((c) => c.type === 'function' && c.function.name === CAST_VOTE_TOOL_NAME);
    if (!call) {
      // Non-conforming: no tool_calls at all, or none named cast_vote.
      // Fail-closed immediately — never repaired or retried.
      return this.denyVote('model response contained no cast_vote tool call (fail-closed, not repaired)');
    }

    let rawInput: unknown;
    try {
      rawInput = JSON.parse(call.function.arguments);
    } catch (error) {
      return this.denyVote(
        `cast_vote arguments failed to parse as JSON (fail-closed, not repaired): ${describeError(error)}`,
      );
    }

    const parsed = CastVoteInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return this.denyVote(
        `cast_vote input failed schema validation (fail-closed, not repaired): ${parsed.error.message}`,
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

  private buildUserPrompt(action: ProposedAction, severity: SeverityTier, exemplars?: readonly CalibrationEntry[]): string {
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
    // Byte-identical-prompt guarantee: see anthropic-evaluator.ts's
    // identical comment — `formatExemplarsForPrompt` is a true no-op on an
    // empty/absent exemplar set.
    const exemplarBlock = formatExemplarsForPrompt(exemplars ?? []);
    if (exemplarBlock) lines.push(exemplarBlock);
    lines.push('Cast your vote (allow / deny / abstain) with a rationale via the cast_vote tool.');
    return lines.join('\n');
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
