/**
 * Every combination of the three inputs — the template skip must never leak into a generated
 * project, where a missing `projects/` has to fail instead of going green.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { TEMPLATE_PACKAGE_NAME, projectJobs } from './ci-projects.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = TEMPLATE_PACKAGE_NAME;

describe('projectJobs', () => {
  it('runs the jobs wherever both projects exist', () => {
    for (const rootName of [TEMPLATE, 'my-project']) {
      assert.deepEqual(projectJobs({ hasApi: true, hasApp: true, rootName }), { run: true });
    }
  });

  it('skips them in the template without projects, and says why', () => {
    const decision = projectJobs({ hasApi: false, hasApp: false, rootName: TEMPLATE });
    assert.equal(decision.run, false);
    assert.equal(decision.error, undefined);
    assert.match(decision.notice, /Template repository/);
  });

  it('fails a generated project without projects instead of skipping', () => {
    for (const rootName of ['my-project', undefined, '']) {
      const decision = projectJobs({ hasApi: false, hasApp: false, rootName });
      assert.equal(decision.run, undefined, `root name ${String(rootName)}`);
      assert.match(decision.error, /not the template/);
    }
  });

  it('fails a half checkout everywhere, the template included', () => {
    for (const rootName of [TEMPLATE, 'my-project']) {
      assert.match(
        projectJobs({ hasApi: true, hasApp: false, rootName }).error,
        /projects\/app\/package\.json is missing/,
      );
      assert.match(
        projectJobs({ hasApi: false, hasApp: true, rootName }).error,
        /projects\/api\/package\.json is missing/,
      );
    }
  });

  it('matches the name this template actually carries', () => {
    // If the root package is ever renamed, the template stops recognising itself and its
    // empty projects/ fails loudly — the safe direction, but this names the cause.
    assert.equal(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name, TEMPLATE);
  });
});

describe('test.yml wiring', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8');
  const job = (name) => {
    const start = workflow.indexOf(`\n  ${name}:\n`);
    assert.ok(start >= 0, `job ${name} not found`);
    const rest = workflow.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
    return next < 0 ? rest : rest.slice(0, next + 1);
  };

  it('runs the decision script in a projects job', () => {
    assert.match(job('projects'), /node scripts\/ci-projects\.mjs/);
    assert.match(job('projects'), /run: \$\{\{ steps\.[\w-]+\.outputs\.run \}\}/);
  });

  for (const name of ['api-test', 'build']) {
    it(`gates ${name} on the decision`, () => {
      assert.match(job(name), /needs: \[?projects/);
      assert.match(job(name), /if: \$\{\{ needs\.projects\.outputs\.run == 'true' \}\}/);
    });
  }

  it('gates app-report despite its always()', () => {
    // always() alone would run the report in the template and fail on `cd projects/app`.
    assert.match(job('app-report'), /needs: \[app-test, projects\]/);
    assert.match(job('app-report'), /if: \$\{\{ always\(\) && needs\.projects\.outputs\.run == 'true' \}\}/);
  });
});
