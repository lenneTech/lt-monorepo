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
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

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
  for (const [rel, body] of Object.entries(files)) {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
  return root;
}

const runIn = (root, script) => spawnSync('node', [join(root, 'scripts', script)], { encoding: 'utf8' });
const runReal = (script) => spawnSync('node', [join(SCRIPTS, script)], { cwd: REPO, encoding: 'utf8' });

// The pin this repo actually uses, so fixtures stay realistic.
const VALID_PIN =
  'pnpm@11.14.0+sha512.66c1ac4c7d4762d6d7dde44c7f3e5a73591ed0a0806e751d4ed32d4f004f25b2285a906b1fd8a9e3e621df3b4e2858bf88e50e0cf626bedbe977fe434a5caf85';

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
      'projects/app/package.json': { devDependencies: { '@playwright/test': '1.61.1' }, name: 'app' },
    });
    const res = runIn(root, SCRIPT);
    assert.notEqual(res.status, 0, `expected drift to be caught, got:\n${res.stdout}${res.stderr}`);
  });

  it('passes when image tag and package version agree', () => {
    const root = fixture(SCRIPT, {
      '.gitlab-ci.yml': 'app:test:\n  image: mcr.microsoft.com/playwright:v1.61.1-noble\n',
      'package.json': { name: 'f' },
      'projects/app/package.json': { devDependencies: { '@playwright/test': '1.61.1' }, name: 'app' },
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
