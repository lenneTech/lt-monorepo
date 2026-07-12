---
name: project-template-and-deploy-stack
description: lt-monorepo is the empty template repo (projects populated by lt fullstack init); deploys via TurboOps. Scoping rules for infra reviews.
metadata:
  type: project
---

This repository (`git@github.com:lenneTech/lt-monorepo.git`) is the **lt-monorepo TEMPLATE**, not an initialized project.

**Fact:** `projects/api` and `projects/app` are empty (`.gitkeep`) until a developer runs `lt fullstack init`, which pulls `nest-server-starter` + `nuxt-base-starter`. Deployment targets **TurboOps** (`registry.turbo-ops.de`, `@turboops/cli`, `.turboops.json`, `scripts/turboops-guard.sh`).

**Why:** it matters for DevOps reviews — many files a review would expect only exist post-init.

**How to apply:** when reviewing infra here, do NOT flag as bugs: `projects/api/Dockerfile` / `projects/app/Dockerfile` "missing" (ship with the starters; docker-compose references them, they exist post-init); `.turboops.json` absent (created per-project via `lt deployment create`; `turboops-guard.sh` fails fast by design if missing); root `format:check`/`lint`/`api:test`/`build` scripts being no-ops (they recurse into `projects/*`, work post-init); `lt server permissions` gate absent from CI (can't run against an empty api — flag as a post-init recommendation, not a regression). The Dockerfile-specific and Nuxt-SSR checks are N/A in the bare template — grade them "not evaluable", don't score 0. Deployment CI lives in `.gitlab-ci.yml` + `.github/workflows/{test,deploy}.yml`.
