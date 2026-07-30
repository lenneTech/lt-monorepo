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
