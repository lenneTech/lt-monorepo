---
name: Security overrides for commit-and-tag-version transitive deps
description: pnpm.overrides for commit-and-tag-version transitive vulnerabilities; only fast-xml-parser override remains active as of 2026-05-10
type: project
---

Active `pnpm.overrides` as of 2026-05-10:
- `fast-xml-parser@<5.7.0: 5.7.3` — fixes moderate XML Comment/CDATA Injection (GHSA-gh4j-gqv2-49f6); also resolves high `fast-xml-builder` <=1.1.6 attribute-quote-bypass (GHSA-5wm8-gmm8-39j9) since `fast-xml-parser` >=5.7.0 requires `fast-xml-builder` ^1.1.7

Removed overrides (2026-05-10) — no longer needed because natural transitive resolution now picks patched versions:
- `handlebars: 4.7.9` — `conventional-changelog-writer` requires `^4.7.7`, latest 4.x is `4.7.9` anyway
- `minimatch@<3.1.4: 10.2.5` — `dotgitignore` requires `^3.0.4`, natural resolution picks `3.1.5` (>= patched `3.1.4`)
- `yaml@>=2.0.0 <2.8.3: 2.8.3` — `commit-and-tag-version@12.7.3` requires `^2.6.0`, natural resolution picks `2.8.4` (>= patched `2.8.3`)

**Why fast-xml-parser still needs an override:** `commit-and-tag-version@12.7.3` only requires `fast-xml-parser ^5.5.6`, and pnpm picks `5.5.10` by default — still in the vulnerable `<5.7.0` range. Override forces `5.7.3` (latest 5.x, no major jump).

**How to apply:** When `commit-and-tag-version` releases a version requiring `fast-xml-parser ^5.7.0` or later, this override can also be removed. Re-verify by removing the override, running `pnpm install` then `pnpm audit`.

Remaining deprecated transitive deps (not fixable via overrides — internal to commit-and-tag-version, no security issue):
- `git-raw-commits@3.0.0` — used internally, latest is 5.0.1
- `git-semver-tags@5.0.1` — used internally, latest is 8.0.1
