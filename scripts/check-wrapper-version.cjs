/**
 * commit-and-tag-version updater for the `// @lt-check-wrapper <version>` line in
 * scripts/check.mjs, wired up through `bumpFiles` in .versionrc.json.
 *
 * The marker names the lt-monorepo RELEASE the wrapper belongs to; the lt CLI reads it to
 * refuse replacing a project's wrapper with an older one. So it may only move in the template
 * itself. A generated project inherits .versionrc.json and `pnpm run release`, but its
 * package.json version is the project's own — writing that into the marker would pass an
 * arbitrary project version off as a wrapper release. There the file is left untouched.
 * `lt fullstack init` renames the root package, which is what tells the two apart.
 *
 * CommonJS on purpose: commit-and-tag-version loads custom updaters with `require()`.
 */
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const TEMPLATE_NAME = 'lt-monorepo';

// The exact format the lt CLI parses. Anchored to a whole line so prose that mentions the tag
// never matches; `\r?` keeps a CRLF checkout readable.
const MARKER_RE = /^\/\/ @lt-check-wrapper (\S+)\r?$/m;

function readMarker(contents) {
  return MARKER_RE.exec(contents)?.[1];
}

function bumpMarker(contents, version) {
  // Throw rather than return the input unchanged: commit-and-tag-version reports a thrown error
  // as a warning, while an unchanged file would read as a successful bump.
  if (!MARKER_RE.test(contents)) {
    throw new Error(
      'scripts/check.mjs has no `// @lt-check-wrapper <version>` line — the wrapper version was NOT bumped',
    );
  }
  return contents.replace(MARKER_RE, `// @lt-check-wrapper ${version}`);
}

function createUpdater(readPackageName) {
  return {
    readVersion: readMarker,
    writeVersion(contents, version) {
      return readPackageName() === TEMPLATE_NAME ? bumpMarker(contents, version) : contents;
    },
  };
}

function packageNameAt(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name;
}

module.exports = {
  // commit-and-tag-version runs from the repository root.
  ...createUpdater(() => packageNameAt(process.cwd())),
  MARKER_RE,
  TEMPLATE_NAME,
  createUpdater,
  readMarker,
};
