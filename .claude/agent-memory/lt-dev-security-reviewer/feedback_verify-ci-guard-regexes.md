---
name: verify-ci-guard-regexes
description: Every rule in scripts/check-ci-consistency.mjs is a textual regex over YAML (by design, no parser) — test each one against valid alternative YAML forms before accepting it as a guard
metadata:
  type: feedback
---

When a diff adds or changes a rule in `scripts/check-ci-consistency.mjs` (or a sibling `check-*.mjs`), do not accept the rule as enforcement until its regex has been run against the **valid alternative spellings** of the thing it guards.

**Why:** The script deliberately does textual matching instead of parsing YAML (its own header explains why: GitLab's `!reference` tag breaks most YAML parsers). That makes every rule an exact-shape match. Confirmed 2026-08-18: the new mongo-isolation rule `/-\s*name:\s*mongo:/` arms only on the long form `- name: mongo:7` and silently skips GitLab's equally valid short form `- mongo:7`, an untagged `- name: mongo`, and any registry-prefixed or alternative image name. A guard that skips is indistinguishable from a guard that passes — the exact "fails silently green" class the script exists to catch, now inside the catcher.

**How to apply:** Write a throwaway `node` snippet that feeds the rule's regex ~6-8 valid YAML variants (short form, no tag, registry prefix, alternative image name, value in a hidden `.template` reached via `extends:`) and print ARMED/SKIPPED per case. Also check the rule's *scope*: `splitTopLevelBlocks` keys by top-level block, so a value factored into an `extends:` template lands in a different block than the trigger and produces a false positive. Same treatment for the "does this guard actually run in CI" question — see [[verify-justification-comments]]. Findings here weigh heavier because the guard ships into every generated project ([[template-repo-nature]]).
