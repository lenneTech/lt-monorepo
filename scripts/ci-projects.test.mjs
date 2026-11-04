/**
 * Every combination of the three inputs — the template skip must never leak into a generated
 * project, where a missing `projects/` has to fail instead of going green.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { TEMPLATE_PACKAGE_NAME, projectJobs } from './ci-projects.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = TEMPLATE_PACKAGE_NAME;

/**
 * Runs the real script in a throwaway root, the way the `projects` job does, and returns its exit
 * code and what it wrote to GITHUB_OUTPUT. `projectJobs` alone does not prove the decision reaches
 * the jobs: they read only the exit code and the output file.
 */
function runScript({ name, projects }) {
  const root = mkdtempSync(join(tmpdir(), 'ci-projects-'));
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(join(ROOT, 'scripts/ci-projects.mjs'), join(root, 'scripts/ci-projects.mjs'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name }));
    for (const project of projects) {
      mkdirSync(join(root, 'projects', project), { recursive: true });
      writeFileSync(join(root, 'projects', project, 'package.json'), '{}');
    }
    const output = join(root, 'github-output');
    writeFileSync(output, '');
    const r = spawnSync(process.execPath, [join(root, 'scripts/ci-projects.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: output },
    });
    return { output: readFileSync(output, 'utf8'), status: r.status, stdout: r.stdout };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

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

  it('accepts the repository it runs in', () => {
    // Runs in the template AND in every project generated from it, whose root package init
    // renames. So it must not pin the name; it pins the outcome. In the template (empty
    // projects/, name "lt-monorepo") that is a skip; in a generated project, a run. If the
    // template's package is ever renamed, its empty projects/ stops being recognised and
    // this names the cause before CI does.
    const decision = projectJobs({
      hasApi: existsSync(join(ROOT, 'projects/api/package.json')),
      hasApp: existsSync(join(ROOT, 'projects/app/package.json')),
      rootName: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name,
    });
    assert.equal(decision.error, undefined, decision.error);
  });
});

describe('ci-projects.mjs as the projects job runs it', () => {
  it('writes run=true and exits 0 in a generated project with both projects', () => {
    const r = runScript({ name: 'my-project', projects: ['api', 'app'] });
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.output, 'run=true\n');
  });

  it('exits 1 and writes no decision in a generated project without projects', () => {
    // Exit 0 here, or any run= line, would skip the gated jobs and report the pipeline green.
    const r = runScript({ name: 'my-project', projects: [] });
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.output, '');
  });

  it('writes run=false and exits 0 in the template', () => {
    const r = runScript({ name: TEMPLATE, projects: [] });
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.output, 'run=false\n');
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

  it('runs the decision script in a projects job and exposes the output of that step', () => {
    // The job output must name the id of the step that runs the script. With any other id,
    // outputs.run is empty in every project and all gated jobs skip: green, untested.
    const id = /- id: ([\w-]+)\n\s+run: node scripts\/ci-projects\.mjs\n/.exec(job('projects'))?.[1];
    assert.ok(id, 'no step with an id runs node scripts/ci-projects.mjs');
    assert.match(job('projects'), new RegExp(`run: \\$\\{\\{ steps\\.${id}\\.outputs\\.run \\}\\}`));
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
