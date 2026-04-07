---
name: Security overrides for commit-and-tag-version transitive deps
description: pnpm.overrides added 2025-04 to fix vulnerabilities in handlebars, minimatch, yaml pulled in by commit-and-tag-version@12.7.1
type: project
---

Active `pnpm.overrides` as of 2026-04-07:
- `handlebars: 4.7.9` — fixes critical/high/moderate JS injection and prototype pollution CVEs
- `minimatch@<3.1.4: 10.2.5` — fixes high ReDoS vulnerabilities (also resolves brace-expansion vuln as side effect)
- `yaml@>=2.0.0 <2.8.3: 2.8.3` — fixes moderate stack overflow on deeply nested YAML

**Why:** `commit-and-tag-version@12.7.1` is the latest version but ships with old transitive deps. Overrides are necessary until the package is updated.
**How to apply:** When `commit-and-tag-version` releases a new version, re-check if these overrides are still needed by running `pnpm audit` after removing them.

Remaining deprecated transitive deps (not fixable via overrides — internal to commit-and-tag-version):
- `git-raw-commits@3.0.0` — used internally, latest is 5.0.1 (no security issue, just deprecated)
- `git-semver-tags@5.0.1` — used internally, latest is 8.0.1 (no security issue, just deprecated)
