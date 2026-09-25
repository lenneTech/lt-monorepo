#!/usr/bin/env node
/**
 * Decides whether the project jobs of .github/workflows/test.yml run.
 *
 * This repository is the template `lt fullstack init` clones, and `projects/` stays empty
 * until init fills it. So in the template itself every job that builds or tests
 * `projects/api` / `projects/app` can only fail — and did, on every run since the workflow
 * first ran on 2026-09-14. That red said "the template has no projects", not "broken".
 *
 * The template is recognised by what it IS, not by where it lives: its root package is named
 * `lt-monorepo`, and init renames it to the project (`setPackageName` in the CLI's
 * `fullstack/init.ts`) in both the classic and the `--next` flow. A repository name check
 * would break in every fork, rename and mirror.
 *
 * The asymmetry is the point:
 * - template without projects   → the jobs are skipped, visibly, with a notice saying why;
 * - a generated project without `projects/api` or `projects/app` → FAIL. Skipping there
 *   would turn "the code under test is missing" into a green pipeline.
 * - one of the two present but not the other → FAIL everywhere; that is a broken checkout,
 *   not a template.
 *
 * Note for branch protection: GitHub counts a skipped job as passed for required checks.
 * In the template that is intended; `main` has no branch protection today. Whoever turns
 * it on must not make these jobs the only required checks there.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEMPLATE_PACKAGE_NAME = 'lt-monorepo';

/** Pure decision: `{ run }` or `{ error }`, plus a `notice` when the jobs are skipped. */
export function projectJobs({ hasApi, hasApp, rootName }) {
  const isTemplate = rootName === TEMPLATE_PACKAGE_NAME;
  if (hasApi && hasApp) return { run: true };
  if (hasApi !== hasApp) {
    const missing = hasApi ? 'projects/app' : 'projects/api';
    return { error: `${missing}/package.json is missing while the other project exists — incomplete checkout` };
  }
  if (isTemplate) {
    return {
      notice:
        `Template repository (root package "${TEMPLATE_PACKAGE_NAME}") without projects/: ` +
        'api-test, build, app-test and app-report are skipped. They run in every project `lt fullstack init` generates.',
      run: false,
    };
  }
  return {
    error:
      `projects/api and projects/app are missing, and this is not the template (root package "${rootName}"). ` +
      'The jobs that test them would have nothing to test — refusing to report that as green.',
  };
}

function main(root) {
  const rootName = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;
  const decision = projectJobs({
    hasApi: existsSync(join(root, 'projects/api/package.json')),
    hasApp: existsSync(join(root, 'projects/app/package.json')),
    rootName,
  });
  if (decision.error) {
    console.log(`::error title=projects/ missing::${decision.error}`);
    process.exitCode = 1;
    return;
  }
  if (decision.notice) console.log(`::notice title=Project jobs skipped::${decision.notice}`);
  console.log(`run=${decision.run}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${decision.run}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(join(dirname(fileURLToPath(import.meta.url)), '..'));
}
