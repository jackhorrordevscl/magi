import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicEvaluator } from '../../src/gating/anthropic-evaluator.ts';
import type { AnthropicMessagesClient } from '../../src/gating/anthropic-evaluator.ts';
import { GroqEvaluator } from '../../src/gating/groq-evaluator.ts';
import type { GroqChatClient } from '../../src/gating/groq-evaluator.ts';
import { GeminiEvaluator } from '../../src/gating/gemini-evaluator.ts';
import type { GeminiClient } from '../../src/gating/gemini-evaluator.ts';
import type { CodingAgentAction } from '../../src/gating/proposed-action.ts';
import type { CalibrationEntry } from '../../src/calibration/corpus-schema.ts';

/**
 * Cross-backend proof of spec Requirement: Additive exemplar parameter on
 * castVote / Scenario "All three backends inject identical exemplar text" —
 * all three concrete evaluators share the same `formatExemplarsForPrompt`
 * (`src/calibration/exemplar-prompt.ts`), so a shared exemplar set must
 * produce byte-identical formatted exemplar text in each backend's outgoing
 * prompt, with no provider-specific filtering or redaction.
 */

const FACET = { description: 'fact/consistency', guidance: 'test guidance' };

function action(): CodingAgentAction {
  return {
    source: 'coding_agent',
    actor: 'test-agent',
    actionType: 'shell_exec',
    target: 'repo',
    environment: 'local',
    mode: 'shadow',
    command: 'git push --force origin main',
  };
}

const EXEMPLARS: CalibrationEntry[] = [
  {
    tag: 'force-push-protected-branch',
    severity: 'critical',
    exemplar: 'Force-pushing to main destroys shared history for everyone else on the team; always deny.',
    contentHash: 'a'.repeat(64),
    createdAt: '2026-08-12T00:00:00.000Z',
  },
  {
    tag: 'read-only-file-access',
    severity: 'low',
    exemplar: 'Reading a config file is harmless observation; always allow.',
    contentHash: 'b'.repeat(64),
    createdAt: '2026-08-12T00:00:00.000Z',
  },
];

function extractExemplarBlock(prompt: string): string {
  const start = prompt.indexOf('Operator calibration exemplars');
  const end = prompt.indexOf('Cast your vote');
  return prompt.slice(start, end).trimEnd();
}

describe('formatExemplarsForPrompt output is identical across all three evaluator backends', () => {
  test('a shared exemplar set produces byte-identical formatted exemplar text in each backend prompt', async () => {
    let anthropicPrompt = '';
    const anthropicClient: AnthropicMessagesClient = {
      create: async (body) => {
        anthropicPrompt = body.messages[0]?.content as string;
        return {
          id: 'msg_1',
          type: 'message' as const,
          role: 'assistant' as const,
          model: 'claude-3-5-haiku-latest',
          content: [{ type: 'tool_use' as const, id: 'tool_1', name: 'cast_vote', input: { vote: 'allow', rationale: 'ok' } }],
          stop_reason: 'tool_use' as const,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        } as never;
      },
    };

    let groqPrompt = '';
    const groqClient: GroqChatClient = {
      create: async (body) => {
        groqPrompt = body.messages[1]?.content as string;
        return {
          choices: [
            {
              message: {
                tool_calls: [
                  { type: 'function', function: { name: 'cast_vote', arguments: JSON.stringify({ vote: 'allow', rationale: 'ok' }) } },
                ],
              },
            },
          ],
        } as never;
      },
    };

    let geminiPrompt = '';
    const geminiClient: GeminiClient = {
      create: async (body) => {
        geminiPrompt = body.contents[0]?.parts[0]?.text as string;
        return {
          candidates: [{ content: { parts: [{ functionCall: { name: 'cast_vote', args: { vote: 'allow', rationale: 'ok' } } }] } }],
        };
      },
    };

    const anthropicEvaluator = new AnthropicEvaluator('melchior', FACET, { client: anthropicClient });
    const groqEvaluator = new GroqEvaluator('balthasar', FACET, { client: groqClient });
    const geminiEvaluator = new GeminiEvaluator('casper', FACET, { client: geminiClient });

    const a = action();
    await anthropicEvaluator.castVote(a, 'critical', EXEMPLARS);
    await groqEvaluator.castVote(a, 'critical', EXEMPLARS);
    await geminiEvaluator.castVote(a, 'critical', EXEMPLARS);

    const anthropicBlock = extractExemplarBlock(anthropicPrompt);
    const groqBlock = extractExemplarBlock(groqPrompt);
    const geminiBlock = extractExemplarBlock(geminiPrompt);

    assert.equal(anthropicBlock, groqBlock);
    assert.equal(groqBlock, geminiBlock);
    assert.match(anthropicBlock, /\[1\] tag: force-push-protected-branch \| severity: critical/);
    assert.match(anthropicBlock, /\[2\] tag: read-only-file-access \| severity: low/);
  });
});
