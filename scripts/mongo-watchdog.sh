#!/usr/bin/env bash
#
# Run a command while watching that a TCP service stays reachable.
#
#   scripts/mongo-watchdog.sh <host> <port> -- <command> [args...]
#
# Why this exists (provenance: lenne.tech DEV-3068 — internal tracker; everything
# needed to act on it is in this file, the ID is for the template maintainers):
# when the mongo SERVICE CONTAINER disappears mid-job, every later DB call waits
# out MongoDB's 30 s server-selection timeout. With Playwright's own retries that
# is ~95 s per test, so one infrastructure fault burns ~19 min per shard while
# verifying nothing — and the log reads like failing sign-up tests, with the real
# cause thousands of lines up. This turns that into a fast, correctly NAMED
# failure.
#
# It is a shell script and not 55 inline lines of `.gitlab-ci.yml` for one reason:
# this code only ever executes during an infrastructure fault, i.e. never on the
# happy path. Inline, its first real execution would be the day someone depends on
# it to explain a red pipeline. As a file it has scripts/mongo-watchdog.test.mjs.
#
# Exit code: the command's own, unchanged — so a genuinely failing test run stays
# red and a green one stays green. The watchdog only ever converts a HANG into a
# fast failure (exit 1). Verified in both directions by the test file.
#
# Environment:
#   WATCHDOG_INTERVAL   seconds between probes (default 3)
#   WATCHDOG_MISSES     consecutive misses before aborting (default 15 → 45 s)
#   WATCHDOG_KILL_GRACE seconds between SIGTERM and SIGKILL (default 5)
#   WATCHDOG_API_URL    optional URL whose liveness is reported in the forensics
#   CI_DEBUG_NETWORK=1  also dump raw resolv.conf / addresses / routes
set -uo pipefail

INTERVAL="${WATCHDOG_INTERVAL:-3}"
MAX_MISSES="${WATCHDOG_MISSES:-15}"
# Playwright's SIGTERM teardown can itself block on the dead service, so it gets a
# grace period before SIGKILL. Configurable so the test suite does not pay it.
KILL_GRACE="${WATCHDOG_KILL_GRACE:-5}"

if [ "${1:-}" = "--help" ] || [ $# -lt 3 ]; then
  echo "usage: $0 <host> <port> -- <command> [args...]" >&2
  exit 2
fi
HOST="$1"
PORT="$2"
shift 2
[ "${1:-}" = "--" ] && shift
[ $# -ge 1 ] || { echo "$0: no command given" >&2; exit 2; }

# ── probes ───────────────────────────────────────────────────────────────────
# Connect attempt with a hard ceiling. Without `timeout` a hanging SYN blocks for
# the kernel's full SYN-retry budget (~2 min), and the advertised abort window
# silently stops holding — in exactly the "lost the build network" case this is
# written to diagnose.
probe() {
  timeout "${WATCHDOG_CONNECT_TIMEOUT:-5}" bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null
}

# Can this shell do /dev/tcp AT ALL? Deliberately separate from "is the service
# up", and this separation is the point:
#
# A single combined probe cannot tell "this shell lacks /dev/tcp" from "mongo is
# already gone" — both just fail. The inline version this replaces took the second
# case for the first and DISABLED itself, printing a message that named the wrong
# cause, in precisely the scenario it was built for. (Its comment argued the
# readiness step "has just proven mongo reachable", but minutes of migrations and
# API boot sit in between.)
#
# So we probe a port that is definitionally closed and read the FAILURE MODE:
# bash reports a refused connection, a shell without net-redirections reports that
# the path does not exist. Only the latter means "no capability".
probe_capability() {
  local err
  err="$( (exec 3<>/dev/tcp/127.0.0.1/9) 2>&1 )"
  case "$err" in
    *'o such file'* | *'not found'* | *'restricted'* | *'Bad file descriptor'*) return 1 ;;
    *) return 0 ;;
  esac
}

forensics() {
  echo "--- forensics: WHICH of the three failure shapes is this? ---"
  if getent hosts "$HOST" >/dev/null 2>&1; then
    echo "  $HOST alias:      RESOLVES"
  else
    echo "  $HOST alias:      GONE"
  fi
  # Docker's embedded resolver. Reachable + alias gone => the container died;
  # unreachable => this container lost the build network.
  if probe 127.0.0.11 53; then
    echo "  embedded DNS:      reachable"
  else
    echo "  embedded DNS:      UNREACHABLE"
  fi
  if [ -n "${WATCHDOG_API_URL:-}" ]; then
    if wget -q --spider --timeout=5 "$WATCHDOG_API_URL" >/dev/null 2>&1; then
      echo "  API:               alive"
    else
      echo "  API:               not responding"
    fi
  fi
  # Raw dumps are opt-in. They add nothing to the decision tree below, and job
  # logs are readable by anyone the project's `public_builds` setting lets in
  # (default: on) — including Guests without repo access.
  if [ "${CI_DEBUG_NETWORK:-0}" = "1" ]; then
    echo "  --- raw (CI_DEBUG_NETWORK=1) ---"
    sed 's/^/    /' /etc/resolv.conf 2>&1 || true
    # NOT `ip`: iproute2 is absent from mcr.microsoft.com/playwright:*-noble, so
    # an `ip route` line prints a permanently empty section. Verified in-image.
    { hostname -I 2>/dev/null || true; } | sed 's/^/    addr: /'
    { cat /proc/net/route 2>/dev/null || true; } | sed 's/^/    route: /'
  fi
  echo "  read it like this: alias GONE + DNS reachable   => the $HOST CONTAINER died."
  echo "                     alias GONE + DNS unreachable => this container lost the build NETWORK."
  echo "                     alias RESOLVES               => not a service fault; look at the daemon itself."
  echo "-------------------------------------------------------------"
}

# ── run ──────────────────────────────────────────────────────────────────────
# Job control on, so the child becomes its own process group leader and can be
# signalled as a GROUP. `$!` is the `pnpm exec` wrapper; killing only that leaves
# the node process and its browsers orphaned, still holding CPU and still writing
# into test-results while artifacts are being collected.
set -m
"$@" &
CHILD=$!
set +m

if ! probe_capability; then
  # No /dev/tcp in this shell — supervise nothing rather than kill a healthy job.
  echo "NOTE: /dev/tcp unavailable in this shell - running without the $HOST watchdog." >&2
  wait "$CHILD"
  exit $?
fi

if ! probe "$HOST" "$PORT"; then
  # Capability is present, so this is a real outage, not a broken probe. Saying so
  # up front beats discovering it 40 minutes later in a job timeout.
  echo "FATAL: $HOST:$PORT is already unreachable before the run starts." >&2
  forensics >&2
  kill -TERM -"$CHILD" 2>/dev/null || kill -TERM "$CHILD" 2>/dev/null || true
  sleep "$KILL_GRACE"
  kill -KILL -"$CHILD" 2>/dev/null || kill -KILL "$CHILD" 2>/dev/null || true
  wait "$CHILD" 2>/dev/null
  exit 1
fi

MISSES=0
while kill -0 "$CHILD" 2>/dev/null; do
  sleep "$INTERVAL"
  if probe "$HOST" "$PORT"; then
    MISSES=0
    continue
  fi
  MISSES=$((MISSES + 1))
  echo "WARN: $HOST:$PORT unreachable (${MISSES}/${MAX_MISSES})"
  [ "$MISSES" -ge "$MAX_MISSES" ] || continue

  # State the probe COUNT and the interval rather than a wall-clock figure. A
  # blocking getaddrinfo stretches each iteration well past INTERVAL, so any
  # precomputed "gone for 45s" can be wrong by 30 s or more — in exactly the
  # lost-the-network case this dump is meant to diagnose. Counts cannot drift.
  echo "FATAL: $HOST:$PORT has failed ${MAX_MISSES} consecutive probes at ${INTERVAL}s intervals."
  echo "       This is a CI INFRASTRUCTURE fault, not a test failure."
  echo "       Aborting now instead of letting every remaining test burn"
  echo "       MongoDB's 30s server-selection timeout until the job times out."
  forensics
  kill -TERM -"$CHILD" 2>/dev/null || kill -TERM "$CHILD" 2>/dev/null || true
  sleep "$KILL_GRACE"
  kill -KILL -"$CHILD" 2>/dev/null || kill -KILL "$CHILD" 2>/dev/null || true
  wait "$CHILD" 2>/dev/null
  exit 1
done

# The loop ends when the child is gone. Bash keeps a terminated background job's
# status in its job table until `wait` consumes it, so this still yields the
# command's real exit code rather than an error.
wait "$CHILD"
