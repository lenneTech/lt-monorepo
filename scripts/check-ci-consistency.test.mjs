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

import {
  checkCiConsistency,
  declaresMongoService,
  packageScripts,
  scriptInvocations,
  servicesBlock,
  splitGithubJobs,
} from './check-ci-consistency.mjs';

const dirs = [];
after(() =>
  dirs.forEach((d) => {
    // Unguarded, one EPERM/EBUSY abandons every remaining dir (`force` only
    // suppresses ENOENT).
    try {
      rmSync(d, { force: true, maxRetries: 2, recursive: true });
    } catch {
      /* a leaked tmp dir is not worth failing a green suite over */
    }
  }),
);

/**
 * Materialise a throwaway repo root holding the given CI files.
 *
 * `packages` maps a directory to that package's `scripts` object (or to the raw
 * string to write, for the malformed-JSON case). Rule 7 resolves a `pnpm run`
 * call against the package it targets, so a fixture without these has no
 * package.json anywhere and every script check reports SKIPPED — which is a
 * meaningful state of its own and asserted below.
 */
function fixture({ github, gitlab, packages }) {
  const root = mkdtempSync(join(tmpdir(), 'ci-consistency-'));
  dirs.push(root);
  if (gitlab) writeFileSync(join(root, '.gitlab-ci.yml'), gitlab);
  if (github) {
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    for (const [file, body] of Object.entries(github)) {
      writeFileSync(join(root, '.github/workflows', file), body);
    }
  }
  for (const [dir, scripts] of Object.entries(packages ?? {})) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(
      join(root, dir, 'package.json'),
      typeof scripts === 'string' ? scripts : JSON.stringify({ name: 'fixture', scripts }),
    );
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

describe('script existence rule (rule 7)', () => {
  // The defect this rule was written for: both pipelines called
  // `pnpm run start:e2e:dist` in projects/api while nest-server-starter defined
  // no such script. Rule 5 above confirmed the *ordering* of a command that did
  // not exist — the guard passed on a pipeline that could only fail.
  const job = (script, dir) =>
    `app:test:\n  stage: test\n  script:\n    - (cd ${dir} && pnpm run ${script})\n`;

  it('FIRES when a referenced sub-project script does not exist', () => {
    const res = run({
      gitlab: job('start:e2e:dist', 'projects/api'),
      packages: { 'projects/api': { build: 'nest build', 'migrate:up': 'migrate up' } },
    });
    assert.ok(failed(res, '`start:e2e:dist` exists in projects/api'), 'the missing script must be reported');
    // The message has to carry what IS defined — otherwise the reader's next step
    // is to go open the file the guard just read.
    assert.match(res.problems.join('\n'), /has: build, migrate:up/);
  });

  it('holds when the script exists (positive control — the rule is not just always red)', () => {
    const res = run({
      gitlab: job('start:e2e:dist', 'projects/api'),
      packages: { 'projects/api': { 'start:e2e:dist': 'node dist/src/main.js' } },
    });
    assert.ok(armed(res, '`start:e2e:dist` exists in projects/api'), 'the rule must ARM, not merely not-fail');
    // Scoped to rule 7's own name. A looser `failed(res, 'start:e2e:dist')` also
    // matches rule 5's message — this fixture runs the script with no `migrate:up`
    // before it — so the positive control would fail on an unrelated rule doing
    // its job correctly.
    assert.equal(failed(res, '`start:e2e:dist` exists in projects/api'), false);
  });

  it('FIRES on the GitHub side too, not just GitLab', () => {
    // Mutation-verified gap: deleting the GitHub call site of rule 7 left all 50
    // tests green. The defect that motivated the rule (`start:e2e:dist`) was
    // referenced by BOTH pipelines, so a guard on one arm only is half a guard.
    const res = run({
      github: { 'test.yml': 'name: test\non: push\njobs:\n  app-test:\n    steps:\n      - run: cd projects/api && pnpm run start:e2e:dist\n' },
      packages: { 'projects/api': { build: 'nest build' } },
    });
    assert.ok(failed(res, '`start:e2e:dist` exists in projects/api'), `expected a github/ finding; got ${JSON.stringify(res.problems)}`);
    assert.ok(res.problems.some((p) => p.startsWith('github/')), 'the finding must be labelled github/');
  });

  it('holds on the GitHub side when the script exists (positive control)', () => {
    const res = run({
      github: { 'test.yml': 'name: test\non: push\njobs:\n  app-test:\n    steps:\n      - run: cd projects/api && pnpm run start:e2e:dist\n' },
      packages: { 'projects/api': { 'start:e2e:dist': 'node dist/src/main.js' } },
    });
    assert.ok(armed(res, '`start:e2e:dist` exists in projects/api'));
    assert.equal(failed(res, '`start:e2e:dist` exists in projects/api'), false);
  });

  it('holds for a root-level call that exists (positive control)', () => {
    // Without this, a regression that reddened EVERY root call would pass: the
    // neighbouring root test only asserts the failing direction.
    const res = run({
      gitlab: 'lint:\n  script:\n    - pnpm run lint\n',
      packages: { '.': { lint: 'oxlint' } },
    });
    assert.ok(armed(res, '`lint` exists in the workspace root'));
    assert.equal(failed(res, '`lint` exists in the workspace root'), false);
  });

  it('checks root-level calls against the root package.json', () => {
    const res = run({
      gitlab: 'lint:\n  script:\n    - pnpm run lint\n',
      packages: { '.': { format: 'oxfmt' } },
    });
    assert.ok(failed(res, '`lint` exists in the workspace root'));
  });

  it('SKIPS, loudly, when the target package.json does not exist yet', () => {
    // This repo's own state: `projects/` is empty until `lt fullstack init` fills
    // it. A skip that were silently counted as "held" would let a bad reference
    // ship to every generated project — the exact path the real bug took.
    const res = run({ gitlab: job('start:e2e:dist', 'projects/api') });
    assert.equal(failed(res, '`start:e2e:dist` exists in projects/api'), false);
    assert.equal(armed(res, '`start:e2e:dist` exists in projects/api'), false, 'must not count as a held rule');
    assert.ok(
      res.skipped.some((sk) => sk.includes('start:e2e:dist') && sk.includes('projects/api')),
      `the skip must be reported; got ${JSON.stringify(res.skipped)}`,
    );
  });

  it('treats an unparseable package.json as broken, not as absent', () => {
    // Both would otherwise take the same silent path out of the rule.
    const res = run({
      gitlab: job('build', 'projects/api'),
      packages: { 'projects/api': '{ not valid json' },
    });
    assert.ok(failed(res, 'projects/api/package.json parses'));
    assert.equal(res.skipped.length, 0, 'a broken file must not be filed as "not there yet"');
  });

  it('does not invent a target for recursive or filtered calls', () => {
    // `pnpm -r run build` runs wherever the script exists and exits 0 when nowhere;
    // there is no single package.json to check it against. Claiming otherwise would
    // red a correct pipeline, which is the fastest way to get a guard deleted.
    const res = run({
      gitlab: 'build:\n  script:\n    - pnpm -r run build\n    - pnpm --filter app run test\n',
      packages: { '.': {} },
    });
    assert.equal(failed(res, 'exists in'), false);
    assert.equal(res.skipped.length, 0);
    // Positive limb: the same fixture written as a DIRECT call must arm, so this
    // test cannot pass merely because the parser returned nothing at all.
    const direct = run({ gitlab: 'build:\n  script:\n    - pnpm run build\n', packages: { '.': {} } });
    assert.ok(armed(direct, '`build` exists in the workspace root'), 'the rule must be capable of arming here');
  });
});

describe('scriptInvocations parsing', () => {
  it('attributes a call to the directory cd-ed into on the same line', () => {
    const calls = scriptInvocations('    - (cd projects/api && pnpm run migrate:up)\n');
    assert.deepEqual(calls, [{ dir: 'projects/api', kind: 'direct', script: 'migrate:up' }]);
  });

  it('stops carrying a cd at the next sequence item', () => {
    // A new `- ` entry is a new shell. The old fixture used exactly this shape to
    // "prove" that cd never carries across lines — but it cannot distinguish the
    // two behaviours: the cd is consumed by the first match, and the second line
    // falls back to '.' either way. A mutation making cd fully sticky survived it.
    const calls = scriptInvocations('    - cd projects/api && pnpm run build\n    - pnpm run lint\n');
    assert.deepEqual(calls[0], { dir: 'projects/api', kind: 'direct', script: 'build' });
    assert.deepEqual(calls[1], { dir: '.', kind: 'direct', script: 'lint' });
  });

  it('DOES carry a cd across lines of a block scalar', () => {
    // The shape both pipelines actually use for the Playwright step:
    //     - |
    //       cd projects/app
    //       pnpm run test:unit
    // Scoping cd to one line attributes that to the workspace root, where a
    // same-named script very likely exists — a silent pass against the wrong
    // package, which is the failure class this whole file exists to prevent.
    const calls = scriptInvocations('    - |\n      cd projects/app\n      pnpm run test:unit\n');
    assert.deepEqual(calls, [{ dir: 'projects/app', kind: 'direct', script: 'test:unit' }]);
  });

  it('carries a cd across a shell line continuation', () => {
    const calls = scriptInvocations('        cd projects/api &&\n        pnpm run build\n');
    assert.deepEqual(calls, [{ dir: 'projects/api', kind: 'direct', script: 'build' }]);
  });

  it('resets the carried cd at the next mapping key', () => {
    const calls = scriptInvocations('  script: |\n    cd projects/api\n    pnpm run build\n  after_script:\n    - pnpm run lint\n');
    assert.deepEqual(calls[0], { dir: 'projects/api', kind: 'direct', script: 'build' });
    assert.deepEqual(calls[1], { dir: '.', kind: 'direct', script: 'lint' });
  });

  it("honours pnpm's own directory flags instead of discarding them", () => {
    // `-C` / `--dir` used to be swallowed by the flag group, so the call was
    // attributed to the root — a FALSE POSITIVE that reds a correct pipeline.
    for (const form of ['pnpm -C projects/api run build', 'pnpm --dir projects/api run build', 'pnpm --dir=projects/api run build']) {
      assert.deepEqual(scriptInvocations(`    - ${form}\n`), [{ dir: 'projects/api', kind: 'direct', script: 'build' }], form);
    }
  });

  it('strips quotes from both the cd target and the script name', () => {
    // `pnpm run "start:e2e:dist"` yielded NOTHING before — the guard's own
    // motivating defect escaped it whenever the name was quoted.
    assert.deepEqual(scriptInvocations('    - cd "projects/api" && pnpm run \'start:e2e:dist\'\n'), [
      { dir: 'projects/api', kind: 'direct', script: 'start:e2e:dist' },
    ]);
  });

  it('treats `;` like `&&` — it is the same shell', () => {
    assert.deepEqual(scriptInvocations('    - cd projects/api; pnpm run build\n'), [
      { dir: 'projects/api', kind: 'direct', script: 'build' },
    ]);
  });

  it('recognises the `pnpm <script>` shorthand but not pnpm subcommands', () => {
    // Same ERR_PNPM_NO_SCRIPT, so it needs the same coverage. `pnpm install`
    // must not be read as a script called "install".
    assert.deepEqual(scriptInvocations('    - pnpm start:e2e:dist\n')[0], { dir: '.', kind: 'direct', script: 'start:e2e:dist' });
    assert.deepEqual(scriptInvocations('    - pnpm install\n'), []);
    assert.deepEqual(scriptInvocations('    - pnpm exec playwright test\n'), []);
    // `pnpm test` / `pnpm start` DO run the script of that name.
    assert.deepEqual(scriptInvocations('    - pnpm test\n')[0], { dir: '.', kind: 'direct', script: 'test' });
  });

  it('matches `npm run` too, but gives npm no shorthand', () => {
    assert.deepEqual(scriptInvocations('    - npm run build\n')[0], { dir: '.', kind: 'direct', script: 'build' });
    assert.deepEqual(scriptInvocations('    - npm ci\n'), []);
  });

  it('ignores a trailing YAML comment', () => {
    // `- pnpm run build # pnpm run ghost` produced a phantom invocation of a
    // script YAML discards before the shell sees it.
    assert.deepEqual(scriptInvocations('    - pnpm run build # pnpm run ghost\n'), [
      { dir: '.', kind: 'direct', script: 'build' },
    ]);
  });

  it('does not mistake a `#` inside quotes for a comment', () => {
    const calls = scriptInvocations('    - echo "a # b" && pnpm run build\n');
    assert.deepEqual(calls, [{ dir: '.', kind: 'direct', script: 'build' }]);
  });

  it('finds several invocations on one line', () => {
    assert.equal(scriptInvocations('    - pnpm run lint && pnpm run build\n').length, 2);
  });

  it('accepts the --filter=value form as well as the spaced one', () => {
    assert.deepEqual(scriptInvocations('- pnpm --filter=app run test\n')[0], { kind: 'filtered', script: 'test' });
  });

  it('reads the flags of the run call, not of a command chained before it', () => {
    // A permissive pattern here classifies this as `--filter`ed and skips it.
    const calls = scriptInvocations('    - pnpm install --filter app && pnpm run build\n');
    assert.deepEqual(calls, [{ dir: '.', kind: 'direct', script: 'build' }]);
  });

  it('ignores commented-out invocations', () => {
    assert.deepEqual(scriptInvocations('    # - pnpm run ghost\n'), []);
  });

  it('classifies recursive and filtered calls separately', () => {
    assert.deepEqual(scriptInvocations('- pnpm -r run build\n')[0], { kind: 'recursive', script: 'build' });
    assert.deepEqual(scriptInvocations('- pnpm --filter app run test\n')[0], { kind: 'filtered', script: 'test' });
  });

  it('packageScripts distinguishes missing from unreadable', () => {
    const root = fixture({ packages: { good: { a: 'x' }, broken: '{{{' } });
    assert.deepEqual(packageScripts(root, 'good'), { kind: 'ok', scripts: ['a'] });
    assert.equal(packageScripts(root, 'broken').kind, 'unreadable');
    assert.equal(packageScripts(root, 'absent').kind, 'missing');
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
    // The only test that runs against the SHIPPED config, and it was blind to the
    // whole `skipped` field. `projects/` is empty here by design, so the three
    // sub-project calls in each pipeline must show up as skips — on both arms.
    assert.ok(res.skipped.length >= 6, `expected the sub-project calls to be reported as skips; got ${res.skipped.length}`);
    assert.ok(res.skipped.some((sk) => sk.startsWith('gitlab/')), 'gitlab skips must be reported');
    assert.ok(res.skipped.some((sk) => sk.startsWith('github/')), 'github skips must be reported');
    assert.ok(res.skipped.every((sk) => /no package.json at \//.test(sk)), 'a skip must name the path it observed');
  });
});

describe('helpers', () => {
  it('splitGithubJobs finds jobs: even as the first line', () => {
    // YAML imposes no key order. Anchored on `\njobs:`, such a workflow parsed as
    // zero jobs — every rule skipped it and the run still printed a success line.
    const jobs = splitGithubJobs('jobs:\n  build:\n    steps:\n      - run: pnpm run build\n');
    assert.deepEqual(Object.keys(jobs), ['build']);
  });


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
