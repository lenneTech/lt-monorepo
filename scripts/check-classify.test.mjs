// Contract: what a step of a `check` chain becomes in the wrapper — its kind, its gate
// class, its auto-fix variant, and whether it stays in the root chain at all.
//
// `vue-tsc` / `tsc` saturate the machine like a build, but a chain step reads
// `pnpm run typecheck:tests` and contains neither "build" nor "tsc". Unclassified it
// fell through to `other`, ran outside the build⊥test gate and alongside the API e2e
// suite the gate protects (DEV-2654, DEV-2658). Driven through `buildGroups` and
// `gateClass`, the two exports `runGroup` reads, so a narrowed branch in the private
// `classify()` cannot pass unnoticed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildGroups, gateClass, isRecursiveCheck } from './check.mjs';

/** The typecheck tail of nuxt-base-starter's `check:raw`. */
const APP_CHAIN = 'pnpm run lint && pnpm run build:check && pnpm run typecheck && pnpm run typecheck:tests';

const stepsOf = (check) => buildGroups([{ check, dir: '.', name: 'app', rel: 'projects/app' }]).groups[0].steps;

describe('check.mjs classifies typecheck steps', () => {
  it('gates every typecheck step in the build class', () => {
    const typechecks = stepsOf(APP_CHAIN).filter((s) => s.label.startsWith('typecheck'));
    assert.equal(typechecks.length, 2, 'both typecheck steps of the chain should be recognised');
    for (const step of typechecks) {
      assert.equal(step.kind, 'build', `${step.label} must not run as kind "${step.kind}"`);
      assert.equal(gateClass(step), 'build', `${step.label} runs outside the build⊥test gate`);
    }
  });

  it('keeps the script suffix, so two typecheck steps stay distinguishable', () => {
    assert.deepEqual(
      stepsOf(APP_CHAIN).map((s) => s.label),
      ['lint', 'build', 'typecheck', 'typecheck:tests'],
    );
  });

  it('recognises a typecheck behind a build-dir pin', () => {
    const [step] = stepsOf('cross-env NUXT_BUILD_DIR=.nuxt-check pnpm run typecheck:app');
    assert.equal(step.label, 'typecheck:app');
    assert.equal(gateClass(step), 'build');
  });
});

describe('check.mjs gate classes', () => {
  const classOf = (cmd) => gateClass(stepsOf(cmd)[0]);

  it('treats a bare test step as sensitive, the safe direction', () => {
    // A bare `pnpm test` resolves to the API e2e suite in the starters. Too wide costs
    // wall-clock; too narrow costs the flaky suite this gate exists to fix.
    assert.equal(classOf('pnpm test'), 'test');
  });

  it('lets an explicitly unit-only run through the gate', () => {
    assert.equal(classOf('pnpm run test:unit'), null);
  });

  it('leaves the cheap steps ungated', () => {
    for (const cmd of ['pnpm run format:check', 'pnpm run lint', 'pnpm run check:server-start']) {
      assert.equal(classOf(cmd), null, `\`${cmd}\` must stay fully parallel`);
    }
  });
});

describe('check.mjs hoisting', () => {
  it('does not hoist a project script that merely has "audit" in its name', () => {
    // `runAudit` appends ` --json` to whatever was hoisted. A script that does not accept
    // that flag exits non-zero, and the check fails on an argument the wrapper invented.
    const check = 'pnpm run check:audit-log-schema && pnpm run build';
    const { auditCmd, groups } = buildGroups([{ check, dir: '.', name: 'app', rel: 'projects/app' }]);
    assert.equal(auditCmd, null);
    assert.equal(groups[0].steps.length, 2, 'the audit-named script must stay an ordinary step');
  });
});

describe('check.mjs lint auto-fix', () => {
  const fixed = (check) => stepsOf(check).map((s) => s.cmd);

  it('maps the lint script onto lint:fix', () => {
    assert.deepEqual(fixed('pnpm run lint'), ['pnpm run lint:fix']);
  });

  it('applies only safe oxlint fixes, never suggestions', () => {
    // `--fix-suggestions` applies fixes oxlint itself marks as behaviour-changing: the
    // no-console suggestion deletes every console.log in the linted tree. A `check` run
    // in auto-fix mode must not rewrite program behaviour.
    assert.deepEqual(fixed('oxlint src && npx oxlint --type-aware tests'), [
      'oxlint --fix src',
      'npx oxlint --fix --type-aware tests',
    ]);
  });
});

describe('isRecursiveCheck', () => {
  it('recognises every fan-out spelling, not just `pnpm -r run check`', () => {
    // A surviving fan-out runs every member a SECOND time, concurrently with the wrapper's
    // own member groups, because the root group runs under the same Promise.all. That means
    // two installs against one node_modules and two e2e suites on one database.
    const fanOuts = [
      'pnpm -r --parallel run check',
      'pnpm -r check',
      'pnpm --recursive check',
      'pnpm --filter ./projects/* run check',
      'pnpm --filter=./projects/* run check',
      'npm run check --workspaces',
      'yarn workspaces foreach -A run check',
      'turbo run check',
      'lerna run check',
      'nx run-many -t check',
    ];
    for (const cmd of fanOuts) assert.equal(isRecursiveCheck(cmd), true, `\`${cmd}\` was not detected`);
  });

  it("leaves the root project's own steps alone", () => {
    // A false positive is the quieter failure: the step disappears from the chain and the
    // guard it runs never reports again.
    const ownSteps = [
      'pnpm run check:workspace',
      'pnpm run check:pin',
      'pnpm run check:ci',
      'pnpm run build',
      'node scripts/check-workspace-consistency.mjs',
      'pnpm -r --parallel run build',
    ];
    for (const cmd of ownSteps) assert.equal(isRecursiveCheck(cmd), false, `\`${cmd}\` was wrongly stripped`);
  });
});
