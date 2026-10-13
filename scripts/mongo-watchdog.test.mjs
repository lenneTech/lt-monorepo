// Contract: the watchdog must be invisible on the happy path and loud on the
// infrastructure path — and it must NEVER change a verdict.
//
// This code only runs during an infrastructure fault, which means it is never
// exercised by a normal pipeline. Left inline in `.gitlab-ci.yml` its first real
// execution would be the day someone is already debugging a red pipeline and is
// depending on it to tell them the truth. These tests run it against a real TCP
// listener that can be killed on demand, so all four shapes are covered in
// seconds:
//
//   exit code passthrough (green AND red)  — a watchdog that swallowed a failure
//                                            would turn a red suite green, which
//                                            is worse than no watchdog at all
//   service dies mid-run                   — abort fast, name the cause
//   service already down at start          — must NOT silently disable itself
//
// The last one is the defect this file was written for: the original inline probe
// could not tell "this shell has no /dev/tcp" from "mongo is already gone", took
// the second for the first, and disabled the watchdog in exactly the scenario it
// existed to catch.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'mongo-watchdog.sh');
const servers = [];
after(() => servers.forEach((s) => s.close()));

/** A throwaway TCP listener standing in for the mongo service container. */
function listener() {
  return new Promise((resolve) => {
    // `probed` settles on the first accepted connection, which is the watchdog's
    // initial probe: its capability check dials 127.0.0.1:9, never this port.
    let markProbed;
    const probed = new Promise((r) => (markProbed = r));
    const server = createServer((socket) => {
      markProbed();
      socket.end();
    });
    servers.push(server);
    // A listening server keeps the event loop alive on its own. While the tests
    // run that is harmless (a child process holds the loop anyway), but if they
    // abort early — a spawn that never starts, say — these fixtures are the only
    // handles left and the process hangs after the last test instead of exiting.
    // unref'd they hold nothing: the run still ends on its own merits.
    server.unref();
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, probed, stop: () => server.close() }));
  });
}

/**
 * Run the watchdog; resolves with its exit code and combined output. `onStart` runs
 * once `started` settles — pass the listener's `probed`.
 */
function watchdog(port, command, { env = {}, onStart, started } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [SCRIPT, '127.0.0.1', String(port), '--', ...command], {
      // KILL_GRACE down from 5 s: the abort path is asserted here many times over,
      // and this suite runs inside `pnpm run check` on every commit.
      env: {
        ...process.env,
        WATCHDOG_INTERVAL: '1',
        WATCHDOG_MISSES: '2',
        WATCHDOG_KILL_GRACE: '0.2',
        WATCHDOG_CONNECT_TIMEOUT: '1',
        ...env,
      },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    // After the initial probe, not after a fixed delay. A 400 ms timer lost the race
    // whenever bash started slowly, as under the parallel load of `pnpm run check`:
    // the service then vanished BEFORE the initial probe, and the run took the
    // "already unreachable" exit instead of the mid-run abort under test.
    if (onStart) started.then(onStart);
    child.on('close', (code) => resolve({ code, out }));
    // A spawn that never starts emits `error` and NEVER `close`, so without this
    // the promise stays pending forever and the whole suite hangs until the CI job
    // timeout kills it. That is not hypothetical: a generated project (lt-crm,
    // DEV-2997) wired `test:scripts` into a `lint` job on `node:24-alpine`, which
    // ships no bash — the job burned its full 1 h budget before failing, instead of
    // the ~1 s this rejection costs. `apk add bash` is the actual fix; this makes
    // the NEXT missing interpreter cost a second rather than an hour.
    child.on('error', (err) => reject(new Error(`could not spawn \`bash ${SCRIPT}\`: ${err.message}`)));
  });
}

describe('mongo-watchdog — exit code passthrough (DEV-3068)', { concurrency: true }, () => {
  it('passes a successful run through as 0', async () => {
    const { port } = await listener();
    const { code } = await watchdog(port, ['sh', '-c', 'sleep 2; exit 0']);
    assert.equal(code, 0, 'a green run must stay green');
  });

  it('passes a FAILING run through unchanged, not as a generic 1', async () => {
    // The load-bearing assertion. If the poll loop ate the status, a red suite
    // would report green and the pipeline would be worse than before the watchdog.
    const { port } = await listener();
    const { code } = await watchdog(port, ['sh', '-c', 'sleep 2; exit 7']);
    assert.equal(code, 7, 'the command exit code must survive the poll loop verbatim');
  });

  it('stays silent while the service is up', async () => {
    const { port } = await listener();
    const { out } = await watchdog(port, ['sh', '-c', 'sleep 1']);
    assert.doesNotMatch(out, /WARN|FATAL/, 'no noise on the happy path');
  });
});

describe('mongo-watchdog — service dies mid-run', { concurrency: true }, () => {
  it('aborts fast with exit 1 instead of letting the command run to its timeout', async () => {
    const { port, probed, stop } = await listener();
    const started = Date.now();
    // The command would run for 60 s; the watchdog must cut it far sooner.
    const { code, out } = await watchdog(port, ['sh', '-c', 'sleep 60'], { onStart: stop, started: probed });
    const elapsed = (Date.now() - started) / 1000;
    assert.equal(code, 1);
    assert.ok(elapsed < 20, `expected a fast abort, took ${elapsed}s`);
    assert.match(out, /FATAL/);
    assert.match(out, /consecutive probes/);
  });

  it('names it an infrastructure fault, not a test failure', async () => {
    const { port, probed, stop } = await listener();
    const { out } = await watchdog(port, ['sh', '-c', 'sleep 60'], { onStart: stop, started: probed });
    assert.match(out, /INFRASTRUCTURE fault, not a test failure/);
    assert.match(out, /read it like this/, 'the decision tree is the point of the dump');
  });

  it('reports the measured window, not a hardcoded number', async () => {
    // 2 misses x 1 s interval — the message must reflect the configuration.
    const { port, probed, stop } = await listener();
    const { out } = await watchdog(port, ['sh', '-c', 'sleep 60'], { onStart: stop, started: probed });
    assert.match(out, /2 consecutive probes at 1s intervals/);
  });

  it('counts only CONSECUTIVE misses — a recovered blip does not abort', async () => {
    const { port, probed, stop } = await listener();
    let restarted = null;
    const { code } = await watchdog(port, ['sh', '-c', 'sleep 4'], {
      started: probed,
      onStart: () => {
        stop();
        // Back before the miss threshold is reached.
        setTimeout(() => {
          const again = createServer((s) => s.end());
          servers.push(again);
          again.unref(); // same reason as in listener()
          again.listen(port, '127.0.0.1');
          restarted = again;
        }, 250);
      },
    });
    assert.ok(restarted, 'test setup: listener should have been restarted');
    assert.equal(code, 0, 'a transient blip below the threshold must not kill a green run');
  });
});

describe('mongo-watchdog — service already down at start', { concurrency: true }, () => {
  it('fails loudly instead of silently disabling itself', async () => {
    // Regression test for the original defect: mongo dying between the readiness
    // step and the watchdog start was misread as "this shell has no /dev/tcp",
    // and the watchdog opted out with a message naming the wrong cause.
    const { port, stop } = await listener();
    stop();
    await new Promise((r) => setTimeout(r, 100));
    const { code, out } = await watchdog(port, ['sh', '-c', 'sleep 10']);
    assert.equal(code, 1);
    assert.match(out, /already unreachable before the run starts/);
    assert.doesNotMatch(out, /\/dev\/tcp unavailable/, 'must not blame the shell for a dead service');
  });
});

describe('mongo-watchdog — forensics hygiene', { concurrency: true }, () => {
  it('keeps raw network dumps out of the log by default', async () => {
    const { port, stop } = await listener();
    stop();
    const { out } = await watchdog(port, ['sh', '-c', 'true']);
    assert.doesNotMatch(out, /nameserver/, 'resolv.conf must not be dumped unasked');
    assert.doesNotMatch(out, /raw \(CI_DEBUG_NETWORK/);
  });

  it('emits them when CI_DEBUG_NETWORK=1 is set explicitly', async () => {
    const { port, stop } = await listener();
    stop();
    const { out } = await watchdog(port, ['sh', '-c', 'true'], { env: { CI_DEBUG_NETWORK: '1' } });
    assert.match(out, /raw \(CI_DEBUG_NETWORK=1\)/);
  });

  it('never invokes `ip`, which is absent from the Playwright image', async () => {
    const { port, stop } = await listener();
    stop();
    const { out } = await watchdog(port, ['sh', '-c', 'true'], { env: { CI_DEBUG_NETWORK: '1' } });
    assert.doesNotMatch(out, /ip: (command )?not found/, 'verified in-image: iproute2 is not installed');
  });
});

describe('mongo-watchdog — usage', { concurrency: true }, () => {
  it('rejects a call without a command instead of running nothing and exiting 0', async () => {
    const { code } = await new Promise((resolve, reject) => {
      const child = spawn('bash', [SCRIPT, '127.0.0.1', '1']);
      child.on('close', (c) => resolve({ code: c }));
      // See the note on `watchdog()` — `error` without `close` would hang here too.
      child.on('error', (err) => reject(new Error(`could not spawn \`bash ${SCRIPT}\`: ${err.message}`)));
    });
    assert.equal(code, 2);
  });
});
