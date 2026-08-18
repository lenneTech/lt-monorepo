// Contract: the CI guard must actually FIRE.
//
// This file exists because of a concrete defect. The mongo-isolation rule
// originally matched `- name: mongo:` and nothing else — so it recognised only
// the one spelling already present in this repo's `.gitlab-ci.yml`, and every
// other valid spelling (GitLab's idiomatic `- mongo:7`, a flow sequence, an
// untagged image, any registry prefix) walked straight past it. The script still
// printed `ok — N rule(s) hold` and exited 0, which is precisely the
// "silently green" failure mode the script was written to prevent.
//
// The trap that made it invisible: a NEGATIVE control alone cannot catch it.
// Deleting `FF_NETWORK_PER_BUILD` from a job spelled `- name: mongo:7` does turn
// the script red, so a single test would have passed while seven of eight
// spellings went unguarded. Every rule below is therefore driven from BOTH sides:
// a positive control proving the guard ARMS on the shape, and a negative control
// proving it FIRES when the required wiring is missing. A rule that only ever
// gets asserted in its passing state is indistinguishable from a rule that is
// never evaluated at all.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { checkCiConsistency, declaresMongoService, servicesBlock } from './check-ci-consistency.mjs';

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { force: true, recursive: true })));

/** Materialise a throwaway repo root holding the given CI files. */
function fixture({ github, gitlab }) {
  const root = mkdtempSync(join(tmpdir(), 'ci-consistency-'));
  dirs.push(root);
  if (gitlab) writeFileSync(join(root, '.gitlab-ci.yml'), gitlab);
  if (github) {
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    for (const [file, body] of Object.entries(github)) {
      writeFileSync(join(root, '.github/workflows', file), body);
    }
  }
  return root;
}

const run = (files) => checkCiConsistency(fixture(files));
/** Did any rule matching `needle` get EVALUATED (armed), regardless of verdict? */
const armed = (res, needle) => res.checked.some((c) => c.includes(needle));
/** Did any rule matching `needle` FAIL? */
const failed = (res, needle) => res.problems.some((p) => p.includes(needle));

const mongoJob = (service, vars = '    FF_NETWORK_PER_BUILD: "true"\n') =>
  `api:test:\n  stage: test\n  services:\n${service}  variables:\n${vars}`;

describe('mongo isolation rule — arming across YAML spellings (DEV-3068)', () => {
  // Each of these is valid GitLab and declares a MongoDB service. The rule must
  // ARM on every one; the original `- name: mongo:` regex armed on only the first.
  const spellings = {
    'block form, name + tag': '    - name: mongo:7\n      alias: mongo\n',
    'short form': '    - mongo:7\n',
    'short form, quoted': '    - "mongo:7"\n',
    'long form, untagged': '    - name: mongo\n',
    'registry prefix': '    - name: docker.io/library/mongo:7\n',
    'vendor image': '    - name: bitnami/mongodb:7\n',
    'community server': '    - name: mongodb/mongodb-community-server:7.0\n',
  };

  for (const [label, service] of Object.entries(spellings)) {
    it(`arms on ${label}`, () => {
      const res = run({ gitlab: mongoJob(service) });
      assert.ok(armed(res, 'mongo service requests per-build networking'), `rule never armed on: ${label}`);
      assert.equal(failed(res, 'mongo service'), false, 'flag IS present — must not fail');
    });

    it(`fires on ${label} when the flag is missing`, () => {
      const res = run({ gitlab: mongoJob(service, '    NSC__MONGOOSE__URI: "mongodb://mongo:27017/x"\n') });
      assert.ok(failed(res, 'mongo service'), `rule did not fire on: ${label}`);
    });
  }

  it('arms on the flow sequence', () => {
    const res = run({ gitlab: 'api:test:\n  stage: test\n  services: [mongo:7]\n  variables:\n    X: "1"\n' });
    assert.ok(failed(res, 'mongo service'), 'flow-sequence service went unguarded');
  });

  it('stays silent for a job with no mongo service at all', () => {
    const res = run({ gitlab: 'lint:\n  stage: test\n  script:\n    - pnpm run lint\n' });
    assert.equal(armed(res, 'mongo service'), false);
  });

  it('does not mistake a `mongodump` command for a service declaration', () => {
    // `services:` scoping — a bare /mongo/ over the job body matches script lines.
    const res = run({ gitlab: 'backup:\n  stage: test\n  script:\n    - mongodump --uri "$URI"\n' });
    assert.equal(armed(res, 'mongo service'), false, 'a script line must not arm the service rule');
  });
});

describe('mongo isolation rule — where the flag is allowed to live', () => {
  it('accepts the flag in the global variables block', () => {
    // Valid GitLab, arguably cleaner than repeating it per job. Reading only the
    // job block reds a correctly configured pipeline — and a guard that fails on
    // correct config is the fastest route to being deleted downstream.
    const res = run({
      gitlab:
        'variables:\n  FF_NETWORK_PER_BUILD: "true"\n\n' +
        'api:test:\n  stage: test\n  services:\n    - name: mongo:7\n  variables:\n    X: "1"\n',
    });
    assert.ok(armed(res, 'mongo service requests per-build networking'));
    assert.equal(failed(res, 'mongo service'), false, 'globally-set flag must satisfy the rule');
  });

  it('accepts the flag inherited through extends', () => {
    const res = run({
      gitlab:
        '.distributed:\n  variables:\n    FF_NETWORK_PER_BUILD: "true"\n\n' +
        'api:test:\n  stage: test\n  extends: .distributed\n  services:\n    - name: mongo:7\n',
    });
    assert.equal(failed(res, 'mongo service'), false, 'flag on the extended block must count');
  });

  it('blames the real job, not the hidden template, when the service is inherited', () => {
    const res = run({
      gitlab:
        '.with-mongo:\n  services:\n    - name: mongo:7\n\n' +
        'api:test:\n  stage: test\n  extends: .with-mongo\n  script:\n    - pnpm test\n',
    });
    assert.ok(failed(res, 'gitlab/api:test'), 'the failing job must be named');
    assert.equal(
      res.problems.some((p) => p.includes('gitlab/.with-mongo')),
      false,
      'a hidden template never runs — naming it sends the reader to the wrong file',
    );
  });
});

describe('sharding rules', () => {
  it('fires when a parallel job never passes --shard', () => {
    const res = run({
      gitlab: 'app:test:\n  parallel: 2\n  script:\n    - pnpm exec playwright test --reporter=blob\n',
    });
    assert.ok(failed(res, 'parallel job passes --shard'));
  });

  it('passes when --shard is wired, quoted or bare', () => {
    for (const arg of ['--shard=$CI_NODE_INDEX/$CI_NODE_TOTAL', '--shard="$CI_NODE_INDEX/$CI_NODE_TOTAL"']) {
      const res = run({ gitlab: `app:test:\n  parallel: 2\n  script:\n    - pnpm exec playwright test ${arg}\n` });
      assert.ok(armed(res, 'parallel job passes --shard'), `rule did not arm for ${arg}`);
      assert.equal(failed(res, 'parallel job passes --shard'), false, `false positive for ${arg}`);
    }
  });

  it('fires on an unguarded $CI_NODE_INDEX in a non-parallel job', () => {
    const res = run({
      gitlab: 'app:test:\n  script:\n    - if [ "$CI_NODE_INDEX" = "1" ]; then pnpm run test:unit; fi\n',
    });
    assert.ok(failed(res, 'CI_NODE_INDEX only in a parallel job'));
  });

  it('accepts the ${CI_NODE_INDEX:-1} default form', () => {
    const res = run({
      gitlab: 'app:test:\n  script:\n    - if [ "${CI_NODE_INDEX:-1}" = "1" ]; then pnpm run test:unit; fi\n',
    });
    assert.equal(failed(res, 'CI_NODE_INDEX only in a parallel job'), false);
  });
});

describe('audit gate', () => {
  it('fires on allow_failure in GitLab', () => {
    const res = run({ gitlab: 'audit:\n  stage: test\n  allow_failure: true\n  script:\n    - pnpm audit\n' });
    assert.ok(failed(res, 'audit job blocks'));
  });

  it('passes for a blocking GitLab audit job', () => {
    const res = run({ gitlab: 'audit:\n  stage: test\n  script:\n    - pnpm audit\n' });
    assert.ok(armed(res, 'audit job blocks'));
    assert.equal(failed(res, 'audit job blocks'), false);
  });

  it('fires on continue-on-error in GitHub', () => {
    const res = run({
      github: { 'test.yml': 'name: Test\non: [push]\njobs:\n  audit:\n    continue-on-error: true\n    steps:\n      - run: pnpm audit\n' },
    });
    assert.ok(failed(res, 'audit job blocks'));
  });
});

describe('built server + migrations', () => {
  it('fires when E2E_BUILT_SERVER lacks the build artifact', () => {
    const res = run({ gitlab: 'app:test:\n  variables:\n    E2E_BUILT_SERVER: "true"\n  script:\n    - pnpm test\n' });
    assert.ok(failed(res, 'consumes the build artifact'));
  });

  it('fires when start:e2e:dist runs without migrate:up', () => {
    const res = run({ gitlab: 'app:test:\n  script:\n    - pnpm run start:e2e:dist\n' });
    assert.ok(failed(res, 'migrations run before the compiled API'));
  });

  it('fires when migrate:up runs AFTER start:e2e:dist', () => {
    const res = run({
      gitlab: 'app:test:\n  script:\n    - pnpm run start:e2e:dist\n    - pnpm run migrate:up\n',
    });
    assert.ok(failed(res, 'migrations run before the compiled API'), 'order matters, not mere presence');
  });

  it('passes when migrate:up precedes start:e2e:dist', () => {
    const res = run({
      gitlab: 'app:test:\n  script:\n    - pnpm run migrate:up\n    - pnpm run start:e2e:dist\n',
    });
    assert.equal(failed(res, 'migrations run before the compiled API'), false);
  });

  it('is not fooled by a comment mentioning start:e2e:dist above the command', () => {
    const res = run({
      gitlab:
        'app:test:\n  script:\n    # start:e2e:dist is bare node and runs no migrations\n' +
        '    - pnpm run migrate:up\n    - pnpm run start:e2e:dist\n',
    });
    assert.equal(failed(res, 'migrations run before the compiled API'), false);
  });
});

describe('build artifact contract', () => {
  it('fires when the build job does not assert its outputs', () => {
    const res = run({ gitlab: 'build:\n  stage: test\n  script:\n    - pnpm run build\n' });
    assert.ok(failed(res, 'artifact contract is asserted'));
  });

  it('passes when both outputs are asserted', () => {
    const res = run({
      gitlab: 'build:\n  script:\n    - pnpm run build\n    - test -f projects/api/dist/main.js\n    - test -f projects/app/.output/server/index.mjs\n',
    });
    assert.equal(failed(res, 'artifact contract is asserted'), false);
  });
});

describe('no-op protection', () => {
  it('reports zero rules for a repo without CI files, rather than pretending', () => {
    const res = run({});
    assert.equal(res.checked.length, 0);
    assert.equal(res.problems.length, 0);
  });

  it('this repo\'s own pipelines satisfy every rule', () => {
    // The regression guard: whatever else changes, the shipped config stays green
    // AND keeps arming a meaningful number of rules.
    const res = checkCiConsistency();
    assert.deepEqual(res.problems, []);
    assert.ok(res.checked.length >= 8, `only ${res.checked.length} rules armed against the real pipelines`);
    assert.ok(armed(res, 'gitlab/api:test: mongo service'), 'api:test must be covered by the mongo rule');
    assert.ok(armed(res, 'gitlab/app:test: mongo service'), 'app:test must be covered by the mongo rule');
  });
});

describe('helpers', () => {
  it('servicesBlock stops at the next job-level key', () => {
    const body = '  services:\n    - name: mongo:7\n  variables:\n    NOT_A_SERVICE: mongo\n';
    assert.match(servicesBlock(body), /mongo:7/);
    assert.doesNotMatch(servicesBlock(body), /NOT_A_SERVICE/);
  });

  it('declaresMongoService is false for empty input', () => {
    assert.equal(declaresMongoService(''), false);
    assert.equal(declaresMongoService('    - name: redis:7\n'), false);
  });
});
