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

// ---------------------------------------------------------------------------
// Wire-critical packages: api and app must resolve them to the SAME version.
//
// Some dependencies are not two projects' private business — they are one
// protocol with two ends. better-auth is the case that taught us: the app talks
// to the api through it, so a version split is a client and a server disagreeing
// about their own wire format. It is invisible to both repos' own checks, since
// each is internally consistent; only the assembled workspace has both halves.
//
// It shipped: nest-server pinned better-auth 1.6.26 as a hard dependency while
// nuxt-extensions declared it as a peer, so the app moved to 1.7.1 and the api
// could not follow. better-auth 1.7 gives `twoFactor.enable` a discriminated
// result carrying `method`, which 1.6.26 never sends — so EVERY 2FA activation
// failed, with a generic client error and nothing unusual in the server log.
//
// Two things are checked, because they fail differently:
//   1. What the manifests PROMISE — the frameworks' peer ranges must agree.
//      A mismatch here is a future split, even when today's install is fine.
//   2. What is INSTALLED — the resolved versions per member must be identical.
//      This is the one that actually breaks, and `shamefullyHoist: true` makes
//      it worse: with two versions in the tree, which one gets hoisted is not
//      something either project controls.
// ---------------------------------------------------------------------------
const WIRE_CRITICAL = ["better-auth", "@better-auth/passkey", "@better-auth/core"];

/** The framework libraries that own the contract, and therefore declare the peer ranges. */
const CONTRACT_OWNERS = ["@lenne.tech/nest-server", "@lenne.tech/nuxt-extensions"];

const wireProblems = [];

// 1. Peer ranges promised by the framework libraries must be identical where both declare one.
const declaredRanges = new Map(); // pkg -> [{ owner, range }]
for (const { rel } of members) {
  for (const owner of CONTRACT_OWNERS) {
    const ownerPkg = readJson(join(ROOT, rel, "node_modules", owner, "package.json"));
    if (!ownerPkg) continue;
    for (const dep of WIRE_CRITICAL) {
      const range = ownerPkg.peerDependencies?.[dep];
      if (!range) continue;
      if (!declaredRanges.has(dep)) declaredRanges.set(dep, []);
      const seen = declaredRanges.get(dep);
      if (!seen.some((e) => e.owner === owner)) seen.push({ owner, range });
    }
  }
}

for (const [dep, entries] of declaredRanges) {
  const ranges = [...new Set(entries.map((e) => e.range))];
  if (ranges.length <= 1) continue;
  wireProblems.push(
    `${dep}: the frameworks promise different ranges —\n`
      + entries.map((e) => `        ${e.owner} says "${e.range}"`).join("\n")
      + `\n      They are two ends of one protocol, so the ranges must be identical.\n`
      + `      Raise them together, in both repos, in the same release.`,
  );
}

// 2. What is actually installed per member.
for (const dep of WIRE_CRITICAL) {
  const resolved = new Map(); // version -> [member rel]
  for (const { rel } of members) {
    const installed = readJson(join(ROOT, rel, "node_modules", dep, "package.json"));
    if (!installed?.version) continue;
    if (!resolved.has(installed.version)) resolved.set(installed.version, []);
    resolved.get(installed.version).push(rel);
  }

  if (resolved.size <= 1) continue;

  wireProblems.push(
    `${dep} resolves to ${resolved.size} different versions in one workspace —\n`
      + [...resolved].map(([v, rels]) => `        ${v}  in ${rels.join(", ")}`).join("\n")
      + `\n      Client and server would speak different versions of the same protocol.\n`
      + `      Pin the SAME version in every member's package.json.`,
  );
}

// 3. Is anybody actually PINNING it, or did pnpm just guess?
//
// Checks 1 and 2 both pass on a workspace where nobody declares the package at
// all. `autoInstallPeers` defaults to TRUE, so pnpm quietly installs a missing
// peer by picking from the framework's range — and picks the same thing for both
// members, on the same day. Identical versions, identical ranges, guard silent,
// nothing pinned. The next install is free to land somewhere else, and the first
// member to be installed separately (a Docker build, a CI cache miss) is the one
// that drifts.
//
// So the absence of a declaration is its own defect, independent of what is
// installed right now. Only members that HAVE the package resolved are asked for
// a declaration — a project legitimately not using it is not required to pin it.
for (const dep of WIRE_CRITICAL) {
  const undeclared = [];

  for (const { pkg, rel } of members) {
    const installed = readJson(join(ROOT, rel, "node_modules", dep, "package.json"));
    if (!installed?.version) continue;

    const declared = pkg.dependencies?.[dep] ?? pkg.devDependencies?.[dep] ?? pkg.peerDependencies?.[dep];
    if (!declared) undeclared.push({ rel, version: installed.version });
  }

  if (undeclared.length === 0) continue;

  wireProblems.push(
    `${dep} is installed but declared nowhere in —\n`
      + undeclared.map((u) => `        ${u.rel}  (pnpm resolved ${u.version} on its own)`).join("\n")
      + `\n      With autoInstallPeers (pnpm's default), a missing peer is filled in silently from\n`
      + `      the framework's range. It agrees today and is free to drift on the next install.\n`
      + `      Add it to that member's package.json, pinned to the exact version.`,
  );
}

if (problems.length > 0 || wireProblems.length > 0) {
  console.error("[workspace-consistency] the assembled workspace is inconsistent:\n");
  for (const p of problems) console.error(`  ✗ ${p}`);
  for (const p of wireProblems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

const checkedWire = WIRE_CRITICAL.filter((dep) =>
  members.some(({ rel }) => readJson(join(ROOT, rel, "node_modules", dep, "package.json"))),
);

console.log(
  `[workspace-consistency] ok — ${members.length} member(s) agree with the root on packageManager (${root.packageManager ?? "unset"})`
    + (checkedWire.length > 0 ? `, and on ${checkedWire.join(", ")}` : ""),
);
