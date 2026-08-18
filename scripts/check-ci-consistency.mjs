#!/usr/bin/env node
/**
 * Contract test for the CI pipeline definitions.
 *
 * Every rule below guards a wiring mistake that CI cannot catch by running: it
 * either fails **silently green** — the pipeline reports success while testing
 * less than it claims — or it fails **loudly but names the wrong culprit**, so
 * the log sends whoever reads it in the wrong direction for hours. A loud,
 * correctly-named failure (a missing artifact, a bad image tag) needs no guard;
 * these do:
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
 *   6. A job declaring a `mongo` service without `FF_NETWORK_PER_BUILD: "true"`.
 *      This is the member of the set that fails LOUDLY rather than green — and
 *      it is in here because of how it fails. Without the flag the runner keeps
 *      the service on the shared default bridge in the deprecated `--link` mode
 *      instead of a per-build network with DNS aliases. Every container on that
 *      host can then reach an unauthenticated `mongo:7` (port access is full
 *      access), and alias resolution is fragile: when it goes, the job dies on
 *      `getaddrinfo ENOTFOUND mongo` once per call, each preceded by MongoDB's
 *      30 s server-selection timeout. The log reads like failing sign-up tests
 *      and the real cause sits thousands of lines up.
 *      GitLab-only, and Docker-executor-only: Kubernetes executors run services
 *      as pod sidecars and Shell executors have no service containers at all, so
 *      the flag is a REQUEST that a runner may ignore (it also loses to a
 *      `network_mode` in config.toml). See the rule name below, which says so.
 *
 * Scans BOTH pipeline definitions so GitLab and GitHub cannot drift apart — they
 * are meant to be equivalent, and deploy.yml gates its deploy on the GitHub one.
 * Rule 6 is the deliberate exception: GitHub Actions gives every job its own
 * ephemeral runner and its own service containers, so it has neither the flag
 * nor the problem.
 *
 * Testability is part of the contract. This file is a guard against failures that
 * "pass" — so an untested guard has the exact defect it exists to prevent, and a
 * rule whose condition never matches would report `ok — N rule(s) hold` forever.
 * The checks therefore live in an exported function that runs no process.exit;
 * only the CLI wrapper at the bottom does. Same split as scripts/check.mjs.
 *
 * Exit code: 0 when every rule holds, 1 otherwise.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Drop `#` comment lines.
 *
 * Ordering rules ("migrate:up must precede start:e2e:dist") compare positions of
 * literals, and these files explain their commands in prose directly above them —
 * so a comment mentioning `start:e2e:dist` would be found before the actual
 * invocation and invert the verdict. Only lines whose first non-space character
 * is `#` are dropped; a trailing `#` inside a shell command is left alone.
 */
export function stripComments(body) {
  return body
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

/** Index of `needle` among the actual commands, ignoring commentary. */
function cmdIndexOf(body, needle) {
  return stripComments(body).indexOf(needle);
}

/**
 * The `services:` section of a job, and nothing else.
 *
 * Scoping matters: a bare `/mongo/` over the whole job body also matches a
 * `- mongodump …` line in `script:`, and the rule would fire on a job that
 * declares no service at all. Handles both YAML spellings — the block sequence
 * and the flow sequence on the same line.
 */
export function servicesBlock(body) {
  // `[ \t]` and NOT `\s`: with `\s*` the greedy class eats the preceding blank
  // lines and their newlines, so `indent.length` comes out too large and the very
  // first service line reads as "back at job level" — the section then scans as
  // empty. Only shows up once bodies are concatenated (an `extends:` merge), which
  // is exactly where the rule has to work.
  const m = /^([ \t]*)services:[ \t]*(.*)$/m.exec(body);
  if (!m) return '';
  const [, indent, sameLine] = m;
  if (sameLine.trim().startsWith('[')) return sameLine;
  const rest = body.slice(m.index).split('\n').slice(1);
  const out = [];
  for (const line of rest) {
    if (/^\s*$/.test(line)) continue;
    // Back at (or above) the `services:` key itself → section is over.
    if (line.search(/\S/) <= indent.length) break;
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Does this `services:` section declare a MongoDB?
 *
 * Deliberately broad. GitLab accepts several spellings and the idiomatic short
 * form is the one a developer is most likely to write:
 *
 *     - name: mongo:7      - mongo:7      - "mongo:7"      [mongo:7]
 *     - name: mongo        - name: docker.io/library/mongo:7
 *     - name: bitnami/mongodb:7            - name: mongodb/mongodb-community-server:7.0
 *
 * A false positive costs one line of `FF_NETWORK_PER_BUILD`; a false negative
 * costs the isolation while the summary line reassures the reader that all rules
 * hold. Matching only `- name: mongo:` — as this rule first did — recognises
 * exactly the spelling that is already correct and protects nothing.
 */
export function declaresMongoService(servicesText) {
  if (!servicesText) return false;
  return (
    /^\s*-\s*(?:name:\s*)?["']?[\w.\-/]*mongo/im.test(servicesText) ||
    /\[[^\]]*\bmongo/i.test(servicesText)
  );
}

/**
 * Split a GitLab CI file into top-level blocks keyed by job name.
 * Deliberately textual rather than a YAML parse: GitLab's `!reference` tag is not
 * standard YAML and trips most parsers, and every rule here is a shape check.
 */
export function splitTopLevelBlocks(text) {
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
export function splitGithubJobs(text) {
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

/**
 * Everything a job effectively sees: its own body plus every block it `extends:`.
 *
 * Without this, a service moved into a hidden template (`.with-mongo`) and a flag
 * left on the concrete job look like two unrelated blocks, and the rule fires on
 * the template — naming a "job" that never runs, while the job that will actually
 * break is not mentioned.
 */
export function effectiveBody(jobs, name, seen = new Set()) {
  if (seen.has(name)) return '';
  seen.add(name);
  const own = jobs[name] ?? '';
  let merged = own;
  for (const m of own.matchAll(/^\s*(?:-\s*)?extends:\s*(.+)$/gm)) {
    for (const parent of m[1].replace(/[[\]"']/g, ' ').split(/[,\s]+/).filter(Boolean)) {
      merged += `\n${effectiveBody(jobs, parent, seen)}`;
    }
  }
  return merged;
}

/**
 * Run every rule. Pure: collects results instead of exiting, so a test can drive
 * it. `root` points at a directory holding `.gitlab-ci.yml` / `.github/workflows`.
 */
export function checkCiConsistency(root = ROOT) {
  const problems = [];
  const checked = [];

  /** Record a rule as evaluated, so the summary can prove it did not no-op. */
  const rule = (name, ok, detail) => {
    checked.push(name);
    if (!ok) problems.push(`${name}: ${detail}`);
  };

  // ── GitLab ─────────────────────────────────────────────────────────────────
  const gitlabPath = join(root, '.gitlab-ci.yml');
  if (existsSync(gitlabPath)) {
    const text = readFileSync(gitlabPath, 'utf8');
    // Split into top-level blocks: a job starts at column 0 with `name:`.
    const jobs = splitTopLevelBlocks(text);
    // A feature flag set once for the whole pipeline applies to every job. Reading
    // only the job block would red a pipeline that is configured correctly — and a
    // guard that fails on correct config is the fastest way to get itself deleted.
    const globalVars = stripComments(jobs.variables ?? '');

    for (const [name, body] of Object.entries(jobs)) {
      const clean = stripComments(body);
      const isParallel = /^\s{2}parallel:\s*\d+/m.test(clean);
      const usesShardFlag = /--shard=["']?\$CI_NODE_INDEX\/\$CI_NODE_TOTAL/.test(clean);
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

      // Rule 6 — see the header. Hidden templates (`.foo`) are skipped as blocks in
      // their own right: they never run, and they are already covered through every
      // job that extends them, where the message can name a job that actually exists.
      if (!name.startsWith('.')) {
        const merged = stripComments(effectiveBody(jobs, name));
        if (declaresMongoService(servicesBlock(merged))) {
          rule(
            `gitlab/${name}: mongo service requests per-build networking (docker executor)`,
            /FF_NETWORK_PER_BUILD:\s*["']?true/.test(merged) ||
              /FF_NETWORK_PER_BUILD:\s*["']?true/.test(globalVars),
            'declares a `mongo` service but no `FF_NETWORK_PER_BUILD: "true"` (neither on the job, on a block it extends, nor in the global `variables:`). Without it the runner keeps the service on the shared default bridge in the deprecated `--link` mode: every container on that host can reach an unauthenticated mongo, and when alias resolution goes, every call waits out MongoDB\'s 30 s server-selection timeout while the log blames the tests. NOTE when adding it: with a per-build network the service is no longer reachable on `127.0.0.1` — address it by its alias (`mongodb://mongo:27017/...`), or this fix breaks a currently-green job',
          );
        }
      }

      if (/start:e2e:dist/.test(clean)) {
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

  // ── GitHub Actions ─────────────────────────────────────────────────────────
  const ghDir = join(root, '.github/workflows');
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

  return { checked, problems };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// Split into a pure DECISION and its side effect on purpose — same reasoning as
// scripts/check.mjs: with `process.exit` inlined in the rules, no test could
// reach the failing branch without taking the test process down with it.
export function resolveCliEntry(entry = process.argv[1], self = fileURLToPath(import.meta.url)) {
  if (!entry) return { isEntry: false };
  try {
    return { isEntry: realpathSync(entry) === realpathSync(self) };
  } catch (err) {
    // "Cannot tell" is NOT "not the entry" — the caller must fail closed.
    return { isEntry: false, unresolvable: err };
  }
}

function isCliEntry() {
  const { isEntry, unresolvable } = resolveCliEntry();
  if (unresolvable) {
    // Fail CLOSED: reporting "not the CLI" here would exit 0 without running a
    // single rule — the green gate this file exists to prevent.
    process.stderr.write(
      `[ci-consistency] cannot resolve the CLI entry (${unresolvable?.code || unresolvable}) — refusing to report success\n`,
    );
    process.exit(1);
  }
  return isEntry;
}

if (isCliEntry()) {
  const { checked, problems } = checkCiConsistency();

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
      '\n  Each of these either fails SILENTLY GREEN in CI, or fails loudly while naming the wrong culprit.\n',
    );
    process.exit(1);
  }

  console.log(`[ci-consistency] ok — ${checked.length} rule(s) hold: ${checked.join(', ')}`);
}
