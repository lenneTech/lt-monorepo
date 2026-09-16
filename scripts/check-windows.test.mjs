/**
 * The two places where the check runner has to behave differently on Windows.
 *
 * Both were measured on a Windows laptop against a project generated from cli 1.47.0, and
 * neither can be reproduced by the suite that runs on macOS and in CI — the platform branch is
 * the only thing a test here can hold onto. So both helpers take the platform as an argument
 * and this file drives them from both sides.
 *
 * 1. The build-dir pin. `VAR=value cmd` is POSIX shell syntax; cmd.exe reads the assignment as
 *    the command name and the step dies. The prefix is therefore dropped on Windows, which only
 *    works because the same value reaches the child as a real environment variable.
 * 2. Killing a process tree. Windows has no `pgrep` and no signals, and `taskkill /T` without
 *    `/F` was measured to leave the tree alive with the port still held.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { killTreePlan, pinCheckBuildDir, stepEnv } from './check.mjs';

const CHECK_DIR = '.nuxt-check';

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
