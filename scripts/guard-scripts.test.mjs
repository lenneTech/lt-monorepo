// Contract: every guard script in scripts/ must actually FIRE.
//
// These scripts share one failure mode, and it is the mode they exist to prevent:
// a rule whose condition never matches reports success. `check-ci-consistency.mjs`
// demonstrated it in practice — its mongo rule matched only the exact spelling
// already present in this repo, so it recognised nothing a developer would
// realistically get wrong, and still printed `ok — N rule(s) hold`.
//
// A green `pnpm run check` therefore proves nothing on its own: it is equally
// consistent with "the repo is correct" and with "the guard is blind". Each test
// below pairs the two directions — the real repo must pass, and a fixture with a
// deliberately broken config must fail with a non-zero exit code.
//
// Black box on purpose. `check-ci-consistency.mjs` was refactored to expose its
// checks as a function because it needed per-rule assertions; these three are
// driven through their CLI instead, which keeps them untouched and tests the thing
// that actually matters — the exit code `check` reacts to. Each script resolves
// its ROOT relative to its own file, so a fixture is a throwaway directory with a
// copy of the script in scripts/.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { splitGithubJobs, splitTopLevelBlocks, stripComments } from './check-ci-consistency.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const REPO = join(SCRIPTS, '..');
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { force: true, recursive: true })));

/** A throwaway repo containing `script` and the given files. */
function fixture(script, files) {
  const root = mkdtempSync(join(tmpdir(), 'guard-'));
  dirs.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(join(SCRIPTS, script), join(root, 'scripts', script));
  // Guards import their shared helpers from scripts/lib/. Staging only the guard itself
  // made it die on ERR_MODULE_NOT_FOUND, and this suite asserts on a script's OUTPUT —
  // so a crash reads as "the guard fired", which is the one thing it must never do.
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  for (const helper of readdirSync(join(SCRIPTS, 'lib'))) {
    if (helper.endsWith('.mjs') && !helper.endsWith('.test.mjs')) {
      copyFileSync(join(SCRIPTS, 'lib', helper), join(root, 'scripts', 'lib', helper));
    }
  }
  for (const [rel, body] of Object.entries(files)) {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
  return root;
}

/**
 * A crashed guard must never read as a guard that fired.
 *
 * This suite's whole contract is "the guard FIRES" — asserted through its output and exit
 * code. A script that dies on a bad import exits non-zero and prints a stack, which passes
 * a naive "did it complain?" check while having verified nothing. It is not hypothetical:
 * moving shared code into `scripts/lib/` made every guard crash here, because `fixture()`
 * staged the guard without its import.
 *
 * Checked centrally in the two runners, so a guard added later inherits the protection.
 */
function assertDidNotCrash(result, what) {
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const crash = /ERR_MODULE_NOT_FOUND|Cannot find module|^\s*(SyntaxError|ReferenceError|TypeError)\b/m.exec(out);
  assert.equal(crash, null, `${what} crashed instead of reporting — this run verified nothing:\n${out.slice(0, 600)}`);
  return result;
}

const runIn = (root, script) =>
  assertDidNotCrash(spawnSync('node', [join(root, 'scripts', script)], { encoding: 'utf8' }), script);
const runReal = (script) =>
  assertDidNotCrash(spawnSync('node', [join(SCRIPTS, script)], { cwd: REPO, encoding: 'utf8' }), script);

// A real, published pin, so fixtures stay realistic. Do NOT keep it in step with the repo's own
// pin: a fixture pin that differs from the caller's cwd is what exposed the provisioning probe
// reading `packageManager` from the wrong directory (see check-packagemanager-pin.mjs, step 4).
const VALID_PIN =
  'pnpm@11.14.0+sha512.66c1ac4c7d4762d6d7dde44c7f3e5a73591ed0a0806e751d4ed32d4f004f25b2285a906b1fd8a9e3e621df3b4e2858bf88e50e0cf626bedbe977fe434a5caf85';

describe('check-audit.mjs', () => {
  const SCRIPT = 'check-audit.mjs';

  // This suite's contract is "the guard FIRES". For this one the first question is smaller and was
  // the one that actually bit: does it still START? It runs ONLY in CI — `pnpm run check` never
  // calls it — so a broken import here passes a fully green local check and fails first in the
  // pipeline, on the job that gates the deploy. That happened: extracting the decision into
  // scripts/lib/ left the import behind, `pnpm run check` reported 258 tests green, and the gate
  // was dead. `assertDidNotCrash` in runReal is what turns that into a test failure.
  it('starts, resolves its imports, and reaches a verdict', () => {
    const res = runReal(SCRIPT);
    const out = `${res.stdout}${res.stderr}`;
    assert.match(out, /^\[audit\]/m, `no verdict line — the gate said nothing:\n${out.slice(0, 600)}`);
    // Exit 0 = clean or degraded; 1 = findings. Both are verdicts. Anything else is a crash that
    // `assertDidNotCrash` did not recognise.
    assert.ok([0, 1].includes(res.status), `unexpected exit ${res.status}:\n${out.slice(0, 600)}`);
  });

  it('is wired into both pipelines, since nothing else runs it', () => {
    // The local chain deliberately does not call it (check.mjs wraps the audit itself), so the CI
    // wiring IS its only caller. Losing that line would remove the gate without failing anything.
    for (const file of ['.gitlab-ci.yml', '.github/workflows/test.yml']) {
      const body = readFileSync(join(REPO, file), 'utf8');
      assert.match(body, /pnpm run check:audit/, `${file} no longer runs the audit gate`);
    }
  });
});

describe('check-packagemanager-pin.mjs', () => {
  const SCRIPT = 'check-packagemanager-pin.mjs';

  it('passes against this repository', () => {
    assert.equal(runReal(SCRIPT).status, 0);
  });

  it('fires on a packageManager pin without its integrity hash', () => {
    const root = fixture(SCRIPT, {
      'package.json': { engines: { pnpm: '^11.0.0' }, name: 'f', packageManager: 'pnpm@11.14.0' },
    });
    const res = runIn(root, SCRIPT);
    assert.notEqual(res.status, 0, `expected failure, got:\n${res.stdout}${res.stderr}`);
  });

  it('fires when engines.pnpm contradicts the pinned major', () => {
    const root = fixture(SCRIPT, {
      'package.json': { engines: { pnpm: '^9.0.0' }, name: 'f', packageManager: VALID_PIN },
    });
    assert.notEqual(runIn(root, SCRIPT).status, 0);
  });

  it('fires on a CI file that provisions pnpm through corepack', () => {
    const root = fixture(SCRIPT, {
      '.github/workflows/test.yml': 'jobs:\n  a:\n    steps:\n      - run: corepack enable\n',
      'package.json': { engines: { pnpm: '^11.0.0' }, name: 'f', packageManager: VALID_PIN },
    });
    assert.notEqual(runIn(root, SCRIPT).status, 0);
  });

  // --- section 3b: the Dockerfile scan ------------------------------------
  // Until these existed, that scan had never executed. This repo ships no
  // Dockerfile at all (`projects/` stays empty until `lt fullstack init`), so
  // the "passes against this repository" case above passed by reading nothing —
  // the precise "condition never matches, reports success" failure this file
  // exists to catch, sitting inside the file that catches it.
  const PKG = { engines: { pnpm: '^11.0.0' }, name: 'f', packageManager: VALID_PIN };
  const BAD_DOCKERFILE = 'FROM node:24-alpine\nRUN corepack enable\nRUN pnpm install\n';
  const GOOD_DOCKERFILE = [
    'FROM node:24-alpine',
    'RUN npm install -g "$(node -p "require(\'./package.json\').packageManager.split(\'+\')[0]")"',
    'RUN pnpm install --frozen-lockfile',
    '',
  ].join('\n');

  // Every path here except `docker/api/` was read by NO previous version of the
  // scan: it walked the SUBdirectories of a three-root allowlist, so a Dockerfile
  // in a root itself, one nested a level deeper, or one named `api.Dockerfile`
  // went unread while the run still reported success.
  for (const rel of [
    'Dockerfile',
    'api.Dockerfile',
    'docker/Dockerfile',
    'docker/api/Dockerfile',
    'projects/api/Dockerfile',
    'projects/api/docker/Dockerfile',
    'tools/Dockerfile',
  ]) {
    it(`fires on a corepack Dockerfile at ${rel}`, () => {
      const root = fixture(SCRIPT, { 'package.json': PKG, [rel]: BAD_DOCKERFILE });
      const res = runIn(root, SCRIPT);
      assert.notEqual(res.status, 0, `${rel} went unscanned:\n${res.stdout}${res.stderr}`);
      assert.match(res.stderr, /corepack/);
    });
  }

  it('fires on a Dockerfile that hardcodes a pnpm version', () => {
    const root = fixture(SCRIPT, {
      'package.json': PKG,
      'projects/api/Dockerfile': 'FROM node:24-alpine\nRUN npm install -g pnpm@10.0.0\nRUN pnpm install\n',
    });
    assert.notEqual(runIn(root, SCRIPT).status, 0);
  });

  it('passes a Dockerfile that derives pnpm from the pin', () => {
    const root = fixture(SCRIPT, {
      'package.json': PKG,
      'projects/api/Dockerfile': GOOD_DOCKERFILE,
    });
    const res = runIn(root, SCRIPT);
    assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
  });

  it('ignores Dockerfiles vendored inside node_modules', () => {
    const root = fixture(SCRIPT, {
      'package.json': PKG,
      'projects/node_modules/Dockerfile': BAD_DOCKERFILE,
    });
    const res = runIn(root, SCRIPT);
    assert.equal(res.status, 0, `a dependency's Dockerfile must not red the repo:\n${res.stdout}${res.stderr}`);
  });

  it('reports how many Dockerfiles it scanned, and which', () => {
    const root = fixture(SCRIPT, {
      'docker/web/Dockerfile': GOOD_DOCKERFILE,
      'package.json': PKG,
      'projects/api/Dockerfile': GOOD_DOCKERFILE,
    });
    const res = runIn(root, SCRIPT);
    assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /scanning 2 Dockerfile\(s\)/);
    assert.match(res.stdout, /projects\/api\/Dockerfile/);
  });

  // Same contract as check-playwright-image.mjs below, for the same reason: a run
  // that compared nothing has to say so on stderr, and the tail must not read as
  // coverage. The WORDING is asserted deliberately — an unasserted message can be
  // reworded or dropped while `check` stays green, which leaves it exactly as
  // unverifiable as the silence it replaced.
  it('warns on stderr when it found no Dockerfile at all', () => {
    const root = fixture(SCRIPT, { 'package.json': PKG });
    const res = runIn(root, SCRIPT);
    assert.equal(res.status, 0);
    assert.match(res.stderr, /WARN/);
    assert.match(res.stderr, /no Dockerfile found/);
    assert.match(res.stderr, /UNVERIFIED/);
    assert.match(res.stdout, /0 Dockerfile\(s\) scanned/);
  });
});

describe('check-workspace-consistency.mjs', () => {
  const SCRIPT = 'check-workspace-consistency.mjs';

  it('passes against this repository', () => {
    assert.equal(runReal(SCRIPT).status, 0);
  });

  it('fires when a workspace member carries its own packageManager pin', () => {
    // The real-world trigger: Corepack's AUTO_PIN writes this field per machine,
    // so two checkouts drift apart and the assembled workspace stops installing.
    const root = fixture(SCRIPT, {
      'package.json': { name: 'root', packageManager: VALID_PIN },
      'pnpm-workspace.yaml': "packages:\n  - 'projects/*'\n",
      'projects/api/package.json': { name: 'api', packageManager: VALID_PIN },
    });
    const res = runIn(root, SCRIPT);
    assert.notEqual(res.status, 0, 'a member pin equal to the root must still fail');
    assert.match(res.stderr, /packageManager/);
  });

  it('fires louder when the member pin disagrees with the root', () => {
    const root = fixture(SCRIPT, {
      'package.json': { name: 'root', packageManager: VALID_PIN },
      'pnpm-workspace.yaml': "packages:\n  - 'projects/*'\n",
      'projects/api/package.json': { name: 'api', packageManager: 'pnpm@10.0.0' },
    });
    const res = runIn(root, SCRIPT);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /root pins/);
  });

  it('passes a workspace whose members carry no pin', () => {
    const root = fixture(SCRIPT, {
      'package.json': { name: 'root', packageManager: VALID_PIN },
      'pnpm-workspace.yaml': "packages:\n  - 'projects/*'\n",
      'projects/api/package.json': { name: 'api' },
    });
    assert.equal(runIn(root, SCRIPT).status, 0);
  });
});

describe('check-playwright-image.mjs', () => {
  const SCRIPT = 'check-playwright-image.mjs';

  it('passes against this repository', () => {
    assert.equal(runReal(SCRIPT).status, 0);
  });

  it('fires when the CI image tag lags the pinned @playwright/test', () => {
    // The failure this prevents reds the entire E2E suite at browser launch, with
    // an error that points at the tests rather than at the image.
    const root = fixture(SCRIPT, {
      '.gitlab-ci.yml': 'app:test:\n  image: mcr.microsoft.com/playwright:v1.55.0-noble\n',
      'package.json': { name: 'f' },
      'projects/app/package.json': {
        devDependencies: { '@playwright/test': '1.61.1' },
        name: 'app',
      },
    });
    const res = runIn(root, SCRIPT);
    assert.notEqual(res.status, 0, `expected drift to be caught, got:\n${res.stdout}${res.stderr}`);
  });

  it('passes when image tag and package version agree', () => {
    const root = fixture(SCRIPT, {
      '.gitlab-ci.yml': 'app:test:\n  image: mcr.microsoft.com/playwright:v1.61.1-noble\n',
      'package.json': { name: 'f' },
      'projects/app/package.json': {
        devDependencies: { '@playwright/test': '1.61.1' },
        name: 'app',
      },
    });
    const res = runIn(root, SCRIPT);
    assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
  });

  it('warns rather than passing silently on a bare template with no app package', () => {
    // Must not be mistaken for a pass that verified something: this repo IS that
    // template, so the "passes against this repository" case above takes the skip
    // path — which is exactly why the drift case is asserted on a fixture.
    //
    // The wording is asserted, not just the exit code. A skip that printed "ok" is
    // what let the image pins drift for eleven days behind a green check, so the
    // message has to say plainly that nothing was compared — on stderr, where a
    // warning belongs.
    const root = fixture(SCRIPT, { 'package.json': { name: 'f' } });
    const res = runIn(root, SCRIPT);
    assert.equal(res.status, 0);
    assert.match(res.stderr, /WARN/);
    assert.match(res.stderr, /nothing compared/);
    assert.doesNotMatch(res.stdout, /\bok\b/);
  });
});

describe('turboops-guard.sh', () => {
  // The guard fails a job on purpose when the TurboOps setup is incomplete. That is right once a
  // project deploys to TurboOps, and wrong everywhere else: in a GitLab project without TurboOps,
  // the template included, every dev/main pipeline went red at the guard, and real failures got
  // lost among those red pipelines. So every job that runs the guard sits behind a gate that skips
  // it while neither TURBOOPS_PROJECT nor TURBOOPS_TOKEN is set. Either value opens the gate, on
  // purpose: a half-finished setup (one value forgotten, or a protected variable on an unprotected
  // branch) has to reach the guard, which names what is missing. Requiring both would skip the
  // deploy silently instead, with a green pipeline.
  const GITLAB_GATE = /^ {4}-\s*if:\s*['"]?\(\$TURBOOPS_PROJECT \|\| \$TURBOOPS_TOKEN\) && /;
  const GITHUB_GATE = /^ {4}if:\s*\$\{\{\s*needs\.guard\.outputs\.configured == 'true'/m;
  const isTemplate = () => JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).name === 'lt-monorepo';
  // A generated project may delete a pipeline it does not use: GitLab-only projects drop
  // deploy.yml and keep test.yml. There the file reads as empty, so the test skips instead of
  // crashing on ENOENT. The template ships both files, so a missing one still fails here.
  const readCi = (file) => (isTemplate() || existsSync(join(REPO, file)) ? readFileSync(join(REPO, file), 'utf8') : '');

  /** GitLab jobs that run the guard, each with the rule entries that would start it ungated. */
  function gitlabGuardJobs(text) {
    const out = {};
    for (const [name, body] of Object.entries(splitTopLevelBlocks(stripComments(text)))) {
      if (name.startsWith('.') || !body.includes('turboops-guard')) continue;
      const rules = /^ {2}rules:\s*\n((?: {4}.*\n?)*)/m.exec(body)?.[1] ?? '';
      const entries = rules.split('\n').filter((l) => /^ {4}-/.test(l));
      out[name] = entries.length ? entries.filter((l) => !GITLAB_GATE.test(l)) : ['no `rules:`, so it runs ungated'];
    }
    return out;
  }

  /** GitHub jobs that run the guard, each with what is missing from its gate. */
  function githubGuardJobs(text) {
    const out = {};
    for (const [name, body] of Object.entries(splitGithubJobs(stripComments(text)))) {
      if (!body.includes('turboops-guard.sh')) continue;
      out[name] = GITHUB_GATE.test(body) && /^ {4}needs:.*\bguard\b/m.test(body) ? [] : ['not behind the guard job'];
    }
    return out;
  }

  it('keeps every GitLab job that runs the guard behind the gate', (t) => {
    const jobs = gitlabGuardJobs(readCi('.gitlab-ci.yml'));
    if (isTemplate()) {
      assert.deepEqual(Object.keys(jobs).sort(), ['deploy-dev', 'deploy-prod', 'turboops-build']);
    } else if (Object.keys(jobs).length === 0) {
      t.skip('no GitLab job runs turboops-guard.sh — this project does not deploy to TurboOps from GitLab');
      return;
    }
    for (const [name, open] of Object.entries(jobs)) {
      assert.deepEqual(open, [], `${name} starts without the TurboOps gate ($TURBOOPS_PROJECT || $TURBOOPS_TOKEN)`);
    }
  });

  it('keeps every GitHub job that runs the guard behind the gate', (t) => {
    const text = readCi('.github/workflows/deploy.yml');
    const jobs = githubGuardJobs(text);
    if (isTemplate()) {
      assert.deepEqual(Object.keys(jobs).sort(), ['build-push', 'deploy']);
    } else if (Object.keys(jobs).length === 0) {
      t.skip('no GitHub job runs turboops-guard.sh — this project does not deploy to TurboOps from GitHub');
      return;
    }
    for (const [name, open] of Object.entries(jobs)) {
      assert.deepEqual(open, [], `${name} starts without the TurboOps gate`);
    }
    assert.match(
      text,
      /\[ "\$HAS_PROJECT" = "true" \] \|\| \[ "\$HAS_TOKEN" = "true" \]/,
      'either value must open the gate',
    );
  });

  it('flags a guard job that is not behind the gate', () => {
    const job = (rules) => `deploy-dev:\n  before_script:\n    - !reference [.turboops-guard, script]\n${rules}`;
    const branchOnly = gitlabGuardJobs(job(`  rules:\n    - if: '$CI_COMMIT_BRANCH == "dev"'\n`));
    assert.equal(branchOnly['deploy-dev'].length, 1, 'a branch-only rule must be flagged');
    const bothRequired = gitlabGuardJobs(
      job(`  rules:\n    - if: '$TURBOOPS_PROJECT && $TURBOOPS_TOKEN && $CI_COMMIT_BRANCH == "dev"'\n`),
    );
    assert.equal(bothRequired['deploy-dev'].length, 1, 'requiring both values skips a half-finished setup silently');
    const onlyKeyword = gitlabGuardJobs(job('  only:\n    - dev\n'));
    assert.equal(onlyKeyword['deploy-dev'].length, 1, 'a job without rules must be flagged');
    const gated = gitlabGuardJobs(
      job(
        `  rules:\n    - if: '($TURBOOPS_PROJECT || $TURBOOPS_TOKEN) && $CI_COMMIT_BRANCH == "dev"'\n      when: on_success\n`,
      ),
    );
    assert.deepEqual(gated['deploy-dev'], []);

    const ungatedGithub = githubGuardJobs(
      'jobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: sh scripts/turboops-guard.sh\n',
    );
    assert.equal(ungatedGithub.deploy.length, 1, 'a GitHub job outside the guard job must be flagged');
  });
});
