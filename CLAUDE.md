# {{PROJECT_NAME}} — lenne.Tech Fullstack Monorepo

> **📖 Ecosystem Documentation**
> - **[LT-ECOSYSTEM-GUIDE](https://github.com/lenneTech/cli/blob/main/docs/LT-ECOSYSTEM-GUIDE.md)** — Full reference for `lt` CLI + `lt-dev` Claude-Code plugin (architecture, commands, agents, skills, vendor-mode workflows)
> - **[VENDOR-MODE-WORKFLOW](https://github.com/lenneTech/cli/blob/main/docs/VENDOR-MODE-WORKFLOW.md)** — Step-by-step: npm → vendor conversion, vendor updates, vendor → npm rollback
> - **[CLI Command Reference](https://github.com/lenneTech/cli/blob/main/docs/commands.md)** — All `lt` commands with options
>
> **🔧 Framework Mode** — Each sub-project runs in `npm` or `vendor` mode. If `projects/api/src/core/VENDOR.md` (backend) or `projects/app/app/core/VENDOR.md` (frontend) exists, that half is **vendored**: read framework code from the `core/` tree, update it with `/lt-dev:backend:update-nest-server-core` / `/lt-dev:frontend:update-nuxt-extensions-core` (both also raise npm packages to at least the upstream baseline via `/lt-dev:maintenance:maintain`), and send generally-useful core fixes upstream with the matching `contribute-*-core` command. Run `lt fullstack update` to print the right flow for this workspace.

## Project Structure

```
{{PROJECT_DIR}}/
├── projects/
│   ├── api/    ← NestJS backend (depends on @lenne.tech/nest-server)
│   └── app/    ← {{FRONTEND_FRAMEWORK}} frontend (depends on @lenne.tech/nuxt-extensions)
├── pnpm-workspace.yaml
└── package.json (workspaces: ["projects/*"])
```

This is a pnpm monorepo created via `lt fullstack init`. The two sub-projects are independent applications that share a workspace.

## Sub-Projects

### Backend: `projects/api/`

- **Framework:** NestJS + `@lenne.tech/nest-server`
- **Framework Mode:** `{{FRAMEWORK_MODE}}` (`npm` = classic npm dependency, `vendor` = framework core copied into `src/core/`)
- **Database:** MongoDB (Mongoose ODM)
- **API Mode:** {{API_MODE}}
- **Auth:** Better Auth (2FA, Passkeys, SSR sessions)
- **URL:** `https://api.{{PROJECT_NAME}}.localhost` (set automatically by `lt dev up`); falls back to `http://localhost:3000` for classic `pnpm start`

```bash
cd projects/api && pnpm start       # Start backend (default port)
cd projects/api && pnpm run test:e2e  # Run API tests
```

### Frontend: `projects/app/`

- **Framework:** {{FRONTEND_FRAMEWORK}} + `@lenne.tech/nuxt-extensions`
- **UI:** NuxtUI 4 + TailwindCSS 4
- **API Client:** Generated types (`types.gen.ts`, `sdk.gen.ts`)
- **Auth:** `useBetterAuth()` composable
- **URL:** `https://{{PROJECT_NAME}}.localhost` (set automatically by `lt dev up`); falls back to `http://localhost:3001` for classic `pnpm dev`

```bash
cd projects/app && pnpm dev           # Start frontend (default port)
cd projects/app && pnpm run generate-types  # Generate API types (API must be running)
cd projects/app && pnpm run test:e2e  # Run Playwright E2E tests
```

## Development

```bash
pnpm install          # Install all dependencies
pnpm run check        # Run checks across all sub-projects
pnpm run check:fix    # Auto-fix across all sub-projects
```

## Build Identity / Drift Detection

App and API are deployed together but versioned independently, so a partial /
stale rollout (one container older than the other) is otherwise hard to spot.
The build commit SHA makes it visible at a glance:

- **API** (`@lenne.tech/nest-server` meta module) reports it via `GET /meta`
  (`commit` field) and the `/health-check` build indicator.
- **App** freezes it into the Nuxt bundle (`runtimeConfig.public.appCommit`) and
  shows + compares both under **`/app/admin/system`** — a warning appears when
  the App and API commits differ.

The contract (one variable, end to end):

```
CI commit SHA → IMAGE_TAG (.gitlab-ci.yml)
             → APP_VERSION_COMMIT build arg (docker-compose.yml)
             → ENV in each image (Dockerfile)
             → GET /meta + runtimeConfig.public.appCommit
```

Versions (semver) are per-component and may legitimately differ — only the
**commit** is compared for drift. Local builds without CI report `unknown`, which
never triggers the warning. When deploying with a different tool than the bundled
`docker-compose.yml`, just ensure `APP_VERSION_COMMIT` is passed as a build arg
to both images (= the CI commit SHA).

## Local Development (Parallel Projects)

To run this project alongside other lt-projects on the same machine without colliding on `localhost:3000`/`localhost:3001` and without cross-wiring auth cookies:

```bash
pnpm run dev               # Shorthand for `lt dev up`
pnpm run dev:status        # Shows what is running for THIS project
pnpm run dev:down          # Stops the detached processes + removes Caddy block
pnpm run dev:doctor        # Diagnose Caddy / CA / DNS / port issues

# First run in a fresh project — just this, then `lt dev up`:
lt dev init                # Patches legacy hardcoded ports to env-aware variants
                           # Registers project in ~/.lenneTech/projects.json
                           # Injects the URL block into CLAUDE.md files
                           # Auto-runs `lt dev install` first if the machine
                           # isn't set up yet (idempotent, one hop, no recursion)

# (install can also be run explicitly; inside a project it auto-runs init after)
lt dev install             # Verify Caddy + create Caddyfile stub + reminder for `caddy trust`

lt dev status --all        # Lists every registered project + running state
```

`lt dev up` exports the env vars both starters respect:

- API: `PORT`, `BASE_URL`, `APP_URL`, `NSC__MONGOOSE__URI`, `NSC__BASE_URL`, `NSC__APP_URL`, `DATABASE_URL`
- App: `PORT`, `NUXT_API_URL`, `NUXT_PUBLIC_API_URL`, `NUXT_PUBLIC_SITE_URL`, `NUXT_PUBLIC_STORAGE_PREFIX`, `NUXT_PUBLIC_API_PROXY=false`

Without `lt dev up`, both starters fall back to the classic localhost ports (3000/3001) with the vite-proxy enabled for same-origin cookies. On a single-project machine that is fine; on a multi-project machine `lt dev up` is mandatory — it prevents the "wrong API answers wrong frontend" class of bugs by serving every project under stable HTTPS URLs (`https://{{PROJECT_NAME}}.localhost`, `https://api.{{PROJECT_NAME}}.localhost`) with a per-slug cookie domain, storage-prefix and database name.

### E2E tests (Playwright)

The App E2E suite is environment-agnostic and runs unchanged in three setups:

- **Classic ports** — API `:3000` + App `:3001` started manually.
- **`lt dev up`** — HTTPS behind Caddy; the `.lt-dev/.env` bridge (auto-loaded by `playwright.config.ts`) feeds the project URLs. Run via `lt dev test`.
- **CI** — GitLab (`.gitlab-ci.yml`) and GitHub Actions (`.github/workflows/test.yml`) boot the API on `:3000`, set `PLAYWRIGHT=true`, and run Playwright.

Test code reads `NUXT_PUBLIC_API_URL` / `NUXT_PUBLIC_SITE_URL` / `API_URL` with `localhost:3000` / `:3001` fallbacks — **never hardcode ports in specs**. Auth cookies injected into the browser must preserve the `Secure` flag (HTTPS under `lt dev`) and derive their domain from the app host.

## Framework Source Code

Both frameworks ship their source code and documentation. **ALWAYS read
actual source code** before guessing framework behavior.

### Backend Framework: @lenne.tech/nest-server

The backend can consume the framework in one of two modes — the
`Framework Mode` shown above tells you which this project uses:

- **npm mode** — framework source is in
  `projects/api/node_modules/@lenne.tech/nest-server/`, imports use
  bare specifiers (`from '@lenne.tech/nest-server'`). Updated via
  `/lt-dev:backend:update-nest-server`.

- **vendor mode** — framework source is copied directly into
  `projects/api/src/core/**` as first-class project code. No
  `@lenne.tech/nest-server` npm dependency. Imports use relative
  paths (`from '../../../core'`). Baseline + patch log live in
  `projects/api/src/core/VENDOR.md`. Updated via
  `/lt-dev:backend:update-nest-server-core`. Detect via:
  `test -f projects/api/src/core/VENDOR.md`.

  **Vendor Modification Policy:** The vendored core exists so Claude
  Code can read framework internals — it is **not a fork**. Only edit
  `src/core/` for changes that are **generally useful to all
  nest-server consumers** (bugfixes, security fixes, broad
  enhancements). Anything project-specific goes into project code via
  inheritance, extension, or `ICoreModuleOverrides`. Generally-useful
  changes MUST be submitted as a PR to
  `github.com/lenneTech/nest-server` — use
  `/lt-dev:backend:contribute-nest-server-core` to prepare it. The
  same policy applies to `projects/app/app/core/` vs.
  `github.com/lenneTech/nuxt-extensions`
  (`/lt-dev:frontend:contribute-nuxt-extensions-core`).

Key files — **path prefix depends on mode**:

- **npm mode:** `projects/api/node_modules/@lenne.tech/nest-server/<path>`
- **vendor mode:** `projects/api/<path>` where `src/core/` replaces
  `src/core/` in the table below (no node_modules prefix)

| File                                                     | Purpose                                              |
|----------------------------------------------------------|------------------------------------------------------|
| `CLAUDE.md` (npm) / `src/core/VENDOR.md` (vendor)        | Framework rules / vendor baseline + patch log        |
| `FRAMEWORK-API.md` (npm only)                            | Compact API reference                                |
| `src/core.module.ts`                                     | CoreModule.forRoot() — module registration           |
| `src/core/common/interfaces/server-options.interface.ts` | ALL config interfaces                                |
| `src/core/common/services/crud.service.ts`               | CrudService base class                               |
| `docs/REQUEST-LIFECYCLE.md` (npm only)                   | Complete request lifecycle                           |

### Frontend Framework: @lenne.tech/nuxt-extensions

Key files in `projects/app/node_modules/@lenne.tech/nuxt-extensions/`:

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Composables, components, configuration |
| `dist/runtime/composables/` | Available composables (useBetterAuth, etc.) |
| `dist/runtime/components/` | Available components |

## Auth Middleware Pattern

When implementing auth middleware in `projects/app/app/middleware/`, follow the read-only pattern from `@lenne.tech/nuxt-extensions`. Never mutate `lt-auth-state` directly — use `useLtAuth()` composable methods.

## Native MongoDB Driver — Forbidden

`model.collection.*`, `model.db.*`, and `connection.db.collection()` bypass all Mongoose security plugins (Tenant, Audit, RoleGuard, Password).
Use Mongoose Model methods (`insertMany`, `bulkWrite`, `updateMany`, etc.) instead.

**CrudService vs direct Mongoose:** Use CrudService for user-facing APIs (provides authorization + field filtering). Use direct Mongoose (`Model.create()`, `findByIdAndUpdate().lean()`, `findById().lean()`) for system-internal code (processors, crons) where no user context exists. **Never** pass Mongoose SubDocument Arrays through `CrudService.update()` — use `CrudService.pushToArray()` / `pullFromArray()` instead, or `$push`/`$set` via `findByIdAndUpdate()` for combined operations (OOM risk applies in ALL contexts, including controllers). Details: `projects/api/node_modules/@lenne.tech/nest-server/CLAUDE.md`.

Details: `projects/api/node_modules/@lenne.tech/nest-server/CLAUDE.md` → "Native MongoDB Driver" and "CrudService process()".

## Mongoose Index Placement

**Rule:** Single-field indexes live on the property. `Schema.index()` is reserved for compound (multi-field) indexes only.

1. **Single-field indexes** → declare directly on the property via `@Prop({ index: true })` or `@UnifiedField({ mongoose: { index: true } })`. Keeps all property info in one place.

2. **Framework-managed indexes** → do NOT set manually. `tenantId` is automatically indexed by the `mongooseTenantPlugin` in `@lenne.tech/nest-server`. Adding `index: true` on `tenantId` triggers Mongoose `"Duplicate schema index"` warnings.

3. **Compound (multi-field) indexes** → the only valid use of `Schema.index({ field1: 1, field2: 1 })` after `SchemaFactory.createForClass(...)`.

4. **TTL indexes** → inline on the property: `@Prop({ required: true, index: { expireAfterSeconds: 3600 } })`.

5. **`unique: true`** implicitly creates an index — do not re-declare it in `Schema.index()`.

**Why:** Hidden schema-level index calls are easy to miss during review. Keeping them property-local prevents duplicate definitions and Mongoose warnings.

## Rules

1. **Backend tasks** → Use `generating-nest-servers` skill
2. **Frontend tasks** → Use `developing-lt-frontend` skill
3. **Always read framework source** before guessing — in npm mode from
   `node_modules/@lenne.tech/nest-server/`, in vendor mode directly
   from `projects/api/src/core/**`. Run `lt status` inside
   `projects/api/` to confirm the current mode.
4. **API types must be generated** (`pnpm run generate-types` in `projects/app/`) before frontend work
5. **Backend must be running** under `lt dev up` (URL: `https://api.{{PROJECT_NAME}}.localhost`) — or on `localhost:3000` for classic mode — before frontend development
