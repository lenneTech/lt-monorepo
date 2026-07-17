# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [3.6.0](https://github.com/lenneTech/lt-monorepo/compare/v3.5.2...v3.6.0) (2026-07-17)


### Features

* **check:** add `check:workspace` guard asserting the workspace root and its members agree on `packageManager` — the mismatch that broke `lt fullstack init` was invisible to every single repo's own check
* **check:** add `check:pin` contract test asserting the exact pnpm pin, its matching `engines.pnpm` major, and that every CI job derives pnpm from the pin instead of hardcoding a version
* **check:** hoist the workspace install into one run before the fan-out, so parallel project chains no longer race two installs on the same `node_modules`
* **check:** kill wedged test steps via an idle watchdog (no output for 300s, configurable via `--idle-timeout=` / `CHECK_IDLE_TIMEOUT`) and terminate whole process trees instead of orphaning worker forks
* **check:** resolve a member's real chain from `check:raw` when its `check` is the wrapper itself — previously every member was dropped and the monorepo reported as one opaque step with its tests running unseen


### Chores

* **toolchain:** replace corepack with an exact `packageManager` pin as the single source of truth for pnpm provisioning — Node >= 25 no longer ships corepack, so all CI jobs now derive pnpm from the pin
* **toolchain:** bump CI to Node 24 and pnpm 11.13.1, add an `engines` field (`node >= 22`, `pnpm ^11.0.0`)
* **pnpm:** move `shamefullyHoist` and `autoInstallPeers` from `.npmrc` into `pnpm-workspace.yaml` (pnpm 11+ reads its settings there; `.npmrc` keeps auth/registry only) and drop the `onlyBuiltDependencies` duplicate of `allowBuilds`
* ignore `.lt-dev/` session state (ports, PIDs, env bridge, logs)


### Documentation

* **claude:** note that the HMR WebSocket port collision is largely resolved since Nuxt 4.4.8, which picks a free port from `24678–24698` and honors an explicit `vite.server.hmr.port` again

## [3.5.2](https://github.com/lenneTech/lt-monorepo/compare/v3.5.1...v3.5.2) (2026-07-13)


### Refactoring

* **scripts:** remove obsolete prettier detection and auto-fix branch from check.mjs ([7200ab1](https://github.com/lenneTech/lt-monorepo/commit/7200ab16ef99d4471daaa09282ba52af1f8bb589))

## [3.5.1](https://github.com/lenneTech/lt-monorepo/compare/v3.5.0...v3.5.1) (2026-07-12)


### Bug Fixes

* **build:** set APP_DIR=projects/app in docker-compose to fix app image build in monorepo ([08f5c06](https://github.com/lenneTech/lt-monorepo/commit/08f5c060e8bfd03d99ce440bf6d4a71c77e0246b))

## [3.5.0](https://github.com/lenneTech/lt-monorepo/compare/v3.4.0...v3.5.0) (2026-07-12)


### Bug Fixes

* **ci:** force compose upload on turbo deploy and use IPv4 in Docker healthchecks; add non-blocking audit job and frontend unit tests to CI ([b16e22a](https://github.com/lenneTech/lt-monorepo/commit/b16e22aaf14cea19220f10efb54753652f716540))

## [3.4.0](https://github.com/lenneTech/lt-monorepo/compare/v3.3.1...v3.4.0) (2026-07-12)


### Features

* **deploy:** replace generic package stage with TurboOps registry build + CLI deploy across GitLab and GitHub ([f21979f](https://github.com/lenneTech/lt-monorepo/commit/f21979f82cfc8402f39ee4e7718c409661c8b356))

## [3.3.1](https://github.com/lenneTech/lt-monorepo/compare/v3.3.0...v3.3.1) (2026-06-23)


### Chores

* **pnpm:** upgrade to pnpm 11 and move overrides + build allowlist to pnpm-workspace.yaml ([6f5af0a](https://github.com/lenneTech/lt-monorepo/commit/6f5af0a7989612345dd1427e4389c9b89195ba51))

## [3.3.0](https://github.com/lenneTech/lt-monorepo/compare/v3.1.0...v3.3.0) (2026-06-22)

> **Note:** 3.2.0 was never released — the version jumped straight from 3.1.0 to 3.3.0. No tag and no commits exist for it.


### Features

* **check:** add quiet report-driven check wrapper with auto-fix, parallel runs, and step-level metrics ([db13493](https://github.com/lenneTech/lt-monorepo/commit/db13493d553d1ea17c8178effb05af0cc17dea9e))

## [3.1.0](https://github.com/lenneTech/lt-monorepo/compare/v3.0.3...v3.1.0) (2026-06-14)


### Features

* add deployment compose + CI package stage with APP_VERSION_COMMIT for App/API build drift detection ([03ec8f9](https://github.com/lenneTech/lt-monorepo/commit/03ec8f9726371001bd2cd399d457213c124e0c93))

## [3.0.3](https://github.com/lenneTech/lt-monorepo/compare/v3.0.2...v3.0.3) (2026-06-07)


### Documentation

* **claude:** add Framework Mode note explaining npm vs vendor sub-project detection and update flow ([9e5bf7c](https://github.com/lenneTech/lt-monorepo/commit/9e5bf7cd85b1eeef0d6f5d4a8c504221f52e6ce5))

## [3.0.2](https://github.com/lenneTech/lt-monorepo/compare/v3.0.1...v3.0.2) (2026-05-24)


### Documentation

* **claude:** document `lt dev init` (renamed from migrate) + auto-chaining note ([a1e16d6](https://github.com/lenneTech/lt-monorepo/commit/a1e16d6f506060fde9cd1918b6822bbd84474385))

## [3.0.1](https://github.com/lenneTech/lt-monorepo/compare/v3.0.0...v3.0.1) (2026-05-24)


### CI/CD

* add GitHub Actions workflow and align GitLab app:test job to boot the API on :3000 for environment-agnostic Playwright ([6b407e2](https://github.com/lenneTech/lt-monorepo/commit/6b407e20f33fb56ffb61f9959514ec92c84dfcb3))

## [3.0.0](https://github.com/lenneTech/lt-monorepo/compare/v2.1.1...v3.0.0) (2026-05-10)


### Chores

* switch monorepo scripts to lt dev (Caddy-backed HTTPS, per-slug cookie domain) ([3b1380e](https://github.com/lenneTech/lt-monorepo/commit/3b1380e96858d73049808341e5cb2979a3924e7a))

## [2.1.1](https://github.com/lenneTech/lt-monorepo/compare/v2.1.0...v2.1.1) (2026-05-10)


### Chores

* update npm-package-maintainer agent memory with current override state ([5676bab](https://github.com/lenneTech/lt-monorepo/commit/5676bab5117c2bd14a4da81eb36034b08246c1e8))
* **deps:** bump commit-and-tag-version and consolidate security overrides ([22870bb](https://github.com/lenneTech/lt-monorepo/commit/22870bb89ba88ede9be15b85b26f38ed13e0554b))

## [2.1.0](https://github.com/lenneTech/lt-monorepo/compare/v2.0.8...v2.1.0) (2026-05-10)


### Features

* support multi-project local development via lt local up/down/status ([89e4221](https://github.com/lenneTech/lt-monorepo/commit/89e422189f9d1e13c3f46d8b85973a7fa0310416))

## [2.0.8](https://github.com/lenneTech/lt-monorepo/compare/v2.0.7...v2.0.8) (2026-04-17)


### Documentation

* clarify vendor mode as read-only reference with upstream contribution policy ([a994edc](https://github.com/lenneTech/lt-monorepo/commit/a994edc858a7cecbc196c2256ed7d091f88496f6))

## [2.0.7](https://github.com/lenneTech/lt-monorepo/compare/v2.0.6...v2.0.7) (2026-04-11)


### Documentation

* add {{FRAMEWORK_MODE}} placeholder + dual-mode framework source table ([f5f26a0](https://github.com/lenneTech/lt-monorepo/commit/f5f26a0fb0b48708f1e45df531e34b9ea3786664))

## [2.0.6](https://github.com/lenneTech/lt-monorepo/compare/v2.0.5...v2.0.6) (2026-04-07)


### Chores

* improve CLAUDE.md MongoDB performance guidance with use-case-specific methods ([a082596](https://github.com/lenneTech/lt-monorepo/commit/a082596bd2fa713fee196a681e6a9ba3cc5bf269))

## [2.0.5](https://github.com/lenneTech/lt-monorepo/compare/v2.0.4...v2.0.5) (2026-04-07)


### Chores

* fix transitive dependency vulnerabilities and enhance CLAUDE.md MongoDB driver rules ([c781bb4](https://github.com/lenneTech/lt-monorepo/commit/c781bb4554ef06ca53d788cb67fd7802cd246457))

## [2.0.4](https://github.com/lenneTech/lt-monorepo/compare/v2.0.3...v2.0.4) (2026-04-06)


### Chores

* add auth middleware section to CLAUDE.md to prevent direct state mutation ([4af191c](https://github.com/lenneTech/lt-monorepo/commit/4af191c7e4b519369e954601fefeb12d3a47a7aa))

## [2.0.3](https://github.com/lenneTech/lt-monorepo/compare/v2.0.2...v2.0.3) (2026-04-04)


### Chores

* introduce CLAUDE.md for AI-assisted development, bump tooling deps ([7a777f2](https://github.com/lenneTech/lt-monorepo/commit/7a777f2d6f63ffc643ef4d8b61f464c8b49ab1c5))

## [2.0.2](https://github.com/lenneTech/lt-monorepo/compare/v2.0.1...v2.0.2) (2026-03-16)


### Bug Fixes

* **ci:** husky in Docker, native bindings, frozen-lockfile, Playwright image ([f5086c0](https://github.com/lenneTech/lt-monorepo/commit/f5086c0d49c228dd68151e38dcaa1507c0bed90e))

## [2.0.1](https://github.com/lenneTech/lt-monorepo/compare/v2.0.0...v2.0.1) (2026-02-12)


### Bug Fixes

* **ci:** fix pnpm initialization by installing corepack globally before enabling ([7657cf2](https://github.com/lenneTech/lt-monorepo/commit/7657cf26051dd831171579577dff5966fc1015f8))

## [2.0.0](https://github.com/lenneTech/lt-monorepo/compare/v1.1.0...v2.0.0) (2026-02-10)


### Features

* add default pipelines ([cadff1d](https://github.com/lenneTech/lt-monorepo/commit/cadff1d7c591e5719fd3c4e0d6af17a553ba22e6))
* add default pipelines ([e2b6600](https://github.com/lenneTech/lt-monorepo/commit/e2b660087e43d46020838d11cff6dc399d0ea1f9))
* add new readme and update packages ([3a9fdfb](https://github.com/lenneTech/lt-monorepo/commit/3a9fdfb199d4ea96099b6d8daefddf7689489d6c))
* **DEV-609:** update project configuration and improve README structure ([b470b86](https://github.com/lenneTech/lt-monorepo/commit/b470b86171c4cacbab2fed794b614e5f40124613))
* replace npm and lerna with pnpm workspaces ([2a30394](https://github.com/lenneTech/lt-monorepo/commit/2a30394ac41c515e0cbb1f178403e54e4af0b1e3))

## 1.1.0 (2024-02-19)

### Features

- Add license ([eba22ac](https://github.com/lenneTech/lt-monorepo/commit/eba22ac1bac5c9c0463b2ac98e82af412c9c7640))
- Update packages ([e84da61](https://github.com/lenneTech/lt-monorepo/commit/e84da61a148d74a782bb0da08f429942264b8f27))
- Update packages ([da3e6b6](https://github.com/lenneTech/lt-monorepo/commit/da3e6b666f605891628d49a78e6628666d6ddd5a))
- Update packages ([18f2608](https://github.com/lenneTech/lt-monorepo/commit/18f26080e06b1466bbaad299c2eb94e07e409bec))

### Bug Fixes

- Change README.md ([df2bedd](https://github.com/lenneTech/lt-monorepo/commit/df2beddc6761cc88f888cd7acb9e9e4aa1af5086))
- fix version config file ([23638c7](https://github.com/lenneTech/lt-monorepo/commit/23638c7450ec8436f381791a8c23835d0bfbea1a))
