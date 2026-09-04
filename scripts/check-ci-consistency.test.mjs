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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  LOOPBACK_URI,
  checkCiConsistency,
  declaresMongoService,
  packageScripts,
  scriptInvocations,
  servicesBlock,
  splitGithubJobs,
} from './check-ci-consistency.mjs';

/** The repo this suite is running in — the template, or a generated project. */
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

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
  // A workspace file, so `--filter=<name>` can be resolved to a directory. Written
  // unconditionally: the resolver reads the globs from here, and a fixture without it
  // would silently exercise the unresolvable path in every case.
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'projects/*'\n");
  for (const [dir, scripts] of Object.entries(packages ?? {})) {
    mkdirSync(join(root, dir), { recursive: true });
    // The package NAME is the directory's last segment, so a fixture can be addressed by
    // `--filter` the way a real pipeline addresses a real workspace member.
    writeFileSync(
      join(root, dir, 'package.json'),
      typeof scripts === 'string' ? scripts : JSON.stringify({ name: dir.split('/').pop(), scripts }),
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
      const res = run({
        gitlab: mongoJob(service, '    NSC__MONGOOSE__URI: "mongodb://mongo:27017/x"\n'),
      });
      assert.ok(failed(res, 'mongo service'), `rule did not fire on: ${label}`);
    });
  }

  it('arms on the flow sequence', () => {
    const res = run({
      gitlab: 'api:test:\n  stage: test\n  services: [mongo:7]\n  variables:\n    X: "1"\n',
    });
    assert.ok(failed(res, 'mongo service'), 'flow-sequence service went unguarded');
  });

  it('stays silent for a job with no mongo service at all', () => {
    const res = run({ gitlab: 'lint:\n  stage: test\n  script:\n    - pnpm run lint\n' });
    assert.equal(armed(res, 'mongo service'), false);
  });

  it('does not mistake a `mongodump` command for a service declaration', () => {
    // `services:` scoping — a bare /mongo/ over the job body matches script lines.
    const res = run({
      gitlab: 'backup:\n  stage: test\n  script:\n    - mongodump --uri "$URI"\n',
    });
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
      const res = run({
        gitlab: `app:test:\n  parallel: 2\n  script:\n    - pnpm exec playwright test ${arg}\n`,
      });
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
    const res = run({
      gitlab: 'audit:\n  stage: test\n  allow_failure: true\n  script:\n    - pnpm audit\n',
    });
    assert.ok(failed(res, 'audit job blocks'));
  });

  it('passes for a blocking GitLab audit job', () => {
    const res = run({ gitlab: 'audit:\n  stage: test\n  script:\n    - pnpm audit\n' });
    assert.ok(armed(res, 'audit job blocks'));
    assert.equal(failed(res, 'audit job blocks'), false);
  });

  it('fires on continue-on-error in GitHub', () => {
    const res = run({
      github: {
        'test.yml':
          'name: Test\non: [push]\njobs:\n  audit:\n    continue-on-error: true\n    steps:\n      - run: pnpm audit\n',
      },
    });
    assert.ok(failed(res, 'audit job blocks'));
  });
});

describe('built server + migrations', () => {
  it('fires when E2E_BUILT_SERVER lacks the build artifact', () => {
    const res = run({
      gitlab: 'app:test:\n  variables:\n    E2E_BUILT_SERVER: "true"\n  script:\n    - pnpm test\n',
    });
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
      gitlab:
        'build:\n  script:\n    - pnpm run build\n    - test -f projects/api/dist/main.js\n    - test -f projects/app/.output/server/index.mjs\n',
    });
    assert.equal(failed(res, 'artifact contract is asserted'), false);
  });
});

describe('script existence rule (rule 7)', () => {
  // The defect this rule was written for: both pipelines called
  // `pnpm run start:e2e:dist` in projects/api while nest-server-starter defined
  // no such script. Rule 5 above confirmed the *ordering* of a command that did
  // not exist — the guard passed on a pipeline that could only fail.
  const job = (script, dir) => `app:test:\n  stage: test\n  script:\n    - (cd ${dir} && pnpm run ${script})\n`;

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
      github: {
        'test.yml':
          'name: test\non: push\njobs:\n  app-test:\n    steps:\n      - run: cd projects/api && pnpm run start:e2e:dist\n',
      },
      packages: { 'projects/api': { build: 'nest build' } },
    });
    assert.ok(
      failed(res, '`start:e2e:dist` exists in projects/api'),
      `expected a github/ finding; got ${JSON.stringify(res.problems)}`,
    );
    assert.ok(
      res.problems.some((p) => p.startsWith('github/')),
      'the finding must be labelled github/',
    );
  });

  it('holds on the GitHub side when the script exists (positive control)', () => {
    const res = run({
      github: {
        'test.yml':
          'name: test\non: push\njobs:\n  app-test:\n    steps:\n      - run: cd projects/api && pnpm run start:e2e:dist\n',
      },
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

  it('checks a filtered call once its package name resolves', () => {
    // `pnpm --filter=<name> run <script>` is the invocation the lt pipelines are meant to
    // use — from the workspace root, rather than `cd projects/x && pnpm run`, which can
    // trigger a stale-deps reconcile install. Treating it as unverifiable left the rule
    // blind on precisely the prescribed style: a pipeline could name a script that exists
    // nowhere and this check reported success.
    const res = run({
      gitlab: 'build:\n  script:\n    - pnpm --filter=api run nope\n',
      packages: { 'projects/api': { build: 'nest build' } },
    });

    assert.ok(armed(res, 'exists in projects/api'), 'a resolvable filter must arm the rule');
    assert.ok(failed(res, 'exists in projects/api'), 'and catch the script that is not there');
  });

  it('passes a filtered call that names a script the package defines', () => {
    // The paired case. A rule that only ever fires proves nothing about the one time it
    // stays quiet, and this one now runs against every filtered call in the pipeline.
    const res = run({
      gitlab: 'build:\n  script:\n    - pnpm --filter=api run build\n',
      packages: { 'projects/api': { build: 'nest build' } },
    });

    assert.ok(armed(res, 'exists in projects/api'));
    assert.equal(failed(res, 'exists in'), false);
  });

  it('does not invent a target for a recursive call', () => {
    // `pnpm -r run build` runs wherever the script exists and exits 0 when nowhere;
    // there is no single package.json to check it against. Claiming otherwise would
    // red a correct pipeline, which is the fastest way to get a guard deleted.
    const res = run({
      gitlab: 'build:\n  script:\n    - pnpm -r run build\n',
      packages: { '.': {} },
    });
    assert.equal(failed(res, 'exists in'), false);
    assert.equal(armed(res, 'exists in'), false, 'a recursive call must not arm the rule at all');
    // Positive limb: the same fixture written as a DIRECT call must arm, so this
    // test cannot pass merely because the parser returned nothing at all.
    const direct = run({
      gitlab: 'build:\n  script:\n    - pnpm run build\n',
      packages: { '.': {} },
    });
    assert.ok(armed(direct, '`build` exists in the workspace root'), 'the rule must be capable of arming here');
  });

  it('records an unresolvable filter as SKIPPED rather than dropping it', () => {
    // The workspace here has no members at all — this repo's own state, where `projects/`
    // stays empty until `lt fullstack init`. Nothing is decidable, so the rule must not
    // fire; but it must not stay silent either. A quiet skip is how a guard comes to read
    // as "held" in the one repo that owns these CI files, which is the failure mode the
    // direct-call path already guards against.
    const res = run({
      gitlab: 'build:\n  script:\n    - pnpm --filter app run test\n',
      packages: { '.': {} },
    });
    assert.equal(failed(res, 'exists in'), false, 'nothing is decidable here — it must not fail');
    assert.ok(
      res.skipped.some((s) => /`pnpm run test`/.test(s)),
      `the skip must be visible in the report, got: ${JSON.stringify(res.skipped)}`,
    );
  });

  it('names the real reason a filter did not resolve, not the benign one', () => {
    // A workspace whose member exists but whose package.json does not parse is a DEFECT.
    // Describing it with the template's benign "projects/ is empty" wording is how a real
    // breakage comes to look like the expected state — the same trap the
    // missing-package.json branch was already fixed for once.
    const res = run({
      gitlab: 'build:\n  script:\n    - pnpm --filter=api run nope\n',
      packages: { 'projects/api': '{ broken' },
    });
    const skip = res.skipped.find((s) => /`pnpm run nope`/.test(s));
    assert.ok(skip, 'the skip must still be visible');
    assert.match(skip, /no workspace member declares a package name/);
    assert.doesNotMatch(skip, /is empty until/, 'must not blame the empty-template state');
  });

  it('fails a filter that names a package the workspace does not define', () => {
    // The incident both pipelines carry a postmortem for: `pnpm --filter app` matched no
    // package, exited 0, `nuxt build` silently never ran, and the image shipped a stale
    // `.output`. Once the workspace itself resolves, this is decidable — the full
    // name->dir map is in hand — so it is a failure, not a skip.
    const res = run({
      gitlab: 'build:\n  script:\n    - pnpm --filter app run build\n',
      packages: { 'projects/api': { build: 'nest build' } },
    });
    assert.ok(armed(res, '`--filter app` names a workspace package'), 'the rule must arm');
    assert.ok(failed(res, '`--filter app` names a workspace package'), 'and must fail');
  });

  it('checks every --filter on a call, not only the first', () => {
    // pnpm runs the script in EACH filtered package. Reading only the first let a missing
    // script in the second through while the guard reported success.
    const res = run({
      gitlab: 'build:\n  script:\n    - pnpm --filter api --filter app run build\n',
      packages: {
        'projects/api': { build: 'nest build' },
        'projects/app': { generate: 'nuxt generate' },
      },
    });
    assert.ok(failed(res, 'exists in projects/app'), 'the second filter must be checked too');
    assert.equal(failed(res, 'exists in projects/api'), false, 'the first one is fine');
  });

  it('leaves `--filter-prod` and other --filter* flags unresolved instead of blaming the root', () => {
    // `--filter-prod` is a real pnpm flag. An anchored `--filter[= ]` match alone does not
    // match it, so the call fell through to the `direct` branch and was attributed to the
    // workspace root — inventing a finding on a correct pipeline.
    assert.deepEqual(scriptInvocations('- pnpm --filter-prod=api run build\n')[0], {
      kind: 'filtered',
      script: 'build',
    });
    const res = run({
      gitlab: 'build:\n  script:\n    - pnpm --filter-prod=api run build\n',
      packages: { '.': { check: 'x' } },
    });
    assert.equal(failed(res, 'exists in the workspace root'), false, 'must not be blamed on the root');
  });

  it('resolves a filter by package NAME, not by directory basename', () => {
    // Every other fixture names its package after its directory, so a resolver that simply
    // guessed `projects/<filter>` would pass those identically. A scoped name is what
    // actually pins resolution to package.json.
    const res = run({
      gitlab: 'build:\n  script:\n    - pnpm --filter=@acme/api run nope\n',
      packages: { 'projects/api': '{"name":"@acme/api","scripts":{"build":"nest build"}}' },
    });
    assert.ok(armed(res, 'exists in projects/api'), 'a scoped name must resolve to its directory');
    assert.ok(failed(res, 'exists in projects/api'));
  });

  it('counts a symlinked workspace member', () => {
    // `lt fullstack init --api-link` / `--frontend-link` symlink `projects/api` and
    // `projects/app` at the developer's own checkout. `Dirent.isDirectory()` reflects an
    // lstat and is FALSE for a symlink, so filtering on it alone made every link-mode
    // workspace resolve to zero packages and the rule went silently blind.
    const root = fixture({
      gitlab: 'build:\n  script:\n    - pnpm --filter=api run nope\n',
      packages: {},
    });
    mkdirSync(join(root, 'linked-api'), { recursive: true });
    writeFileSync(join(root, 'linked-api/package.json'), '{"name":"api","scripts":{"build":"x"}}');
    mkdirSync(join(root, 'projects'), { recursive: true });
    symlinkSync('../linked-api', join(root, 'projects/api'), 'dir');

    const res = checkCiConsistency(root);
    assert.ok(armed(res, 'exists in projects/api'), 'a symlinked member must still resolve');
    assert.ok(failed(res, 'exists in projects/api'));
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
    const calls = scriptInvocations(
      '  script: |\n    cd projects/api\n    pnpm run build\n  after_script:\n    - pnpm run lint\n',
    );
    assert.deepEqual(calls[0], { dir: 'projects/api', kind: 'direct', script: 'build' });
    assert.deepEqual(calls[1], { dir: '.', kind: 'direct', script: 'lint' });
  });

  it("honours pnpm's own directory flags instead of discarding them", () => {
    // `-C` / `--dir` used to be swallowed by the flag group, so the call was
    // attributed to the root — a FALSE POSITIVE that reds a correct pipeline.
    for (const form of [
      'pnpm -C projects/api run build',
      'pnpm --dir projects/api run build',
      'pnpm --dir=projects/api run build',
    ]) {
      assert.deepEqual(
        scriptInvocations(`    - ${form}\n`),
        [{ dir: 'projects/api', kind: 'direct', script: 'build' }],
        form,
      );
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
    assert.deepEqual(scriptInvocations('    - pnpm start:e2e:dist\n')[0], {
      dir: '.',
      kind: 'direct',
      script: 'start:e2e:dist',
    });
    assert.deepEqual(scriptInvocations('    - pnpm install\n'), []);
    assert.deepEqual(scriptInvocations('    - pnpm exec playwright test\n'), []);
    // `pnpm test` / `pnpm start` DO run the script of that name.
    assert.deepEqual(scriptInvocations('    - pnpm test\n')[0], {
      dir: '.',
      kind: 'direct',
      script: 'test',
    });
  });

  it('matches `npm run` too, but gives npm no shorthand', () => {
    assert.deepEqual(scriptInvocations('    - npm run build\n')[0], {
      dir: '.',
      kind: 'direct',
      script: 'build',
    });
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
    assert.deepEqual(scriptInvocations('- pnpm --filter=app run test\n')[0], {
      filter: 'app',
      kind: 'filtered',
      script: 'test',
    });
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
    assert.deepEqual(scriptInvocations('- pnpm -r run build\n')[0], {
      kind: 'recursive',
      script: 'build',
    });
    assert.deepEqual(scriptInvocations('- pnpm --filter app run test\n')[0], {
      filter: 'app',
      kind: 'filtered',
      script: 'test',
    });
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

  it("this repo's own pipelines satisfy every rule", () => {
    // The regression guard: whatever else changes, the shipped config stays green
    // AND keeps arming a meaningful number of rules.
    const res = checkCiConsistency();
    assert.deepEqual(res.problems, []);
    assert.ok(res.checked.length >= 8, `only ${res.checked.length} rules armed against the real pipelines`);
    assert.ok(armed(res, 'gitlab/api:test: mongo service'), 'api:test must be covered by the mongo rule');
    assert.ok(armed(res, 'gitlab/app:test: mongo service'), 'app:test must be covered by the mongo rule');
    // The only test that runs against the SHIPPED config, and it was blind to the
    // whole `skipped` field. What it must assert DEPENDS ON THE REPO, and getting
    // that wrong is how this file first shipped: this same test travels into every
    // generated project, where `projects/` is POPULATED and there is nothing to
    // skip. Asserting the template's state as a universal truth reddened the very
    // first `pnpm run check` of a fresh workspace — caught by the smoke test.
    //
    // So: branch on what the repo actually is, and make each side a real claim.
    const populated = existsSync(join(ROOT_DIR, 'projects', 'api', 'package.json'));
    if (populated) {
      // A generated project: every sub-project call resolves, so the rule must
      // ARM on them — this is where it does its real work.
      assert.equal(
        res.skipped.length,
        0,
        `sub-projects exist, nothing should be skipped; got ${JSON.stringify(res.skipped)}`,
      );
      assert.ok(
        armed(res, 'exists in projects/api') || armed(res, 'exists in projects/app'),
        'with the sub-projects present the script-existence rule must actually run',
      );
    } else {
      // The template: `projects/` is empty by design, so the three sub-project
      // calls in each pipeline must be REPORTED as skips rather than swallowed.
      assert.ok(
        res.skipped.length >= 6,
        `expected the sub-project calls to be reported as skips; got ${res.skipped.length}`,
      );
      assert.ok(
        res.skipped.some((sk) => sk.startsWith('gitlab/')),
        'gitlab skips must be reported',
      );
      assert.ok(
        res.skipped.some((sk) => sk.startsWith('github/')),
        'github skips must be reported',
      );
      assert.ok(
        res.skipped.every((sk) => /no package.json at \//.test(sk)),
        'a skip must name the path it observed',
      );
    }
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

describe('E2E remote-DB opt-out rule', () => {
  // The contradiction this rule exists for spans two repos and is invisible in
  // either: `.gitlab-ci.yml` (here) points the suite at the mongo SERVICE
  // CONTAINER by alias, while `assertSafeToDelete` (nuxt-base-template
  // tests/e2e/helpers/auth-backend.ts) refuses to wipe a non-loopback database
  // without `E2E_ALLOW_REMOTE_DB=true`. Both repos stayed green; the generated
  // project went red in CI while the same suite passed locally against
  // 127.0.0.1.
  //
  // Driven from both sides per this file's header: a rule only ever asserted in
  // its passing state cannot be told apart from one that never runs.
  // `script:` carries the Playwright call on purpose: rule 8's subject is a job
  // that RESETS test data, not merely one that has a database. `api:test` in this
  // repo declares a mongo service and a non-loopback `NSC__MONGOOSE__URI` too, and
  // demanding the destructive opt-out THERE would talk a reader into granting
  // delete rights to a job that never deletes anything.
  const jobWith = (uri, extra = '', key = 'MONGO_URI') =>
    `app:test:\n  stage: test\n  services:\n    - name: mongo:7\n      alias: mongo\n  variables:\n    FF_NETWORK_PER_BUILD: "true"\n    ${key}: "${uri}"\n${extra}  script:\n    - pnpm exec playwright test\n`;

  const NEEDLE = 'E2E data reset is permitted';
  const TARGET = 'opt-out targets a throwaway service container';
  const ALIASED = 'mongodb://mongo:27017/app-ci-$CI_NODE_INDEX';
  const OPT_OUT = '    E2E_ALLOW_REMOTE_DB: "true"\n';

  it('FIRES when an aliased database carries no opt-out', () => {
    const res = run({ gitlab: jobWith(ALIASED) });
    assert.ok(armed(res, NEEDLE), 'rule must arm on an E2E job with a database');
    assert.ok(failed(res, NEEDLE), 'rule must fire without E2E_ALLOW_REMOTE_DB');
  });

  it('passes once the opt-out is granted', () => {
    const res = run({ gitlab: jobWith(ALIASED, OPT_OUT) });
    assert.ok(armed(res, NEEDLE), 'rule must still arm — a silent skip would hide a regression');
    assert.ok(!failed(res, NEEDLE));
  });

  // One `it` per host, not a loop in one: a loop aborts on the first failing host
  // and reports one of three. Same shape as the mongo rule's `spellings` table.
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    it(`leaves a loopback database alone — ${host}`, () => {
      const res = run({ gitlab: jobWith(`mongodb://${host}:27017/app-ci`) });
      assert.ok(armed(res, NEEDLE), `rule must arm for ${host}`);
      assert.ok(!failed(res, NEEDLE), `${host} is loopback and needs no opt-out`);
    });
  }

  // The spellings `assertSafeToDelete` accepts as loopback and a paraphrased
  // regex does not. Each one reds a CORRECT pipeline, and the cheapest way out of
  // a red check is to set the destructive flag that was never needed — a guard
  // that fails on correct config is the fastest route to being deleted.
  for (const uri of ['mongodb://user:pw@127.0.0.1:27017/db', 'mongodb://localhost', 'mongodb+srv://localhost/db']) {
    it(`treats \`${uri}\` as loopback, exactly as the runtime guard does`, () => {
      const res = run({ gitlab: jobWith(uri) });
      assert.ok(armed(res, NEEDLE), `rule must arm for ${uri}`);
      assert.ok(
        !failed(res, NEEDLE),
        `${uri} is loopback to auth-backend.ts — demanding the opt-out here is a false positive`,
      );
    });
  }

  // The dangerous direction, and the reason `[:/]` was not good enough: the seed
  // list STARTS loopback and ends at a real host. A terminator that matches the
  // port colon waves it through while the runtime guard refuses it — check green,
  // CI red, `prod.example.com` in the URI.
  it('FIRES on a replica-set seed list that merely starts at loopback', () => {
    const res = run({
      gitlab: jobWith('mongodb://127.0.0.1:27017,prod.example.com:27017/app?replicaSet=rs0'),
    });
    assert.ok(failed(res, NEEDLE), 'a seed list reaching a real host must not pass as loopback');
  });

  // Prefix attack. Deleting the host terminator from the regex leaves every other
  // test in this block green, so without this one the property is silently
  // deletable — and it is the property the rule's own message promises.
  it('FIRES on a host that merely begins with a loopback address', () => {
    const res = run({ gitlab: jobWith('mongodb://127.0.0.1.evil.tld:27017/db') });
    assert.ok(failed(res, NEEDLE), '`127.0.0.1.evil.tld` is not loopback');
  });

  // `NSC__MONGOOSE__URI` wins over `MONGO_URI` in auth-backend.ts:99, and it is
  // the canonical lt spelling — nest-server does not read `MONGO_URI` at all. A
  // rule greping only `MONGO_URI:` fails to ARM here, reporting a silent skip as
  // coverage.
  it('arms on NSC__MONGOOSE__URI, the spelling the stack actually uses', () => {
    const res = run({ gitlab: jobWith(ALIASED, '', 'NSC__MONGOOSE__URI') });
    assert.ok(armed(res, NEEDLE), 'rule must arm on the NSC__ form');
    assert.ok(failed(res, NEEDLE), 'rule must fire without the opt-out');
  });

  it('lets NSC__MONGOOSE__URI win over MONGO_URI, as the guard does', () => {
    const gitlab = jobWith('mongodb://127.0.0.1:27017/app-ci', '    NSC__MONGOOSE__URI: "mongodb://mongo:27017/x"\n');
    assert.ok(failed(run({ gitlab }), NEEDLE), 'the NSC__ value decides, so the aliased host must fire');
  });

  // The third OR-branch. Deleting it left the whole suite green before this test:
  // untested working code is indistinguishable from a clause that never runs.
  it('accepts the opt-out in the global variables block', () => {
    const res = run({ gitlab: `variables:\n  E2E_ALLOW_REMOTE_DB: "true"\n\n${jobWith(ALIASED)}` });
    assert.ok(armed(res, NEEDLE), 'rule must still arm');
    assert.ok(!failed(res, NEEDLE), 'a pipeline-wide opt-out satisfies the rule');
  });

  // A global block is CONFIG, not a job. Reported under `gitlab/variables` it
  // blames something no runner executes, while the job that inherits the URI goes
  // unnamed — the same reasoning that skips hidden `.template` blocks.
  it('never reports a finding against the `variables` block itself', () => {
    const res = run({ gitlab: `variables:\n  MONGO_URI: "${ALIASED}"\n\n${jobWith(ALIASED)}` });
    assert.ok(
      !res.checked.some((c) => c.startsWith('gitlab/variables') && c.includes(NEEDLE)),
      'the global block is not a job and must never be the subject of this rule',
    );
    assert.ok(armed(res, `gitlab/app:test: ${NEEDLE}`), 'the job that inherits the URI is the subject');
  });

  // `merged` vs `clean`: with no fixture using `extends:` the two are the same
  // string and the choice between them is unfalsifiable.
  it('accepts an opt-out inherited through extends', () => {
    const gitlab = `.e2e-db:\n  variables:\n    E2E_ALLOW_REMOTE_DB: "true"\n\n${jobWith(ALIASED, '  extends: .e2e-db\n')}`;
    assert.ok(!failed(run({ gitlab }), NEEDLE), 'an inherited opt-out counts');
  });

  it('blames the real job, not the hidden template, for an inherited database', () => {
    const gitlab = `.e2e-db:\n  variables:\n    MONGO_URI: "${ALIASED}"\n\napp:test:\n  stage: test\n  extends: .e2e-db\n  script:\n    - pnpm exec playwright test\n`;
    const res = run({ gitlab });
    assert.ok(failed(res, `gitlab/app:test: ${NEEDLE}`), 'the job that runs must be named');
    assert.ok(
      !res.checked.some((c) => c.startsWith('gitlab/.e2e-db') && c.includes(NEEDLE)),
      'a hidden template never runs — naming it sends the reader to the wrong file',
    );
  });

  // Scoping. An unscoped grep also matches a `script:` line, producing a finding
  // against a job that sets no such variable.
  it('does not mistake a MONGO_URI mentioned in a script line for a variable', () => {
    const gitlab =
      'app:test:\n  stage: test\n  script:\n    - pnpm exec playwright test\n    - echo "MONGO_URI: mongodb://prod-cluster/live"\n';
    assert.ok(!armed(run({ gitlab }), NEEDLE), 'a shell line is not configuration');
  });

  // A job with a database but no E2E suite — the `api:test` shape. Arming here
  // would demand a destructive opt-out for a job that resets nothing.
  it('stays silent for a job that has a database but runs no E2E suite', () => {
    const gitlab =
      'api:test:\n  stage: test\n  services:\n    - name: mongo:7\n      alias: mongo\n  variables:\n    FF_NETWORK_PER_BUILD: "true"\n    NSC__MONGOOSE__URI: "mongodb://mongo:27017/api-ci"\n  script:\n    - pnpm run api:test\n';
    assert.ok(!armed(run({ gitlab }), NEEDLE), 'no resetTestData, no permission to demand');
  });

  // The inverse assertion. Rule 8's first half is satisfied forever once the flag
  // is set; this is what still asks whether the thing being wiped is disposable.
  it('FIRES when the opt-out points somewhere the job declares no service for', () => {
    const gitlab = jobWith('mongodb://shared-staging.example.com:27017/app', OPT_OUT);
    assert.ok(failed(run({ gitlab }), TARGET), 'a granted wipe permission must name a service the job owns');
  });

  it("accepts the opt-out when the host IS the job's own service alias", () => {
    assert.ok(!failed(run({ gitlab: jobWith(ALIASED, OPT_OUT) }), TARGET), "`mongo` is this job's service container");
  });
});

describe('LOOPBACK_URI drift detector', () => {
  // `LOOPBACK_URI` here is a hand-copy of a `const` in another repo, because the
  // layout leaves no alternative: this script runs in the template, where
  // `projects/` is empty by design, so at that moment there is nothing to import
  // from. A copy with no detector is a copy that drifts — and it already had,
  // in both directions, before anyone noticed.
  //
  // Absence of the sibling checkout must be VISIBLY skipped, never green. CI here
  // checks out this repo alone, so `../nuxt-base-starter` will not exist and a
  // detector that "passed" would be indistinguishable from one that ran.
  // `LT_DRIFT_STRICT=1` turns absence into a hard failure and belongs in the
  // release workflow — the one moment drift actually costs something.
  const UPSTREAM = join(ROOT_DIR, '..', 'nuxt-base-starter', 'nuxt-base-template/tests/e2e/helpers/auth-backend.ts');
  const STRICT = process.env.LT_DRIFT_STRICT === '1';
  const itDrift = existsSync(UPSTREAM) || STRICT ? it : it.skip;

  itDrift('matches the guard it mirrors, character for character', () => {
    assert.ok(existsSync(UPSTREAM), `LT_DRIFT_STRICT=1 but ${UPSTREAM} is absent — cannot prove the copy is current`);
    const upstream = readFileSync(UPSTREAM, 'utf8');
    const declared = /^const LOOPBACK_URI = (\/.+\/);$/m.exec(upstream)?.[1];
    assert.ok(declared, 'could not find `const LOOPBACK_URI = …` upstream — the anchor moved, update this detector');
    assert.equal(
      LOOPBACK_URI.toString(),
      declared,
      'LOOPBACK_URI has drifted from auth-backend.ts. Narrower reds a correct pipeline and pushes people to set the destructive opt-out; wider passes a URI the runtime guard refuses. Copy it verbatim.',
    );
  });
});

describe('E2E remote-DB opt-out rule — GitHub', () => {
  // NOT a symmetry exercise. `app-test` runs inside `container:`, where a service
  // container is reachable only by alias — as non-loopback as GitLab. The rule
  // lived in the GitLab loop for exactly one commit, during which the checker
  // reported `ok — N rule(s) hold` over a GitHub pipeline carrying the very defect
  // it had just been written to catch.
  const NEEDLE = 'E2E data reset is permitted';
  const ghJob = (env) =>
    `name: Test\non:\n  pull_request:\njobs:\n  app-test:\n    runs-on: ubuntu-latest\n    container:\n      image: mcr.microsoft.com/playwright:v1.62.1-noble\n    services:\n      mongo:\n        image: mongo:7\n    env:\n${env}    steps:\n      - run: pnpm exec playwright test\n`;

  it('FIRES on an aliased database with no opt-out', () => {
    const res = run({
      github: {
        'test.yml': ghJob('      MONGO_URI: mongodb://mongo:27017/app-ci-${{ matrix.shard }}\n'),
      },
    });
    assert.ok(armed(res, NEEDLE), 'the GitHub loop must evaluate this rule at all');
    assert.ok(failed(res, NEEDLE), 'a container job addressing mongo by alias needs the opt-out');
  });

  it('passes once the opt-out is granted', () => {
    const env =
      "      MONGO_URI: mongodb://mongo:27017/app-ci-${{ matrix.shard }}\n      E2E_ALLOW_REMOTE_DB: 'true'\n";
    const res = run({ github: { 'test.yml': ghJob(env) } });
    assert.ok(armed(res, NEEDLE));
    assert.ok(!failed(res, NEEDLE));
  });

  // `${{ matrix.shard }}` contains spaces. A value regex stopping at the first
  // one truncates the URI to `…app-ci-${{` in every message the rule prints.
  it('reads a value containing `${{ }}` whole', () => {
    const res = run({
      github: {
        'test.yml': ghJob('      MONGO_URI: mongodb://mongo:27017/app-ci-${{ matrix.shard }}\n'),
      },
    });
    const problem = res.problems.find((p) => p.includes(NEEDLE));
    assert.ok(problem?.includes('matrix.shard }}'), `URI was truncated in: ${problem}`);
  });

  // GitHub's answer to GitLab's global `variables:`. The slice that finds it must
  // stop at `jobs:`, or a JOB's own `env:` is mistaken for the workflow's.
  it('honours a workflow-level env block', () => {
    const gh = ghJob('      MONGO_URI: mongodb://mongo:27017/app-ci\n').replace(
      '\njobs:',
      "\nenv:\n  E2E_ALLOW_REMOTE_DB: 'true'\njobs:",
    );
    const res = run({ github: { 'test.yml': gh } });
    assert.ok(armed(res, NEEDLE), 'rule must still arm');
    assert.ok(!failed(res, NEEDLE), 'a workflow-level opt-out reaches every job');
  });
});
