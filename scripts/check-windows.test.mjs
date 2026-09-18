/**
 * What has to behave differently on Windows, or the run dies there while every macOS and CI
 * run stays green. Each case below was measured on a Windows laptop against a project
 * generated from cli 1.47.0, and none of them can be reproduced by the suite that runs here —
 * so the helpers take the platform as an argument and this file drives both branches.
 *
 * 1. The build-dir pin. `VAR=value cmd` is POSIX shell syntax; cmd.exe reads the assignment as
 *    the command name and the step dies. The prefix is therefore dropped on Windows, which only
 *    works because the same value reaches the child as a real environment variable.
 * 2. Killing a process tree. Windows has no `pgrep` and no signals, and `taskkill /T` without
 *    `/F` was measured to leave the tree alive with the port still held.
 * 3. The shell the root scripts are written in. cmd.exe has no `true`, so `<cmd> || true` —
 *    the idiom for "this step may fail" — fails twice and takes the whole install down. It has
 *    no `rm` either, which is how `reinit` died before it deleted anything.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { killTreePlan, pinCheckBuildDir, stepEnv } from './check.mjs';
import { removeAll, resolveTarget } from './remove.mjs';

const CHECK_DIR = '.nuxt-check';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rootScripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts;

/**
 * Programs a POSIX shell has and cmd.exe does not.
 *
 * `true` is deliberately absent: the `|| true` case below names that one with a message that
 * says what to write instead, and two failures for one mistake help nobody.
 */
const POSIX_ONLY = new Set([
  'awk',
  'cat',
  'chmod',
  'chown',
  'cp',
  'find',
  'grep',
  'kill',
  'ln',
  'mkdir',
  'mv',
  'open',
  'pgrep',
  'rm',
  'rmdir',
  'sed',
  'sleep',
  'touch',
  'which',
  'xargs',
]);

/**
 * The program a shell segment actually runs.
 *
 * Matching the raw text would be wrong in both directions: `--find` or a script named
 * `rm:cache` is not a call to `find` or `rm`, and a command hidden behind `cross-env` or an
 * environment assignment IS one. So the leading assignments and `cross-env` are stepped over
 * and only the resulting first word counts.
 */
function commandOf(segment) {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && (words[i] === 'cross-env' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))) i++;
  return words[i] ?? '';
}

describe('pinCheckBuildDir across platforms', () => {
  it('writes the textual prefix on POSIX', () => {
    assert.equal(pinCheckBuildDir('pnpm install', 'darwin'), `NUXT_BUILD_DIR=${CHECK_DIR} pnpm install`);
    assert.equal(pinCheckBuildDir('pnpm audit --fix', 'linux'), `NUXT_BUILD_DIR=${CHECK_DIR} pnpm audit --fix`);
  });

  it('writes no prefix on Windows, where cmd.exe would read it as the command name', () => {
    for (const cmd of ['pnpm install', 'pnpm audit', 'npm ci', 'pnpm run check:install-guard']) {
      assert.equal(pinCheckBuildDir(cmd, 'win32'), cmd, `\`${cmd}\` must stay untouched on win32`);
    }
  });

  it('leaves non-package-manager steps alone everywhere', () => {
    for (const platform of ['darwin', 'win32']) {
      assert.equal(pinCheckBuildDir('pnpm run test:unit', platform), 'pnpm run test:unit');
    }
  });

  it('keeps a pin the command carries itself', () => {
    const own = `cross-env NUXT_BUILD_DIR=.nuxt-other pnpm install`;
    assert.equal(pinCheckBuildDir(own, 'darwin'), own);
    assert.equal(pinCheckBuildDir(own, 'win32'), own);
  });

  it('hands every command the pin covers a build dir through the environment', () => {
    // The Windows branch drops the prefix and relies entirely on what `stepEnv` supplies. If
    // this pairing breaks, the pin does not fail loudly — it silently stops applying on the one
    // platform none of the other tests run on, and the check writes into the dev build dir.
    for (const cmd of ['pnpm install --frozen-lockfile', 'pnpm audit', 'npm ci', 'yarn install']) {
      assert.notEqual(pinCheckBuildDir(cmd, 'darwin'), cmd, `\`${cmd}\` is expected to be pinned on POSIX`);
      assert.deepEqual(
        stepEnv({ cmd: pinCheckBuildDir(cmd, 'win32') }),
        { NUXT_BUILD_DIR: CHECK_DIR },
        `on Windows \`${cmd}\` runs with no prefix, so stepEnv must supply the build dir`,
      );
    }
  });

  it('gives an ordinary step no environment of its own', () => {
    assert.equal(stepEnv({ cmd: 'pnpm run test:unit' }), null);
  });

  it('covers a step the prefix could never reach', () => {
    // The `;` and leading-`cd` shapes the prefix cannot bind to. These are the reason stepEnv
    // exists at all, and they must keep working now that its predicate changed.
    assert.deepEqual(stepEnv({ cmd: 'cd projects/app && pnpm install' }), { NUXT_BUILD_DIR: CHECK_DIR });
    assert.deepEqual(stepEnv({ cmd: 'echo hi ; pnpm install' }), { NUXT_BUILD_DIR: CHECK_DIR });
  });
});

describe('root scripts survive cmd.exe', () => {
  it('no script swallows a failure with `|| true`', () => {
    // Measured: `pnpm install --prod` in a generated workspace drops husky, `prepare` runs
    // `husky || true`, and cmd.exe answers BOTH halves with "ist entweder falsch geschrieben
    // oder konnte nicht gefunden werden" — it has no `true` command. The prepare script exits
    // 1 and pnpm aborts the entire install. `|| exit 0` is the portable spelling: it means the
    // same thing in sh and in cmd.exe.
    for (const [name, cmd] of Object.entries(rootScripts)) {
      assert.doesNotMatch(
        cmd,
        /\|\|\s*true\b/,
        `\`${name}\` ends a failure path with \`|| true\`; cmd.exe has no \`true\`, so the script fails instead of passing. Use \`|| exit 0\``,
      );
    }
  });

  it('no script calls a program cmd.exe does not have', () => {
    // `reinit` ran `rm -rf node_modules`, so on Windows it failed before deleting anything —
    // the same class as `|| true`, one command further along. The portable replacement is
    // `node scripts/remove.mjs`, because node is the one interpreter a package-manager script
    // can count on: pnpm is running on it.
    let seen = 0;
    for (const [name, chain] of Object.entries(rootScripts)) {
      for (const segment of chain.split(/&&|\|\||;|\|/)) {
        const command = commandOf(segment);
        seen++;
        assert.ok(
          !POSIX_ONLY.has(command),
          `\`${name}\` runs \`${command}\`, which cmd.exe does not have — the step dies on Windows before it does anything. For file removal use \`node scripts/remove.mjs <path…>\``,
        );
      }
    }
    assert.ok(seen > 20, `only ${seen} script segments scanned — the rule is no longer reading the scripts`);
  });

  it('`prepare` still tolerates a missing husky', () => {
    // The reason the `|| …` is there at all: a production install (`--prod`, `--no-optional`)
    // has no husky, and installing git hooks is not what such an install is for. Without the
    // fallback the whole install fails on a dev-only tool.
    assert.match(
      rootScripts.prepare ?? '',
      /^husky\s*\|\|\s*exit 0$/,
      '`prepare` must run husky and step aside when it is absent, in a form both shells understand',
    );
  });
});

describe('scripts/remove.mjs — the portable `rm -rf`', () => {
  const dirs = [];
  const sandbox = () => {
    const dir = mkdtempSync(join(tmpdir(), 'remove-test-'));
    dirs.push(dir);
    return dir;
  };
  after(() => {
    for (const dir of dirs) rmSync(dir, { force: true, recursive: true });
  });

  it('removes a directory tree and a file in one call', () => {
    const root = sandbox();
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), '');
    writeFileSync(join(root, 'pnpm-lock.yaml'), '');
    removeAll(['node_modules', 'pnpm-lock.yaml'], root);
    assert.equal(existsSync(join(root, 'node_modules')), false);
    assert.equal(existsSync(join(root, 'pnpm-lock.yaml')), false);
  });

  it('treats an absent path as done, not as an error', () => {
    // `reinit` runs on trees that were never installed — that is precisely when node_modules
    // is missing, and `rm -rf` did not mind either.
    const root = sandbox();
    assert.doesNotThrow(() => removeAll(['node_modules'], root));
  });

  it('refuses a path outside the repository root', () => {
    const root = sandbox();
    for (const target of ['..', '../sibling', root]) {
      assert.throws(() => resolveTarget(target, root), /outside the repository root|refusing/);
    }
  });
});

describe('killTreePlan', () => {
  it('forces the whole tree on Windows', () => {
    const plan = killTreePlan(4321, 'SIGTERM', 'win32');
    assert.equal(plan.command, 'taskkill');
    assert.deepEqual(plan.args, ['/PID', '4321', '/T', '/F']);
  });

  it('keeps /F even for the polite signal, because Windows has no polite stage', () => {
    // `taskkill /T` without `/F` was measured to answer "Die Beendigung dieses Prozesses muss
    // erzwungen werden" and leave the port held — the hang the watchdog exists to end.
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      assert.ok(killTreePlan(1, signal, 'win32').args.includes('/F'), `${signal} must still force`);
    }
  });

  it('passes the signal through on POSIX and names no command', () => {
    assert.deepEqual(killTreePlan(4321, 'SIGTERM', 'linux'), { signal: 'SIGTERM' });
    assert.deepEqual(killTreePlan(4321, 'SIGKILL', 'darwin'), { signal: 'SIGKILL' });
  });
});
