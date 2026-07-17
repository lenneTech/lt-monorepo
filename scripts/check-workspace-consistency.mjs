#!/usr/bin/env node
/**
 * Guards cross-project consistency inside the assembled workspace.
 *
 * This repo is a TEMPLATE: `projects/` is empty here (just a .gitkeep) and gets
 * filled by `lt fullstack init`, which clones nest-server-starter into
 * projects/api and nuxt-base-starter into projects/app. Each of those is its own
 * repo with its own package.json — so conflicts only exist in the ASSEMBLED
 * project, where no single repo's `check` was ever looking.
 *
 * That blind spot shipped a real bug: lt-monorepo pinned `packageManager:
 * pnpm@11.5.1` while nest-server-starter pinned `pnpm@11.13.0`. Corepack refuses
 * a workspace whose root and member disagree, so `lt fullstack init` died on
 *
 *   [ERROR] This project is configured to use 11.5.1 of pnpm. Your current pnpm
 *   is v11.13.0 — Corepack invoked pnpm with this version, and pnpm does not
 *   switch versions when running under corepack.
 *
 * Every check in every source repo was green: each was self-consistent. Only the
 * combination broke. Since this script travels with the template, it runs inside
 * the generated project — the one place where the members are actually present.
 *
 * Rule: `packageManager` belongs to the workspace ROOT only. A member may omit
 * it (nuxt-base-template does — correct) but must not contradict the root.
 *
 * Exit code: 0 when the workspace is coherent, 1 otherwise.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// Mirrors the `packages:` parsing in check.mjs — same simple value-list read.
function workspaceGlobs() {
  let text;
  try {
    text = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  } catch {
    return [];
  }
  const globs = [];
  let inPackages = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "");
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = line.match(/^\s*-\s*['"]?([^'"]+?)['"]?\s*$/);
      if (m) globs.push(m[1]);
      else if (line.trim() && !/^\s/.test(line)) break;
    }
  }
  return globs;
}

function expandGlob(glob) {
  if (glob.endsWith("/*")) {
    const base = glob.slice(0, -2);
    try {
      return readdirSync(join(ROOT, base), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(base, d.name));
    } catch {
      return [];
    }
  }
  return [glob];
}

const root = readJson(join(ROOT, "package.json"));
const members = workspaceGlobs()
  .flatMap(expandGlob)
  .map((rel) => ({ pkg: readJson(join(ROOT, rel, "package.json")), rel }))
  .filter((m) => m.pkg);

if (members.length === 0) {
  // The un-assembled template — nothing to compare yet. Not a failure.
  console.log("[workspace-consistency] no workspace members yet (template state) — skipped");
  process.exit(0);
}

const problems = [];

// A member must not carry `packageManager` at all — not even one that currently
// matches the root.
//
// This is not style policing. Corepack's AUTO_PIN is ON BY DEFAULT and rewrites
// the field into package.json on every `pnpm install`, using whatever pnpm the
// machine happens to run — that is where "pnpm@11.5.1+sha512..." came from; the
// hash suffix is Corepack's signature, nobody typed it. So a member pin does not
// stay put: two repos installed on two machines drift apart on their own, and
// the assembled workspace then dies with
//   "This project is configured to use X of pnpm. Your current pnpm is Y."
// A pin that agrees today is simply a conflict that has not happened yet — hence
// fail on presence, not just on mismatch. In a workspace the field belongs to the
// root alone (which may legitimately have none, letting the installed pnpm win).
for (const { pkg, rel } of members) {
  if (!pkg.packageManager) continue;
  const clash = pkg.packageManager !== root.packageManager;
  problems.push(
    clash
      ? `${rel} pins "${pkg.packageManager}" but the root pins "${root.packageManager ?? "nothing"}".\n`
        + `      Corepack refuses this workspace — this is the break, not a warning.\n`
        + `      Remove the field from ${rel}; in a workspace it belongs to the root only.`
      : `${rel} carries "packageManager" (currently equal to the root, so nothing breaks yet).\n`
        + `      Remove it anyway: Corepack's AUTO_PIN rewrites this field per machine, so the\n`
        + `      two WILL drift apart and then Corepack refuses the workspace.`,
  );
}

if (problems.length > 0) {
  console.error("[workspace-consistency] the assembled workspace is inconsistent:\n");
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

console.log(
  `[workspace-consistency] ok — ${members.length} member(s) agree with the root on packageManager (${root.packageManager ?? "unset"})`,
);
