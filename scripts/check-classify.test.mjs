// Contract: a typecheck step is gated like a build and keeps its script name in the report.
//
// `vue-tsc` / `tsc` saturate the machine like a build, but a chain step reads
// `pnpm run typecheck:tests` and contains neither "build" nor "tsc". Unclassified it
// fell through to `other`, ran outside the build⊥test gate and alongside the API e2e
// suite the gate protects (DEV-2654, DEV-2658). Driven through `buildGroups` and
// `gateClass`, the two exports `runGroup` reads, so a narrowed branch in the private
// `classify()` cannot pass unnoticed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildGroups, gateClass } from './check.mjs';

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
