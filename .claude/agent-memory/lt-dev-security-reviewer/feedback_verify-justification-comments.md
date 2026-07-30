---
name: verify-justification-comments
description: In lt base repos, security-justification comments (audit ignores, override pins, "runs in CI via X") must be verified against registry/tarballs/CI files — at least one has been factually wrong
metadata:
  type: feedback
---

Treat the extensive, assertive justification comments in these repos as **claims to verify**, never as evidence. Verify empirically: pull the actual tarball, query the advisory API, grep the CI file that a docstring says runs it.

**Why:** Confirmed in the 2026-07-30 review of the audit-gate change. `pnpm-workspace.yaml` asserted GHSA-mh99-v99m-4gvg was "Patched only in 5.0.8, with no 1.x backport" and that the override "keeps the 1.x line on its newest release". Both false — `brace-expansion@1.1.17`/`1.1.18` carry the CVE-2026-14257 fix (GitHub's advisory range `<=5.0.7` was simply never narrowed for the backport), and the override pinned to `1.1.16`, one version short of the fix. The same wrong sentence had already been copied into `nest-server-starter`. Separately, `scripts/check-playwright-image.mjs` claims it runs "in CI via the `lint` job" — the `lint` job runs only `format:check` + `lint`. The comments are detailed and confident, which is exactly what makes an unverified one dangerous.

**How to apply:** For any accepted-advisory / override / "guarded by X" claim: (1) `npm pack <pkg>@<ver>` and grep the actual fix symbol rather than trusting the advisory's version range — maintainers backport across release lines without the GHSA range being updated; (2) for "this guard runs in CI", grep the job's `script:`/`steps:` for the exact command; (3) for pnpm audit suppressions, prove the gate by temporarily neutering the ignore entry and checking the exit code, then restore. See [[template-repo-nature]] — a wrong justification here propagates into every generated project.
