---
name: ci-guard-doc-contract
description: In lt-monorepo, every new rule in scripts/check-ci-consistency.mjs must be mirrored in four prose places, or the repo's own self-documentation goes stale
metadata:
  type: project
---

A new rule in `scripts/check-ci-consistency.mjs` is documented in **four** places in
this repo, and past rules honoured all four:

1. The script's header docblock — a numbered list of guarded wiring mistakes, plus
   the "Scans BOTH pipeline definitions" claim and its named GitLab-only exceptions.
2. `CLAUDE.md` → "E2E tests (Playwright)" — inline enumeration of what the guard catches.
3. `README.md` → "CI pipelines." — the same enumeration in user-facing prose.
4. `migration-guides/<version>.md` — this is a TEMPLATE repo consumed by copy, so a new
   guard rule + the CI-file fix it demands is **breaking if adopted partially**
   (copying the script without the pipeline change reds the consumer's first
   `pnpm run check`). Precedent: `3.8.0.md` §5, `3.9.0.md` §1 (which even has a
   "The trap." section for exactly that partial-adoption failure).

**Why:** the file states its own documentation contract ("Rule 6 is the deliberate
exception"), so an unlisted rule is not a style nit — it makes a load-bearing claim
in the file false, and generated projects never learn they must adopt the fix.

**How to apply:** when reviewing any diff that adds/changes a rule in a
`scripts/check-*.mjs` guard, check all four locations before grading documentation,
and check whether the rule was applied to GitHub's `.github/workflows/test.yml` too
or is a genuine GitLab-only exception.

**That GitHub check is not hypothetical — it caught a real gap in 3.11.0.** The E2E
remote-DB rule shipped GitLab-only while `.github/workflows/test.yml` had the
identical defect: `app-test` runs inside `container:`, where a service container is
reachable only by its alias, so its `mongodb://mongo:27017/…` is exactly as
non-loopback as GitLab's. The checker printed `ok — 19 rule(s) hold` over it. The
distinction to apply: the `FF_NETWORK_PER_BUILD` rule is GitLab-only because GitHub
genuinely has no shared bridge; a rule about a RUNTIME guard in the app's test
helpers fires on both. Ask which kind you are looking at, and require the header to
say so either way — silence there reads as "nobody got round to it".

The security-reviewer's own memory holds the regex-level counterpart of this rule
(note `verify-ci-guard-regexes`); it is a different agent's directory, so it is
named here rather than linked.
