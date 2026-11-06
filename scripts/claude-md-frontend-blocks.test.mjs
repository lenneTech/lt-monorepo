/**
 * Guard for the frontend blocks in the root CLAUDE.md.
 *
 * The template describes both frontends. Each framework's part sits between
 * `<!-- lt:frontend <kind> -->` and `<!-- /lt:frontend -->` lines, and
 * `lt fullstack init` / `add-app` keep the chosen frontend's blocks and drop the
 * others (cli/src/lib/frontend-claude-blocks.ts; the lt-dev `sync-claude-md`
 * command reads the same markers).
 *
 * The failure this suite exists for is a quiet one: when the markers are
 * unbalanced or nested, the CLI only warns and leaves the file UNCHANGED, so
 * every new project's CLAUDE.md tells its agents about both frameworks at once.
 * Nothing downstream notices. The second failure is a leak: a Nuxt-only fact
 * written outside a block reaches every Angular project, and vice versa.
 *
 * `select()` below mirrors the CLI's selection (whole-line markers, keep the
 * chosen kind without its markers, drop the rest). It only has to agree with the
 * CLI on what a well-formed file means; the CLI owns the blank-line handling.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// The CLI's patterns (START / END in cli/src/lib/frontend-claude-blocks.ts).
const START = /^\s*<!--\s*lt:frontend\s+([a-z]+)\s*-->\s*$/;
const END = /^\s*<!--\s*\/lt:frontend\s*-->\s*$/;
const ANY_MARKER = /<!--\s*\/?lt:frontend\b/;

const KINDS = ['angular', 'nuxt'];

/** Tokens that may only appear inside the other framework's blocks. */
const FOREIGN = {
  angular: [/nuxt-extensions/, /\bNUXT_/, /useLtAuth/, /projects\/app\/app\/core/, /NuxtUI/],
  nuxt: [/@lenne\.tech\/ng-base\b/, /\bNG_[A-Z]/, /LtAuthService/, /projects\/app\/src\/core/, /Spartan/],
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lines = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8').split(/\r?\n/);

// This file travels into every generated project, whose CLAUDE.md `lt fullstack init`
// has already resolved: no markers left, by design. Init renames the root package, which
// is what tells the two apart (the same guard as check-wrapper-version.test.mjs). Never
// skip on "no markers found" instead: in the template, losing every marker is exactly
// the failure this suite exists for.
const TEMPLATE_NAME = 'lt-monorepo';
const pkgName = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name;
const SKIP_GENERATED =
  pkgName !== TEMPLATE_NAME && `package "${pkgName}" is a generated project, its CLAUDE.md is already resolved`;
/** Per test, not per suite: a skipped suite counts 0 tests, a skipped test shows in the totals. */
const ONLY_TEMPLATE = { skip: SKIP_GENERATED };

/** Blocks as `{ kind, start, end }` (1-based lines); throws on the shapes the CLI refuses. */
function parseBlocks() {
  const blocks = [];
  let open;
  lines.forEach((line, i) => {
    const start = START.exec(line);
    if (start) {
      if (open) throw new Error(`block opened in line ${i + 1} inside the block of line ${open.start}`);
      open = { kind: start[1], start: i + 1 };
    } else if (END.test(line)) {
      if (!open) throw new Error(`block closed in line ${i + 1} without being opened`);
      blocks.push({ ...open, end: i + 1 });
      open = undefined;
    }
  });
  if (open) throw new Error(`block opened in line ${open.start} is never closed`);
  return blocks;
}

/** What a project of `kind` receives, before the `{{…}}` placeholders are filled. */
function select(kind) {
  const out = [];
  let keep = true;
  for (const line of lines) {
    const start = START.exec(line);
    if (start) keep = start[1] === kind;
    else if (END.test(line)) keep = true;
    else if (keep) out.push(line);
  }
  return out;
}

describe('root CLAUDE.md frontend blocks', () => {
  it('are balanced and not nested, so the CLI does not leave the file unchanged', ONLY_TEMPLATE, () => {
    assert.doesNotThrow(parseBlocks);
  });

  it('write every marker as a line of its own, in the exact form the CLI matches', ONLY_TEMPLATE, () => {
    // `> <!-- lt:frontend nuxt -->` inside a quote, or a typo like `lt-frontend`, is no
    // marker to the CLI: the block's content and both marker lines would ship verbatim.
    const loose = lines
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => ANY_MARKER.test(line) && !START.test(line) && !END.test(line));
    assert.deepEqual(loose, [], 'marker text the CLI does not recognise as a marker line');
  });

  it('name only the frontends the CLI knows, and describe each of them', ONLY_TEMPLATE, () => {
    const kinds = new Set(parseBlocks().map((b) => b.kind));
    assert.deepEqual([...kinds].sort(), KINDS);
  });

  for (const kind of KINDS) {
    it(`give a project on ${kind} nothing that belongs to the other frontend`, ONLY_TEMPLATE, () => {
      // Positive control first: a `select` that returned nothing, or dropped the chosen
      // kind's blocks too, would satisfy the leak check below without checking anything.
      const own = FOREIGN[KINDS.find((k) => k !== kind)];
      assert.ok(
        select(kind).some((line) => own.some((re) => re.test(line))),
        `the ${kind} selection lost its own blocks`,
      );
      const leaks = select(kind)
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => FOREIGN[kind].some((re) => re.test(line)));
      assert.deepEqual(leaks, [], `lines a ${kind} project would receive (n = line in the selected output)`);
    });
  }
});
