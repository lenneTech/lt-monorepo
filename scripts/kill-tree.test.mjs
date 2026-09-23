/**
 * `killTreeWith` executes the plan — tested with every effect injected.
 *
 * The plan tests in check-windows.test.mjs say what SHOULD happen; these prove that `killTree`
 * does it: taskkill runs with the plan's arguments, the POSIX tree is signalled leaves first
 * and each pid once, and a pid that is not a process we own reaches no effect at all.
 *
 * Nothing here signals a real process. The fakes below only record, and the signal guard
 * (scripts/support/signal-guard.mjs, loaded by `test:scripts`) fails any test that tries.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isKillablePid, killTreeWith } from './check.mjs';

/** Records every effect instead of performing it. `tree` maps a pid to its direct children. */
function recorder(platform, tree = {}) {
  const calls = { childrenOf: [], run: [], signal: [] };
  const deps = {
    childrenOf: (pid) => {
      calls.childrenOf.push(pid);
      return tree[pid] ?? [];
    },
    platform,
    run: (command, args) => calls.run.push([command, args]),
    signal: (pid, sig) => calls.signal.push([pid, sig]),
  };
  return { calls, deps };
}

/** Everything a failed spawn, a corrupt value or a reserved pid can put in `child.pid`. */
const NOT_OURS = [undefined, null, Number.NaN, '4321', 4321.5, -4321, -1, 0, 1];

describe('killTreeWith — pid gate', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    it(`reaches no effect for a pid that is not ours (${platform})`, () => {
      for (const pid of NOT_OURS) {
        const { calls, deps } = recorder(platform, { 1: [4321] });
        killTreeWith(pid, 'SIGTERM', deps);
        assert.deepEqual(calls, { childrenOf: [], run: [], signal: [] }, `pid ${String(pid)} on ${platform}`);
      }
    });
  }

  it('never builds `taskkill /PID undefined` from a failed spawn', () => {
    const { calls, deps } = recorder('win32');
    killTreeWith(undefined, 'SIGTERM', deps);
    assert.deepEqual(calls.run, []);
  });

  it('refuses the Windows System pids 0 and 4, but not 5', () => {
    for (const pid of [0, 4]) {
      const { calls, deps } = recorder('win32');
      killTreeWith(pid, 'SIGKILL', deps);
      assert.deepEqual(calls.run, [], `pid ${pid}`);
    }
    const { calls, deps } = recorder('win32');
    killTreeWith(5, 'SIGKILL', deps);
    assert.deepEqual(calls.run, [['taskkill', ['/PID', '5', '/T', '/F']]]);
  });

  it('draws the POSIX line between 1 and 2', () => {
    assert.equal(isKillablePid(1, 'linux'), false);
    assert.equal(isKillablePid(2, 'linux'), true);
  });
});

describe('killTreeWith — Windows', () => {
  it('runs the plan once and asks neither pgrep nor signals', () => {
    const { calls, deps } = recorder('win32', { 4321: [5000] });
    killTreeWith(4321, 'SIGTERM', deps);
    assert.deepEqual(calls, { childrenOf: [], run: [['taskkill', ['/PID', '4321', '/T', '/F']]], signal: [] });
  });

  it('swallows a failing taskkill (tree already gone)', () => {
    const { deps } = recorder('win32');
    deps.run = () => {
      throw new Error('ERROR: The process "4321" not found.');
    };
    assert.doesNotThrow(() => killTreeWith(4321, 'SIGTERM', deps));
  });
});

describe('killTreeWith — POSIX', () => {
  it('signals every pid of the tree, leaves before their parent, each once', () => {
    // 100 ─┬─ 200 ─── 400
    //      └─ 300 ─┬─ 500
    //              └─ 600
    const tree = { 100: [200, 300], 200: [400], 300: [500, 600] };
    const { calls, deps } = recorder('darwin', tree);
    killTreeWith(100, 'SIGTERM', deps);

    const order = calls.signal.map(([pid]) => pid);
    assert.deepEqual(
      order.toSorted((a, b) => a - b),
      [100, 200, 300, 400, 500, 600],
    );
    assert.equal(new Set(order).size, order.length, 'a pid was signalled twice');
    for (const [parent, children] of Object.entries(tree)) {
      for (const child of children) {
        assert.ok(order.indexOf(child) < order.indexOf(Number(parent)), `${child} must die before ${parent}`);
      }
    }
    assert.ok(calls.signal.every(([, sig]) => sig === 'SIGTERM'));
    assert.deepEqual(calls.run, []);
  });

  it('passes SIGKILL through unchanged', () => {
    const { calls, deps } = recorder('linux');
    killTreeWith(4321, 'SIGKILL', deps);
    assert.deepEqual(calls.signal, [[4321, 'SIGKILL']]);
  });

  it('signals a pid once even when the lookup reports it twice', () => {
    // A pid reused between two pgrep calls can show up under two parents, or loop back.
    const { calls, deps } = recorder('linux', { 100: [200, 200], 200: [100] });
    killTreeWith(100, 'SIGTERM', deps);
    assert.deepEqual(calls.signal, [
      [200, 'SIGTERM'],
      [100, 'SIGTERM'],
    ]);
  });

  it('drops children that are not ours instead of signalling them', () => {
    const { calls, deps } = recorder('linux', { 100: [1, 0, -1, Number.NaN, 200] });
    killTreeWith(100, 'SIGTERM', deps);
    assert.deepEqual(calls.signal, [
      [200, 'SIGTERM'],
      [100, 'SIGTERM'],
    ]);
  });

  it('keeps going when the lookup or a signal throws', () => {
    const { calls, deps } = recorder('linux', { 100: [200, 300] });
    const lookup = deps.childrenOf;
    deps.childrenOf = (pid) => {
      if (pid === 200) throw new Error('pgrep: exit 1');
      return lookup(pid);
    };
    const send = deps.signal;
    deps.signal = (pid, sig) => {
      send(pid, sig);
      if (pid === 200) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    };
    killTreeWith(100, 'SIGTERM', deps);
    assert.deepEqual(
      calls.signal.map(([pid]) => pid),
      [200, 300, 100],
    );
  });
});

describe('killTreeWith — nothing real by omission', () => {
  const full = () => recorder('linux').deps;
  for (const name of ['childrenOf', 'platform', 'run', 'signal']) {
    it(`throws when \`${name}\` is not injected`, () => {
      const deps = full();
      delete deps[name];
      assert.throws(() => killTreeWith(4321, 'SIGTERM', deps), new RegExp(`\`${name}\` must be injected`));
    });
  }
});
