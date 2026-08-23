---
name: ci-verification-anchors
description: Where to re-verify the non-obvious upstream behaviours the lt-monorepo CI pipeline depends on (Playwright shard granularity, NODE_ENV default, pnpm auditConfig, artifact/no-match semantics).
metadata:
  type: reference
---

Facts about `.gitlab-ci.yml` / `app:test` that are expensive to re-derive. Each line says WHERE to
re-check, because upstream can change these.

- **Playwright `--shard` granularity** — with `fullyParallel: true` Playwright shards at the
  INDIVIDUAL TEST level, not by file. Only a `test.describe.serial(...)` block is kept together in
  one shard (it becomes the `outerMostSequentialSuite` group). An empty shard does NOT fail the run.
  Re-verify in the bundled runner: `createTestGroups()` and the `!testRun.config.config.shard`
  guard in `projects/app/node_modules/.pnpm/playwright@<v>/node_modules/playwright/lib/runner/index.js`.
  Consequence for review: any spec sharing module state across a PLAIN `describe` silently
  self-skips under sharding.

- **API `NODE_ENV` default is `local`** — `getEnvironmentConfig()` in
  `@lenne.tech/nest-server/dist/core/common/helpers/config.helper.js` uses `defaultEnv: 'local'`.
  So `migrate:up` (no NODE_ENV) and `start:e2e:dist` (`NODE_ENV=local`) resolve the SAME env block,
  and `config.env.ts` reads `process.env.NSC__MONGOOSE__URI` before any per-env dbName — the CI DB
  alignment holds without extra wiring. `local` also sets `permissions: { role: false }`.

- **`auditConfig.ignoreGhsas` in `pnpm-workspace.yaml` IS honored** by pnpm 11.14.0 — `pnpm audit`
  reports `1 high (1 ignored)` and exits 0. That is what makes a BLOCKING CI `audit` job satisfiable.

- **GitLab treats an `artifacts:paths` entry with no matching files as a WARNING, not an error** —
  so a build that silently produced nothing still goes green. Combined with `pnpm -r run <cmd>`
  exiting 0 when no package matches, the artifact contract needs an explicit `test -f` assertion.

**How to apply:** consult before re-auditing the E2E sharding, the CI database wiring, or the audit
gate — these four were each verified from source, not from the (assertive) inline comments.
See [[project-template-and-deploy-stack]] for repo scoping.

- **`wait "$PID"` AFTER a `kill -0` poll loop still returns the child's real exit
  code** — bash (and dash) keep a terminated background job's status in the job
  table until `wait` consumes it, so the "process already reaped → wait returns 1"
  worry is unfounded. Verified end-to-end in `mcr.microsoft.com/playwright:vX-noble`
  (bash 5.2.21) under `set -eo pipefail`: fake run exiting 7 → job exit 7; exiting
  0 → job exit 0. Re-verify by re-running that 3-case docker simulation if the
  app:test mongo watchdog is ever refactored.

- **`iproute2` is NOT installed in `mcr.microsoft.com/playwright:*-noble`** — `ip`
  is missing; `getent`, `hostname -I`, `wget`, `sed`, `timeout` are present.
  `/bin/sh` is dash, `/bin/bash` is 5.2 with `/dev/tcp` net-redirections enabled.
  Any CI forensics block relying on `ip addr` / `ip route` silently prints nothing.

- **GitLab Runner already TCP-probes a service's first exposed port before the
  build starts** (`HEALTHCHECK_TCP_TIMEOUT`, default 30s), so `mongo:7` is up
  before `script:` runs. Explicit `until /dev/tcp/mongo/27017` waits are
  belt-and-braces, not the primary gate.

- **The "guard fires in the template" convention is asserted, not just implied** — the reference
  implementation is `scripts/check-playwright-image.mjs` (skip path) + `scripts/guard-scripts.test.mjs`
  (`'warns rather than passing silently on a bare template with no app package'`). The test pins the
  CONTRACT, not the wording: exit 0, `stderr` matches `/WARN/` and `/nothing compared/`, and `stdout`
  must NOT contain `ok`. Rationale in that test: an "ok" on a skip path let the Playwright image pins
  drift eleven days behind a green check. Recurring review theme (see commits 44e4a66, 03874a4).
  **How to apply:** when any `scripts/check-*.mjs` gains a "nothing to compare here" branch, hold it
  to that contract — stderr + WARN + no "ok"/"all checks passed" tail — and require a fixture test in
  `guard-scripts.test.mjs` in BOTH directions (real repo passes, broken fixture fails).
