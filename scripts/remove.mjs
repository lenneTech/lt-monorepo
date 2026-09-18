#!/usr/bin/env node
/**
 * `rm -rf` for npm scripts, on every platform.
 *
 * cmd.exe has no `rm`, so `rm -rf node_modules` kills `pnpm run reinit` on Windows before it
 * deletes anything. Node is the one interpreter a package-manager script can always count on:
 * pnpm is running on it.
 *
 * Deliberately NOT rimraf or del-cli. Two reasons, and the second is the one that decides it:
 *
 *  - this repo has neither in its tree (rimraf appears nowhere in pnpm-lock.yaml), so it would
 *    be a new dependency for something `node:fs` has done natively since Node 14;
 *  - the first caller deletes `node_modules` itself. On Windows an open file cannot be
 *    unlinked, so a deleter loaded FROM `node_modules` is deleting the directory it is running
 *    out of. `node scripts/remove.mjs` runs from outside it and has nothing of the kind open.
 *
 * `force: true` keeps a missing path from failing — `reinit` must work on a tree that has
 * never been installed, which is exactly when `node_modules` is absent.
 *
 * Paths are resolved against the repository root, not the caller's cwd, and a path outside it
 * is refused: this deletes recursively with force, and a mistyped `../..` in a script is not
 * something to find out about afterwards.
 */
import { rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function resolveTarget(target, root = ROOT) {
  const abs = resolve(root, target);
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..')) {
    throw new Error(`refusing to remove \`${target}\`: outside the repository root (${root})`);
  }
  return abs;
}

export function removeAll(targets, root = ROOT) {
  for (const target of targets) rmSync(resolveTarget(target, root), { force: true, recursive: true });
  return targets.length;
}

// Only when run as a script, so the helpers above stay importable from a test.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    process.stderr.write('usage: node scripts/remove.mjs <path> [path…]\n');
    process.exit(1);
  }
  try {
    removeAll(targets);
  } catch (err) {
    process.stderr.write(`[remove] ${err.message}\n`);
    process.exit(1);
  }
}
