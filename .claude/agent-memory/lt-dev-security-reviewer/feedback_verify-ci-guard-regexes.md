---
name: verify-ci-guard-regexes
description: Every rule in scripts/check-ci-consistency.mjs is a textual regex over YAML (by design, no parser) — test each one against valid alternative YAML forms before accepting it as a guard
metadata:
  type: feedback
---

When a diff adds or changes a rule in `scripts/check-ci-consistency.mjs` (or a sibling `check-*.mjs`), do not accept the rule as enforcement until its regex has been run against the **valid alternative spellings** of the thing it guards.

**Why:** The script deliberately does textual matching instead of parsing YAML (its own header explains why: GitLab's `!reference` tag breaks most YAML parsers). That makes every rule an exact-shape match. Confirmed 2026-08-18: the new mongo-isolation rule `/-\s*name:\s*mongo:/` arms only on the long form `- name: mongo:7` and silently skips GitLab's equally valid short form `- mongo:7`, an untagged `- name: mongo`, and any registry-prefixed or alternative image name. A guard that skips is indistinguishable from a guard that passes — the exact "fails silently green" class the script exists to catch, now inside the catcher.

**How to apply:** Write a throwaway `node` snippet that feeds the rule's regex ~6-8 valid YAML variants (short form, no tag, registry prefix, alternative image name, value in a hidden `.template` reached via `extends:`) and print ARMED/SKIPPED per case. Also check the rule's *scope*: `splitTopLevelBlocks` keys by top-level block, so a value factored into an `extends:` template lands in a different block than the trigger and produces a false positive. Same treatment for the "does this guard actually run in CI" question — see [[verify-justification-comments]]. Findings here weigh heavier because the guard ships into every generated project ([[template-repo-nature]]).

**Confirmed again 2026-09-02, with two extensions to the rule.**

The E2E remote-DB rule paraphrased a predicate that already existed in another repo, and drifted BOTH ways at once: too strict on `mongodb://localhost`, `mongodb+srv://…` and `user:pw@127.0.0.1` (reds a correct pipeline, and the cheapest escape is to set the DESTRUCTIVE opt-out that was never needed), and too loose on `mongodb://127.0.0.1:27017,prod.example.com:27017/x` (the `[:/]` terminator matched the port colon, so a seed list reaching a production host passed as loopback). Same substring-instead-of-whole-segment shape as nest-server's `SAFE_TEST_DB_PATTERN` bug, where `ci` matched inside "pricing".

1. **Do not paraphrase a predicate that exists elsewhere — mirror it verbatim and pin it.** Where the original cannot be imported (here: the checker runs in the template, where `projects/` is empty by design), add a drift detector that reads the sibling checkout and compares the sources. It must report SKIPPED, never green, when the checkout is absent, with a strict-mode env var for release runs. `scripts/check-ci-consistency.test.mjs` → `describe('LOOPBACK_URI drift detector')` is the working example.
2. **Ask what the rule's SUBJECT is before asking what its regex matches.** This rule first keyed on "job has a database", which armed on `api:test` — a job with a mongo service that never runs Playwright and never deletes anything. Demanding a delete permission there teaches people to grant one they do not need, and a permission granted out of habit is soon one nobody checks. The right discriminator was `runsE2eSuite(body)`. A guard can be regex-perfect and still aimed at the wrong jobs.
