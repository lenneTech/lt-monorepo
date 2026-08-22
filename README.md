# lenne.Tech Monorepro

In this readme you find all information about functionality and usage of this project. It is clustered in the following sections:

## 📑 Content Table

- About the project
- Links to running systems
- Prerequisites
- Quick start for contributors
- Environment Variables
- Checks & CI
- Tech-Stack
- How to create a new db-collection
- Deployment

## 🌐 About the project

write here about the project

## 🔗 Links to running systems

The following systems are currently running:

- Dev
- Test
- Production

## ⚙️ Prerequisites

Make sure you have the following installed:

- [Node.js](https://nodejs.org/en)
- [pnpm](https://pnpm.io/) (package manager)
- [MongoDB](https://www.mongodb.com/docs/manual/)
- [Docker](https://docs.docker.com/) (optional, but recommended for deployment)

## 🚀 Quick start for contributors

> Development system must have node installed + mongo installed and running

The project is created as a monorepo. The repository is divided in two separate sections:

- app
- api

The following steps are necessary to install everything correctly:

```bash
# Clone repository
git clone <repository-url>

# Switch to project-folder
cd <project-folder>

# Install dependencies for app and api
pnpm run init

# Create environment variables
cd projects/app
cp .env.example .env

# Start project
cd ../../
pnpm run start
```

## 🛠️ Environment Variables

You need to set up the following environment variables in the `.env` file:

Note the `NUXT_` / `NUXT_PUBLIC_` prefixes on the app variables. Nitro maps only
prefixed variables onto `runtimeConfig`, so an unprefixed `SITE_URL` reaches nothing.

| Variable                     | Description                                                        | Default (.env.example)  |
| ---------------------------- | ------------------------------------------------------------------ | ----------------------- |
| `NUXT_PUBLIC_SITE_URL`       | Public origin of the frontend application. **Required in production** — see below. | `http://localhost:3001` |
| `NODE_ENV`                   | Specifies the environment in which the application is running.     | `development`           |
| `NUXT_API_URL`               | Base URL of the backend API, server-side (SSR + dev proxy target). | `http://localhost:3000` |
| `NUXT_PUBLIC_API_URL`        | Base URL of the backend API, client-side.                          | `http://localhost:3000` |
| `NUXT_PUBLIC_APP_ENV`        | Deployment environment label (`local`, `development`, `production`). | `local`                 |
| `NUXT_PUBLIC_WEB_PUSH_KEY`   | The public key used for Web Push notifications.                    | (empty)                 |
| `NUXT_PUBLIC_STORAGE_PREFIX` | Prefix used for local storage keys (namespaces parallel projects). | `fc-dev`                |
| `API_SCHEMA`                 | The path to the GraphQL schema file.                               | `../api/schema.gql`     |
| `GENERATE_TYPES`             | Determines whether or not types should be automatically generated. | `0`                     |

**`NUXT_PUBLIC_SITE_URL` must be set on every deployed stage.** It is the public origin
of the app itself and feeds two consumers: the SEO site config (canonical URLs, OG
tags, sitemap) and — since the 2.18.0 starter — `runtimeConfig.public.siteUrl`, which
builds the absolute redirect URLs that go into password-reset and e-mail-verification
mails.

Left unset in production, the SEO half falls back to the request's `X-Forwarded-Host`
and the auth half falls back to whichever origin the browser is on. That is correct for
a single-origin deployment and wrong behind a proxy or vanity domain, where users then
receive reset links pointing at the internal host — a failure that only surfaces in
their inbox. Use the `NUXT_PUBLIC_` form, not `NUXT_SITE_URL`: both reach the SEO
config, but only the public form also populates the auth redirect origin.

These reach the containers as **runtime** environment (TurboOps stage variables /
Swarm), not as build args — one image serves every stage.

## ✅ Checks & CI

```bash
pnpm run check       # the gate: install, audit, guards, script tests, then each sub-project's own check
pnpm run check:fix   # same, but auto-fixes format + lint
pnpm run clean       # drop the sub-projects' build dirs
```

`pnpm run check` is the single source of truth for "is this runnable". A non-zero
exit means it failed — there is no partial-success state.

**Why there is a `.nuxt-check/` directory.** Nuxt writes its generated types,
including `tsconfig.json`, into its build dir. With one shared `.nuxt/`, a check
running next to a parked `nuxt dev` rewrote that file underneath the dev server,
which then type-checked without the `~`/`#` aliases and failed on code that was
perfectly fine — it looks exactly like a real type error. So the check chain pins
`NUXT_BUILD_DIR=.nuxt-check` on everything it runs. The directory is disposable
(gitignored, excluded from the Docker context, removed by `pnpm run clean`).
`init` / `reinit` deliberately stay **unpinned** — they are what keeps the IDE's
`.nuxt/` supplied. On a fresh clone where you only ever ran `check`, run
`pnpm run init` (or start the dev server) once to populate it.

**Accepting a security advisory.** The CI `audit` job is **blocking** in both
pipelines: a red audit means an advisory nobody has assessed yet. There is no
blanket escape hatch — `allow_failure` / `continue-on-error` would suppress every
future advisory too, which is the opposite of what an audit gate is for.

Fix it first: raise the vulnerable transitive dependency via `overrides:` in
`pnpm-workspace.yaml`. Only when that provably cannot work, add one entry to
`auditConfig.ignoreGhsas` in the same file, with all four of:

1. the advisory ID,
2. why it is there — either the dependency cannot be fixed, **or** the code *is*
   fixed and the advisory is a false positive (an upstream range that was never
   narrowed). Those are different claims; do not blur them.
3. why the residual risk is acceptable,
4. the date you verified it.

> `auditConfig` is **not** hoisted into projects generated by `lt fullstack init`,
> so a generated project inherits the blocking gate without this allowlist and has
> to assess advisories itself.

**CI pipelines.** GitLab (`.gitlab-ci.yml`) and GitHub Actions
(`.github/workflows/test.yml`) are meant to stay equivalent — `deploy.yml` gates
its deploy on the GitHub one. Both build once and run the E2E suite in two shards
against the built server. `scripts/check-ci-consistency.mjs` (part of `check`)
asserts the wiring that would otherwise fail *silently green*: sharding without
`--shard`, a `$CI_NODE_INDEX`-gated step in a non-parallel job, a non-blocking
audit job, a missing build-artifact dependency, or `start:e2e:dist` without
`migrate:up` before it. It asserts one further rule that fails *loudly but names
the wrong culprit*: every GitLab job declaring a `mongo` service must set
`FF_NETWORK_PER_BUILD: "true"`. Without it the runner leaves the service on the
shared default bridge in the deprecated `--link` mode — an unauthenticated
`mongo:7` is then reachable from every container on that host, and a lost alias
surfaces as `getaddrinfo ENOTFOUND mongo` behind MongoDB's 30 s server-selection
timeout, once per call. The rule is GitLab-only by design: GitHub gives every job
its own ephemeral runner and its own service containers.

For the residual case — a service that dies *during* a run — both `app:test` jobs
wrap Playwright in `scripts/mongo-watchdog.sh`. It polls the service alongside the
run and aborts with an explicit infrastructure diagnosis instead of letting every
remaining test wait out its timeout. Its contract (a failing run keeps its own
exit code; a vanished service aborts fast) is pinned by
`scripts/mongo-watchdog.test.mjs`.

## 🧰 Tech-Stack

This project build with modern frameworks to get a sustainable and fast experience. Following technologies, frameworks and libraries are used:

- Frontend:
  - [Vue.js](https://vuejs.org/guide/introduction.html)
  - [NUXT](https://nuxt.com/docs/getting-started/introduction)
  - [TailwindCSS](https://tailwindcss.com/docs/installation)

- Backend:
  - [Nest.js](https://docs.nestjs.com/)

- Database:
  - [MongoDB](https://www.mongodb.com/docs/manual/)

- Other:
  - [Docker](https://docs.docker.com/)

## 📂 How to create a new db-collection

> The instructions are based on the usage of [lt cli](https://www.npmjs.com/package/@lenne.tech/cli)

If you want to create a new feature with new values inside the database (for example a whole new collection), you need to follow a few steps:

1. Switch to the api folder:

```bash
cd projects/api
```

2. Create a new server module via lt cli:

```bash
# Type lt and switch to server and then module
lt

# Or type the following to get there in one step
lt server module
```

3. Follow the instructions to create the new module.

4. When you submit your creation, there will be a new folder inside your api with a few files, which are necessary for all operations, you want to do with that new collection.

5. To be able to see and use those changes inside your app, you have to generate those types. Therefore we first switch to our app:

```bash
cd projects/app
```

6. Now just type the following command:

```bash
pnpm run generate-types
```

7. The updated types are generated and are ready to be used inside your app.

## 🚢 Deployment

To deploy the project and use new features, you need to follow these steps:

1. Push or merge changes in the dev-branch
   > The changes automatically get deployed on the dev system
2. Push or merge changes in the test-branch
   > The changes automatically get deployed on the test system
3. Push or merge changes in the main-branch
   > The changes automatically get deployed on the production system

New deployments keep the old database. Make sure that your system might not work properly with the new features and an old db-instance

### Build identity / drift detection

App and API are deployed together but versioned independently. To tell at a glance which build is live — and whether the two containers match after a rollout — every deployment bakes the git commit SHA into both images via the `APP_VERSION_COMMIT` build arg (fed from the CI commit SHA, see `docker-compose.yml` + `.gitlab-ci.yml`):

- The **API** reports it at `GET /meta` and in the `/health-check` build indicator.
- The **App** shows + compares both builds under **`/app/admin/system`** and warns when the App and API commits differ (a sign of a partial / stale rollout).

Version numbers are per-component and may legitimately differ; only the commit is compared. Local builds without CI report `unknown` and never trigger the warning.
