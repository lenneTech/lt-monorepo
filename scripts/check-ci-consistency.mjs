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
 *   7. A `pnpm run <script>` the target package does not define — see the rule's
 *      own docblock at `checkScripts`. Every other rule checks the SHAPE of a
 *      command; this one checks that the command is real. It covers calls whose
 *      target is knowable: a `cd`, `-C`/`--dir`, a bare root call, and
 *      `--filter=<package-name>` resolved through `pnpm-workspace.yaml`. It also
 *      covers the reverse — a `--filter` naming a package the workspace does not
 *      define, which pnpm answers by matching nothing and exiting 0, so the step
 *      silently does not run. `-r` and the set-valued filter forms (`api...`,
 *      `[origin/main]`, `!api`) have no single target and are recorded as SKIPPED.
 *   8. An E2E job pointing at a NON-loopback database without
 *      `E2E_ALLOW_REMOTE_DB: "true"` — or carrying that flag while pointing
 *      somewhere the job does not own. `assertSafeToDelete` (nuxt-base-starter →
 *      nuxt-base-template/tests/e2e/helpers/auth-backend.ts) refuses to reset
 *      test data unless the URI is loopback or the flag opts out, so rule 6's
 *      mandate — address the service by alias, not on 127.0.0.1 — is itself what
 *      makes the opt-out mandatory. The two halves live in different repos and
 *      neither can see the other: the URI is set here, the guard runs there, and
 *      a generated project went red in CI while the same suite passed locally.
 *      The second direction matters just as much, because this is a TEMPLATE:
 *      once the flag ships into every generated project, a rule that only ever
 *      demands it can never notice it being pointed at a database that outlives
 *      the job.
 *
 * Scans BOTH pipeline definitions so GitLab and GitHub cannot drift apart — they
 * are meant to be equivalent, and deploy.yml gates its deploy on the GitHub one.
 * Rule 6 is the ONE deliberate exception: GitHub Actions gives every job its own
 * ephemeral runner and its own service containers, so it has neither the flag
 * nor the problem. Rule 8 explicitly is NOT an exception, and was one by accident
 * for exactly one commit — GitHub's `app-test` runs inside a `container:`, so its
 * service is reachable only as `mongo:27017`, which is as non-loopback as
 * GitLab's. Scoping a rule to one pipeline is a decision that belongs in this
 * list, with its reason; silence here reads as "nobody got round to it".
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

import { packageDirsByName, workspacePackageDirs } from './lib/workspace-packages.mjs';

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
  return indentedBlock(body, 'services');
}

/**
 * One `key:` section of a YAML body, and nothing below it.
 *
 * Extracted from `servicesBlock` when rule 8 needed the same scoping for
 * `variables:` (GitLab) and `env:` (GitHub). Scoping is not cosmetic in either
 * case: an unscoped `/MONGO_URI:/` over the whole job body also matches
 * `- echo "MONGO_URI: mongodb://prod/live"` in a `script:` line, and the rule
 * then reports a finding against a job that sets no such variable — the same
 * class of false positive `servicesBlock` was written to avoid for `- mongodump`.
 */
function indentedBlock(body, key) {
  // EVERY occurrence, not the first. `effectiveBody` concatenates a job with the
  // blocks it `extends:`, so a merged body legitimately holds several `variables:`
  // sections — the job's own and one per parent. Returning only the first meant an
  // opt-out inherited from a template was invisible, and the rule demanded a flag
  // the pipeline already set two blocks down. Same argument for `services:`.
  const out = [];
  const lines = body.split('\n');
  // `[ \t]` and NOT `\s`: `\s` also matches newlines, so the class eats the
  // preceding blank lines, `indent.length` comes out too large, and the very first
  // line of the section reads as "back at job level" — the section then scans as
  // empty. Only shows up on concatenated bodies, which is exactly where it matters.
  const head = new RegExp(`^([ \\t]*)${key}:[ \\t]*(.*)$`);

  for (let i = 0; i < lines.length; i++) {
    const m = head.exec(lines[i]);
    if (!m) continue;
    const [, indent, sameLine] = m;
    // Flow sequence on the same line: `services: [mongo:7]`.
    if (sameLine.trim().startsWith('[')) {
      out.push(sameLine);
      continue;
    }
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*$/.test(lines[j])) continue;
      // Back at (or above) the key itself → this section is over.
      if (lines[j].search(/\S/) <= indent.length) break;
      out.push(lines[j]);
    }
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
  return /^\s*-\s*(?:name:\s*)?["']?[\w.\-/]*mongo/im.test(servicesText) || /\[[^\]]*\bmongo/i.test(servicesText);
}

/**
 * Loopback URIs — a VERBATIM mirror of `LOOPBACK_URI` in the frontend template:
 * nuxt-base-starter → nuxt-base-template/tests/e2e/helpers/auth-backend.ts:119.
 *
 * It is a module-local `const` there, not an export — and nothing here could
 * import it anyway: this script's own repo keeps `projects/` EMPTY by design, so
 * at the moment the rule runs in the template there is no checkout to import
 * from. Mirroring is the only option the layout leaves, which is exactly why it
 * has to be verbatim and why the test file carries a drift detector against the
 * sibling checkout.
 *
 * Both drift directions have teeth, and the second is the dangerous one:
 *   - NARROWER than the guard (what a paraphrase produced first) — the check
 *     reds a pipeline the guard is perfectly happy with (`mongodb://localhost`,
 *     `mongodb+srv://…`, `user:pw@127.0.0.1`). The cheapest way out for whoever
 *     hits it is to set the destructive opt-out that was never needed, and a
 *     guard that fails on correct config is the fastest route to being deleted.
 *   - WIDER than the guard — `mongodb://127.0.0.1:27017,prod.example.com:27017/x`
 *     reads as loopback to a `[:/]` terminator (it matches the port colon) while
 *     the guard's `(:\d+)?(\/|$)` correctly refuses the seed list. Check green,
 *     CI red, a real host sitting in the URI: the precise silently-green split
 *     this whole file exists to close.
 */
export const LOOPBACK_URI = /^mongodb(\+srv)?:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/;

/**
 * The database URI an E2E job actually hands to the test helpers.
 *
 * Precedence mirrors auth-backend.ts:99 —
 * `NSC__MONGOOSE__URI || MONGO_URI || <loopback default>` — so `NSC__` wins.
 * That is not a tie-break detail: nest-server does not read `MONGO_URI` at all
 * (confirmed against its source — zero occurrences), because `NSC__MONGOOSE__URI`
 * is one instance of the generic `NSC__<PATH>__<TO>__<OPTION>` config surface.
 * The `NSC__` spelling is therefore the one an lt CI job really carries, and a
 * rule that greps only `MONGO_URI:` does not merely miss an alias — it fails to
 * ARM in the exact spelling the stack uses, reporting a silent skip as coverage.
 */
export function e2eMongoUri(varsText) {
  for (const key of ['NSC__MONGOOSE__URI', 'MONGO_URI']) {
    // `^\s*` anchors to a whole key, which is what keeps `NSC__MONGOOSE__URI`
    // from also matching the `MONGO_URI` pattern on the next pass.
    const m = new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm').exec(varsText || '');
    // `(.+)$` and not `[^"'\s]+`: the GitHub spelling is
    // `mongodb://mongo:27017/app-ci-${{ matrix.shard }}`, and stopping at the
    // first space truncates it to `…app-ci-${{` in every message.
    if (m) return unquote(stripTrailingComment(m[1]).trim());
  }
  return undefined;
}

/**
 * Is `key: true` set in any of these blocks (job, its `extends:` chain, global)?
 *
 * Third occurrence of the same shape — `FF_NETWORK_PER_BUILD` (rule 6) and both
 * halves of rule 8 — so it stops being a coincidence and becomes a helper.
 */
export function varIsTrue(key, ...texts) {
  const re = new RegExp(`^\\s*${key}:\\s*["']?true`, 'm');
  return texts.some((t) => t && re.test(t));
}

/** Redact URI credentials exactly as the guard's own error message does. */
const redact = (uri) => uri.replace(/\/\/[^@]*@/, '//***@');

/**
 * Does this job run the Playwright E2E suite — the only thing that calls
 * `resetTestData`, and therefore the only subject rule 8 has?
 *
 * Deliberately broad, and broad in the SAFE direction: matching a job that does
 * not reset data costs nothing, because the rule then finds no E2E database and
 * returns. Missing one that does costs the whole failure this rule exists for.
 * `playwright` catches the runner, the `mcr.microsoft.com/playwright` image and
 * the `container:` built on it; `E2E_BUILT_SERVER` catches a suite wired up
 * without either.
 */
function runsE2eSuite(body) {
  return /playwright/i.test(body) || /E2E_BUILT_SERVER/.test(body);
}

/**
 * Top-level `.gitlab-ci.yml` keys that are configuration, not jobs.
 *
 * `splitTopLevelBlocks` cannot tell them apart — everything at column 0 is a
 * block — so a rule naming `gitlab/${name}` would otherwise report against
 * `gitlab/variables` or `gitlab/stages`, blaming something no runner will ever
 * execute while the job that actually breaks goes unmentioned.
 */
const NOT_A_JOB = new Set(['default', 'include', 'stages', 'variables', 'workflow']);

/**
 * Rule 8, for one job of either pipeline — see the header.
 *
 * Two assertions, deliberately, because the opt-out is a DESTRUCTIVE permission
 * shipped from a TEMPLATE into every generated project. A rule that only ever
 * demands the flag is satisfied by its mere presence forever after; repoint the
 * URI at a shared database a year later and nothing says a word. So the second
 * assertion asks the question the first cannot: is the thing you were granted
 * permission to wipe actually this job's own throwaway service?
 */
function checkE2eResetPermission({ body, globalVars, label, rule, services, vars }) {
  // Only jobs that actually RUN the E2E suite are subjects. Keying on the
  // database alone was wrong in a way worth recording, because the wrong version
  // was the intuitive one: `api:test` also declares a mongo service and also sets
  // a non-loopback URI (`NSC__MONGOOSE__URI`, the canonical lt spelling) — but it
  // runs the API suite, never Playwright, and so never reaches `resetTestData`.
  // Demanding the flag there is not merely noise: whoever follows the message
  // sets a DESTRUCTIVE opt-out in a job that resets nothing, and a guard that
  // talks people into granting wider delete permissions than they need is
  // working against its own purpose.
  if (!runsE2eSuite(body)) return;

  const uri = e2eMongoUri(vars) ?? e2eMongoUri(globalVars);
  // No E2E database configured → nothing to permit. Not a silent pass: there is
  // genuinely no subject for the rule, and the summary reports what DID arm.
  if (!uri) return;

  const optedOut = varIsTrue('E2E_ALLOW_REMOTE_DB', vars, globalVars);
  const loopback = LOOPBACK_URI.test(uri);
  const host = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^:/,?]+)/.exec(uri)?.[1];

  rule(
    `${label}: E2E data reset is permitted against the CI database`,
    loopback || optedOut,
    `points the E2E database at \`${redact(uri)}\`, which is not loopback, without setting \`E2E_ALLOW_REMOTE_DB: "true"\`. Every spec calling \`resetTestData\` then fails with "Refusing to delete test data" — while the same suite stays green locally, where the URI is 127.0.0.1. Set the flag when the database is a per-job service container (it is thrown away with the job); do NOT set it when the URI could reach a real database. An indirect value (\`$SOME_VAR\`) is treated as non-loopback by design — this script reads the YAML, not the runner's expanded environment`,
  );

  if (optedOut && !loopback) {
    rule(
      `${label}: the E2E reset opt-out targets a throwaway service container`,
      Boolean(host) && services.includes(host),
      `sets \`E2E_ALLOW_REMOTE_DB: "true"\` while the E2E database host is \`${host}\`, which this job declares no \`services:\` entry for. The flag disables the only check standing between \`resetTestData\` and a database that outlives the job. Either point the URI at a service this job owns, or drop the flag — do not grant a wipe permission for a host you cannot see being torn down`,
    );
  }
}

/**
 * pnpm subcommands that are NOT script names.
 *
 * `pnpm <name>` with no `run` executes the script `<name>` — that shorthand is
 * idiomatic and fails with the same ERR_PNPM_NO_SCRIPT the rule exists to catch,
 * so it has to be recognised. But `pnpm install` must not be read as a script
 * called "install". Everything pnpm claims for itself is listed here; anything
 * else is a script reference.
 *
 * `test` and `start` are deliberately ABSENT: pnpm's `test`/`start` subcommands
 * do nothing but run the script of that name, so treating them as script
 * references is correct rather than a special case.
 */
/**
 * pnpm/yarn subcommands, so a bare `pnpm <word>` is not mistaken for a script name.
 *
 * Kept in sync with `pnpm help -a` (11.14.0). The omission that motivated this list being
 * audited rather than appended to: `peers` was missing while `pnpm peers check` was being
 * added to this repo's own check chains, so the parser read the invocation as
 * `pnpm run peers` and demanded a `peers` script — a fabricated failure on a correct
 * pipeline, in a job the E2E stage depends on via `needs:`.
 *
 * `test`, `start`, `t` and `c` are pnpm shortcuts too, and are deliberately NOT here:
 * `pnpm test` really does run the `test` script, so checking that the script exists is
 * the right behaviour and listing them would throw that coverage away.
 */
const PM_SUBCOMMANDS = new Set([
  'add',
  'approve-builds',
  'audit',
  'bin',
  'cat-file',
  'cat-index',
  'config',
  'create',
  'dedupe',
  'deploy',
  'dlx',
  'doctor',
  'env',
  'exec',
  'fetch',
  'find-hash',
  'i',
  'ignored-builds',
  'import',
  'init',
  'install',
  'install-test',
  'it',
  'licenses',
  'link',
  'list',
  'ln',
  'ls',
  'outdated',
  'pack',
  'patch',
  'patch-commit',
  'patch-remove',
  'peers',
  'prune',
  'publish',
  'rb',
  'rebuild',
  'remove',
  'rm',
  'root',
  'rt',
  'run',
  'runtime',
  'self-update',
  'server',
  'setup',
  'store',
  'un',
  'uninstall',
  'unlink',
  'up',
  'update',
  'why',
]);

/**
 * A `--filter` target whose directory is recoverable: a bare package name.
 *
 * pnpm's filter syntax also takes paths (`./projects/api`), dependent selectors
 * (`api...`), diff ranges (`[origin/main]`) and exclusions (`!api`). Those name a SET,
 * not a package, and are left unresolved on purpose — guessing would invent findings.
 * The `..` / trailing-dot rejection is what actually keeps `api...` out; the character
 * class alone admits it, because `.` is a member of `[\w.-]`.
 */
const PLAIN_PACKAGE_NAME = /^@?[A-Za-z0-9][\w.-]*(?:\/[\w.-]+)?$/;
const isPlainPackageName = (target) => PLAIN_PACKAGE_NAME.test(target) && !/\.\.|\.$/.test(target);

/**
 * Drop a trailing YAML comment, leaving `#` inside quotes alone.
 *
 * `stripComments` only removes whole comment LINES. A trailing one survives, and
 * `- pnpm run build # pnpm run ghost` then yields a phantom invocation of a
 * script YAML discards before the shell ever sees it — the guard reds a pipeline
 * that is correct, which is the fastest way to get a guard deleted.
 *
 * Quote tracking matters in the other direction: `--filter "#tag"` and a shell
 * string containing `#` are not comments, and cutting there would truncate a real
 * command and hide the invocation after it.
 */
export function stripTrailingComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    // Require whitespace before `#` so `$#`, `a#b` and a bare `#!` are untouched.
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/** Strip one layer of matching quotes from a shell word. */
function unquote(word) {
  return word ? word.replace(/^(["'])([\s\S]*)\1$/, '$2') : word;
}

/**
 * Every package-manager script invocation in a pipeline body, with its target.
 *
 * Three things this has to get right, each learned from a way the first version
 * was wrong:
 *
 * 1. **`cd` DOES carry across lines inside a block scalar.** Both pipelines use
 *    `script: |` / `run: |` with a bare `cd projects/app` on its own line
 *    (.gitlab-ci.yml and .github/workflows/test.yml, the Playwright step). The
 *    first version scoped `cd` to a single line and justified it with "each entry
 *    is its own shell invocation" — true for list items, false for block scalars.
 *    The carry is therefore reset at each new sequence item (`- …`) and each new
 *    mapping key (`key:`), and carried otherwise.
 * 2. **pnpm's own directory flags are directory information.** `pnpm -C <dir> run x`
 *    and `pnpm --dir <dir> run x` were parsed as flags and discarded, so the call
 *    was attributed to the workspace root — a FALSE POSITIVE that reds a correct
 *    pipeline.
 * 3. **Quotes are shell syntax, not part of the value.** `cd "projects/api"` and
 *    `pnpm run "start:e2e:dist"` were both silently dropped — the second one being
 *    the exact invocation this rule was written to catch.
 *
 * Scanned left to right so a `cd` earlier on the line applies to a call later on
 * it, whether joined by `&&` or `;` — both keep the same shell.
 *
 * Result shape, one entry per invocation (a call with several `--filter` flags yields one
 * entry per filter, because pnpm runs the script in each of them):
 *
 *   { kind: 'direct',    dir, script }    a `cd`, `-C`/`--dir`, or a plain root call
 *   { kind: 'recursive', script }         `-r` — runs wherever it exists, no single target
 *   { kind: 'filtered',  filter, script } `--filter`/`-F`; `filter` is the package NAME
 *                                         when the target is a plain one, else `undefined`
 *
 * `filter: undefined` is the meaningful case, not a missing value: it says the target is a
 * set-valued form (`api...`, `[origin/main]`, `!api`, a path) that names no single package,
 * so the caller must not resolve it. A named-but-unresolvable filter is a different fact
 * again, and the caller — not this function — decides what it means.
 */
export function scriptInvocations(text) {
  const out = [];
  // `cd` carried from a previous line of the same block scalar.
  let blockCd = null;

  const TOKEN = new RegExp(
    [
      // 1: cd target
      String.raw`(?:^|[\s;&|(])cd\s+((?:"[^"]*")|(?:'[^']*')|(?:[^\s;&|()]+))`,
      // 2: package manager, 3: flags, 4: explicit `run`, 5: script (optionally quoted)
      String.raw`(?:^|[\s;&|(])(pnpm|npm|yarn)\s+((?:-{1,2}[\w.-]+(?:[= ][^\s]+)?\s+)*)(run\s+)?((?:"[^"]*")|(?:'[^']*')|(?:[A-Za-z0-9:._-]+))`,
    ].join('|'),
    'g',
  );

  for (const rawLine of text.split('\n')) {
    // Whole-line comments never reach the shell.
    if (/^\s*#/.test(rawLine)) continue;
    const line = stripTrailingComment(rawLine);

    // A new sequence item or mapping key starts a new shell; anything carried
    // from the previous line of a block scalar stops applying here.
    if (/^\s*-\s/.test(line) || /^\s*[A-Za-z_][\w.-]*:\s*(?:[|>][-+]?\d*)?\s*$/.test(line)) {
      blockCd = null;
    }

    let cwd = blockCd;
    for (const m of line.matchAll(TOKEN)) {
      const [, cdTarget, pm, flagsRaw, runKeyword, scriptRaw] = m;

      if (cdTarget !== undefined) {
        cwd = unquote(cdTarget);
        continue;
      }

      const flags = flagsRaw ?? '';
      const script = unquote(scriptRaw);

      // Without an explicit `run`, the token is a script only when pnpm/yarn do
      // not claim it as a subcommand. npm has no such shorthand.
      if (!runKeyword) {
        if (pm === 'npm' || PM_SUBCOMMANDS.has(script)) continue;
      }

      // `-r` runs the script in every workspace package that HAS it and exits 0
      // when none do. There is no single package.json to check it against, which
      // is exactly why the build job asserts its artifacts by path instead.
      if (/(?:^|\s)(?:-r|--recursive)(?:\s|$)/.test(flags)) {
        out.push({ kind: 'recursive', script });
        continue;
      }
      // `--filter` names its target, unlike `-r`, so the directory is often recoverable
      // and the call is then as checkable as a `cd`. The target is carried through and the
      // caller resolves it against the workspace.
      //
      // Note this repo's OWN pipelines deliberately do not use `--filter`: see the
      // postmortem in `.gitlab-ci.yml`'s turboops-build header and the twin in
      // `.github/workflows/deploy.yml`, where `pnpm --filter app` matched no package,
      // exited 0, and shipped an image built from a stale `.output`. They use
      // `cd projects/x && pnpm run` instead. The rule is here for generated projects that
      // do reach for `--filter`, and for that incident class specifically — which is why
      // the caller treats "names a package that does not exist" as a failure rather than
      // as something it cannot know.
      //
      // Every filter on the call is emitted, not just the first: `pnpm --filter api
      // --filter app run build` runs the script in BOTH, and checking only `api` let a
      // missing script in `app` through while reporting success.
      const filters = [...flags.matchAll(/(?:^|\s)(?:--filter|-F)[= ]((?:"[^"]*")|(?:'[^']*')|(?:[^\s]+))/g)];
      if (filters.length) {
        for (const match of filters) {
          const target = unquote(match[1]);
          out.push({
            filter: isPlainPackageName(target) ? target : undefined,
            kind: 'filtered',
            script,
          });
        }
        continue;
      }
      // Any other `--filter*` spelling — `--filter-prod` is a real pnpm flag — still
      // narrows the run to something this rule cannot resolve. The broad substring test
      // this replaced caught those by accident and skipped them; an anchored match alone
      // let them fall through to the `direct` branch below, where the call was blamed on
      // the workspace root and reded a pipeline that was correct.
      if (/(?:^|\s)--filter/.test(flags)) {
        out.push({ kind: 'filtered', script });
        continue;
      }

      const dirFlag = /(?:^|\s)(?:--dir|-C)[= ]((?:"[^"]*")|(?:'[^']*')|(?:[^\s]+))/.exec(flags);
      out.push({ dir: unquote(dirFlag?.[1]) ?? cwd ?? '.', kind: 'direct', script });
    }

    // Carry whatever the line ended up in, for the next line of the same block.
    blockCd = cwd;
  }

  return out;
}

/**
 * The `scripts` keys of `<root>/<dir>/package.json`.
 *
 * Three outcomes, kept distinct on purpose. `missing` is the ordinary case in
 * this repo — `projects/` is empty until `lt fullstack init` fills it — and must
 * be reported rather than swallowed, or the rule reads as "held" in the one repo
 * that owns the CI files. `unreadable` is a defect in its own right: a
 * package.json that does not parse would otherwise skip exactly like an absent
 * one, which is how a guard ends up green against a broken project.
 */
export function packageScripts(root, dir) {
  const path = join(root, dir, 'package.json');
  if (!existsSync(path)) return { kind: 'missing', path };
  try {
    return {
      kind: 'ok',
      scripts: Object.keys(JSON.parse(readFileSync(path, 'utf8')).scripts ?? {}),
    };
  } catch (err) {
    return { kind: 'unreadable', path, reason: err.message };
  }
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
  // `jobs:` may legally be the FIRST line — YAML imposes no key order. Anchoring
  // on `\njobs:` alone made such a workflow parse as zero jobs, so every rule
  // silently skipped it and the run reported "no CI job matched any rule". A
  // guard that quietly evaluates nothing is the failure mode this file exists to
  // prevent, so match at position 0 too.
  const jobsAt = text.startsWith('jobs:') ? 0 : text.indexOf('\njobs:');
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
    for (const parent of m[1]
      .replace(/[[\]"']/g, ' ')
      .split(/[,\s]+/)
      .filter(Boolean)) {
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
  const skipped = [];

  /** Record a rule as evaluated, so the summary can prove it did not no-op. */
  const rule = (name, ok, detail) => {
    checked.push(name);
    if (!ok) problems.push(`${name}: ${detail}`);
  };

  /**
   * Rule 7 — a script the pipeline calls must exist in the package it targets.
   *
   * Every other rule here checks the SHAPE of a command; none check that the
   * command is real. `start:e2e:dist` was referenced by both pipelines while
   * `nest-server-starter` defined no such script — the ordering rule above
   * happily confirmed that a nonexistent script ran after `migrate:up`. In a
   * generated project that surfaces as `ERR_PNPM_NO_SCRIPT` minutes into the
   * run, in a job whose name says "e2e", pointing at neither the starter nor
   * the pipeline that named it.
   *
   * Where a target package.json is absent the rule is recorded as SKIPPED, never
   * silently passed. In this repo that is the normal state — `projects/` is
   * empty by design — which is precisely why the skip has to be visible: the one
   * repo that owns these CI files is the one where the rule cannot fire, and a
   * quiet skip would let a bad reference ship to every project generated from it.
   */
  /**
   * Workspace package NAME -> its directory, built once per run.
   *
   * Only needed for `--filter=<name>` calls: the filter names a package, the rule needs a
   * path. Reads the globs from `pnpm-workspace.yaml` rather than assuming `projects/*`, so
   * a workspace that adds `tools/*` is covered without touching this file.
   */
  const packageDirs = packageDirsByName(root);

  const checkScripts = (label, body) => {
    for (let call of scriptInvocations(body)) {
      if (call.kind === 'filtered') {
        if (call.filter && packageDirs.has(call.filter)) {
          // Resolved: as checkable as a `cd` into the same directory.
          call = { dir: packageDirs.get(call.filter), kind: 'direct', script: call.script };
        } else if (call.filter && packageDirs.size > 0) {
          // The workspace resolved and no member carries this name. Nothing is being
          // guessed here — the full name->dir map is in hand, so this is decidable, and
          // it is the one filter failure this repo has already paid for twice: pnpm
          // matches nothing, EXITS 0, and the step silently does not run. That shipped an
          // image built from a stale `.output` and was misdiagnosed as a BuildKit cache
          // bug for a while (see `.gitlab-ci.yml`'s turboops-build header).
          rule(
            `${label}: \`--filter ${call.filter}\` names a workspace package`,
            false,
            `no workspace package is named \`${call.filter}\` — pnpm matches nothing, exits 0, and \`${call.script}\` silently never runs (workspace defines: ${[...packageDirs.keys()].sort().join(', ')})`,
          );
          continue;
        } else {
          // Unverifiable rather than wrong, and recorded rather than dropped. Two ways to
          // get here: the workspace itself resolved nothing — the normal state of THIS
          // repo, where `projects/` is empty until `lt fullstack init` fills it — or the
          // filter is one of the set-valued forms (`api...`, `[origin/main]`, `!api`, a
          // path) that name no single package. A quiet skip is exactly how a guard comes
          // to read as "held" in the one repo that owns these CI files, which is the
          // reason the direct-call path below reports its own misses too.
          // Report what was OBSERVED, not a presumed cause — the same rule the
          // missing-package.json branch below had to learn. "projects/ is empty" is the
          // benign template state; a workspace whose members exist but whose package.json
          // files do not parse is a DEFECT, and describing it with the benign message is
          // how a real breakage comes to look like the expected one.
          const members = workspacePackageDirs(root);
          skipped.push(
            `${label}: \`pnpm run ${call.script}\` — ${
              !call.filter
                ? 'the `--filter` target does not name a single package'
                : members.length === 0
                  ? 'no workspace members yet (`projects/` is empty until `lt fullstack init` fills it)'
                  : `no workspace member declares a package name (${members.join(', ')}) — check their package.json files`
            }`,
          );
          continue;
        }
      }
      if (call.kind !== 'direct') continue;
      const target = packageScripts(root, call.dir);
      const where = call.dir === '.' ? 'the workspace root' : call.dir;

      if (target.kind === 'missing') {
        // Report what was OBSERVED, not a presumed cause. The old text said
        // "(no package.json there yet)" for every unresolved path — so a PARSER
        // defect that produced a bogus directory read as the benign template
        // skip, which is this file's own stated anti-pattern turned inward.
        skipped.push(`${label}: \`pnpm run ${call.script}\` — no package.json at ${target.path}`);
        continue;
      }
      if (target.kind === 'unreadable') {
        rule(
          `${label}: ${where}/package.json parses`,
          false,
          `cannot read ${target.path} (${target.reason}) — every script reference into this package is unverifiable, so treat it as broken rather than skipping it`,
        );
        continue;
      }
      rule(
        `${label}: \`${call.script}\` exists in ${where}`,
        target.scripts.includes(call.script),
        `the pipeline runs \`pnpm run ${call.script}\` in ${where}, which defines no such script (has: ${target.scripts.join(', ') || 'none'}). The job dies on ERR_PNPM_NO_SCRIPT partway through, naming neither the project that lacks it nor the pipeline that asked for it`,
      );
    }
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
      // `NOT_A_JOB` for the same reason rule 8 needs it: a pipeline that puts
      // `$CI_NODE_INDEX` in its GLOBAL `variables:` (a per-shard database name is
      // the obvious case) armed this rule under `gitlab/variables` — a "job" no
      // runner executes, and one nobody can go and fix. The real parallel job that
      // uses the value went unmentioned.
      if (usesNodeIndex && !isParallel && !NOT_A_JOB.has(name)) {
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

      // Rules 6 and 8 — see the header. Hidden templates (`.foo`) are skipped as
      // blocks in their own right: they never run, and they are already covered
      // through every job that extends them, where the message can name a job that
      // actually exists.
      //
      // `NOT_A_JOB` is the same argument for the other kind of non-job. A pipeline
      // that sets its database in the GLOBAL `variables:` block used to arm rule 8
      // under the pseudo-job name `gitlab/variables` — a "job" nobody can go and
      // look at — while the real job that inherits the URI went unchecked and
      // unnamed. Now the block is skipped as a subject and reaches every job as
      // `globalVars` instead, which is where it belongs.
      if (!name.startsWith('.') && !NOT_A_JOB.has(name)) {
        const merged = stripComments(effectiveBody(jobs, name));
        if (declaresMongoService(servicesBlock(merged))) {
          rule(
            `gitlab/${name}: mongo service requests per-build networking (docker executor)`,
            /FF_NETWORK_PER_BUILD:\s*["']?true/.test(merged) || /FF_NETWORK_PER_BUILD:\s*["']?true/.test(globalVars),
            'declares a `mongo` service but no `FF_NETWORK_PER_BUILD: "true"` (neither on the job, on a block it extends, nor in the global `variables:`). Without it the runner keeps the service on the shared default bridge in the deprecated `--link` mode: every container on that host can reach an unauthenticated mongo, and when alias resolution goes, every call waits out MongoDB\'s 30 s server-selection timeout while the log blames the tests. NOTE when adding it: with a per-build network the service is no longer reachable on `127.0.0.1` — address it by its alias (`mongodb://mongo:27017/...`), or this fix breaks a currently-green job',
          );
        }

        // Rule 8 — see the header. The two halves of the contradiction sit in
        // this very file: the rule above REQUIRES per-build networking, and its
        // own note says the service is then reachable only by alias, never on
        // 127.0.0.1. Following rule 6 is therefore what makes the URI
        // non-loopback and the opt-out mandatory.
        //
        // `merged` (own body + `extends:` chain) and not `clean`: a job that
        // inherits its database from a hidden template must be blamed by ITS
        // name, not the template's — same reasoning as rule 6 one block up.
        checkE2eResetPermission({
          body: merged,
          globalVars,
          label: `gitlab/${name}`,
          rule,
          services: servicesBlock(merged),
          vars: indentedBlock(merged, 'variables'),
        });
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

      checkScripts(`gitlab/${name}`, body);
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
      // GitHub's answer to GitLab's global `variables:`. Everything before
      // `jobs:` is workflow scope, and a workflow-level `env:` reaches every job
      // — so rule 8 has to see it, exactly as it sees `globalVars` on the other
      // side. Slicing first keeps a JOB's own `env:` from being mistaken for it.
      const jobsAt = text.search(/^jobs:/m);
      const workflowEnv = jobsAt > 0 ? indentedBlock(stripComments(text.slice(0, jobsAt)), 'env') : '';

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

        // Rule 8 on the GitHub side too — NOT a mirror added for symmetry's sake.
        // `app-test` runs inside `container: mcr.microsoft.com/playwright`, and a
        // service container is reachable from inside a job container only by its
        // alias, never on 127.0.0.1: the URI is `mongodb://mongo:27017/…`, as
        // non-loopback as GitLab's. deploy.yml calls this workflow and gates
        // `build-push` on it (`needs: [guard, test]`), so the same missing flag
        // that reds two shards also stops the deploy.
        //
        // Worth recording why the upstream starter never hit this: it runs
        // `runs-on: ubuntu-latest` with NO `container:`, so GitHub maps the
        // service port onto the runner's own localhost and 127.0.0.1 is simply
        // the correct address there. Its loopback URI is a consequence of the job
        // shape, not an avoidance of the guard — which is why "just use
        // 127.0.0.1 like they do" is not available to us.
        const ghClean = stripComments(body);
        checkE2eResetPermission({
          body: ghClean,
          globalVars: workflowEnv,
          label: `github/${file}/${name}`,
          rule,
          services: indentedBlock(ghClean, 'services'),
          vars: indentedBlock(ghClean, 'env'),
        });

        checkScripts(`github/${file}/${name}`, body);
      }
    }
  }

  return { checked, problems, skipped };
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
  const { checked, problems, skipped } = checkCiConsistency();

  // Printed before the verdict, and printed even when everything passes. A rule
  // that could not run is not a rule that held — and in THIS repo the script
  // -existence rule is skipped for every sub-project call, because `projects/`
  // stays empty until `lt fullstack init` fills it. Saying so out loud is the
  // difference between "verified" and "assumed"; the same silence is what let a
  // reference to a nonexistent `start:e2e:dist` ship to every generated project.
  if (skipped.length) {
    console.log(`[ci-consistency] ${skipped.length} check(s) could not run here:`);
    for (const s of skipped) console.log(`  - ${s}`);
    console.log('  (these DO run in a generated project, where the sub-projects exist)');
  }

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

  // The skip count rides on the LAST line on purpose: both GitLab and GitHub
  // collapse job output, and an unqualified `ok — N rule(s) hold` is read as
  // full coverage while the skip block has scrolled out of view.
  const skipNote = skipped.length ? `, ${skipped.length} skipped` : '';
  console.log(`[ci-consistency] ok — ${checked.length} rule(s) hold${skipNote}: ${checked.join(', ')}`);
}
