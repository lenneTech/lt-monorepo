# {{PROJECT_NAME}} — lenne.Tech Fullstack Monorepo

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
- **Database:** MongoDB (Mongoose ODM)
- **API Mode:** {{API_MODE}}
- **Auth:** Better Auth (2FA, Passkeys, SSR sessions)
- **Port:** 3000

```bash
cd projects/api && pnpm start       # Start backend
cd projects/api && pnpm run test:e2e  # Run API tests
```

### Frontend: `projects/app/`

- **Framework:** {{FRONTEND_FRAMEWORK}} + `@lenne.tech/nuxt-extensions`
- **UI:** NuxtUI 4 + TailwindCSS 4
- **API Client:** Generated types (`types.gen.ts`, `sdk.gen.ts`)
- **Auth:** `useBetterAuth()` composable
- **Port:** 3001

```bash
cd projects/app && pnpm dev           # Start frontend
cd projects/app && pnpm run generate-types  # Generate API types (API must be running)
cd projects/app && pnpm test          # Run Playwright E2E tests
```

## Development

```bash
pnpm install          # Install all dependencies
pnpm run check        # Run checks across all sub-projects
pnpm run check:fix    # Auto-fix across all sub-projects
```

## Framework Source Code

Both frameworks ship their source code and documentation with the npm package. **ALWAYS read actual source code** before guessing framework behavior.

### Backend Framework: @lenne.tech/nest-server

Key files in `projects/api/node_modules/@lenne.tech/nest-server/`:

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Framework rules, architecture overview |
| `FRAMEWORK-API.md` | Compact API reference (interfaces, method signatures) |
| `src/core.module.ts` | CoreModule.forRoot() — module registration |
| `src/core/common/interfaces/server-options.interface.ts` | ALL config interfaces |
| `src/core/common/services/crud.service.ts` | CrudService base class |
| `docs/REQUEST-LIFECYCLE.md` | Complete request lifecycle |

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

**Performance exception:** If memory issues occur under high traffic, check if `CrudService.process()` overhead is the cause. Use `Model.create(doc)` (fastest for single docs) or `Model.insertMany(docs)` (fastest for batches) instead of `CrudService.create()`. Use `findByIdAndUpdate().lean()` for updates, `findById().lean()` for read-only lookups. Defer complex logic to cron/queue in high-frequency paths.

Details: `projects/api/node_modules/@lenne.tech/nest-server/CLAUDE.md` → "Native MongoDB Driver" and "CrudService process()".

## Rules

1. **Backend tasks** → Use `generating-nest-servers` skill
2. **Frontend tasks** → Use `developing-lt-frontend` skill
3. **Always read framework source** from `node_modules/` before guessing
4. **API types must be generated** (`pnpm run generate-types` in `projects/app/`) before frontend work
5. **Backend must be running** on port 3000 for frontend development
