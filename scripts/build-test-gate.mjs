/**
 * Cross-group mutual exclusion between CPU-heavy `build` steps and the
 * contention-sensitive `test` suites (DEV-2524, Ursache 2).
 *
 * The root check wrapper (scripts/check.mjs) runs each workspace project's step
 * chain concurrently by default. The api group's `test` step is the API-e2e
 * suite: it is already serialized internally (`fileParallelism: false`,
 * `maxWorkers: 1`) precisely because Better-Auth session validation races under
 * CPU contention (DEV-2165 / DEV-2469, documented in
 * projects/api/vitest-e2e.config.ts), so it tips into intermittent 401/500 the
 * moment another group saturates the machine — most reliably the app group's
 * `nuxt build`. This gate guarantees a `build` step and a `test` step never run
 * at the same time, while:
 *   - same-class steps may still overlap (two builds, or the API-e2e suite and
 *     the light app unit run) → the parallel design is preserved elsewhere;
 *   - every other step kind (format, lint, server-start, …) never touches the
 *     gate at all and stays fully parallel.
 *
 * It is a two-class fair lock ("test" vs "build"): whichever class is active
 * admits every waiter of that class; the other class waits until the active
 * class fully drains, then takes over as a batch. Handover is FIFO between the
 * two classes, so neither can starve the other.
 *
 * Starvation-freedom is workload-bounded, not unconditional: an arriving acquire
 * of the ACTIVE class barges ahead of an already-queued opposite-class waiter, so
 * an unbounded stream of same-class arrivals could in theory starve the other
 * class. That cannot happen here — the check wrapper issues finitely many gated
 * steps per group (each project chain has one `test` then one `build`), so the
 * active class always drains and the queued batch is then admitted.
 */
export function createBuildTestGate() {
  let activeClass = null; // 'test' | 'build' | null
  let activeCount = 0;
  const queue = []; // FIFO of { klass, resolve }

  function admit(klass, resolve) {
    activeClass = klass;
    activeCount += 1;
    resolve();
  }

  function acquire(klass) {
    return new Promise((resolve) => {
      if (activeClass === null || activeClass === klass) {
        admit(klass, resolve);
      } else {
        queue.push({ klass, resolve });
      }
    });
  }

  function release() {
    activeCount -= 1;
    if (activeCount > 0) {
      return; // active class still busy
    }
    activeClass = null;
    if (queue.length === 0) {
      return; // idle
    }
    // Active class fully drained with waiters pending: hand over to the class of
    // the oldest waiter, admitting every queued waiter of that class as a batch.
    //
    // Via the public API the queue only ever holds a SINGLE class at a time (a
    // same-class acquire is admitted immediately and never queues, so only the
    // opposite class waits while one class is active). The `carried` re-queue is
    // therefore always empty in practice — kept as a defensive guard so the
    // handover stays correct if the admission rule ever changes.
    const nextClass = queue[0].klass;
    const carried = [];
    for (const waiter of queue) {
      if (waiter.klass === nextClass) {
        admit(waiter.klass, waiter.resolve);
      } else {
        carried.push(waiter);
      }
    }
    queue.length = 0;
    queue.push(...carried);
  }

  return {
    acquire,
    release,
    // Read-only accessors, exposed for assertions / telemetry only.
    get activeClass() {
      return activeClass;
    },
    get activeCount() {
      return activeCount;
    },
  };
}
