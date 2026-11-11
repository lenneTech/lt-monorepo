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

import { escalateWatchdog, isKillablePid, killTreeWith } from './check.mjs';

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

describe('killTreeWith — SIGKILL escalation after the root died', () => {
  // The watchdog's two passes, as seen in a generated Angular project: 100 is the step's
  // `sh -c`, 101 pnpm, 102 pnpm's output helper (`trap '' TERM`). SIGTERM kills 100; 101 and
  // 102 survive and are re-parented to init, so `pgrep -P 100` finds nothing five seconds later.
  const BEFORE = { 100: [101], 101: [102] };
  const AFTER = { 1: [101], 101: [102] };

  it('returns the pids it signalled, leaves first', () => {
    const { deps } = recorder('linux', BEFORE);
    assert.deepEqual(killTreeWith(100, 'SIGTERM', deps), [102, 101, 100]);
  });

  it('starting from the dead root alone kills none of the survivors', () => {
    // What the escalation did before: it signalled the dead root and nothing else.
    const { calls, deps } = recorder('linux', AFTER);
    killTreeWith(100, 'SIGKILL', deps);
    assert.deepEqual(calls.signal, [[100, 'SIGKILL']]);
  });

  it('kills every survivor when it also starts from the pids SIGTERM saw', () => {
    const termed = killTreeWith(100, 'SIGTERM', recorder('linux', BEFORE).deps);
    const { calls, deps } = recorder('linux', AFTER);
    killTreeWith([100, ...termed], 'SIGKILL', deps);
    const killed = calls.signal.map(([pid]) => pid);
    assert.ok(killed.includes(101) && killed.includes(102), `survivors not killed: ${JSON.stringify(killed)}`);
    assert.ok(killed.indexOf(102) < killed.indexOf(101), 'leaves first');
    assert.equal(new Set(killed).size, killed.length, 'a pid was signalled twice');
    assert.ok(calls.signal.every(([, sig]) => sig === 'SIGKILL'));
  });

  it('also kills a child a survivor spawned between the two passes', () => {
    const { calls, deps } = recorder('linux', { 101: [103] });
    killTreeWith([100, 102, 101], 'SIGKILL', deps);
    const killed = calls.signal.map(([pid]) => pid);
    assert.ok(killed.indexOf(103) < killed.indexOf(101), `${JSON.stringify(killed)}`);
  });

  it('applies the pid gate to every root', () => {
    const { calls, deps } = recorder('linux');
    assert.deepEqual(killTreeWith([undefined, 1, 0, 4321], 'SIGKILL', deps), [4321]);
    assert.deepEqual(calls.signal, [[4321, 'SIGKILL']]);
  });

  it('runs one taskkill per root on Windows', () => {
    const { calls, deps } = recorder('win32');
    assert.deepEqual(killTreeWith([5, 6], 'SIGKILL', deps), [5, 6]);
    assert.deepEqual(calls.run, [
      ['taskkill', ['/PID', '5', '/T', '/F']],
      ['taskkill', ['/PID', '6', '/T', '/F']],
    ]);
  });
});

describe('escalateWatchdog — the sequence after a step went silent', () => {
  // `capture` hands this its kill and settle effects. Without the SIGKILL from the SIGTERM
  // pids, a TERM-ignoring survivor keeps the pipes open; without the settle, anything that
  // escapes both passes does. Either way `check` hung for hours instead of failing.
  const TERMED = [102, 101, 100];

  /** Records every kill; the SIGTERM pass reports TERMED as signalled. */
  function effects() {
    const kills = [];
    let settles = 0;
    return {
      kill: (signal, alsoPids) => {
        kills.push([signal, alsoPids]);
        return signal === 'SIGTERM' ? TERMED : [];
      },
      kills,
      settle: () => {
        settles += 1;
      },
      settles: () => settles,
    };
  }

  it('sends SIGTERM at once and SIGKILL five seconds later, from every pid SIGTERM signalled', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fx = effects();
    escalateWatchdog(fx.kill, fx.settle);
    assert.deepEqual(fx.kills, [['SIGTERM', []]]);
    t.mock.timers.tick(4999);
    assert.equal(fx.kills.length, 1);
    t.mock.timers.tick(1);
    assert.deepEqual(fx.kills, [
      ['SIGTERM', []],
      ['SIGKILL', TERMED],
    ]);
  });

  it('settles the step two seconds after SIGKILL, once, when nothing closed it', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fx = effects();
    escalateWatchdog(fx.kill, fx.settle);
    // Two ticks: a timer created inside a tick counts from the end of that tick.
    t.mock.timers.tick(5000);
    t.mock.timers.tick(1999);
    assert.equal(fx.settles(), 0);
    t.mock.timers.tick(1);
    assert.equal(fx.settles(), 1);
    t.mock.timers.tick(60_000);
    assert.equal(fx.settles(), 1);
  });

  it('stops what is still pending once the step closed on its own', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const beforeKill = effects();
    escalateWatchdog(beforeKill.kill, beforeKill.settle)();
    t.mock.timers.tick(60_000);
    assert.deepEqual(beforeKill.kills, [['SIGTERM', []]]);
    assert.equal(beforeKill.settles(), 0);

    const afterKill = effects();
    const cancel = escalateWatchdog(afterKill.kill, afterKill.settle);
    t.mock.timers.tick(5000);
    cancel();
    t.mock.timers.tick(60_000);
    assert.equal(afterKill.kills.length, 2);
    assert.equal(afterKill.settles(), 0);
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
