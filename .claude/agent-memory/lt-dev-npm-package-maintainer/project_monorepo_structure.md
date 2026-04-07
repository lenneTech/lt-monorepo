---
name: lt-monorepo starter kit structure
description: lt-monorepo root package.json has only 2 devDeps (commit-and-tag-version, husky); projects/ dir is empty (.gitkeep); pnpm.onlyBuiltDependencies is a template config for sub-projects
type: project
---

This repo is a **starter kit template**, not an active project with sub-projects.

- `projects/` contains only `.gitkeep` — no api/app sub-projects exist at root level
- Root `devDependencies` has only 2 packages: `commit-and-tag-version` and `husky`
- `pnpm.onlyBuiltDependencies` lists `@swc/core, bcrypt, esbuild, sharp, puppeteer` — this is intentional template config for future sub-projects, NOT unused packages to remove

**Why:** The starter kit pre-configures pnpm security settings so sub-projects inherit them when initialized.
**How to apply:** Do not remove `onlyBuiltDependencies` entries even though those packages aren't installed at root. They're template defaults.
