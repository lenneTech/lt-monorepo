#!/usr/bin/env node
/**
 * Wait until a TCP port accepts a connection, or give up.
 *
 *   node scripts/wait-for-tcp.mjs <host> <port> [timeoutSeconds]
 *
 * Why this exists rather than the one-liner it replaces:
 *
 *   timeout 120 bash -c 'until (exec 3<>/dev/tcp/mongo/27017) 2>/dev/null; do sleep 2; done'
 *
 * `/dev/tcp` is a **bash builtin**, not a device — it does not exist in any other
 * shell. The GitLab pipeline's global image is `node:22-alpine`, whose `/bin/sh` is
 * busybox and which ships no bash at all, so that line failed with
 * `timeout: can't execute 'bash': No such file or directory` and exit 127 — before a
 * single test ran, in every generated project, from 2026-08-18 until this fix.
 *
 * It went unnoticed because the job that DOES have bash (`app:test`, on the Ubuntu
 * -based Playwright image) uses the same idiom and is fine, and because GitHub's
 * runners have bash too. Only the Alpine-based `api:test` job was affected.
 *
 * Node is the one interpreter guaranteed to be present in every image this pipeline
 * uses, so the probe belongs here rather than in a shell that varies per job.
 */
import { connect } from "node:net";

const [host, portArg, timeoutArg] = process.argv.slice(2);
const port = Number(portArg);
const timeoutSeconds = Number(timeoutArg ?? 120);

if (!host || !Number.isInteger(port) || port <= 0) {
  console.error("usage: node scripts/wait-for-tcp.mjs <host> <port> [timeoutSeconds]");
  process.exit(2);
}

const deadline = Date.now() + timeoutSeconds * 1000;

/** One connection attempt. Resolves true on connect, false on any failure. */
function probe() {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    // Per-attempt cap: without it a silently dropped SYN hangs until the OS gives up,
    // which can exceed the whole budget in a single attempt.
    socket.setTimeout(5000);
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

while (Date.now() < deadline) {
  if (await probe()) {
    console.log(`[wait-for-tcp] ${host}:${port} is accepting connections`);
    process.exit(0);
  }
  await sleep(2000);
}

console.error(`[wait-for-tcp] ${host}:${port} not reachable within ${timeoutSeconds}s`);
process.exit(1);
