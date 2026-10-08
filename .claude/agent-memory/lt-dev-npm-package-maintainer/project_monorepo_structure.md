---
name: lt-monorepo starter kit structure
description: lt-monorepo is a template — projects/ is empty (.gitkeep); root has 5 tool devDeps pinned in step with the starters; pnpm settings live in pnpm-workspace.yaml
metadata:
  type: project
---

This repo is a **starter kit template**, not an active project with sub-projects.

- `projects/` contains only `.gitkeep` — filled only by `lt fullstack init`, so Phase 1/2
  (unused / recategorize) are no-ops and there is no framework to align.
- Root `devDependencies` (as of 2026-10-09): `commit-and-tag-version` 13.2.1, `cross-env` 10.1.0,
  `husky` 9.1.7, `oxfmt` 0.72.0, `oxlint` 1.87.0 — all exact pins. `oxlint`/`oxfmt` must match the starters
  (nest-server-starter root `package.json`; nuxt-base-starter pins them in
  `nuxt-base-template/package.json`, oxfmt also at its root) — do not go past them.
- `packageManager` pnpm pin is deliberate; do not bump it (or cross a pnpm major) during maintenance.
- `allowBuilds` (`@swc/core, bcrypt, esbuild, sharp, puppeteer`) in `pnpm-workspace.yaml` is
  template config hoisted into generated projects — NOT unused packages to remove.
- The gate is `pnpm run check` (wrapper `scripts/check.mjs`; auto-fixes format/lint, runs audit +
  `scripts/*.test.mjs`). Baseline: 28 lint warnings (10 eqeqeq, 14 unicorn consistent-function-scoping, 4 unicorn
  no-array-sort, in `scripts/*.test.*`) — accepted, not blockers; unchanged by oxlint 1.85→1.87.
- Edit devDep versions with a direct string edit + `pnpm install`, not `pnpm add` — the user often
  has uncommitted script changes in `package.json` that must not be rewritten.
- `pnpm run release` uses a custom bumpFiles updater (`scripts/check-wrapper-version.cjs`) for the
  `@lt-check-wrapper` marker; after a `commit-and-tag-version` bump verify with
  `pnpm exec commit-and-tag-version --dry-run` (writes nothing).

**Why:** The starter kit pre-configures pnpm security settings so sub-projects inherit them when initialized.
**How to apply:** Only the root manifest matters; keep tool pins in lockstep with the starters. See [[project_security_overrides]].
