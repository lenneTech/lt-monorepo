---
name: Security overrides for commit-and-tag-version transitive deps
description: The single remaining pnpm override (brace-expansion 1.x) and why the fast-xml-parser one was removed as a downgrade lock; verified 2026-08-22
type: project
---

Overrides live in **`pnpm-workspace.yaml` → `overrides:`**, not `package.json`
(pnpm 11 ignores the `pnpm` block there). Same for `auditConfig`,
`minimumReleaseAgeExclude` and `allowBuilds`.

## Active as of 2026-08-22

- `'brace-expansion@<1.1.18': '1.1.18'` — GHSA-3jxr-9vmj-r5cp + GHSA-mh99-v99m-4gvg,
  via `commit-and-tag-version > dotgitignore > minimatch@3 > brace-expansion`.
  **Currently inert** (a resolve without it also lands on 1.1.18) and kept only
  because 1.1.18 IS the newest 1.x, so the pin costs nothing. **It must be raised
  the day 1.1.19 ships**, or it becomes a cap.

`auditConfig.ignoreGhsas` is now **empty**. The GHSA-mh99-v99m-4gvg suppression
was deleted 2026-08-22: GitHub narrowed the advisory from a blanket `<= 5.0.7` to
per-major windows (1.x is now `< 1.1.17`), so the installed 1.1.18 no longer
matches and the entry's own removal condition was met.

## The mechanism that makes these entries go bad

**A pnpm override key is matched against the REQUESTED RANGE, not the resolved
version.** So even a bounded key pins rather than floors, and it silently becomes a
downgrade lock as soon as its target falls behind the newest release in that major.

Proven empirically here: with `commit-and-tag-version` requesting
`fast-xml-parser: ^5.5.6` (natural resolve 5.11.0), adding the probe key
`'fast-xml-parser@<5.6.0': '5.9.0'` — a window the resolved version does NOT
satisfy — still fired and installed 5.9.0.

## Removed, with the reason (do not re-add blindly)

- **2026-08-22 `'fast-xml-parser@>=5.9.3 <5.10.1': '5.10.1'`** — GHSA-8r6m-32jq-jx6q
  is bounded above (first patched 5.10.1), and `^5.5.6` floats clear of the window
  on its own. The entry was pinning 5.10.1 while 5.11.0 existed. Two fresh
  `--lockfile-only` resolves differed in exactly one package (5.10.1 with / 5.11.0
  without) and `pnpm audit` was clean without it.
- 2026-05-10 `handlebars`, `minimatch`, `yaml` — same pattern: natural transitive
  resolution already picks a patched version.

## The verification that actually proves something

Diffing against the committed lockfile proves nothing — it already carries the
pinned versions. Do **two fresh `--lockfile-only` resolves** from the same
`package.json` in a scratch dir, one with `overrides:` and one with it stripped,
diff the resolved versions, and run `pnpm audit` on both. Strip `auditConfig` too,
or a suppression hides the answer.

Note `pnpm install` reuses existing lockfile entries, so after changing an override
you need `pnpm update <pkg>` or a full `rm -rf node_modules pnpm-lock.yaml` to see
the real resolution.

## Deprecated transitive deps (internal to commit-and-tag-version, no advisory)

`git-raw-commits`, `git-semver-tags` — not fixable via overrides, no action.
