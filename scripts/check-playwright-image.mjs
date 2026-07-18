#!/usr/bin/env node
/**
 * Contract test: every Playwright CI image tag MUST match the `@playwright/test`
 * package version.
 *
 * CI jobs that run the E2E suite use a prebuilt
 * `mcr.microsoft.com/playwright:vX.Y.Z-noble` image that already ships the
 * browser binaries — so the GitLab job does NO `playwright install` step. If a
 * dependency bump raises `@playwright/test` (e.g. 1.60.0 -> 1.61.1) without
 * bumping the image tag in lockstep, every E2E test fails at browser launch
 * with "Executable doesn't exist ... chrome-headless-shell" — a red pipeline
 * whose cause is pure image drift, not a code regression.
 *
 * This guard makes that drift a fast, obvious failure (locally via
 * `pnpm run check` and in CI via the `lint` job) instead of a full E2E
 * meltdown after the fact. It scans ALL CI definitions — .gitlab-ci.yml and
 * every .github/workflows/*.yml — so neither pipeline can drift unseen.
 *
 * Exit code: 0 when every tag matches the package version, 1 otherwise.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function fail(msg) {
  process.stderr.write(`[playwright-image] ${msg}\n`);
  process.exit(1);
}

// 1. Package version — the source of truth. Template repos (empty projects/)
//    have no app package.json yet; then there is nothing to guard.
let pkgVersion = '';
const appPkgPath = join(ROOT, 'projects/app/package.json');
if (existsSync(appPkgPath)) {
  try {
    const pkg = JSON.parse(readFileSync(appPkgPath, 'utf8'));
    pkgVersion = (pkg.devDependencies?.['@playwright/test'] ?? pkg.dependencies?.['@playwright/test'] ?? '').trim();
  } catch {
    fail('cannot parse projects/app/package.json');
  }
}
if (!pkgVersion) {
  console.log('[playwright-image] ok — no @playwright/test in projects/app, skipping');
  process.exit(0);
}
// Exact pins only (project policy: no ^ or ~). Strip a leading range char defensively.
const pkgExact = pkgVersion.replace(/^[\^~]/, '');

// 2. Collect every CI file that could pin a Playwright image.
const ciFiles = [];
if (existsSync(join(ROOT, '.gitlab-ci.yml'))) ciFiles.push('.gitlab-ci.yml');
const ghDir = join(ROOT, '.github/workflows');
if (existsSync(ghDir)) {
  for (const f of readdirSync(ghDir)) {
    if (f.endsWith('.yml') || f.endsWith('.yaml')) ciFiles.push(`.github/workflows/${f}`);
  }
}

// 3. Assert each pinned image matches the package version.
const re = /mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-/g;
const mismatches = [];
let found = 0;
for (const rel of ciFiles) {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  for (const m of text.matchAll(re)) {
    found++;
    if (m[1] !== pkgExact) mismatches.push(`${rel}: pins v${m[1]}`);
  }
}

if (found === 0) {
  console.log(`[playwright-image] ok — @playwright/test ${pkgVersion} present but no CI image pin found`);
  process.exit(0);
}
if (mismatches.length) {
  fail(
    `image/package mismatch: @playwright/test is ${pkgVersion} but\n  ` +
      mismatches.join('\n  ') +
      `\n  Fix: set every Playwright CI image to mcr.microsoft.com/playwright:v${pkgExact}-noble ` +
      `(or align the package). They must move in lockstep — the prebuilt image ships the ` +
      `matching browser binaries and the GitLab job runs no 'playwright install'.`,
  );
}

console.log(`[playwright-image] ok — ${found} CI image pin(s) match @playwright/test ${pkgVersion}`);
