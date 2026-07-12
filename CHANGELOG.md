# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

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

## [3.3.0](https://github.com/lenneTech/lt-monorepo/compare/v3.1.0...v3.3.0) (2026-06-22)


### Features

* **check:** add quiet report-driven check wrapper with auto-fix, parallel runs, and step-level metrics ([db13493](https://github.com/lenneTech/lt-monorepo/commit/db13493d553d1ea17c8178effb05af0cc17dea9e))

## [3.1.0](https://github.com/lenneTech/lt-monorepo/compare/v3.0.3...v3.1.0) (2026-06-14)


### Features

* add deployment compose + CI package stage with APP_VERSION_COMMIT for App/API build drift detection ([03ec8f9](https://github.com/lenneTech/lt-monorepo/commit/03ec8f9726371001bd2cd399d457213c124e0c93))

## [3.0.3](https://github.com/lenneTech/lt-monorepo/compare/v3.0.2...v3.0.3) (2026-06-07)

## [3.0.2](https://github.com/lenneTech/lt-monorepo/compare/v3.0.1...v3.0.2) (2026-05-24)

## [3.0.1](https://github.com/lenneTech/lt-monorepo/compare/v3.0.0...v3.0.1) (2026-05-24)

## [3.0.0](https://github.com/lenneTech/lt-monorepo/compare/v2.1.1...v3.0.0) (2026-05-10)

## [2.1.1](https://github.com/lenneTech/lt-monorepo/compare/v2.1.0...v2.1.1) (2026-05-10)

## [2.1.0](https://github.com/lenneTech/lt-monorepo/compare/v2.0.8...v2.1.0) (2026-05-10)


### Features

* support multi-project local development via lt local up/down/status ([89e4221](https://github.com/lenneTech/lt-monorepo/commit/89e422189f9d1e13c3f46d8b85973a7fa0310416))

## [2.0.8](https://github.com/lenneTech/lt-monorepo/compare/v2.0.7...v2.0.8) (2026-04-17)

## [2.0.7](https://github.com/lenneTech/lt-monorepo/compare/v2.0.6...v2.0.7) (2026-04-11)

## [2.0.6](https://github.com/lenneTech/lt-monorepo/compare/v2.0.5...v2.0.6) (2026-04-07)

## [2.0.5](https://github.com/lenneTech/lt-monorepo/compare/v2.0.4...v2.0.5) (2026-04-07)

## [2.0.4](https://github.com/lenneTech/lt-monorepo/compare/v2.0.3...v2.0.4) (2026-04-06)

## [2.0.3](https://github.com/lenneTech/lt-monorepo/compare/v2.0.2...v2.0.3) (2026-04-04)

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
