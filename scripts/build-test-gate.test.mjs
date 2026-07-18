import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createBuildTestGate } from './build-test-gate.mjs';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe('createBuildTestGate (DEV-2524)', () => {
  it('lets same-class steps run concurrently (no global mutex)', async () => {
    const gate = createBuildTestGate();
    await gate.acquire('test');
    // A second `test` must be admitted immediately while the first still holds.
    let secondAdmitted = false;
    const second = gate.acquire('test').then(() => {
      secondAdmitted = true;
    });
    await tick();
    assert.equal(secondAdmitted, true, 'second same-class acquire should not block');
    assert.equal(gate.activeCount, 2);
    gate.release();
    gate.release();
    await second;
    assert.equal(gate.activeClass, null);
    assert.equal(gate.activeCount, 0);
  });

  it('lets same-class build steps run concurrently (per-class, not only test)', async () => {
    const gate = createBuildTestGate();
    await gate.acquire('build');
    let secondAdmitted = false;
    const second = gate.acquire('build').then(() => {
      secondAdmitted = true;
    });
    await tick();
    assert.equal(secondAdmitted, true, 'second same-class build acquire should not block');
    assert.equal(gate.activeClass, 'build');
    assert.equal(gate.activeCount, 2);
    gate.release();
    gate.release();
    await second;
    assert.equal(gate.activeClass, null);
    assert.equal(gate.activeCount, 0);
  });

  it('never lets a build overlap a test (cross-class exclusion)', async () => {
    const gate = createBuildTestGate();
    await gate.acquire('test');
    let buildAdmitted = false;
    const build = gate.acquire('build').then(() => {
      buildAdmitted = true;
    });
    await tick(5);
    assert.equal(buildAdmitted, false, 'build must wait while a test is running');
    gate.release(); // test drains → build may take over
    await build;
    assert.equal(buildAdmitted, true);
    assert.equal(gate.activeClass, 'build');
    gate.release();
    assert.equal(gate.activeClass, null);
  });

  it('hands over to the other class in FIFO order without starving it', async () => {
    const gate = createBuildTestGate();
    await gate.acquire('build');
    const order = [];
    const t1 = gate.acquire('test').then(() => order.push('test-1'));
    const t2 = gate.acquire('test').then(() => order.push('test-2'));
    await tick();
    assert.deepEqual(order, [], 'tests wait while build holds the gate');
    gate.release(); // build drains → both queued tests admitted together
    await Promise.all([t1, t2]);
    // Intra-batch order must be FIFO too (matches the test's stated intent).
    assert.deepEqual(order, ['test-1', 'test-2']);
    assert.equal(gate.activeCount, 2);
    gate.release();
    gate.release();
    assert.equal(gate.activeClass, null);
  });

  it('holds the invariant under an interleaved schedule: no test ever runs during a build', async () => {
    const gate = createBuildTestGate();
    const running = { build: 0, test: 0 };
    const peak = { build: 0, test: 0 };
    let violations = 0;

    const runStep = async (kind, ms) => {
      await gate.acquire(kind);
      running[kind] += 1;
      peak[kind] = Math.max(peak[kind], running[kind]);
      // The whole point of the gate: while one class runs, the other must be idle.
      if (running.build > 0 && running.test > 0) {
        violations += 1;
      }
      await tick(ms);
      running[kind] -= 1;
      gate.release();
    };

    // A schedule that mixes both classes, staggered so builds and tests would
    // otherwise overlap under the wrapper's parallel default.
    const steps = [
      ['test', 8],
      ['build', 6],
      ['test', 4],
      ['build', 5],
      ['test', 3],
      ['build', 7],
      ['test', 2],
      ['build', 4],
    ];
    await Promise.all(steps.map(([kind, ms], i) => tick(i).then(() => runStep(kind, ms))));

    assert.equal(violations, 0, 'a build overlapped a test — gate invariant broken');
    assert.ok(peak.test >= 2 || peak.build >= 2, 'same-class steps should have overlapped at least once');
    assert.equal(running.build, 0);
    assert.equal(running.test, 0);
    assert.equal(gate.activeClass, null, 'gate must be idle after all steps drain');
    assert.equal(gate.activeCount, 0);
  });
});
