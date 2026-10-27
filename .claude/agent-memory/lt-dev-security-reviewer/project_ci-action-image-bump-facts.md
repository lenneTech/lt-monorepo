---
name: ci-action-image-bump-facts
description: Verified behaviour of the GitHub action majors / docker:29-dind adopted 2026-10-26, plus the dind TLS time bomb a future docker:30 bump will hit
metadata:
  type: project
---

Verified 2026-10-26 while reviewing the bump to checkout@v7, setup-node@v7, upload-artifact@v7, download-artifact@v8, docker/login-action@v4, docker:29-dind.

- **docker:29-dind + `DOCKER_TLS_CERTDIR: ""`** (pipeline-level variable in `.gitlab-ci.yml`): the 29 entrypoint binds `tcp://0.0.0.0:2375` WITHOUT `--tls=false`; dockerd 29.9.2 (`daemon/command/daemon.go` `loadListeners`) still only warns and sleeps, but logs "Support for listening on TCP without authentication ... will be removed in the next release". **A `docker:30-dind` bump is likely to hard-fail `turboops-build`** unless TLS is enabled or `--tls=false` is passed. Check that first on the next dind bump.
- `include-hidden-files: true` on the GitHub `build-output` upload sweeps only Nitro's `.output/server/node_modules/.nitro` store, the `.output` root itself and `.gitkeep`s (inventoried across ~10 generated projects). The upload-artifact v7 hidden filter applies to the search ROOT too, so a dot-dir listed by name IS dropped without the flag; the workflow comment saying so is correct.
- checkout v6+ persists the token to a file under `$RUNNER_TEMP` (includeIf), not `.git/config`. checkout v7 refuses fork checkouts under `pull_request_target`/`workflow_run`. setup-node v6+ auto-caches only when `packageManager` is npm (this repo pins pnpm, so no cache). download-artifact v8 fails on digest mismatch by default.
- `deploy.yml` calls `test.yml` without `secrets: inherit`, so no test-workflow job (incl. `build`) holds a secret; `NUXT_LINEAR_API_KEY` is the one build-time secret read in nuxt-base-starter's `nuxt.config.ts`.

**How to apply:** use these as starting points, not conclusions. Re-verify against the new tag's `action.yml` / dist when versions move again. See [[template-repo-nature]], [[verify-justification-comments]].
