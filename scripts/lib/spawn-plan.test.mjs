/**
 * Tests for the Windows-safe spawn plan.
 *
 * On Windows `pnpm` and `npm` are `.cmd` shims, and Node refuses to spawn one without a shell
 * (CVE-2024-27980): `check-audit.mjs` and the provisioning proof in `check-packagemanager-pin.mjs`
 * died there with `EINVAL` before anything ran. Neither branch can be reproduced on the runners this
 * suite uses, so the platform is an argument and both branches are driven from here.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { commandPlan, provisionedPnpmPath, quoteForCmd } from './spawn-plan.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('commandPlan', () => {
  it('leaves POSIX exactly as it was: program, args array, no shell', () => {
    assert.deepEqual(commandPlan('pnpm', ['audit', '--json', '--prod'], 'linux'), {
      args: ['audit', '--json', '--prod'],
      file: 'pnpm',
      options: {},
    });
    assert.deepEqual(commandPlan('pnpm', ['audit'], 'darwin').options, {});
  });

  it('gives Windows ONE command string and a shell, with no args array next to it (DEP0190)', () => {
    const plan = commandPlan('pnpm', ['audit', '--json', '--audit-level=high'], 'win32');
    assert.equal(plan.file, 'pnpm audit --json --audit-level=high');
    assert.deepEqual(plan.args, []);
    assert.deepEqual(plan.options, { shell: true });
  });

  it('quotes a Windows temp path with a space in the user name', () => {
    const prefix = 'C:\\Users\\Jane Doe\\AppData\\Local\\Temp\\pin-provision-ab12';
    const plan = commandPlan('npm', ['install', '-g', '--prefix', prefix, 'pnpm@11.14.0'], 'win32');
    assert.equal(plan.file, `npm install -g --prefix "${prefix}" pnpm@11.14.0`);
  });

  it('refuses a token cmd.exe cannot carry intact instead of running something else', () => {
    assert.throws(() => commandPlan('pnpm', ['audit', '--x=%PATH%'], 'win32'), /cannot pass .* to cmd\.exe intact/);
    assert.throws(() => commandPlan('pnpm', ['audit', 'a"b'], 'win32'), /cannot pass/);
    // POSIX never reaches cmd.exe, so the same token is fine there.
    assert.deepEqual(commandPlan('pnpm', ['audit', '--x=%PATH%'], 'linux').args, ['audit', '--x=%PATH%']);
  });
});

describe('quoteForCmd', () => {
  it('passes the flags a CI file actually uses through unchanged', () => {
    for (const token of ['--prod', '--audit-level=high', '--ignore', 'GHSA-x6jw-m9v5-85vh', 'pnpm@11.14.0']) {
      assert.equal(quoteForCmd(token), token);
    }
  });

  it('wraps a token with cmd.exe metacharacters in double quotes', () => {
    assert.equal(quoteForCmd('a&b'), '"a&b"');
    assert.equal(quoteForCmd(''), '""');
  });

  it('doubles trailing backslashes, so the closing quote is not read as an escaped one', () => {
    assert.equal(quoteForCmd('C:\\Jane Doe\\'), '"C:\\Jane Doe\\\\"');
    assert.equal(quoteForCmd('C:\\Jane Doe\\x'), '"C:\\Jane Doe\\x"');
  });
});

describe('provisionedPnpmPath', () => {
  it('follows npm’s global-prefix layout per platform', () => {
    assert.equal(provisionedPnpmPath('/tmp/p', 'linux'), join('/tmp/p', 'bin', 'pnpm'));
    assert.equal(provisionedPnpmPath('/tmp/p', 'darwin'), join('/tmp/p', 'bin', 'pnpm'));
    assert.equal(provisionedPnpmPath('/tmp/p', 'win32'), join('/tmp/p', 'pnpm.cmd'));
  });
});

describe('the scripts that spawn a package manager use the plan', () => {
  // A direct `execFileSync('pnpm', [...])` is exactly the call that dies on Windows, and it
  // reads as correct to anyone on macOS or Linux — so the guard is structural.
  for (const script of ['check-audit.mjs', 'check-packagemanager-pin.mjs']) {
    it(`${script} spawns no package manager directly`, () => {
      const source = readFileSync(join(SCRIPTS, script), 'utf8');
      assert.doesNotMatch(source, /execFileSync\(\s*['"](?:pnpm|npm)['"]/);
      assert.match(source, /commandPlan\(/);
    });
  }

  it('check-packagemanager-pin.mjs asks the plan where npm put pnpm', () => {
    const source = readFileSync(join(SCRIPTS, 'check-packagemanager-pin.mjs'), 'utf8');
    assert.match(source, /provisionedPnpmPath\(prefix\)/);
    assert.doesNotMatch(source, /join\(prefix, 'bin', 'pnpm'\)/);
  });
});
