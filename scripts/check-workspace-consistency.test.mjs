// Contract: the wire-critical version guard must actually FIRE.
//
// The guard exists because of a defect that shipped. nest-server pinned
// better-auth 1.6.26 as a hard dependency while nuxt-extensions declared it as a
// peer, so the app could move to 1.7.1 and the api could not follow. better-auth
// 1.7 gives `twoFactor.enable` a discriminated result carrying `method`, which a
// 1.6.26 server never sends — so every 2FA activation failed. Both repos' checks
// were green throughout: each was internally consistent, and only the assembled
// workspace ever had both halves.
//
// Every rule below is driven from BOTH sides — a positive control proving the
// guard ARMS on the shape, and a negative control proving it FIRES on the drift.
// A rule only ever asserted in its passing state is indistinguishable from a rule
// that is never evaluated at all.
//
// The guard is a top-level script, not a module with exports, so it is exercised
// the way it really runs: copied into a synthetic workspace and executed, with
// the exit code and the message as the contract.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, 'check-workspace-consistency.mjs');
const PM = 'pnpm@11.14.0+sha512.deadbeef';

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

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Builds a synthetic assembled workspace.
 *
 * @param members - one entry per project, e.g.
 *   { rel: 'projects/api', owner: '@lenne.tech/nest-server',
 *     peers: { 'better-auth': '>=1.7.0 <1.8.0' }, installed: { 'better-auth': '1.7.1' } }
 */
function buildWorkspace(members) {
  const dir = mkdtempSync(join(tmpdir(), 'ws-consistency-'));
  dirs.push(dir);

  writeJson(join(dir, 'package.json'), { name: 'ws-root', packageManager: PM, version: '1.0.0' });
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'projects/*'\n");
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  copyFileSync(GUARD, join(dir, 'scripts', 'check-workspace-consistency.mjs'));
  // The guard imports its workspace reader from scripts/lib/. Staging the guard alone
  // made it die on ERR_MODULE_NOT_FOUND — and since these assertions match on the
  // script's OUTPUT, a crash would read as the guard having fired.
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  for (const helper of readdirSync(join(HERE, 'lib'))) {
    if (helper.endsWith('.mjs') && !helper.endsWith('.test.mjs')) {
      copyFileSync(join(HERE, 'lib', helper), join(dir, 'scripts', 'lib', helper));
    }
  }

  for (const m of members) {
    // `declared` defaults to the installed set: the normal, correct case is a member
    // that pins exactly what it has. A test that wants the auto-installed shape passes
    // `declared: {}` explicitly.
    const declared = m.declared ?? m.installed ?? {};
    writeJson(join(dir, m.rel, 'package.json'), {
      dependencies: declared,
      name: m.rel.split('/').pop(),
      version: '1.0.0',
    });

    if (m.owner) {
      writeJson(join(dir, m.rel, 'node_modules', m.owner, 'package.json'), {
        name: m.owner,
        peerDependencies: m.peers ?? {},
        version: '1.0.0',
      });
    }

    for (const [pkg, version] of Object.entries(m.installed ?? {})) {
      writeJson(join(dir, m.rel, 'node_modules', pkg, 'package.json'), { name: pkg, version });
    }
  }

  return dir;
}

function runGuard(dir) {
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'check-workspace-consistency.mjs')], {
    encoding: 'utf8',
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  assertDidNotCrash(out);
  return { out, status: r.status };
}

/**
 * A crashed guard must never read as a guard that spoke.
 *
 * Every assertion in this file matches on the script's OUTPUT, and the negative ones match
 * on the ABSENCE of a message. A script that dies before printing anything satisfies those
 * perfectly — so a staging mistake or a typo in an import turns the whole suite green while
 * verifying nothing. That is not hypothetical: adding a shared helper under `scripts/lib/`
 * did exactly this, because the fixture staged the guard without its import.
 *
 * Checked centrally rather than per-test, so a rule added later inherits it instead of
 * someone having to remember.
 */
function assertDidNotCrash(out) {
  const crash = /ERR_MODULE_NOT_FOUND|Cannot find module|^\s*(SyntaxError|ReferenceError|TypeError)\b/m.exec(out);
  assert.equal(
    crash,
    null,
    `the guard crashed instead of reporting — this run verified nothing:\n${out.slice(0, 600)}`,
  );
}

/** api + app, both on the same better-auth — the shape the guard must accept. */
const inAgreement = () => [
  {
    installed: { 'better-auth': '1.7.1' },
    owner: '@lenne.tech/nest-server',
    peers: { 'better-auth': '>=1.7.0 <1.8.0' },
    rel: 'projects/api',
  },
  {
    installed: { 'better-auth': '1.7.1' },
    owner: '@lenne.tech/nuxt-extensions',
    peers: { 'better-auth': '>=1.7.0 <1.8.0' },
    rel: 'projects/app',
  },
];

describe('check-workspace-consistency: wire-critical versions', () => {
  it('POSITIVE CONTROL — passes when api and app agree', () => {
    const { out, status } = runGuard(buildWorkspace(inAgreement()));
    assert.equal(status, 0, out);
    assert.match(out, /ok —/);
    // Proves the guard actually LOOKED at better-auth rather than skipping it.
    assert.match(out, /better-auth/);
  });

  it('FIRES when the installed versions differ — the split that shipped', () => {
    const members = inAgreement();
    members[0].installed['better-auth'] = '1.6.26'; // api left behind, exactly as it happened
    const { out, status } = runGuard(buildWorkspace(members));

    assert.equal(status, 1, out);
    assert.match(out, /better-auth resolves to 2 different versions/);
    // The message must name both sides — a bare "mismatch" sends the reader hunting.
    assert.match(out, /1\.6\.26/);
    assert.match(out, /1\.7\.1/);
    assert.match(out, /projects\/api/);
    assert.match(out, /projects\/app/);
  });

  it('FIRES when the frameworks promise different peer ranges', () => {
    const members = inAgreement();
    // The state before the fix: nuxt-extensions promised anything from 1.0.0 up,
    // a range its own code could not honour.
    members[1].peers['better-auth'] = '>=1.0.0';
    const { out, status } = runGuard(buildWorkspace(members));

    assert.equal(status, 1, out);
    assert.match(out, /the frameworks promise different ranges/);
    assert.match(out, /@lenne\.tech\/nest-server says ">=1\.7\.0 <1\.8\.0"/);
    assert.match(out, /@lenne\.tech\/nuxt-extensions says ">=1\.0\.0"/);
  });

  it('catches a range drift even while the installed versions still agree', () => {
    // The failure that has not happened yet: today's install is fine, the next
    // one is a coin flip. Fail now, while it is one line to fix.
    const members = inAgreement();
    members[1].peers['better-auth'] = '>=1.7.0 <1.9.0';
    const { status } = runGuard(buildWorkspace(members));
    assert.equal(status, 1);
  });

  it('stays quiet when only one member uses the package', () => {
    const members = inAgreement();
    delete members[1].installed['better-auth'];
    delete members[1].peers['better-auth'];
    const { out, status } = runGuard(buildWorkspace(members));
    assert.equal(status, 0, out);
  });

  it('stays quiet before install — no node_modules is not a drift', () => {
    const { out, status } = runGuard(buildWorkspace([{ rel: 'projects/api' }, { rel: 'projects/app' }]));
    assert.equal(status, 0, out);
    // And says nothing about packages it could not see.
    assert.doesNotMatch(out, /better-auth/);
  });

  it('FIRES when a member has the package installed but declares it nowhere', () => {
    // The autoInstallPeers hole: pnpm fills a missing peer from the framework's range,
    // picks the same version for both members today, and nothing is pinned. Checks 1
    // and 2 are both satisfied — identical ranges, identical versions — so this is the
    // only one that can see it.
    const members = inAgreement();
    members[1].declared = {};
    const { out, status } = runGuard(buildWorkspace(members));

    assert.equal(status, 1, out);
    assert.match(out, /better-auth is installed but declared nowhere/);
    assert.match(out, /projects\/app/);
    assert.match(out, /pnpm resolved 1\.7\.1 on its own/);
    // And must NOT accuse the member that did pin it.
    assert.doesNotMatch(out, /projects\/api\s+\(pnpm resolved/);
  });

  it('accepts a declaration in any dependency block', () => {
    // A pin is a pin — devDependencies and peerDependencies count too.
    const dir = buildWorkspace(inAgreement());
    writeJson(join(dir, 'projects/app/package.json'), {
      devDependencies: { 'better-auth': '1.7.1' },
      name: 'app',
      version: '1.0.0',
    });
    const { out, status } = runGuard(dir);
    assert.equal(status, 0, out);
  });

  it('does not demand a pin from a member that does not use the package', () => {
    const members = inAgreement();
    delete members[1].installed['better-auth'];
    delete members[1].peers['better-auth'];
    members[1].declared = {};
    const { out, status } = runGuard(buildWorkspace(members));
    assert.equal(status, 0, out);
  });

  it('still enforces the packageManager rule it was written for', () => {
    const dir = buildWorkspace(inAgreement());
    // A member pin that AGREES with the root is still a defect: Corepack's
    // AUTO_PIN rewrites it per machine, so the two drift on their own.
    writeJson(join(dir, 'projects/api/package.json'), {
      dependencies: { 'better-auth': '1.7.1' },
      name: 'api',
      packageManager: PM,
      version: '1.0.0',
    });
    const { out, status } = runGuard(dir);
    assert.equal(status, 1, out);
    assert.match(out, /packageManager/);
  });
});
