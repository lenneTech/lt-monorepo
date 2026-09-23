/**
 * Test preload (`node --import`): a test may send a real signal only to a process it spawned.
 *
 * Why this exists: on 2026-09-23 a test in the lt CLI called a kill helper with only the
 * platform injected. The signal path stayed real, and `process.kill(-1, 'SIGTERM')` is the
 * kill(2) broadcast — every process of the user. The Mac rebooted two minutes later. The
 * helpers here (`killTree` in check.mjs) have the same shape: they take a pid and signal it,
 * so a test that reaches the real signal path with a foreign pid does real damage.
 *
 * Ported from the CLI's `__tests__/support/signal-guard.ts` (Jest) to `node --test`:
 * `process.kill` with a real signal throws unless its target (or the group it names) is a
 * child this test process spawned. Probing with signal 0 stays allowed — it delivers nothing.
 *
 * Scope: signals sent from inside a test process. A subprocess a test spawns runs without
 * this guard. `ChildProcess#kill` does not go through `process.kill` and is not guarded — its
 * target is the test's own child by construction.
 */
import { ChildProcess } from 'node:child_process';
import { afterEach } from 'node:test';

const SPAWNED = Symbol.for('lt-monorepo.signal-guard.spawned');
const GUARDED = Symbol.for('lt-monorepo.signal-guard.installed');

/**
 * Why a signal must not be sent, or null when it may. Pure, so the guard's own test never has
 * to send anything real to prove the decision.
 */
export function signalVerdict(pid, signal, spawned) {
  if (signal === 0) return null;
  if (typeof pid !== 'number' || !Number.isInteger(pid)) return `refused: pid ${String(pid)} is not an integer`;
  if (pid === 0 || pid === -1) return `refused: pid ${pid} addresses every process of a group or of the user`;
  if (!spawned.has(Math.abs(pid))) {
    return `refused: ${pid < 0 ? 'process group' : 'pid'} ${Math.abs(pid)} was not spawned by this test process`;
  }
  return null;
}

/** Pids of children spawned in this process, shared across every importer. */
function spawnedRegistry() {
  const proto = ChildProcess.prototype;
  if (!proto[SPAWNED]) {
    const spawned = new Set();
    const original = proto.spawn;
    // Every async child_process API (spawn, exec, execFile, fork) ends in
    // ChildProcess.prototype.spawn, so recording here sees all of them. The sync variants
    // never hand out a live pid, so there is nothing of theirs to signal.
    proto.spawn = function (...args) {
      const result = original.apply(this, args);
      if (typeof this.pid === 'number') spawned.add(this.pid);
      return result;
    };
    proto[SPAWNED] = spawned;
  }
  return proto[SPAWNED];
}

const violations = [];

if (!process[GUARDED]) {
  const spawned = spawnedRegistry();
  const realKill = process.kill.bind(process);
  process.kill = (pid, signal) => {
    const verdict = signalVerdict(pid, signal ?? 'SIGTERM', spawned);
    if (verdict) {
      const message = `signal-guard: process.kill(${pid}, ${String(signal ?? 'SIGTERM')}) ${verdict}`;
      violations.push(message);
      throw new Error(message);
    }
    return realKill(pid, signal);
  };
  process[GUARDED] = true;

  // Throwing alone is not enough: code under test that wraps `process.kill` in a try/catch
  // (as killTree does) would swallow the refusal and the test would pass. So a refused signal
  // also fails the test it happened in.
  afterEach(() => {
    if (violations.length === 0) return;
    const found = takeViolations();
    throw new Error(`${found.length} refused signal(s) in this test:\n${found.join('\n')}`);
  });
}

/** Whether this process runs under the guard — for the wiring test. */
export function guardInstalled() {
  return process[GUARDED] === true;
}

/** Drain recorded refusals — for the guard's own tests only. */
export function takeViolations() {
  return violations.splice(0);
}
