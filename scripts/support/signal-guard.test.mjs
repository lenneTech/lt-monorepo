/**
 * The signal guard itself: its decision, and that it is actually loaded.
 *
 * The refusal probe targets a pid far above any pid_max (Linux caps at 2^22, macOS at 99998),
 * so if the guard were missing the call would end in a harmless ESRCH, not in a signal.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { guardInstalled, signalVerdict, takeViolations } from './signal-guard.mjs';

const UNREACHABLE = 2 ** 30;
const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'signal-guard.mjs');

describe('signalVerdict', () => {
  const spawned = new Set([4321]);

  it('refuses the broadcast and the own group', () => {
    assert.match(signalVerdict(-1, 'SIGTERM', spawned), /every process/);
    assert.match(signalVerdict(0, 'SIGTERM', spawned), /every process/);
  });

  it('refuses what is not an integer', () => {
    for (const pid of [undefined, Number.NaN, '4321', 4321.5]) {
      assert.match(signalVerdict(pid, 'SIGTERM', spawned), /not an integer/, String(pid));
    }
  });

  it('refuses a pid or group this process did not spawn', () => {
    assert.match(signalVerdict(1, 'SIGTERM', spawned), /pid 1 was not spawned/);
    assert.match(signalVerdict(-1234, 'SIGKILL', spawned), /process group 1234 was not spawned/);
  });

  it('allows an own child, its group, and the signal-0 probe', () => {
    assert.equal(signalVerdict(4321, 'SIGTERM', spawned), null);
    assert.equal(signalVerdict(-4321, 'SIGKILL', spawned), null);
    assert.equal(signalVerdict(1, 0, spawned), null);
  });
});

describe('signal guard wiring', () => {
  it('is loaded by test:scripts, and both CI pipelines run test:scripts', () => {
    // Without the CI half the guard protected only whoever ran `pnpm run check` locally.
    const root = join(dirname(GUARD), '..', '..');
    const script = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts['test:scripts'];
    assert.match(script, /^node --import \.\/scripts\/support\/signal-guard\.mjs --test /);
    assert.match(readFileSync(join(root, '.github/workflows/test.yml'), 'utf8'), /^ {6}- run: pnpm run test:scripts$/m);
    assert.match(readFileSync(join(root, '.gitlab-ci.yml'), 'utf8'), /^ {4}- pnpm run test:scripts$/m);
  });

  it('is loaded in this test process', () => {
    assert.equal(
      guardInstalled(),
      true,
      'run via `pnpm run test:scripts` (node --import ./scripts/support/signal-guard.mjs)',
    );
  });

  it('refuses a foreign pid through the real process.kill, even when the caller swallows it', () => {
    assert.throws(() => process.kill(UNREACHABLE, 'SIGTERM'), /signal-guard: .* was not spawned/);
    try {
      process.kill(UNREACHABLE, 'SIGKILL');
    } catch {
      /* swallowed, like killTree does */
    }
    // Both refusals are on record for the afterEach hook; drain them so this test stays green.
    assert.equal(takeViolations().length, 2);
  });

  it('lets a real signal reach a child this process spawned', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    await once(child, 'spawn');
    process.kill(child.pid, 'SIGTERM');
    const [code, signal] = await once(child, 'exit');
    assert.equal(code, null);
    assert.equal(signal, 'SIGTERM');
  });

  it('fails the test whose refused signal was swallowed, and only that one', () => {
    // Judged by the runner's exit code and per-test verdicts, not by what the guard prints.
    const dir = mkdtempSync(join(tmpdir(), 'signal-guard-'));
    try {
      const probe = join(dir, 'probe.test.mjs');
      writeFileSync(
        probe,
        [
          "import { it } from 'node:test';",
          `it('swallows', () => { try { process.kill(${UNREACHABLE}, 'SIGTERM'); } catch {} });`,
          "it('clean', () => {});",
        ].join('\n'),
      );
      // Without this the child inherits the outer runner's context, treats itself as nested,
      // runs nothing and exits 0 — measured, and the reason the status is asserted below.
      const { NODE_TEST_CONTEXT: _, ...env } = process.env;
      const run = spawnSync(process.execPath, ['--import', GUARD, '--test', '--test-reporter=tap', probe], {
        encoding: 'utf8',
        env,
      });
      assert.equal(run.status, 1, run.stdout + run.stderr);
      assert.match(run.stdout, /^not ok 1 - swallows$/m);
      assert.match(run.stdout, /^ok 2 - clean$/m);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
