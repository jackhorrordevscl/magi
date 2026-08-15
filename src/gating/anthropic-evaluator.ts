import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { VoteDecisionSchema } from './consensus.ts';
import { formatExemplarsForPrompt } from '../calibration/exemplar-prompt.ts';
import { describeError } from '../shared/log.ts';
import type { Evaluator as EvaluatorName, Vote } from './consensus.ts';
import type { ProposedAction, SeverityTier } from './proposed-action.ts';
import type { EvaluatorPort } from './evaluator-port.ts';
import type { CalibrationEntry } from '../calibration/corpus-schema.ts';

/**
 * Sync-tier concrete `EvaluatorPort`: a single forced-tool-use call to a
 * fast/cheap (Haiku-class) Anthropic model, no other tools exposed, short
 * `AbortController` timeout. Per design `sdd/magi/design` (#1008):
 *
 * - Votes are collected via forced tool-use (`tool_choice: { type: 'tool',
 *   name: 'cast_vote' }`) with a Zod-derived input schema — the model has
 *   no choice but to emit a `cast_vote` call, and no other tool is ever
 *   offered, so this is a structured-output mechanism, not agentic tool
 *   access.
 * - Non-conforming output (missing/mismatched tool_use block, or an input
 *   that fails schema validation) is treated as `deny` immediately — it is
 *   NEVER repaired, retried, or re-prompted.
 * - Any transport error or timeout is likewise treated as `deny`
 *   (fail-closed) per spec Requirement: Sync Mode Fail-Closed.
 *
 * `AnthropicEvaluator.castVote` therefore never rejects: every failure
 * mode above resolves to a `deny` vote instead.
 */

const DEFAULT_MODEL = 'claude-3-5-haiku-latest';
const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_MAX_TOKENS = 512;

/** Anthropic's own built-in defaults, exposed for the TUI's display-only effective-value rule (`src/cli/tui/effective-settings.ts`). No behavior change. */
export const ANTHROPIC_BUILTIN_DEFAULTS = { model: DEFAULT_MODEL, timeoutMs: DEFAULT_TIMEOUT_MS, maxTokens: DEFAULT_MAX_TOKENS };

const CAST_VOTE_TOOL_NAME = 'cast_vote';

/**
 * Zod schema for the `cast_vote` tool's `input`. Mirrored (by hand, not
 * generated) into the JSON Schema handed to the Anthropic API as
 * `CAST_VOTE_TOOL.input_schema` below — keep the two in sync if this
 * changes.
 */
const CastVoteInputSchema = z.object({
  vote: VoteDecisionSchema,
  rationale: z.string().min(1),
});

const CAST_VOTE_TOOL: Anthropic.Tool = {
  name: CAST_VOTE_TOOL_NAME,
  description:
    'Cast your single vote on the proposed action: "allow", "deny", or "abstain", plus a short rationale. You must call this tool exactly once — it is the only way to respond.',
  input_schema: {
    type: 'object',
    properties: {
      vote: { type: 'string', enum: ['allow', 'deny', 'abstain'] },
      rationale: { type: 'string', minLength: 1 },
    },
    required: ['vote', 'rationale'],
  },
};

/**
 * The narrow slice of the Anthropic SDK's `client.messages` surface this
 * evaluator depends on. Defined as an interface (rather than depending on
 * the concrete `Anthropic` class directly) so tests can inject a fake
 * implementation without any network access, an API key, or fabricating
 * the real SDK's internal shape — the real `new Anthropic().messages`
 * object satisfies this interface as-is.
 */
export interface AnthropicMessagesClient {
  create(
    body: Anthropic.MessageCreateParamsNonStreaming,
    options?: { signal?: AbortSignal },
  ): Promise<Anthropic.Message>;
}

/**
 * Static calibration facet text for one evaluator. Grounded in the actual
 * evaluator role from spec Requirement: Evaluator Vote Contract (fact/
 * consistency, blast radius + policy, actor risk/anomaly) — not a
 * fabricated "persona". Real per-operator calibration (top-K exemplars
 * retrieved from the calibration corpus, see `src/calibration/`) is now
 * live: `runHook` resolves one exemplar selection per action and threads it
 * into `castVote`'s `exemplars` param, formatted into the prompt alongside
 * this static facet text (see `magi-calibration-live-wiring`).
 */
export interface CalibrationFacet {
  /** Short label for this facet, e.g. "fact/consistency". */
  description: string;
  /** System-prompt guidance grounding this facet in real evaluation criteria. */
  guidance: string;
}

export interface AnthropicEvaluatorOptions {
  /** Injectable fake for tests; defaults to `new Anthropic({ apiKey }).messages`. */
  client?: AnthropicMessagesClient;
  /** Forwarded to `new Anthropic(...)` when `client` is not supplied. Defaults to `ANTHROPIC_API_KEY` (SDK default). */
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  maxTokens?: number;
}

export class AnthropicEvaluator implements EvaluatorPort {
  readonly name: EvaluatorName;
  private readonly facet: CalibrationFacet;
  private readonly client: AnthropicMessagesClient;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;

  // NOTE: Node's native TS strip-only execution does not support
  // constructor parameter-property shorthand — every field is assigned
  // explicitly in the constructor body (see PR2 learnings).
  constructor(name: EvaluatorName, facet: CalibrationFacet, options: AnthropicEvaluatorOptions = {}) {
    this.name = name;
    this.facet = facet;
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey }).messages;
  }

  async castVote(action: ProposedAction, severity: SeverityTier, exemplars?: readonly CalibrationEntry[]): Promise<Vote> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const message = await this.client.create(
        {
          model: this.model,
          max_tokens: this.maxTokens,
          system: this.buildSystemPrompt(),
          messages: [{ role: 'user', content: this.buildUserPrompt(action, severity, exemplars) }],
          tools: [CAST_VOTE_TOOL],
          tool_choice: { type: 'tool', name: CAST_VOTE_TOOL_NAME },
        },
        { signal: controller.signal },
      );
      return this.extractVote(message);
    } catch (error) {
      return this.denyVote(`evaluator error/timeout, fail-closed to deny: ${describeError(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private extractVote(message: Anthropic.Message): Vote {
    const block = message.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === CAST_VOTE_TOOL_NAME,
    );
    if (!block) {
      // Non-conforming: no tool_use block at all, or none named cast_vote.
      // Fail-closed immediately — never repaired or retried.
      return this.denyVote('model response contained no cast_vote tool_use block (fail-closed, not repaired)');
    }

    const parsed = CastVoteInputSchema.safeParse(block.input);
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
    // Byte-identical-prompt guarantee: `formatExemplarsForPrompt` returns
    // `''` for an empty/absent exemplar set, so this is a true no-op when
    // `.magi/calibration/` is empty — nothing is pushed, and the prompt
    // stays byte-identical to the pre-change baseline.
    const exemplarBlock = formatExemplarsForPrompt(exemplars ?? []);
    if (exemplarBlock) lines.push(exemplarBlock);
    lines.push('Cast your vote (allow / deny / abstain) with a rationale via the cast_vote tool.');
    return lines.join('\n');
  }
}
