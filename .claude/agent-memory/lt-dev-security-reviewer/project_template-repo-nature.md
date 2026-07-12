---
name: template-repo-nature
description: lt-monorepo is the TEMPLATE repo (git@github.com:lenneTech/lt-monorepo.git), not an initialized project — scopes what a security review should flag
metadata:
  type: project
---

`lt-monorepo` is the **template** consumed by `lt fullstack init`. `projects/api` and `projects/app` are empty (`.gitkeep` only) until init pulls nest-server-starter + nuxt-base-starter.

**Why:** Every downstream project is generated from this repo, so anything committed here (incl. CI credentials, `.dockerignore`, workflow defaults) is inherited by all projects.

**How to apply:** For security reviews of THIS repo, do NOT flag as bugs: missing `projects/*/Dockerfile` (shipped by starters), absent `.turboops.json` (created per-project by `lt deployment create`), or empty root scripts that recurse into `projects/*`. Backend/frontend app-source phases (permission model, XSS, securityCheck, injection) are N/A — the review surface is CI/CD + infra (`.gitlab-ci.yml`, `.github/workflows/*`, `docker-compose.yml`, `.dockerignore`, `scripts/*`). A finding here weighs heavier because it propagates to every generated project. See [[ci-ephemeral-severity]].
