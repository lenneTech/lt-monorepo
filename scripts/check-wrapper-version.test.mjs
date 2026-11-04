/**
 * Guard for the `// @lt-check-wrapper <version>` line in scripts/check.mjs.
 *
 * The lt CLI reads that line to decide whether `lt fullstack update` may replace a project's
 * wrapper: only with one at least as new. A marker that lags behind package.json lets an old
 * wrapper pass as current — the silent downgrade this marker exists to stop. No release tool
 * bumps it any more: the release recipe (lt-dev `maintaining-lt-stack`) sets it by hand next to
 * the package.json version, and this suite is what notices when one of the two was forgotten.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const TEMPLATE_NAME = 'lt-monorepo';

// The exact format the lt CLI parses (`VERSION_MARKER` in cli/src/lib/heal-check-wrapper.ts).
// Anchored to a whole line so prose that mentions the tag never matches; `\r?` keeps a CRLF
// checkout readable.
const MARKER_RE = /^\/\/ @lt-check-wrapper (\S+)\r?$/m;
const readMarker = (contents) => MARKER_RE.exec(contents)?.[1];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const wrapper = read('scripts/check.mjs');

describe('check.mjs wrapper version marker', () => {
  it('sits directly below the shebang, exactly once, in the format the lt CLI parses', () => {
    const all = [...wrapper.matchAll(new RegExp(MARKER_RE.source, 'gm'))];
    assert.equal(all.length, 1, `expected one \`// @lt-check-wrapper <version>\` line, found ${all.length}`);
    assert.match(
      wrapper.split('\n')[1],
      /^\/\/ @lt-check-wrapper \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
      'line 2 of scripts/check.mjs must be `// @lt-check-wrapper <semver>`',
    );
  });

  it('matches the package.json version', (t) => {
    if (pkg.name !== TEMPLATE_NAME) {
      // A generated project: the marker keeps the lt-monorepo release it was created from, while
      // package.json carries the project's own version. Comparing the two would be meaningless.
      // `lt fullstack init` renames the root package, which is what tells the two apart.
      t.skip(`package "${pkg.name}" is a generated project, not the ${TEMPLATE_NAME} template`);
      return;
    }
    assert.equal(
      readMarker(wrapper),
      pkg.version,
      'scripts/check.mjs names a different release than package.json — set the `@lt-check-wrapper` line to the package version',
    );
  });

  it('reads the marker from a CRLF checkout', () => {
    assert.equal(readMarker('#!/usr/bin/env node\r\n// @lt-check-wrapper 1.2.3\r\n'), '1.2.3');
  });
});
