/**
 * Tests for the shared workspace reader.
 *
 * This module exists because the same parse had been copied into three guards and the
 * copies had drifted — each silently resolving nothing under a slightly different valid
 * workspace file, and each then reporting that every rule held. The cases below are the
 * spellings that actually broke one of those copies, plus the link-mode shape that broke
 * all three. A guard that resolves nothing must be provably rare, not merely believed to be.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { expandGlob, packageDirsByName, workspaceGlobs, workspacePackageDirs } from './workspace-packages.mjs';

const dirs = [];
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { force: true, recursive: true });
    } catch {
      /* best effort */
    }
  }
});

/** A throwaway workspace: the yaml text, plus `dir -> package.json contents`. */
function fixture(yaml, packages = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lt-ws-'));
  dirs.push(root);
  if (yaml !== null) writeFileSync(join(root, 'pnpm-workspace.yaml'), yaml);
  for (const [dir, contents] of Object.entries(packages)) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'package.json'), contents);
  }
  return root;
}

describe('workspaceGlobs', () => {
  it('reads the indented block form', () => {
    assert.deepEqual(workspaceGlobs(fixture("packages:\n  - 'projects/*'\n")), ['projects/*']);
  });

  it('reads a block whose dashes sit at column 0', () => {
    // Valid YAML and a common spelling. The newest copy of this parser treated the dash
    // line as the next top-level key and stopped before reading a single entry — so the
    // guard built on it went blind while reporting success.
    assert.deepEqual(workspaceGlobs(fixture("packages:\n- 'projects/*'\n- 'tools/*'\n")), ['projects/*', 'tools/*']);
  });

  it('reads the flow form', () => {
    assert.deepEqual(workspaceGlobs(fixture("packages: ['projects/*', 'tools/*']\n")), ['projects/*', 'tools/*']);
  });

  it('survives a comment on the key and between entries', () => {
    const globs = workspaceGlobs(fixture("packages: # the members\n  - 'projects/*'\n# a note\n  - 'tools/*'\n"));
    assert.deepEqual(globs, ['projects/*', 'tools/*'], 'a comment must not truncate the list');
  });

  it('finds packages: when it is not the first key', () => {
    // This repo's real pnpm-workspace.yaml opens with shamefullyHoist/autoInstallPeers.
    const globs = workspaceGlobs(
      fixture("shamefullyHoist: true\nautoInstallPeers: true\npackages:\n  - 'projects/*'\n"),
    );
    assert.deepEqual(globs, ['projects/*']);
  });

  it('stops at the next top-level key', () => {
    const globs = workspaceGlobs(fixture("packages:\n  - 'projects/*'\nallowBuilds:\n  esbuild: true\n"));
    assert.deepEqual(globs, ['projects/*'], 'a later mapping must not leak in as a glob');
  });

  it('returns nothing for a missing file or a file without the key', () => {
    assert.deepEqual(workspaceGlobs(fixture(null)), []);
    assert.deepEqual(workspaceGlobs(fixture('shamefullyHoist: true\n')), []);
  });
});

describe('expandGlob', () => {
  it('expands dir/* to its subdirectories', () => {
    const root = fixture("packages:\n  - 'projects/*'\n", {
      'projects/api': '{"name":"api"}',
      'projects/app': '{"name":"app"}',
    });
    assert.deepEqual(expandGlob(root, 'projects/*').sort(), ['projects/api', 'projects/app']);
  });

  it('counts a symlinked member', () => {
    // `lt fullstack init --api-link` points projects/api at the developer's own checkout.
    // Dirent.isDirectory() reflects an lstat and is FALSE for a symlink, so filtering on
    // it alone reported a linked workspace as empty — in all three guards at once.
    const root = fixture("packages:\n  - 'projects/*'\n", { elsewhere: '{"name":"api"}' });
    mkdirSync(join(root, 'projects'), { recursive: true });
    symlinkSync('../elsewhere', join(root, 'projects/api'), 'dir');
    assert.deepEqual(expandGlob(root, 'projects/*'), ['projects/api']);
  });

  it('ignores a dangling symlink and a plain file', () => {
    const root = fixture("packages:\n  - 'projects/*'\n");
    mkdirSync(join(root, 'projects'), { recursive: true });
    symlinkSync('../nowhere', join(root, 'projects/gone'), 'dir');
    writeFileSync(join(root, 'projects/notes.md'), '');
    assert.deepEqual(expandGlob(root, 'projects/*'), []);
  });

  it('takes a literal path only when it is really there', () => {
    const root = fixture("packages:\n  - 'tools/one'\n", { 'tools/one': '{"name":"one"}' });
    assert.deepEqual(expandGlob(root, 'tools/one'), ['tools/one']);
    assert.deepEqual(expandGlob(root, 'tools/two'), [], 'an absent literal must not be invented');
  });

  it('expands an unmodelled glob shape to nothing rather than to a guess', () => {
    const root = fixture("packages:\n  - 'projects/**'\n", { 'projects/api': '{"name":"api"}' });
    assert.deepEqual(expandGlob(root, 'projects/**'), []);
    assert.deepEqual(expandGlob(root, 'a/*/b'), []);
  });
});

describe('packageDirsByName', () => {
  it('maps the declared name, not the directory basename', () => {
    const root = fixture("packages:\n  - 'projects/*'\n", {
      'projects/api': '{"name":"@acme/api"}',
    });
    assert.deepEqual([...packageDirsByName(root)], [['@acme/api', 'projects/api']]);
  });

  it('leaves out a member that is nameless, absent or unparseable', () => {
    const root = fixture("packages:\n  - 'projects/*'\n", {
      'projects/broken': '{ not json',
      'projects/nameless': '{"version":"1.0.0"}',
      'projects/ok': '{"name":"ok"}',
    });
    mkdirSync(join(root, 'projects/empty'), { recursive: true });
    assert.deepEqual([...packageDirsByName(root).keys()], ['ok']);
    // The directories are still discovered — only the NAME lookup drops them, so a caller
    // that walks members by path still sees the broken one and can report it.
    assert.equal(workspacePackageDirs(root).length, 4);
  });

  it('is empty for the un-assembled template', () => {
    const root = fixture("packages:\n  - 'projects/*'\n");
    mkdirSync(join(root, 'projects'), { recursive: true });
    assert.equal(packageDirsByName(root).size, 0);
  });
});
