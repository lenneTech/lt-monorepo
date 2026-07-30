#!/usr/bin/env node
/**
 * Contract test for the CI pipeline definitions.
 *
 * Every rule below guards a wiring mistake that fails **silently green** — the
 * pipeline reports success while testing less than it claims, which is the one
 * failure mode CI cannot catch by running. A loud failure (a missing artifact, a
 * bad image tag) needs no guard; these do:
 *
 *   1. `parallel:` / a shard matrix without `--shard=` — every shard then runs the
 *      FULL suite. N times the cost, still green, invisible in the report.
 *   2. A `$CI_NODE_INDEX`-gated step in a job that is not `parallel:` — GitLab
 *      only defines that variable for parallel jobs, so `[ "$CI_NODE_INDEX" = "1" ]`
 *      becomes `[ "" = "1" ]` → false, and the step (here: the frontend unit
 *      tests) never runs again. Green pipeline, zero vitest specs.
 *   3. A non-blocking audit job (`allow_failure` / `continue-on-error`) — that
 *      suppresses EVERY advisory including future ones. Unresolvable advisories
 *      belong in `auditConfig.ignoreGhsas` (pnpm-workspace.yaml), one entry each,
 *      so a red audit means something genuinely new.
 *   4. `E2E_BUILT_SERVER` without the build artifact wired in — Playwright then
 *      serves nothing and the shards die on a webServer timeout that points at
 *      Playwright rather than at the build.
 *   5. `start:e2e:dist` without `migrate:up` before it — bare node runs no
 *      migrations, the demo data is missing, and every test built on it skips
 *      itself. A suite that quietly skips away reports green and verifies nothing.
 *
 * Scans BOTH pipeline definitions so GitLab and GitHub cannot drift apart — they
 * are meant to be equivalent, and deploy.yml gates its deploy on the GitHub one.
 *
 * Exit code: 0 when every rule holds, 1 otherwise.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const checked = [];

/** Record a rule as evaluated, so the summary can prove it did not no-op. */
function rule(name, ok, detail) {
  checked.push(name);
  if (!ok) problems.push(`${name}: ${detail}`);
}

/**
 * Drop `#` comment lines.
 *
 * Ordering rules ("migrate:up must precede start:e2e:dist") compare positions of
 * literals, and these files explain their commands in prose directly above them —
 * so a comment mentioning `start:e2e:dist` would be found before the actual
 * invocation and invert the verdict. Only lines whose first non-space character
 * is `#` are dropped; a trailing `#` inside a shell command is left alone.
 */
function stripComments(body) {
  return body
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

/** Index of `needle` among the actual commands, ignoring commentary. */
function cmdIndexOf(body, needle) {
  return stripComments(body).indexOf(needle);
}

// ── GitLab ───────────────────────────────────────────────────────────────────
const gitlabPath = join(ROOT, '.gitlab-ci.yml');
if (existsSync(gitlabPath)) {
  const text = readFileSync(gitlabPath, 'utf8');
  // Split into top-level blocks: a job starts at column 0 with `name:`.
  const jobs = splitTopLevelBlocks(text);

  for (const [name, body] of Object.entries(jobs)) {
    const clean = stripComments(body);
    const isParallel = /^\s{2}parallel:\s*\d+/m.test(clean);
    const usesShardFlag = /--shard=\$CI_NODE_INDEX\/\$CI_NODE_TOTAL/.test(clean);
    const usesNodeIndex = /\$\{?CI_NODE_INDEX/.test(clean);

    if (isParallel) {
      rule(
        `gitlab/${name}: parallel job passes --shard`,
        usesShardFlag,
        'job sets `parallel:` but never passes `--shard=$CI_NODE_INDEX/$CI_NODE_TOTAL` — every shard would run the FULL suite at N times the cost, and still report green',
      );
    }

    // A bare "$CI_NODE_INDEX" comparison in a non-parallel job silently evaluates
    // to the empty string. `${CI_NODE_INDEX:-1}` is the safe form and is allowed
    // either way, because it degrades to "run it" rather than "skip it".
    if (usesNodeIndex && !isParallel) {
      const guardedWithDefault = /\$\{CI_NODE_INDEX:-/.test(clean);
      rule(
        `gitlab/${name}: CI_NODE_INDEX only in a parallel job`,
        guardedWithDefault,
        'job reads $CI_NODE_INDEX but is not `parallel:`. GitLab leaves that variable unset outside parallel jobs, so a `[ "$CI_NODE_INDEX" = "1" ]` guard is always false and its step never runs. Use `${CI_NODE_INDEX:-1}`',
      );
    }

    if (/^\s{2}(?:script|before_script):/m.test(clean) && /audit/.test(name)) {
      rule(
        `gitlab/${name}: audit job blocks`,
        !/^\s{2}allow_failure:\s*true/m.test(clean),
        'the audit job carries `allow_failure: true`, which suppresses EVERY advisory including ones nobody has assessed yet. Put unresolvable advisories in `auditConfig.ignoreGhsas` (pnpm-workspace.yaml) instead — one entry each, with its rationale',
      );
    }

    if (/E2E_BUILT_SERVER:\s*["']?true/.test(clean)) {
      rule(
        `gitlab/${name}: built-server job consumes the build artifact`,
        /needs:/.test(clean) && /job:\s*build/.test(clean) && /artifacts:\s*true/.test(clean),
        'sets `E2E_BUILT_SERVER: "true"` but does not declare `needs: [{job: build, artifacts: true}]`. Playwright would start `node .output/server/index.mjs` against nothing and every shard would die on the webServer timeout',
      );
    }

    if (/start:e2e:dist/.test(stripComments(body))) {
      const migrateAt = cmdIndexOf(body, 'migrate:up');
      const startAt = cmdIndexOf(body, 'start:e2e:dist');
      rule(
        `gitlab/${name}: migrations run before the compiled API`,
        migrateAt !== -1 && migrateAt < startAt,
        '`start:e2e:dist` is bare node and runs no migrations. Without a `migrate:up` before it the demo data is missing and every test that depends on it skips itself — the suite reports green having verified nothing',
      );
    }
  }

  const buildBody = jobs.build ?? '';
  if (buildBody) {
    rule(
      'gitlab/build: artifact contract is asserted',
      /test -f projects\/api\/dist/.test(stripComments(buildBody)) &&
        /test -f projects\/app\/\.output/.test(stripComments(buildBody)),
      '`pnpm -r run build` exits 0 when no package matches, and GitLab treats an artifact path matching no files as a warning. Assert the outputs exist (`test -f …`) so an empty build fails here instead of as four E2E timeouts',
    );
  }
}

// ── GitHub Actions ───────────────────────────────────────────────────────────
const ghDir = join(ROOT, '.github/workflows');
if (existsSync(ghDir)) {
  for (const file of readdirSync(ghDir).filter((f) => /\.ya?ml$/.test(f))) {
    const text = readFileSync(join(ghDir, file), 'utf8');
    const jobs = splitGithubJobs(text);

    for (const [name, body] of Object.entries(jobs)) {
      if (/audit/.test(name)) {
        rule(
          `github/${file}/${name}: audit job blocks`,
          !/^\s*continue-on-error:\s*true/m.test(stripComments(body)),
          'the audit job carries `continue-on-error: true`, which suppresses every advisory including new ones — and deploy.yml gates its deploy on this workflow',
        );
      }

      const hasShardMatrix = /matrix:[\s\S]*?\bshard:\s*\[/.test(stripComments(body));
      if (hasShardMatrix) {
        rule(
          `github/${file}/${name}: shard matrix passes --shard`,
          /--shard=\$\{\{\s*matrix\.shard\s*\}\}\//.test(stripComments(body)),
          'declares a `shard` matrix but never passes `--shard=${{ matrix.shard }}/N` — every matrix job would run the FULL suite and still report green',
        );
      }

      if (/start:e2e:dist/.test(stripComments(body))) {
        const migrateAt = cmdIndexOf(body, 'migrate:up');
        const startAt = cmdIndexOf(body, 'start:e2e:dist');
        rule(
          `github/${file}/${name}: migrations run before the compiled API`,
          migrateAt !== -1 && migrateAt < startAt,
          '`start:e2e:dist` runs no migrations; without `migrate:up` before it the dependent tests skip themselves and the suite reports a green nothing',
        );
      }
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
if (checked.length === 0) {
  // Not an error: a bare template with no CI files, or a project that renamed
  // its jobs. But say so — "0 rules evaluated" must never read as "all good".
  console.log('[ci-consistency] ok — no CI job matched any rule (nothing to guard)');
  process.exit(0);
}

if (problems.length) {
  process.stderr.write(`[ci-consistency] ${problems.length} problem(s):\n`);
  for (const p of problems) process.stderr.write(`  - ${p}\n`);
  process.stderr.write(
    '\n  Each of these fails SILENTLY GREEN in CI — the pipeline passes while testing less than it claims.\n',
  );
  process.exit(1);
}

console.log(`[ci-consistency] ok — ${checked.length} rule(s) hold: ${checked.join(', ')}`);

/**
 * Split a GitLab CI file into top-level blocks keyed by job name.
 * Deliberately textual rather than a YAML parse: GitLab's `!reference` tag is not
 * standard YAML and trips most parsers, and every rule here is a shape check.
 */
function splitTopLevelBlocks(text) {
  const out = {};
  let current = null;
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z0-9_.:-]+):\s*$/.exec(line);
    if (m) {
      current = m[1];
      out[current] = '';
      continue;
    }
    if (current) out[current] += `${line}\n`;
  }
  return out;
}

/** Same idea for GitHub Actions, where jobs are nested one level under `jobs:`. */
function splitGithubJobs(text) {
  const out = {};
  const jobsAt = text.indexOf('\njobs:');
  if (jobsAt === -1) return out;
  let current = null;
  for (const line of text.slice(jobsAt).split('\n')) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) {
      current = m[1];
      out[current] = '';
      continue;
    }
    if (current) out[current] += `${line}\n`;
  }
  return out;
}
