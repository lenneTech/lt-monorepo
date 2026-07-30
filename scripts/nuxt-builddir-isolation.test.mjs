// Contract: a `check` run must never write the Nuxt build directory that a
// parked `nuxt dev` (typically `lt dev up`) reads.
//
// Background: `nuxt dev`, `nuxt prepare` and `nuxt build` all write their
// generated types — including `tsconfig.json` — into the build dir. With a
// single shared `.nuxt/`, a dev server rewrote that file in place while a gate
// was reading it, and the run failed with a flood of TS2307 on every `~`/`#`
// alias plus TS1378 — on code that was perfectly fine. It reads exactly like a
// real type error, so it costs a debugging round every single time.
//
// The app template pins `NUXT_BUILD_DIR=.nuxt-check` on the commands it owns
// (`build:check`, `typecheck:*`). One writer has no script to pin it in:
// `postinstall: nuxt prepare`. That hook inherits the env of whatever triggered
// the install — and THIS runner triggers one on every run (the hoisted install).
// Unpinned, a check therefore still rewrites the dev server's `.nuxt/`, which is
// the same race, just moved into the install phase.
//
// ── Scope of this file vs. its siblings ──────────────────────────────────────
// A materialised project has TWO more guards covering the rest of the contract
// (nuxt.config's overridable buildDir, the tsconfig twins, gitignore /
// dockerignore, `clean`/`reinit`): `nuxt-base-starter`'s
// tests/unit/nuxt-builddir-isolation.test.ts, cloned into every `projects/app`.
// They cannot live here — `projects/` is empty in the template until
// `lt fullstack init` fills it. What IS testable here is the runner, so that is
// what this file pins.
//
// ── Writing assertions here: assert the EFFECT, never the spelling ───────────
// A guard that cannot fail is worse than no guard. Two vacuous-pass traps have
// actually bitten this file and are now pinned by positive controls:
//
//   * an empty loop — a `for` over commands that match nothing passes silently.
//     Every loop below counts its iterations and fails when the body never ran.
//   * an empty-collection assertion — `deepEqual(leaked, [])` is also satisfied
//     when the collection it was filtered from is itself empty. Gutting
//     `buildGroups` so it pushed no steps at all once left this file fully
//     green. Every such assertion is now preceded by a check that the haystack
//     was non-empty.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// Importing the runner is itself part of the contract: it must expose its pure
// helpers WITHOUT starting a check run. `isCliEntry()` in check.mjs is what
// guarantees that, and the spawn probe at the bottom of this file asserts it
// explicitly rather than relying on this import to notice.
import { PM_INVOCATION, buildGroups, pinCheckBuildDir, resolveCliEntry } from './check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** The isolated build directory the check writes. */
const CHECK_DIR = '.nuxt-check';

/** Escape a literal for safe interpolation into a RegExp. */
const rx = (literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Anchored: a pin buried mid-command would not reach the child's env. */
const PINNED = new RegExp(`^NUXT_BUILD_DIR=${rx(CHECK_DIR)}\\s`);

/**
 * The commands that run package-manager lifecycle hooks.
 *
 * Deliberately a LOCAL literal rather than the imported `PM_INVOCATION`. If this
 * test asked check.mjs what counts as a package-manager command, then narrowing
 * check.mjs's own predicate would narrow the test in lockstep and the leak
 * assertions could no longer fail. The imported constant is still checked — see
 * "the two predicates agree" below — but against this independent definition.
 */
const PM_SHAPES = /\b(?:pnpm|npm|yarn|bun)\s+(?:(?:audit|ci|install|i)\b|run\s+\S*(?:audit|install)\S*)/;

const rootScripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts;

/** A project as `discoverProjects()` yields it. */
const asProject = (rel, check) => ({ check, dir: join(ROOT, rel), name: rel, rel });

/**
 * A member chain that does NOT pin the build dir itself — which is the whole
 * point of it.
 *
 * This is adversarial input, NOT a mirror of what `lt fullstack init` ships. It
 * stands in for the cases the runner-level pin exists for: an older starter, or
 * `projects/api`, whose real chain in `nest-server-starter` is still unpinned.
 * Keep it unpinned. Syncing it to the current (pinned) `nuxt-base-starter` chain
 * would make the two hoist assertions below tautologies — they would pass
 * whether or not `buildGroups` pins anything at all.
 */
const UNPINNED_MEMBER_CHAIN =
  'pnpm install --frozen-lockfile && pnpm audit && pnpm run format:check && pnpm run lint && ' +
  'pnpm test && pnpm run build:check && pnpm run typecheck:tests && bash scripts/check-server-start.sh';

/** A member chain that already pins, i.e. what the current starter ships. */
const PINNED_MEMBER_CHAIN =
  `NUXT_BUILD_DIR=${CHECK_DIR} pnpm install --frozen-lockfile && NUXT_BUILD_DIR=${CHECK_DIR} pnpm audit && ` +
  'pnpm run lint';

describe("DEV-2720 — the runner's own package-manager steps write .nuxt-check", () => {
  it('the hoisted install is pinned', () => {
    const { installCmd } = buildGroups([asProject('projects/app', UNPINNED_MEMBER_CHAIN)]);
    assert.ok(installCmd, 'the chain no longer yields a hoisted install — there is nothing left to pin');
    assert.match(
      installCmd,
      PINNED,
      `the hoisted install \`${installCmd}\` runs \`postinstall: nuxt prepare\` against the dev build dir — it collides with a parked \`lt dev up\``,
    );
  });

  it('the hoisted audit is pinned', () => {
    const { auditCmd } = buildGroups([asProject('projects/app', UNPINNED_MEMBER_CHAIN)]);
    assert.ok(auditCmd, 'the chain no longer yields a hoisted audit');
    assert.match(auditCmd, PINNED, `the hoisted audit \`${auditCmd}\` is not pinned to ${CHECK_DIR}`);
  });

  it('an already-pinned member chain is not double-prefixed', () => {
    // The two layers (chain pins itself, runner pins again) must compose to
    // exactly one prefix. A doubled prefix is legal sh but makes the reported
    // step unreadable, and it would hide which layer actually applied it.
    const { installCmd, auditCmd } = buildGroups([asProject('projects/app', PINNED_MEMBER_CHAIN)]);
    for (const [name, cmd] of [
      ['install', installCmd],
      ['audit', auditCmd],
    ]) {
      assert.ok(cmd, `the pinned chain no longer yields a hoisted ${name}`);
      assert.equal(
        (cmd.match(/NUXT_BUILD_DIR=/g) || []).length,
        1,
        `hoisted ${name} carries a doubled pin: \`${cmd}\``,
      );
    }
  });

  it('no package-manager command reaches the step list unpinned', () => {
    // Two layers make this hold: classify() routes installs and audits into a
    // hoist, AND buildGroups pins the ordinary steps too. The second layer is
    // what survives a narrowed classify() — its `vendor-freshness` branch once
    // ran ahead of the install branch and let `pnpm install --filter
    // vendor-freshness` land here with no pin at all.
    const { groups } = buildGroups([
      asProject('projects/app', UNPINNED_MEMBER_CHAIN),
      // A second member: only the FIRST install/audit is captured by a hoist, so
      // any further one has to survive as a step — pinned.
      asProject(
        'projects/api',
        'pnpm install --frozen-lockfile && pnpm audit && pnpm i && pnpm run audit:ci && ' +
          'pnpm install --filter vendor-freshness && pnpm run build',
      ),
    ]);
    const steps = groups.flatMap((g) => g.steps);
    // POSITIVE CONTROL. Without it the filter below is satisfied by an empty
    // step list, and gutting buildGroups' `steps.push` leaves this test green.
    assert.ok(steps.length > 0, 'buildGroups produced no steps at all — the assertion below would pass vacuously');
    const leaked = steps.filter((s) => PM_SHAPES.test(s.cmd) && !PINNED.test(s.cmd));
    assert.deepEqual(
      leaked.map((s) => s.cmd),
      [],
      'a package-manager command reached the step list without NUXT_BUILD_DIR — it will fire the app\'s `postinstall: nuxt prepare` against the dev build dir',
    );
  });

  it("check.mjs's own predicate is at least as wide as this file's", () => {
    // The silent failure this pins: classify() hoists a command while
    // pinCheckBuildDir() declines to pin it. Hoisted-but-unpinned is the worst
    // combination, because the command is no longer in the step list where the
    // leak assertion above would have caught it.
    const shapes = [
      'pnpm install',
      'pnpm install --frozen-lockfile',
      'pnpm i',
      'npm ci',
      'pnpm audit',
      'pnpm audit --fix',
      'pnpm run audit:ci',
      'yarn install',
      'bun install',
    ];
    let seen = 0;
    for (const cmd of shapes) {
      if (!PM_SHAPES.test(cmd)) continue;
      seen++;
      assert.ok(
        PM_INVOCATION.test(cmd),
        `check.mjs's PM_INVOCATION does not recognise \`${cmd}\`, so pinCheckBuildDir() leaves it unpinned`,
      );
      assert.match(pinCheckBuildDir(cmd), PINNED, `\`${cmd}\` is not pinned by pinCheckBuildDir()`);
    }
    assert.ok(seen > 0, 'no shape matched the local predicate — this test no longer proves anything');
  });
});

describe('DEV-2720 — pinCheckBuildDir', () => {
  it('pins install/ci/audit and nothing else', () => {
    assert.equal(
      pinCheckBuildDir('pnpm install --frozen-lockfile'),
      `NUXT_BUILD_DIR=${CHECK_DIR} pnpm install --frozen-lockfile`,
    );
    assert.equal(pinCheckBuildDir('pnpm audit --fix'), `NUXT_BUILD_DIR=${CHECK_DIR} pnpm audit --fix`);
    assert.equal(pinCheckBuildDir('npm ci'), `NUXT_BUILD_DIR=${CHECK_DIR} npm ci`);
    // Untouched: these either pin themselves in package.json or write no build
    // dir at all. A blanket prefix would silently override a step that
    // deliberately targets a different dir.
    assert.equal(pinCheckBuildDir('pnpm run test:unit'), 'pnpm run test:unit');
    assert.equal(pinCheckBuildDir(`NUXT_BUILD_DIR=${CHECK_DIR} nuxt build`), `NUXT_BUILD_DIR=${CHECK_DIR} nuxt build`);
    assert.equal(pinCheckBuildDir('bash scripts/check-server-start.sh'), 'bash scripts/check-server-start.sh');
  });

  it('is idempotent and never overrides an explicit pin', () => {
    // buildGroups may route a command through it twice, and a doubled prefix is
    // legal in sh but makes the reported step unreadable.
    const once = pinCheckBuildDir('pnpm install');
    assert.equal(pinCheckBuildDir(once), once);
    assert.equal(pinCheckBuildDir('NUXT_BUILD_DIR=.nuxt-other pnpm install'), 'NUXT_BUILD_DIR=.nuxt-other pnpm install');
  });
});

describe('DEV-2723 — the raw chains pin their package-manager steps themselves', () => {
  // DEV-2720 pinned the RUNNER. Starting `check:raw` / `check:fix` / `check:naf`
  // directly bypasses the runner and would otherwise bypass its pin too, so the
  // chains carry the pin as well. Both layers are idempotent
  // (`pinCheckBuildDir` never double-prefixes), so they compose.
  it("the template's own root chain still runs a package-manager step", () => {
    // Positive control for the chain assertions in this describe: without a
    // package-manager step anywhere in `check:raw`, the loop below has nothing
    // to iterate and would pass having asserted nothing.
    assert.match(
      rootScripts['check:raw'],
      PM_SHAPES,
      'root `check:raw` no longer contains an install/audit — the chain assertions below assert nothing',
    );
  });

  it("the template's own check chains are pinned", () => {
    let seen = 0;
    for (const [name, chain] of Object.entries(rootScripts).filter(([k]) => /^check(?::|$)/.test(k))) {
      for (const step of chain.split('&&').map((s) => s.trim())) {
        if (!PM_SHAPES.test(step)) continue;
        seen++;
        assert.match(step, PINNED, `\`${name}\`: step \`${step}\` runs the package manager unpinned — started directly it fires the app's \`postinstall: nuxt prepare\` against the dev build dir`);
      }
    }
    assert.ok(seen > 0, 'no check chain surfaced a package-manager step — this test no longer proves anything');
  });

  it('`init` / `reinit` stay unpinned (they are what supplies the IDE)', () => {
    // The counterpart, and the reason the rule is scoped to `check*` instead of
    // every script: pinning these would move the staleness instead of fixing it.
    let seen = 0;
    for (const script of ['init', 'reinit']) {
      const cmd = rootScripts[script];
      // assert, not `continue` — if both scripts disappear this test must fail
      // rather than quietly stop checking anything.
      assert.ok(cmd, `root \`${script}\` script is gone — it is what keeps the IDE's dev build dir supplied`);
      seen++;
      assert.doesNotMatch(cmd, /NUXT_BUILD_DIR=/, `\`${script}\` must stay unpinned — it is what keeps the IDE's dev build dir supplied`);
    }
    assert.equal(seen, 2, 'expected both `init` and `reinit` to be present');
  });
});

describe('DEV-2720 — the runner exposes its helpers without running', () => {
  const probe = join(tmpdir(), `check-import-probe-${process.pid}.mjs`);
  after(() => {
    try {
      require('node:fs').rmSync(probe, { force: true });
    } catch {
      /* best effort */
    }
  });

  it('importing check.mjs does not start a check run', () => {
    // Asserted explicitly rather than left implicit in this file's own import.
    // If `isCliEntry()` regresses, importing the module runs main() — which
    // spawns install/audit/build, and since `test:scripts` is itself inside that
    // chain, RECURSIVELY. A fork bomb is not a test failure anyone can read, so
    // this runs in a child process with a hard timeout instead.
    writeFileSync(probe, `import ${JSON.stringify(pathToFileUrlish(join(HERE, 'check.mjs')))};\n`);
    const res = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(res.signal, null, `importing check.mjs did not terminate (signal ${res.signal}) — isCliEntry() no longer guards main()`);
    assert.equal(res.status, 0, `importing check.mjs exited ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.equal(res.stdout.trim(), '', `importing check.mjs produced output — it started a run:\n${res.stdout}`);
  });

  it('resolveCliEntry fails CLOSED when the entry cannot be resolved', () => {
    // The branch that matters most and was previously untestable: with
    // `process.exit(1)` inlined, a regression to a silent `return false` — the
    // "green gate that never ran" — produced no test reaction at all.
    const self = join(HERE, 'check.mjs');
    assert.equal(resolveCliEntry(self, self).isEntry, true, 'the module should recognise itself as the entry');
    assert.equal(resolveCliEntry(join(HERE, 'check.mjs'), join(HERE, 'build-test-gate.mjs')).isEntry, false);
    assert.equal(resolveCliEntry(undefined, self).isEntry, false, 'no argv[1] means not the CLI entry');

    const missing = join(tmpdir(), 'definitely-does-not-exist-check-entry.mjs');
    const verdict = resolveCliEntry(missing, self);
    assert.equal(verdict.isEntry, false);
    assert.ok(
      verdict.unresolvable,
      '"cannot tell" must be reported as unresolvable, not as a plain false — the caller has to fail closed, otherwise `node scripts/check.mjs` prints nothing and exits 0',
    );
  });
});

/** file:// URL for an absolute path, without pulling in another import. */
function pathToFileUrlish(abs) {
  return new URL(`file://${abs}`).href;
}
