import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../../src/gating/severity.ts';
import type { CodingAgentAction } from '../../src/gating/proposed-action.ts';

function action(command: string, overrides: Partial<CodingAgentAction> = {}): CodingAgentAction {
  return {
    source: 'coding_agent',
    actor: 'test-agent',
    actionType: 'shell_exec',
    target: 'repo',
    environment: 'local',
    mode: 'shadow',
    command,
    ...overrides,
  };
}

describe('classify — deterministic, table-driven rule classification (no model call)', () => {
  const cases: Array<{ command: string; expected: 'low' | 'medium' | 'high' }> = [
    { command: 'ls -la', expected: 'low' },
    { command: 'git status', expected: 'low' },
    { command: 'git log --oneline', expected: 'low' },
  ];

  for (const { command, expected } of cases) {
    test(`"${command}" classifies as ${expected}`, () => {
      assert.equal(classify(action(command)), expected);
    });
  }

  test('classify is deterministic — same input always produces the same tier', () => {
    const first = classify(action('git push origin main'));
    const second = classify(action('git push origin main'));
    assert.equal(first, second);
  });
});

describe('classify — git destructive-operation rules', () => {
  test('git reset --hard classifies as high', () => {
    assert.equal(classify(action('git reset --hard')), 'high');
  });

  test('git reset --hard HEAD~1 classifies as high', () => {
    assert.equal(classify(action('git reset --hard HEAD~1')), 'high');
  });

  test('git clean -fdx classifies as high', () => {
    assert.equal(classify(action('git clean -fdx')), 'high');
  });

  test('git clean -f -d -x (split flags) classifies as high', () => {
    assert.equal(classify(action('git clean -f -d -x')), 'high');
  });

  test('git clean -f alone does not trigger the -fdx rule', () => {
    assert.notEqual(classify(action('git clean -f')), 'high');
  });

  test('force-push to a non-protected branch classifies as high (not critical)', () => {
    assert.equal(classify(action('git push --force origin feature/my-branch')), 'high');
  });

  test('force-push with an ambiguous/unresolved target classifies as high (not critical)', () => {
    assert.equal(classify(action('git push --force origin')), 'high');
  });

  test('a refspec resolved to a protected branch (main) classifies as high even without force', () => {
    assert.equal(classify(action('git push origin HEAD:main')), 'high');
  });

  test('a refspec resolved to a protected branch (master) classifies as high', () => {
    assert.equal(classify(action('git push origin master')), 'high');
  });

  test('a push to a non-protected branch without force is not forced to high', () => {
    assert.notEqual(classify(action('git push origin feature/my-branch')), 'high');
  });

  test('an ambiguous push target (no refspec) classifies as high', () => {
    assert.equal(classify(action('git push origin')), 'high');
  });
});

describe('classify — force-push to a protected branch is Critical per spec exemplar', () => {
  test('git push --force origin main classifies as critical', () => {
    assert.equal(classify(action('git push --force origin main')), 'critical');
  });

  test('git push -f origin master classifies as critical', () => {
    assert.equal(classify(action('git push -f origin master')), 'critical');
  });

  test('git push --force-with-lease origin HEAD:main classifies as critical', () => {
    assert.equal(classify(action('git push --force-with-lease origin HEAD:main')), 'critical');
  });

  test('git push --force origin release/1.0 classifies as critical', () => {
    assert.equal(classify(action('git push --force origin release/1.0')), 'critical');
  });

  test('a low or high adapter hint cannot lower a critical rule result', () => {
    assert.equal(classify(action('git push --force origin main', { adapterSeverityHint: 'high' })), 'critical');
  });
});

describe('classify — hint escalation is escalation-only: final = max(ruleTier, hint)', () => {
  test('a low hint cannot lower a high rule result', () => {
    assert.equal(classify(action('git reset --hard', { adapterSeverityHint: 'low' })), 'high');
  });

  test('a high hint raises an otherwise-low rule result', () => {
    assert.equal(classify(action('git status', { adapterSeverityHint: 'high' })), 'high');
  });

  test('a medium hint raises a low rule result to medium', () => {
    assert.equal(classify(action('git status', { adapterSeverityHint: 'medium' })), 'medium');
  });

  test('a medium hint cannot lower a high rule result', () => {
    assert.equal(classify(action('git clean -fdx', { adapterSeverityHint: 'medium' })), 'high');
  });
});

describe('classify — unparseable commands force high via the Phase 2 sentinel', () => {
  test('an unparseable command (unbalanced quote) classifies as high', () => {
    assert.equal(classify(action('echo "unterminated')), 'high');
  });
});
