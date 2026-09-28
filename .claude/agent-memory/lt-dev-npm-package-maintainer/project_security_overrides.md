---
name: Security overrides for commit-and-tag-version transitive deps
description: The one live override (brace-expansion 1.x, now <1.1.21 -> 1.1.21), why it must be re-checked against the newest 1.x every run, and the two-fresh-resolves test; verified 2026-09-28
metadata:
  type: project
---

Overrides live in **`pnpm-workspace.yaml` → `overrides:`**, not `package.json`
(pnpm 11 ignores the `pnpm` block there). Same for `auditConfig`,
`minimumReleaseAgeExclude` and `allowBuilds`.

## Active as of 2026-09-28

- `'brace-expansion@<1.1.21': '1.1.21'` (+ `minimumReleaseAgeExclude: brace-expansion@1.1.21`,
  which moves in lockstep per its comment) — closes GHSA-3jxr-9vmj-r5cp, GHSA-mh99-v99m-4gvg,
  GHSA-rgw5-rvv9-x895 on the 1.x line, via
  `commit-and-tag-version > dotgitignore > minimatch@3.1.5 (^1.1.7) > brace-expansion`.
  **Inert** (a resolve without it also lands on 1.1.21); kept per its own `KEPT` comment in
  `pnpm-workspace.yaml` — the pin costs nothing while 1.1.21 is the newest 1.x.
- History: was `<1.1.18 → 1.1.18` until 2026-09-28, when 1.1.19–1.1.21 (published 2026-09-14,
  pure DoS hardening in index.js, same publisher, no dep change) had turned it into a
  downgrade lock. Raised, not removed.

**Every run: `npm view brace-expansion versions` — if a 1.x newer than the target exists, raise
key and target (and the exclude entry) together.** `pnpm run check` / `check:overrides` does NOT
detect a downgrade lock (it only flags TOO LOW / NOT MATCHING vs. advisories), so a green check
proves nothing here. This exact miss happened between 2026-09-14 and 2026-09-28.

`auditConfig.ignoreGhsas` is **empty** (GHSA-mh99-v99m-4gvg suppression deleted 2026-08-22 after
GitHub narrowed its range). Keep it empty unless a fix provably cannot work.

## The mechanism that makes these entries go bad

**A pnpm override key is matched against the REQUESTED RANGE, not the resolved
version.** So even a bounded key pins rather than floors, and it silently becomes a
downgrade lock as soon as its target falls behind the newest release in that major.

## Removed, with the reason (do not re-add blindly)

- **2026-08-22 `'fast-xml-parser@>=5.9.3 <5.10.1': '5.10.1'`** — downgrade lock
  (pinned 5.10.1 while `^5.5.6` naturally resolved higher); advisory bounded above.
- 2026-05-10 `handlebars`, `minimatch`, `yaml` — natural resolution already patched.

## The verification that actually proves something

Diffing against the committed lockfile proves nothing. In the scratchpad, copy
`package.json` + `pnpm-workspace.yaml` (drop the `packages:` block) into two dirs, strip
`overrides:` AND `auditConfig:` from one, `pnpm install --lockfile-only` in both, compare
`grep -E "^  brace-expansion@" pnpm-lock.yaml`, and `pnpm audit` both. Test the raised variant
the same way and confirm its package set equals the stripped resolve.

`pnpm install` in the repo does re-resolve after the override key changes (the lockfile's
`overrides:` section is invalidated) — confirm with `pnpm why brace-expansion`.

## Deprecated transitive deps (internal to commit-and-tag-version, no advisory)

`git-raw-commits`, `git-semver-tags` — not fixable via overrides, no action.
