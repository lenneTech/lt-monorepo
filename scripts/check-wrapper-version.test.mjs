/**
 * Guard for the `// @lt-check-wrapper <version>` line in scripts/check.mjs.
 *
 * The lt CLI reads that line to decide whether `lt fullstack update` may replace a project's
 * wrapper: only with one at least as new. A marker that lags behind package.json lets an old
 * wrapper pass as current — the silent downgrade this marker exists to stop. `pnpm run release`
 * bumps it through .versionrc.json; this suite notices when that wiring is gone or was bypassed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import updater from './check-wrapper-version.cjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const wrapper = read('scripts/check.mjs');

describe('check.mjs wrapper version marker', () => {
  it('sits directly below the shebang, exactly once, in the format the lt CLI parses', () => {
    const all = [...wrapper.matchAll(new RegExp(updater.MARKER_RE.source, 'gm'))];
    assert.equal(all.length, 1, `expected one \`// @lt-check-wrapper <version>\` line, found ${all.length}`);
    assert.match(
      wrapper.split('\n')[1],
      /^\/\/ @lt-check-wrapper \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
      'line 2 of scripts/check.mjs must be `// @lt-check-wrapper <semver>`',
    );
  });

  it('matches the package.json version', (t) => {
    if (pkg.name !== updater.TEMPLATE_NAME) {
      // A generated project: the marker keeps the lt-monorepo release it was created from, while
      // package.json carries the project's own version. Comparing the two would be meaningless.
      t.skip(`package "${pkg.name}" is a generated project, not the ${updater.TEMPLATE_NAME} template`);
      return;
    }
    assert.equal(
      updater.readMarker(wrapper),
      pkg.version,
      'scripts/check.mjs names a different release than package.json — set the `@lt-check-wrapper` line to the package version',
    );
  });

  it('is bumped by `pnpm run release`', () => {
    const entry = JSON.parse(read('.versionrc.json')).bumpFiles?.find((f) => f.filename === 'scripts/check.mjs');
    assert.ok(
      entry,
      '.versionrc.json bumpFiles has no scripts/check.mjs entry — a release would leave the marker behind',
    );
    assert.equal(entry.updater, 'scripts/check-wrapper-version.cjs');
  });

  it('rewrites only the marker line in the template', () => {
    const { readVersion, writeVersion } = updater.createUpdater(() => updater.TEMPLATE_NAME);
    const next = writeVersion(wrapper, '99.0.0');
    assert.equal(readVersion(next), '99.0.0');
    assert.equal(next.replace(updater.MARKER_RE, ''), wrapper.replace(updater.MARKER_RE, ''));
  });

  it('leaves the marker alone in a generated project', () => {
    const { writeVersion } = updater.createUpdater(() => 'my-project');
    assert.equal(writeVersion(wrapper, '99.0.0'), wrapper);
  });

  it('throws when the marker is missing, so the release warns instead of reporting a bump', () => {
    const { writeVersion } = updater.createUpdater(() => updater.TEMPLATE_NAME);
    assert.throws(() => writeVersion('#!/usr/bin/env node\n', '1.0.0'), /NOT bumped/);
  });

  it('reads the marker from a CRLF checkout', () => {
    assert.equal(updater.readMarker('#!/usr/bin/env node\r\n// @lt-check-wrapper 1.2.3\r\n'), '1.2.3');
  });
});
