import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseShellCommand, classifyPath } from '../../src/shell/command-parser.ts';

describe('classifyPath — doc-like paths are never treated as arbitrary executable code', () => {
  test('requirements.txt classifies as doc', () => {
    assert.equal(classifyPath('requirements.txt'), 'doc');
  });

  test('CMakeLists.txt classifies as doc', () => {
    assert.equal(classifyPath('CMakeLists.txt'), 'doc');
  });

  test('README.sh classifies as doc despite the .sh extension', () => {
    // The README prefix overrides the script-like extension: this file is
    // documentation, not an arbitrary executable script.
    assert.equal(classifyPath('README.sh'), 'doc');
  });

  test('.github/workflows/*.yml classifies as doc', () => {
    assert.equal(classifyPath('.github/workflows/ci.yml'), 'doc');
    assert.equal(classifyPath('.github/workflows/release.yaml'), 'doc');
  });

  test('contrast: a genuine script keeps its script classification', () => {
    assert.equal(classifyPath('deploy.sh'), 'script');
    assert.equal(classifyPath('scripts/malicious.py'), 'script');
  });
});

describe('parseShellCommand — doc-like referenced paths inside commands', () => {
  test('cat requirements.txt: executable is not flagged, referenced path is doc', () => {
    const result = parseShellCommand('cat requirements.txt');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.subCommands.length, 1);
    const sub = result.subCommands[0];
    assert.ok(sub);
    assert.equal(sub.executable, 'cat');
    assert.equal(sub.referencedPaths.length, 1);
    assert.equal(sub.referencedPaths[0]?.path, 'requirements.txt');
    assert.equal(sub.referencedPaths[0]?.classification, 'doc');
  });

  test('bash README.sh: referenced path is still classified doc, not script', () => {
    const result = parseShellCommand('bash README.sh');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const sub = result.subCommands[0];
    assert.ok(sub);
    assert.equal(sub.referencedPaths[0]?.classification, 'doc');
  });
});

describe('parseShellCommand — compound command decomposition', () => {
  test('&& chains decompose into discrete sub-commands', () => {
    const result = parseShellCommand('echo a && echo b');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.subCommands.length, 2);
    assert.equal(result.subCommands[0]?.executable, 'echo');
    assert.deepEqual(result.subCommands[0]?.args, ['a']);
    assert.equal(result.subCommands[1]?.executable, 'echo');
    assert.deepEqual(result.subCommands[1]?.args, ['b']);
  });

  test('; chains decompose into discrete sub-commands', () => {
    const result = parseShellCommand('git status; git log');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.subCommands.length, 2);
    assert.equal(result.subCommands[0]?.executable, 'git');
    assert.deepEqual(result.subCommands[0]?.args, ['status']);
    assert.equal(result.subCommands[1]?.executable, 'git');
    assert.deepEqual(result.subCommands[1]?.args, ['log']);
  });

  test('| pipe chains decompose into discrete sub-commands', () => {
    const result = parseShellCommand('cat a.txt | grep foo');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.subCommands.length, 2);
    assert.equal(result.subCommands[0]?.executable, 'cat');
    assert.equal(result.subCommands[1]?.executable, 'grep');
    assert.deepEqual(result.subCommands[1]?.args, ['foo']);
  });

  test('|| chains also decompose into discrete sub-commands', () => {
    const result = parseShellCommand('false || echo fallback');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.subCommands.length, 2);
    assert.equal(result.subCommands[1]?.executable, 'echo');
  });

  test('env-var prefixes (ENV=x cmd) are captured separately from the executable', () => {
    const result = parseShellCommand('FOO=bar BAZ=qux npm test');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.subCommands.length, 1);
    const sub = result.subCommands[0];
    assert.ok(sub);
    assert.deepEqual(sub.envPrefix, { FOO: 'bar', BAZ: 'qux' });
    assert.equal(sub.executable, 'npm');
    assert.deepEqual(sub.args, ['test']);
  });

  test('shell alias definitions are a discrete sub-command in a chain, not an opaque atom', () => {
    const result = parseShellCommand("alias gs='git status' && gs");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.subCommands.length, 2);
    assert.equal(result.subCommands[0]?.executable, 'alias');
    assert.deepEqual(result.subCommands[0]?.args, ['gs=git status']);
    assert.equal(result.subCommands[1]?.executable, 'gs');
  });

  test('a mixed && ; | chain with env prefixes decomposes into every discrete sub-command', () => {
    const result = parseShellCommand('FOO=1 git fetch && git merge --ff-only; cat notes.txt | wc -l');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.subCommands.length, 4);
    assert.deepEqual(result.subCommands[0]?.envPrefix, { FOO: '1' });
    assert.equal(result.subCommands[0]?.executable, 'git');
    assert.equal(result.subCommands[1]?.executable, 'git');
    assert.deepEqual(result.subCommands[1]?.args, ['merge', '--ff-only']);
    assert.equal(result.subCommands[2]?.executable, 'cat');
    assert.equal(result.subCommands[3]?.executable, 'wc');
  });
});

describe('parseShellCommand — unparseable sentinel forces downstream High severity', () => {
  test('unterminated double quote produces an unparseable sentinel', () => {
    const result = parseShellCommand('echo "unterminated');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0);
    assert.equal(result.raw, 'echo "unterminated');
  });

  test('unterminated single quote produces an unparseable sentinel', () => {
    const result = parseShellCommand("echo 'unterminated");
    assert.equal(result.ok, false);
  });

  test('a dangling separator with no following command is unparseable', () => {
    const result = parseShellCommand('echo a &&');
    assert.equal(result.ok, false);
  });

  test('an empty command string is unparseable', () => {
    const result = parseShellCommand('   ');
    assert.equal(result.ok, false);
  });
});
