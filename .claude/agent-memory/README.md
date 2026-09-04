# Agent memory — committed on purpose

**Decision (2026-09-03, Kai): these files are versioned with the repo.** They are not scratch
state, and `.gitignore` deliberately does not cover them.

## Why

The notes here are what review agents learned about *this* repository the expensive way — by
measuring something that a fresh run would otherwise measure again, or worse, guess at. A few from
the current set, each of which cost a real investigation:

- `Dirent.isDirectory()` is `false` for a symlinked package directory, so a workspace guard that
  filters on it sees an empty workspace in `lt fullstack init --api-link` checkouts.
- The CI pipelines do not run `pnpm run check` / `check:raw` at all — they mirror the discrete
  steps — so a gate added only to the `check:*` chains has no CI counterpart.
- `pnpm peers check` exists across the whole declared `engines.pnpm` range, verified by unpacking
  the floor version rather than by assuming it.

Uncommitted, that knowledge lives on one machine and dies with the checkout. Committed, the next
review starts from it. This repo is also a template: what is true here is usually true in every
generated project, which is what makes the notes worth carrying.

## What belongs here

Durable, repo-specific facts that were **verified**, with the verification named so the next reader
can redo it. Anything else — a finding, a TODO, a summary of one session's work — belongs in the
review report, a commit message, or a ticket.

## Curation before committing

A stale memory is worse than none: it is trusted and wrong. Before committing a change under this
directory, re-read the entries it touches and delete what the repository has since disproved. An
entry that names a file, a script or a flag is only as good as that name still being real.

Agents write here on their own during a review, so these files routinely turn up dirty in
`git status` after a `/lt-dev:review` run. That is expected — read the diff and keep what earned
its place, rather than committing it unread or discarding it wholesale.
